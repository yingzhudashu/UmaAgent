package site.robotclaw.umaagent

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.io.FileOutputStream
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

private val storageJson = Json { ignoreUnknownKeys = true; isLenient = true }

class PatStore(context: Context) {
    private val file = AtomicFile(File(context.filesDir, "pat.bin"))
    private val alias = "uma-pat"

    private fun writeAtomically(bytes: ByteArray) {
        var output: FileOutputStream? = null
        try {
            output = file.startWrite()
            output.write(bytes)
            file.finishWrite(output)
        } catch (error: Throwable) {
            file.failWrite(output)
            throw error
        }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    fun save(value: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        writeAtomically(cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8)))
    }

    fun read(): String? {
        if (!file.baseFile.exists()) return null
        return try {
            if (file.baseFile.length() > MAX_PAT_FILE_BYTES) error("访问令牌文件过大")
            val bytes = file.readFully()
            if (bytes.size <= 12) return null
            Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
                String(doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
            }
        } catch (_: Exception) {
            file.delete()
            null
        }
    }

    fun clear() = file.delete()

    private companion object {
        const val MAX_PAT_FILE_BYTES = 16 * 1024L
    }
}

/** Stores the staging gateway password separately from the user PAT. */
class StagingAuthStore(context: Context) {
    private val file = AtomicFile(File(context.filesDir, "staging-auth.bin"))
    private val alias = "uma-staging-basic-auth"

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    fun save(password: String) {
        require(password.isNotBlank()) { "测试环境口令不能为空" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        var output: FileOutputStream? = null
        try {
            output = file.startWrite()
            output.write(cipher.iv + cipher.doFinal(password.toByteArray(Charsets.UTF_8)))
            file.finishWrite(output)
        } catch (error: Throwable) {
            file.failWrite(output)
            throw error
        }
    }

    fun read(): String? {
        if (!file.baseFile.exists()) return null
        return try {
            if (file.baseFile.length() > MAX_AUTH_FILE_BYTES) error("测试环境口令文件过大")
            val bytes = file.readFully()
            if (bytes.size <= 12) return null
            Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
                String(doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8).takeIf { it.isNotBlank() }
            }
        } catch (_: Exception) {
            file.delete()
            null
        }
    }

    fun clear() = file.delete()

    private companion object {
        const val MAX_AUTH_FILE_BYTES = 4 * 1024L
    }
}

@Serializable
data class CacheEnvelope(
    val version: Int,
    val sessions: List<Session>,
    val snapshots: Map<String, String>,
    val sequences: Map<String, Long> = emptyMap(),
)

class SnapshotCache(context: Context) {
    private val file = AtomicFile(File(context.filesDir, "cache.json"))

    fun read(): CacheEnvelope? = try {
        if (!file.baseFile.exists()) null
        else if (file.baseFile.length() > MAX_CACHE_FILE_BYTES) error("离线缓存过大")
        else storageJson.decodeFromString<CacheEnvelope>(
            file.readFully().toString(Charsets.UTF_8),
        ).let {
            if (it.version == 2) it else null.also { file.delete() }
        }
    } catch (_: Exception) {
        file.delete()
        null
    }

    fun write(value: CacheEnvelope) {
        val encoded = storageJson.encodeToString(value).toByteArray(Charsets.UTF_8)
        if (encoded.size > MAX_CACHE_FILE_BYTES) throw IllegalStateException("离线缓存过大")
        var output: FileOutputStream? = null
        try {
            output = file.startWrite()
            output.write(encoded)
            file.finishWrite(output)
        } catch (error: Throwable) {
            file.failWrite(output)
            throw error
        }
    }

    fun clear() = file.delete()

    private companion object {
        const val MAX_CACHE_FILE_BYTES = 16 * 1024 * 1024L
    }
}
