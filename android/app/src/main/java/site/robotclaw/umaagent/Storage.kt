package site.robotclaw.umaagent

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

private val storageJson = Json { ignoreUnknownKeys = true; isLenient = true }

class PatStore(context: Context) {
    private val file = File(context.filesDir, "pat.bin")
    private val alias = "uma-pat"

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
        file.writeBytes(cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8)))
    }

    fun read(): String? {
        if (!file.exists()) return null
        return try {
            val bytes = file.readBytes()
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
}

@Serializable
data class CacheEnvelope(
    val version: Int,
    val sessions: List<Session>,
    val snapshots: Map<String, String>,
    val sequences: Map<String, Long> = emptyMap(),
)

class SnapshotCache(private val context: Context) {
    private val file = File(context.filesDir, "cache.json")

    fun read(): CacheEnvelope? = try {
        if (!file.exists()) null else storageJson.decodeFromString<CacheEnvelope>(file.readText()).let {
            if (it.version == 2) it else null.also { file.delete() }
        }
    } catch (_: Exception) {
        file.delete()
        null
    }

    fun write(value: CacheEnvelope) {
        val temporary = File(context.filesDir, "cache.json.tmp")
        temporary.writeText(storageJson.encodeToString(value))
        if (!temporary.renameTo(file)) {
            file.delete()
            check(temporary.renameTo(file)) { "无法保存离线缓存" }
        }
    }

    fun clear() = file.delete()
}
