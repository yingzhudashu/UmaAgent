package site.robotclaw.umaagent

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Credentials
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.ResponseBody
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.time.OffsetDateTime

@Serializable
data class ApkUpdate(
    val url: String,
    val sha256: String,
    val sizeBytes: Long,
)

@Serializable
data class UpdateManifest(
    val packageName: String,
    val versionName: String,
    val versionCode: Long,
    val minSupportedVersionCode: Long = 1,
    val releaseId: String = "",
    val apk: ApkUpdate,
    val publishedAt: String = "",
    val releaseNotes: List<String> = emptyList(),
)

data class UpdateDownload(
    val manifest: UpdateManifest,
    val file: File,
)

class UpdateException(message: String) : Exception(message)

object UpdateService {
    val manifestUrl: String get() = BuildConfig.UMA_UPDATE_MANIFEST_URL
    internal const val maxApkSizeBytes = 512L * 1024 * 1024
    private const val maxManifestSizeBytes = 256 * 1024
    private val versionNamePattern = Regex("^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$")
    private val sha256Pattern = Regex("^[0-9a-fA-F]{64}$")
    private val publishedAtPattern = Regex(
        "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,7})?(?:Z|[+-]\\d{2}:\\d{2})$",
    )
    private val updateOrigin get() = (BuildConfig.UMA_BASE_URL + "/").toHttpUrl()
    private val json = Json { ignoreUnknownKeys = true }
    private val http = OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    internal fun validateManifest(manifest: UpdateManifest): UpdateManifest {
        val releaseIdPattern = Regex("^${manifest.versionCode}-[0-9a-f]{7,40}$")
        val publishedAtValid = publishedAtPattern.matches(manifest.publishedAt) &&
            runCatching { OffsetDateTime.parse(manifest.publishedAt) }.isSuccess
        if (
            manifest.packageName != BuildConfig.APPLICATION_ID ||
            !versionNamePattern.matches(manifest.versionName) ||
            manifest.versionCode < 1 ||
            manifest.minSupportedVersionCode !in 1..manifest.versionCode ||
            !releaseIdPattern.matches(manifest.releaseId) ||
            !sha256Pattern.matches(manifest.apk.sha256) ||
            manifest.apk.sizeBytes !in 1..maxApkSizeBytes ||
            !publishedAtValid
        ) {
            throw UpdateException("更新清单无效")
        }
        resolveDownloadUrl(manifest)
        return manifest
    }

    internal fun resolveDownloadUrl(manifest: UpdateManifest): HttpUrl {
        val url = updateOrigin.resolve(manifest.apk.url) ?: throw UpdateException("APK 下载地址无效")
        val expectedPath = "/app/releases/${manifest.releaseId}/UmaAgent-${manifest.versionName}.apk"
        if (
            url.scheme != updateOrigin.scheme ||
            url.host != updateOrigin.host ||
            url.port != updateOrigin.port ||
            url.encodedPath != expectedPath ||
            url.encodedQuery != null ||
            url.fragment != null ||
            url.username.isNotEmpty() ||
            url.password.isNotEmpty()
        ) {
            throw UpdateException("APK 下载地址无效")
        }
        return url
    }

    private fun readManifestBody(body: ResponseBody): String {
        if (body.contentLength() > maxManifestSizeBytes) throw UpdateException("更新清单过大")
        val output = ByteArrayOutputStream()
        body.byteStream().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            var total = 0
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                total += count
                if (total > maxManifestSizeBytes) throw UpdateException("更新清单过大")
                output.write(buffer, 0, count)
            }
        }
        return output.toString(Charsets.UTF_8.name())
    }

    private fun Request.Builder.withGatewayAuthentication(gatewayPassword: String?): Request.Builder {
        gatewayPassword?.takeIf { it.isNotBlank() }?.let { header("Authorization", Credentials.basic("staging", it)) }
        return this
    }

    suspend fun check(gatewayPassword: String? = null): UpdateManifest = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(manifestUrl).get().withGatewayAuthentication(gatewayPassword).build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw UpdateException("更新清单请求失败（HTTP ${response.code}）")
            val responseBody = response.body ?: throw UpdateException("更新清单为空")
            val body = readManifestBody(responseBody)
            if (body.isBlank()) throw UpdateException("更新清单为空")
            val manifest = runCatching { json.decodeFromString<UpdateManifest>(body) }
                .getOrElse { throw UpdateException("更新清单格式无效") }
            validateManifest(manifest)
        }
    }

    suspend fun download(
        context: Context,
        manifest: UpdateManifest,
        gatewayPassword: String? = null,
        onProgress: (Long, Long) -> Unit,
    ): File = withContext(Dispatchers.IO) {
        val checkedManifest = validateManifest(manifest)
        val updatesDir = File(context.cacheDir, "updates")
        if (!updatesDir.isDirectory && !updatesDir.mkdirs()) throw UpdateException("无法创建更新目录")
        val target = File(
            updatesDir,
            "UmaAgent-${checkedManifest.versionName}-${checkedManifest.versionCode}.apk",
        )
        val temp = File(updatesDir, "${target.name}.part")
        if (temp.exists() && !temp.delete()) throw UpdateException("无法清理旧的 APK 临时文件")
        var promoted = false
        try {
            val downloadUrl = resolveDownloadUrl(checkedManifest)
            val request = Request.Builder().url(downloadUrl).get().withGatewayAuthentication(gatewayPassword).build()
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) throw UpdateException("APK 下载失败（HTTP ${response.code}）")
                val body = response.body ?: throw UpdateException("APK 响应为空")
                val contentType = body.contentType()
                if (
                    contentType != null &&
                    (contentType.type != "application" ||
                        contentType.subtype !in setOf("vnd.android.package-archive", "octet-stream"))
                ) {
                    throw UpdateException("APK 响应类型无效")
                }
                val expectedSize = checkedManifest.apk.sizeBytes
                val declaredSize = body.contentLength()
                if (declaredSize >= 0 && declaredSize != expectedSize) {
                    throw UpdateException("APK 大小校验失败")
                }
                body.byteStream().use { input ->
                    temp.outputStream().use { output ->
                        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                        var downloaded = 0L
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            if (downloaded > expectedSize - count) {
                                throw UpdateException("APK 大小校验失败")
                            }
                            output.write(buffer, 0, count)
                            downloaded += count
                            onProgress(downloaded, expectedSize)
                        }
                    }
                }
            }
            if (temp.length() != checkedManifest.apk.sizeBytes) throw UpdateException("APK 大小校验失败")
            val digest = MessageDigest.getInstance("SHA-256")
            temp.inputStream().use { input ->
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    digest.update(buffer, 0, count)
                }
            }
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            if (!actual.equals(checkedManifest.apk.sha256, ignoreCase = true)) {
                throw UpdateException("APK SHA-256 校验失败")
            }
            if (target.exists() && !target.delete()) throw UpdateException("无法替换旧 APK")
            if (!temp.renameTo(target)) throw UpdateException("无法保存 APK")
            promoted = true
            target
        } finally {
            if (!promoted && temp.exists()) temp.delete()
        }
    }

    fun installIntent(context: Context, file: File): Intent {
        val uri = FileProvider.getUriForFile(context, "${BuildConfig.APPLICATION_ID}.fileprovider", file)
        return Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }
}
