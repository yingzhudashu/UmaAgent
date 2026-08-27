package site.robotclaw.umaagent

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@Serializable
data class Session(val id: String, val title: String, val workspace: String = "")

@Serializable
data class BootstrapEntry(val session: Session, val lastSequence: Long = 0)

@Serializable
data class Bootstrap(val user: JsonObject? = null, val sessions: List<BootstrapEntry> = emptyList())

@Serializable
data class Unlock(val grant: String, val expiresAt: Long)

private val json = Json { ignoreUnknownKeys = true; isLenient = true }

class UmaApi(private val token: String, private val baseUrl: String = "https://robotclaw.site") {
    private val http = OkHttpClient()

    private suspend fun request(path: String, method: String = "GET", body: String? = null, grant: String? = null): String =
        withContext(Dispatchers.IO) {
            val builder = Request.Builder().url("$baseUrl/api/v14$path").addHeader("Authorization", "Bearer $token")
            if (grant != null) builder.addHeader("X-Xianyu-Grant", grant)
            if (body != null) builder.method(method, body.toRequestBody("application/json".toMediaType()))
            http.newCall(builder.build()).execute().use { response ->
                if (!response.isSuccessful) error("HTTP ${response.code}")
                response.body?.string() ?: "{}"
            }
        }

    suspend fun bootstrap(): Bootstrap = json.decodeFromString(request("/sync/bootstrap", "POST"))
    suspend fun sessions(): List<Session> = json.decodeFromString(request("/sessions"))
    suspend fun snapshot(sessionId: String): JsonObject = json.parseToJsonElement(request("/sessions/${encode(sessionId)}/snapshot")).jsonObject
    suspend fun history(sessionId: String, before: Long? = null, limit: Int = 100): JsonObject {
        val suffix = buildString { append("?limit=").append(limit); if (before != null) append("&before=").append(before) }
        return json.parseToJsonElement(request("/sessions/${encode(sessionId)}/history$suffix")).jsonObject
    }
    suspend fun events(sessionId: String, after: Long, limit: Int = 500): JsonObject =
        json.parseToJsonElement(request("/sessions/${encode(sessionId)}/events?after=$after&limit=$limit")).jsonObject
    suspend fun send(sessionId: String, text: String): JsonObject = json.parseToJsonElement(
        request("/sessions/${encode(sessionId)}/messages", "POST", buildJsonObject {
            put("messageId", java.util.UUID.randomUUID().toString()); put("text", text); put("mode", "agent")
        }.toString()),
    ).jsonObject
    suspend fun unlock(password: String): Unlock = json.decodeFromString(
        request("/xianyu/unlock", "POST", buildJsonObject { put("password", password) }.toString()),
    )
    suspend fun xianyuStatus(grant: String): JsonObject = json.parseToJsonElement(request("/xianyu/status", grant = grant)).jsonObject

    fun connectEvents(onOpen: (WebSocket) -> Unit, onText: (String) -> Unit, onFailure: (Throwable) -> Unit): WebSocket {
        val url = baseUrl.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") + "/api/v14/events"
        return http.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = onOpen(webSocket)
            override fun onMessage(webSocket: WebSocket, text: String) = onText(text)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = onFailure(t)
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = onFailure(Exception("WebSocket closed: $code"))
        })
    }

    private fun encode(value: String) = java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")
}

class PatStore(context: Context) {
    private val file = File(context.filesDir, "pat.bin")
    private val alias = "uma-pat"

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        return generator.generateKey()
    }

    fun save(value: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        file.writeBytes(cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8)))
    }

    fun read(): String? {
        if (!file.exists()) return null
        return try {
            val bytes = file.readBytes(); if (bytes.size <= 12) return null
            Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
                String(doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
            }
        } catch (_: Exception) { null }
    }

    fun clear() { file.delete() }
}

@Serializable
data class CacheEnvelope(val version: Int, val sessions: List<Session>, val snapshots: Map<String, String>)

class SnapshotCache(context: Context) {
    private val file = File(context.filesDir, "cache.json")
    fun read(): CacheEnvelope? = try {
        if (!file.exists()) null else json.decodeFromString<CacheEnvelope>(file.readText()).takeIf { it.version == 1 }
    } catch (_: Exception) { file.delete(); null }
    fun write(value: CacheEnvelope) { file.writeText(json.encodeToString(value)) }
    fun clear() { file.delete() }
}
