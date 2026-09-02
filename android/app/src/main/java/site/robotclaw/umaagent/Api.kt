package site.robotclaw.umaagent

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.ByteArrayOutputStream
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Credentials
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.MultipartBody
import okio.BufferedSink
import okhttp3.WebSocket
import okhttp3.WebSocketListener

@Serializable
data class Session(
    val id: String,
    val title: String,
    val workspace: String = "",
    val assistantName: String = "UmaAgent",
    val assistantAvatarAttachmentId: String? = null,
    val queueMode: String = "queue",
)

@Serializable
data class BootstrapEntry(val session: Session, val lastSequence: Long = 0)

@Serializable
data class BootstrapUser(val id: String, val role: String = "user")

@Serializable
data class Bootstrap(val user: BootstrapUser? = null, val sessions: List<BootstrapEntry> = emptyList())

@Serializable
data class Unlock(val grant: String, val expiresAt: Long)

@Serializable
data class Registration(val userId: String, val token: String, val tokenId: String)

class UmaApiException(val status: Int, message: String) : Exception(message)
class UmaWebSocketException(val code: Int, val reason: String) : Exception("WebSocket closed: $code ($reason)")

private val json = Json { ignoreUnknownKeys = true; isLenient = true }

private data class UploadMetadata(val name: String, val size: Long?)

private fun uploadMetadata(context: Context, uri: Uri, fallbackName: String): UploadMetadata {
    val columns = arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
    var displayName: String? = null
    var size: Long? = null
    runCatching { context.contentResolver.query(uri, columns, null, null, null) }.getOrNull()?.use { cursor ->
        if (cursor.moveToFirst()) {
            val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (nameColumn >= 0 && !cursor.isNull(nameColumn)) displayName = cursor.getString(nameColumn)
            val sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE)
            if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) {
                size = cursor.getLong(sizeColumn).takeIf { it >= 0 }
            }
        }
    }
    return UploadMetadata(displayName?.trim()?.takeIf { it.isNotEmpty() } ?: fallbackName, size)
}

internal fun buildUploadMultipart(
    name: String,
    sessionId: String,
    body: RequestBody,
    purpose: String? = null,
): MultipartBody = MultipartBody.Builder().setType(MultipartBody.FORM)
    .addFormDataPart("file", name, body)
    .addFormDataPart("sessionId", sessionId)
    .apply { purpose?.let { addFormDataPart("purpose", it) } }
    .build()

private fun errorMessage(payload: String, status: Int, operation: String): String = runCatching {
    val error = json.parseToJsonElement(payload).jsonObject["error"] as? JsonObject
    (error?.get("message") as? JsonPrimitive)?.content
}.getOrNull()?.takeIf { it.isNotBlank() } ?: "$operation（HTTP $status）"

