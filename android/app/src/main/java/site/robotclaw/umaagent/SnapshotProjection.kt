package site.robotclaw.umaagent

import kotlinx.serialization.json.*

/** 4ms 合并窗口为重组、WebView 栅格化与宿主帧提交留出预算；UI 自身仍按帧合并。 */
internal const val STREAM_PUBLISH_INTERVAL_MS = 4L

/** 永久事件更新游标，临时增量只改变正文。纯函数可在 JVM 覆盖重放、去重和终态覆盖。 */
internal fun projectSnapshot(snapshot: JsonObject, event: JsonObject): JsonObject {
    val kind = event["type"]?.jsonPrimitive?.contentOrNull ?: return snapshot
    val sequence = event["sequence"]?.jsonPrimitive?.longOrNull ?: 0
    val currentSequence = snapshot["snapshotSequence"]?.jsonPrimitive?.longOrNull ?: 0
    if (sequence > 0 && sequence <= currentSequence) return snapshot
    val next = snapshot.toMutableMap()
    if (sequence > 0) next["snapshotSequence"] = JsonPrimitive(sequence)
    val payload = event["payload"] as? JsonObject ?: JsonObject(emptyMap())
    fun list(key: String) = (next[key] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
    fun merge(key: String, value: JsonObject) {
        val id = value["id"] ?: return
        val previous = list(key)
        next[key] =
            JsonArray(
                if (previous.any { it["id"] == id })
                    previous.map { if (it["id"] == id) JsonObject(it + value) else it }
                else previous + value
            )
    }
    when (kind) {
        "session.snapshot" ->
            return JsonObject(payload + ("snapshotSequence" to JsonPrimitive(sequence)))
        "message.delta" -> {
            val id = payload["messageId"]
            val append = payload["append"]?.jsonPrimitive?.contentOrNull ?: return snapshot
            val offset = payload["offset"]?.jsonPrimitive?.intOrNull ?: return snapshot
            next["transcript"] =
                JsonArray(
                    list("transcript").map {
                        val content = it["content"]?.jsonPrimitive?.contentOrNull.orEmpty()
                        if (
                            it["id"] == id &&
                                it["status"]?.jsonPrimitive?.contentOrNull == "streaming" &&
                                offset in 0..content.length
                        )
                            JsonObject(
                                it +
                                    ("content" to
                                        JsonPrimitive(
                                            content + append.drop(content.length - offset)
                                        ))
                            )
                        else it
                    }
                )
        }
        "message.started",
        "message.completed" -> {
            if (payload["id"] != null) merge("transcript", payload)
            else
                next["transcript"] =
                    JsonArray(
                        list("transcript").map {
                            if (it["id"] == payload["messageId"])
                                JsonObject(
                                    it +
                                        payload.filterKeys { key ->
                                            key in setOf("status", "updatedAt")
                                        }
                                )
                            else it
                        }
                    )
        }
        "tool.started",
        "tool.completed" -> (payload["item"] as? JsonObject)?.let { merge("transcript", it) }
        "run.updated",
        "run.resumed" -> merge("recentRuns", payload)
        "run.awaiting_input" -> (payload["run"] as? JsonObject)?.let { merge("recentRuns", it) }
        "response.started",
        "response.updated",
        "response.completed" -> merge("responses", payload)
        "response.activity",
        "response.attachment.updated" -> {
            val field = if (kind == "response.activity") "activities" else "attachments"
            val item =
                payload[if (kind == "response.activity") "activity" else "attachment"]
                    as? JsonObject
            if (item != null)
                next["responses"] =
                    JsonArray(
                        list("responses").map { response ->
                            if (response["id"] != payload["responseId"]) response
                            else {
                                val previous = (response[field] as? JsonArray).orEmpty()
                                JsonObject(
                                    response +
                                        (field to
                                            JsonArray(
                                                previous.filter {
                                                    (it as? JsonObject)?.get("id") != item["id"]
                                                } + item
                                            ))
                                )
                            }
                        }
                    )
        }
        "plan.updated" ->
            next["recentRuns"] =
                JsonArray(
                    list("recentRuns").map {
                        if (it["id"] == event["runId"])
                            JsonObject(
                                it + ("plan" to (event["payload"] ?: JsonArray(emptyList())))
                            )
                        else it
                    }
                )
        "approval.requested" -> merge("pendingApprovals", payload)
        "approval.resolved" ->
            next["pendingApprovals"] =
                JsonArray(list("pendingApprovals").filter { it["id"] != payload["id"] })
        "queue.updated" ->
            next["queue"] = payload["queue"] ?: event["payload"] ?: JsonArray(emptyList())
    }
    return JsonObject(next)
}
