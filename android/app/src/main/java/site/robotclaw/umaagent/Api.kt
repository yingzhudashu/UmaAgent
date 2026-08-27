package site.robotclaw.umaagent

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

@Serializable data class Session(val id: String, val title: String, val workspace: String = "")
@Serializable data class Unlock(val grant: String, val expiresAt: Long)
class UmaApi(private val token: String, private val baseUrl: String = "https://robotclaw.site") {
    private val http = OkHttpClient(); private val json = Json { ignoreUnknownKeys = true }
    private fun request(path: String, method: String = "GET", body: String? = null, grant: String? = null): String {
        val builder = Request.Builder().url("$baseUrl/api/v14$path").addHeader("Authorization", "Bearer $token")
        if (grant != null) builder.addHeader("X-Xianyu-Grant", grant)
        if (body != null) builder.method(method, body.toRequestBody("application/json".toMediaType()))
        http.newCall(builder.build()).execute().use { response -> if (!response.isSuccessful) error("HTTP ${response.code}"); return response.body?.string() ?: "{}" }
    }
    fun sessions(): List<Session> = json.decodeFromString(request("/sessions"))
    fun unlock(password: String): Unlock = json.decodeFromString(request("/xianyu/unlock", "POST", buildJsonObject { put("password", password) }.toString()))
    fun xianyuStatus(grant: String): String = request("/xianyu/status", grant = grant)
    fun send(sessionId: String, text: String): String = request("/sessions/$sessionId/messages", "POST", buildJsonObject { put("text", text); put("mode", "agent") }.toString())
}
