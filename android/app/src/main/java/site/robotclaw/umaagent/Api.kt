package site.robotclaw.umaagent

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
            else if (method != "GET") builder.method(method, null)
            http.newCall(builder.build()).execute().use { response ->
                if (!response.isSuccessful) error("HTTP ${response.code}")
                response.body?.string() ?: "{}"
            }
        }

    suspend fun getJson(path: String): JsonElement = json.parseToJsonElement(request(path))
    suspend fun postJson(path: String, body: JsonObject = buildJsonObject {}): JsonElement =
        json.parseToJsonElement(request(path, "POST", body.toString()))
    suspend fun patchJson(path: String, body: JsonObject): JsonElement =
        json.parseToJsonElement(request(path, "PATCH", body.toString()))
    suspend fun delete(path: String) { request(path, "DELETE") }

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
    suspend fun createSession(title: String): Session = json.decodeFromString(
        request("/sessions", "POST", buildJsonObject { put("title", title) }.toString()),
    )
    suspend fun renameSession(sessionId: String, title: String): Session = json.decodeFromString(
        request("/sessions/${encode(sessionId)}", "PATCH", buildJsonObject { put("title", title) }.toString()),
    )
    suspend fun deleteSession(sessionId: String) { request("/sessions/${encode(sessionId)}", "DELETE") }
    suspend fun cancelSession(sessionId: String) { request("/sessions/${encode(sessionId)}/cancel", "POST") }
    suspend fun compactSession(sessionId: String): JsonObject = json.parseToJsonElement(
        request("/sessions/${encode(sessionId)}/compact", "POST"),
    ).jsonObject
    suspend fun unlock(password: String): Unlock = json.decodeFromString(
        request("/xianyu/unlock", "POST", buildJsonObject { put("password", password) }.toString()),
    )
    suspend fun xianyuStatus(grant: String): JsonObject = json.parseToJsonElement(request("/xianyu/status", grant = grant)).jsonObject
    suspend fun xianyuConversations(grant: String): JsonElement = json.parseToJsonElement(request("/xianyu/conversations", grant = grant))
    suspend fun xianyuHistory(grant: String, conversationId: String): JsonElement = json.parseToJsonElement(
        request("/xianyu/history/${encode(conversationId)}", grant = grant),
    )
    suspend fun xianyuItem(grant: String, itemId: String): JsonElement = json.parseToJsonElement(
        request("/xianyu/item/${encode(itemId)}", grant = grant),
    )
    suspend fun xianyuControl(grant: String, action: String) {
        require(action in setOf("start", "stop", "pause", "resume"))
        request("/xianyu/$action", "POST", grant = grant)
    }
    suspend fun xianyuChat(grant: String, receiverId: String, itemId: String): JsonElement = json.parseToJsonElement(
        request("/xianyu/chat", "POST", buildJsonObject { put("receiverId", receiverId); put("itemId", itemId) }.toString(), grant),
    )
    suspend fun xianyuPublish(grant: String, description: String, imagePaths: List<String>, delivery: String): JsonElement = json.parseToJsonElement(
        request("/xianyu/publish", "POST", buildJsonObject {
            put("description", description)
            put("imagePaths", kotlinx.serialization.json.buildJsonArray { imagePaths.forEach { add(JsonPrimitive(it)) } })
            put("delivery", delivery)
        }.toString(), grant),
    )

    suspend fun authMe(): JsonObject = getJson("/auth/me").jsonObject
    suspend fun models(): JsonElement = getJson("/models")
    suspend fun profile(): JsonElement = getJson("/profile")
    suspend fun updateProfile(content: String): JsonElement =
        putJson("/profile", buildJsonObject { put("content", content) })
    suspend fun skills(): JsonElement = getJson("/skills")
    suspend fun mcp(): JsonElement = getJson("/mcp")
    suspend fun knowledge(): JsonElement = getJson("/knowledge")
    suspend fun knowledgeSearch(query: String, sourceId: String? = null, limit: Int = 20): JsonElement =
        getJson("/knowledge/search?q=${encode(query)}${sourceId?.let { "&sourceId=${encode(it)}" } ?: ""}&limit=$limit")
    suspend fun tasks(): JsonElement = getJson("/tasks")
    suspend fun createTask(prompt: String, parentSessionId: String? = null): JsonElement = postJson(
        "/tasks",
        buildJsonObject { put("prompt", prompt); parentSessionId?.let { put("parentSessionId", it) } },
    )
    suspend fun cancelTask(id: String): JsonElement = postJson("/tasks/${encode(id)}/cancel")
    suspend fun deleteTask(id: String) { delete("/tasks/${encode(id)}") }
    suspend fun schedules(): JsonElement = getJson("/schedules")
    suspend fun memory(status: String? = null): JsonElement = getJson("/memory${status?.let { "?status=${encode(it)}" } ?: ""}")
    suspend fun operations(): JsonElement = getJson("/reports/operations")
    suspend fun diagnostics(): JsonElement = getJson("/reports/diagnostics")
    suspend fun evaluations(): JsonElement = getJson("/evaluations")
    suspend fun optimizationProposals(): JsonElement = getJson("/optimization-proposals")
    suspend fun run(runId: String): JsonElement = getJson("/runs/${encode(runId)}")
    suspend fun runCheckpoints(runId: String): JsonElement = getJson("/runs/${encode(runId)}/checkpoints")
    suspend fun runActions(runId: String): JsonElement = getJson("/runs/${encode(runId)}/actions")
    suspend fun resumeRun(runId: String): JsonElement = postJson("/runs/${encode(runId)}/resume")
    suspend fun confirmPlan(runId: String): JsonElement = postJson("/runs/${encode(runId)}/confirm-plan")
    suspend fun cancelRun(runId: String): JsonElement = postJson("/runs/${encode(runId)}/cancel")
    suspend fun decideAction(runId: String, actionId: String, decision: String): JsonElement = postJson(
        "/runs/${encode(runId)}/actions/${encode(actionId)}/decide",
        buildJsonObject { put("decision", decision) },
    )
    suspend fun reviewMessage(messageId: String, feedback: String = ""): JsonElement = postJson(
        "/messages/${encode(messageId)}/review",
        buildJsonObject { put("feedback", feedback) },
    )
    suspend fun improveMessage(messageId: String, force: Boolean = false, reset: Boolean = false): JsonElement = postJson(
        "/messages/${encode(messageId)}/improve",
        buildJsonObject { put("force", force); put("reset", reset) },
    )
    private suspend fun putJson(path: String, body: JsonObject): JsonElement =
        json.parseToJsonElement(request(path, "PUT", body.toString()))

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

class SnapshotCache(private val context: Context) {
    private val file = File(context.filesDir, "cache.json")
    fun read(): CacheEnvelope? = try {
        if (!file.exists()) null else json.decodeFromString<CacheEnvelope>(file.readText()).let {
            if (it.version == 1) it else null.also { file.delete() }
        }
    } catch (_: Exception) { file.delete(); null }
    fun write(value: CacheEnvelope) {
        val temporary = File(context.filesDir, "cache.json.tmp")
        temporary.writeText(json.encodeToString(value))
        if (!temporary.renameTo(file)) {
            file.delete()
            check(temporary.renameTo(file)) { "无法保存离线缓存" }
        }
    }
    fun clear() { file.delete() }
}
