package site.robotclaw.umaagent

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

data class UiMessage(
    val id: String,
    val role: String,
    val status: String,
    val content: String,
    val attachmentCount: Int,
)

data class PendingAttachment(
    val id: String,
    val name: String,
    val size: Long,
)

private val uiJson = Json { ignoreUnknownKeys = true; isLenient = true }

fun parseSnapshotMessages(snapshot: String): List<UiMessage> {
    if (snapshot.isBlank()) return emptyList()
    return runCatching {
        val transcript = (uiJson.parseToJsonElement(snapshot) as JsonObject)["transcript"] as? JsonArray
            ?: return@runCatching emptyList()
        transcript.mapNotNull { item ->
            val value = item as? JsonObject ?: return@mapNotNull null
            UiMessage(
                id = value["id"]?.jsonPrimitive?.content ?: return@mapNotNull null,
                role = value["role"]?.jsonPrimitive?.content ?: "assistant",
                status = value["status"]?.jsonPrimitive?.content ?: "complete",
                content = value["content"]?.jsonPrimitive?.content.orEmpty(),
                attachmentCount = (value["attachments"] as? JsonArray)?.size ?: 0,
            )
        }
    }.getOrDefault(emptyList())
}
