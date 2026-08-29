package site.robotclaw.umaagent

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest

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
    const val manifestUrl = "https://robotclaw.site/app/latest.json"
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    private val http = OkHttpClient()

    suspend fun check(): UpdateManifest = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(manifestUrl).get().build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw UpdateException("更新清单请求失败（HTTP ${response.code}）")
            val body = response.body?.string().orEmpty()
            if (body.isBlank()) throw UpdateException("更新清单为空")
            json.decodeFromString<UpdateManifest>(body).also {
                if (it.packageName != BuildConfig.APPLICATION_ID) throw UpdateException("更新包不匹配")
                if (it.versionCode < 1 || it.apk.sizeBytes <= 0 || it.apk.sha256.length != 64) throw UpdateException("更新清单无效")
            }
        }
    }

    suspend fun download(context: Context, manifest: UpdateManifest, onProgress: (Long, Long) -> Unit): File = withContext(Dispatchers.IO) {
        val updatesDir = File(context.cacheDir, "updates").apply { mkdirs() }
        val target = File(updatesDir, "UmaAgent-${manifest.versionName}-${manifest.versionCode}.apk")
        val temp = File(updatesDir, "${target.name}.part")
        val downloadUrl = Uri.parse(manifest.apk.url).let {
            if (it.isAbsolute) it.toString() else "https://robotclaw.site${it.path?.let { path -> if (path.startsWith("/")) path else "/$path" } ?: "/app/latest.apk"}"
        }
        val request = Request.Builder().url(downloadUrl).get().build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw UpdateException("APK 下载失败（HTTP ${response.code}）")
            val body = response.body ?: throw UpdateException("APK 响应为空")
            val contentType = body.contentType()?.toString()?.lowercase()
            if (contentType != null && contentType != "application/vnd.android.package-archive" && contentType != "application/octet-stream") {
                throw UpdateException("APK 响应类型无效")
            }
            val total = body.contentLength().takeIf { it > 0 } ?: manifest.apk.sizeBytes
            body.byteStream().use { input -> temp.outputStream().use { output ->
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                var downloaded = 0L
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    output.write(buffer, 0, count)
                    downloaded += count
                    onProgress(downloaded, total)
                }
            } }
        }
        if (temp.length() != manifest.apk.sizeBytes) throw UpdateException("APK 大小校验失败")
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
        if (!actual.equals(manifest.apk.sha256, ignoreCase = true)) throw UpdateException("APK SHA-256 校验失败")
        if (target.exists()) target.delete()
        if (!temp.renameTo(target)) throw UpdateException("无法保存 APK")
        target
    }

    fun installIntent(context: Context, file: File): Intent {
        val uri = FileProvider.getUriForFile(context, "${BuildConfig.APPLICATION_ID}.fileprovider", file)
        return Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }
}