class UmaApi(
    private val token: String = "",
    private val baseUrl: String = BuildConfig.UMA_BASE_URL,
    private val gatewayPassword: String? = null,
    private val http: OkHttpClient = OkHttpClient(),
) {

    private val gatewayAuthorization = gatewayPassword?.takeIf { it.isNotBlank() }
        ?.let { Credentials.basic("staging", it) }

    private fun Request.Builder.withAuthentication(): Request.Builder {
        gatewayAuthorization?.let { header("Authorization", it) }
        if (token.isNotBlank()) {
            val name = if (gatewayAuthorization == null) "Authorization" else "X-Uma-Authorization"
            header(name, "Bearer $token")
        }
        return this
    }

    private suspend fun request(path: String, method: String = "GET", body: String? = null, grant: String? = null): String =
        withContext(Dispatchers.IO) {
            val builder = Request.Builder().url("$baseUrl/api/v15$path").withAuthentication()
            if (grant != null) builder.addHeader("X-Xianyu-Grant", grant)
            if (body != null) builder.method(method, body.toRequestBody("application/json".toMediaType()))
            else if (method == "POST" || method == "PUT" || method == "PATCH") {
                // OkHttp requires a body for POST/PUT/PATCH even when the API has no fields.
                builder.method(method, ByteArray(0).toRequestBody("application/json".toMediaType()))
            } else if (method == "DELETE") {
                builder.delete()
            }
            http.newCall(builder.build()).execute().use { response ->
                val payload = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    throw UmaApiException(response.code, errorMessage(payload, response.code, "请求失败"))
                }
                payload.ifBlank { "{}" }
            }
        }

    suspend fun getJson(path: String): JsonElement = json.parseToJsonElement(request(path))
    suspend fun postJson(path: String, body: JsonObject = buildJsonObject {}): JsonElement =
        json.parseToJsonElement(request(path, "POST", body.toString()))
    suspend fun patchJson(path: String, body: JsonObject): JsonElement =
        json.parseToJsonElement(request(path, "PATCH", body.toString()))
    suspend fun delete(path: String) { request(path, "DELETE") }

    suspend fun upload(
        context: Context,
        uri: Uri,
        name: String,
        sessionId: String,
        purpose: String? = null,
    ): JsonObject =
        withContext(Dispatchers.IO) {
            val resolver = context.contentResolver
            val metadata = uploadMetadata(context, uri, name)
            val body = object : RequestBody() {
                override fun contentType() = resolver.getType(uri)?.toMediaTypeOrNull()
                override fun contentLength() = metadata.size ?: -1L
                override fun writeTo(sink: BufferedSink) {
                    resolver.openInputStream(uri)?.use { input -> input.copyTo(sink.outputStream()) }
                        ?: error("无法读取附件")
                }
            }
            val multipart = buildUploadMultipart(metadata.name, sessionId, body, purpose)
            val request = Request.Builder().url("$baseUrl/api/v15/uploads")
                .withAuthentication()
                .post(multipart).build()
            http.newCall(request).execute().use { response ->
                val payload = response.body?.string().orEmpty()
                if (!response.isSuccessful) throw UmaApiException(response.code, errorMessage(payload, response.code, "附件上传失败"))
                json.parseToJsonElement(payload.ifBlank { "{}" }).jsonObject
            }
        }

    suspend fun downloadAttachment(context: Context, id: String, destination: Uri): Long = withContext(Dispatchers.IO) {
        val request = Request.Builder().url("$baseUrl/api/v15/attachments/${encode(id)}/content?download=1")
            .withAuthentication().build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                val payload = response.body?.string().orEmpty()
                throw UmaApiException(response.code, errorMessage(payload, response.code, "附件下载失败"))
            }
            val input = response.body?.byteStream() ?: error("附件为空")
            val output = context.contentResolver.openOutputStream(destination) ?: error("无法写入附件")
            var total = 0L
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            input.use { source -> output.use { target ->
                while (true) {
                    val read = source.read(buffer)
                    if (read < 0) break
                    target.write(buffer, 0, read)
                    total += read
                }
            } }
            total
        }
    }

    suspend fun attachmentBytes(
        id: String,
        maxBytes: Int = 2 * 1024 * 1024,
        description: String = "头像",
    ): ByteArray = withContext(Dispatchers.IO) {
        require(maxBytes > 0) { "${description}大小限制必须为正数" }
        val request = Request.Builder().url(baseUrl + "/api/v15/attachments/" + encode(id) + "/content")
            .withAuthentication().build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw UmaApiException(response.code, "${description}读取失败（HTTP " + response.code + "）")
            val body = response.body ?: error("${description}为空")
            if (body.contentLength() > maxBytes) error("${description}超过大小限制")
            val output = ByteArrayOutputStream(minOf(maxBytes, DEFAULT_BUFFER_SIZE))
            body.byteStream().use { input ->
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                var total = 0
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (total > maxBytes - count) error("${description}超过大小限制")
                    output.write(buffer, 0, count)
                    total += count
                }
            }
            output.toByteArray()
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
    suspend fun send(
        sessionId: String,
        text: String,
        attachmentIds: List<String> = emptyList(),
        mode: String = "agent",
    ): JsonObject = json.parseToJsonElement(
        request("/sessions/${encode(sessionId)}/messages", "POST", buildJsonObject {
            require(mode == "agent" || mode == "plan") { "Unsupported interaction mode" }
            put("messageId", java.util.UUID.randomUUID().toString()); put("text", text); put("mode", mode)
            if (attachmentIds.isNotEmpty()) put("attachmentIds", kotlinx.serialization.json.buildJsonArray {
                attachmentIds.forEach { add(JsonPrimitive(it)) }
            })
        }.toString()),
    ).jsonObject
    suspend fun createSession(title: String): Session = json.decodeFromString(
        request("/sessions", "POST", buildJsonObject { put("title", title) }.toString()),
    )
    suspend fun renameSession(sessionId: String, title: String): Session = json.decodeFromString(
        request("/sessions/${encode(sessionId)}", "PATCH", buildJsonObject { put("title", title) }.toString()),
    )
    suspend fun updateQueueMode(sessionId: String, queueMode: String): Session = json.decodeFromString(
        request("/sessions/${encode(sessionId)}", "PATCH", buildJsonObject { put("queueMode", queueMode) }.toString()),
    )
    suspend fun updateAssistantIdentity(sessionId: String, name: String? = null, avatarAttachmentId: String? = null, clearAvatar: Boolean = false): Session =
        json.decodeFromString(
            request("/sessions/" + encode(sessionId), "PATCH", buildJsonObject {
                name?.let { put("assistantName", it) }
                if (clearAvatar) put("assistantAvatarAttachmentId", kotlinx.serialization.json.JsonNull)
                else avatarAttachmentId?.let { put("assistantAvatarAttachmentId", it) }
            }.toString()),
        )
    suspend fun deleteSession(sessionId: String) { request("/sessions/" + encode(sessionId), "DELETE") }
    suspend fun cancelSession(sessionId: String) { request("/sessions/${encode(sessionId)}/cancel", "POST") }
    suspend fun resolveApproval(id: String, approved: Boolean): JsonObject = json.parseToJsonElement(
        request("/approvals/${encode(id)}", "POST", buildJsonObject { put("approved", approved) }.toString()),
    ).jsonObject
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
    suspend fun xianyuPublish(
        grant: String,
        description: String,
        imagePaths: List<String>,
        delivery: String,
        longitude: String,
        latitude: String,
        currentPrice: String? = null,
        originalPrice: String? = null,
        shippingFee: String? = null,
        selfPickup: Boolean? = null,
    ): JsonElement = json.parseToJsonElement(
        request("/xianyu/publish", "POST", buildJsonObject {
            put("description", description)
            put("imagePaths", kotlinx.serialization.json.buildJsonArray { imagePaths.forEach { add(JsonPrimitive(it)) } })
            put("delivery", delivery)
            put("longitude", longitude)
            put("latitude", latitude)
            currentPrice?.let { put("currentPrice", it) }
            originalPrice?.let { put("originalPrice", it) }
            shippingFee?.let { put("shippingFee", it) }
            selfPickup?.let { put("selfPickup", it) }
        }.toString(), grant),
    )

    suspend fun authMe(): JsonObject = getJson("/auth/me").jsonObject
    suspend fun register(label: String = "android"): Registration = json.decodeFromString(
        request("/auth/register", "POST", buildJsonObject { put("label", label) }.toString()),
    )
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
    suspend fun createSchedule(
        name: String,
        prompt: String,
        kind: String,
        value: String,
        timezone: String = "Asia/Shanghai",
    ): JsonElement = postJson("/schedules", buildJsonObject {
        put("name", name)
        put("prompt", prompt)
        put("messageMode", "agent")
        put("schedule", buildJsonObject {
            put("kind", kind)
            when (kind) {
                "once" -> put("at", Instant.parse(value).toEpochMilli())
                "interval" -> put("everyMs", value.toLongOrNull() ?: error("间隔必须是毫秒数"))
                "cron" -> {
                    put("expression", value)
                    put("timezone", timezone)
                }
                else -> error("Unsupported schedule kind")
            }
        })
    })
    suspend fun updateSchedule(id: String, enabled: Boolean): JsonElement = patchJson(
        "/schedules/${encode(id)}", buildJsonObject { put("enabled", enabled) },
    )
    suspend fun deleteSchedule(id: String) { delete("/schedules/${encode(id)}") }
    suspend fun runSchedule(id: String): JsonElement = postJson("/schedules/${encode(id)}/run")
    suspend fun scheduleRuns(id: String): JsonElement = getJson("/schedules/${encode(id)}/runs")
    suspend fun cancelScheduleRun(id: String): JsonElement = postJson("/schedule-runs/${encode(id)}/cancel")
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
    suspend fun editMessage(messageId: String, text: String): JsonElement = patchJson(
        "/messages/${encode(messageId)}", buildJsonObject { put("text", text) },
    )
    suspend fun queue(sessionId: String): JsonElement = getJson("/sessions/${encode(sessionId)}/queue")
    suspend fun reorderQueue(sessionId: String, runIds: List<String>): JsonElement = postJson(
        "/sessions/${encode(sessionId)}/queue/reorder",
        kotlinx.serialization.json.buildJsonObject { put("runIds", kotlinx.serialization.json.buildJsonArray { runIds.forEach { add(JsonPrimitive(it)) } }) },
    )
    suspend fun prioritizeRun(runId: String): JsonElement = postJson("/runs/${encode(runId)}/prioritize")
    private suspend fun putJson(path: String, body: JsonObject): JsonElement =
        json.parseToJsonElement(request(path, "PUT", body.toString()))

    fun connectEvents(onOpen: (WebSocket) -> Unit, onText: (String) -> Unit, onFailure: (Throwable) -> Unit): WebSocket {
        val url = baseUrl.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") + "/api/v15/events"
        return http.newWebSocket(Request.Builder().url(url).withAuthentication().build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = onOpen(webSocket)
            override fun onMessage(webSocket: WebSocket, text: String) = onText(text)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = onFailure(t)
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) =
                onFailure(UmaWebSocketException(code, reason))
        })
    }

    private fun encode(value: String) = java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")
}
