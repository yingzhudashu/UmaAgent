package site.robotclaw.umaagent

import kotlinx.serialization.json.*

/** 与 60Hz 屏幕帧对齐，避免高频增量驱动 Compose/WebView 超过可见刷新率。 */
internal const val STREAM_PUBLISH_INTERVAL_MS = 16L

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
            return mergeSessionSnapshots(snapshot, JsonObject(payload + ("snapshotSequence" to JsonPrimitive(sequence))))
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

/** 同一会话分支共享一份投影；刷新最新快照不能丢失已经翻出的历史回答。 */
internal fun snapshotHistoryHasMore(snapshot: JsonObject?): Boolean =
    (snapshot?.get("history") as? JsonObject)?.get("hasMoreBefore")?.jsonPrimitive?.booleanOrNull == true

internal fun snapshotHistoryCursor(snapshot: JsonObject?): Long =
    (snapshot?.get("history") as? JsonObject)?.get("oldestMessageSequence")?.jsonPrimitive?.longOrNull ?: 0L

private fun sameProjectionBranch(left: JsonObject, right: JsonObject): Boolean =
    left["id"] == right["id"] && left["activeBranchId"] == right["activeBranchId"] &&
        (left["branchRevision"]?.jsonPrimitive?.longOrNull ?: 0L) ==
        (right["branchRevision"]?.jsonPrimitive?.longOrNull ?: 0L)

private fun mergeProjectionList(previous: JsonElement?, incoming: JsonElement?, order: String): JsonArray {
    val values = linkedMapOf<String, JsonObject>()
    for (item in (previous as? JsonArray).orEmpty() + (incoming as? JsonArray).orEmpty()) {
        val value = item as? JsonObject ?: continue
        val id = value["id"]?.jsonPrimitive?.contentOrNull ?: continue
        val old = values[id]
        if (old == null || (value["updatedAt"]?.jsonPrimitive?.longOrNull ?: 0L) >=
            (old["updatedAt"]?.jsonPrimitive?.longOrNull ?: 0L)) values[id] = value
    }
    return JsonArray(values.values.sortedBy { it[order]?.jsonPrimitive?.longOrNull ?: 0L })
}

internal fun mergeSessionSnapshots(previous: JsonObject?, incoming: JsonObject): JsonObject {
    val oldSession = previous?.get("session") as? JsonObject ?: return incoming
    val session = incoming["session"] as? JsonObject ?: return incoming
    // 同一会话的迟到 HTTP 快照不能回退已经应用的实时事件序号。
    if (oldSession["id"] == session["id"] &&
        (incoming["snapshotSequence"]?.jsonPrimitive?.longOrNull ?: 0L) <
        (previous["snapshotSequence"]?.jsonPrimitive?.longOrNull ?: 0L)) return previous
    if (!sameProjectionBranch(oldSession, session)) return incoming
    val oldCursor = snapshotHistoryCursor(previous)
    val cursor = snapshotHistoryCursor(incoming)
    return JsonObject(incoming + mapOf(
        "transcript" to mergeProjectionList(previous["transcript"], incoming["transcript"], "sequence"),
        "responses" to mergeProjectionList(previous["responses"], incoming["responses"], "createdAt"),
        "recentRuns" to mergeProjectionList(previous["recentRuns"], incoming["recentRuns"], "createdAt"),
    ) + if (oldCursor > 0 && oldCursor <= cursor) mapOf("history" to previous.getValue("history")) else emptyMap())
}

/** 请求中的分支和页游标必须仍有效；迟到回执不能混入切换后的会话或覆盖新正文。 */
internal fun mergeSnapshotHistoryPage(snapshot: JsonObject, page: JsonObject): JsonObject {
    val session = snapshot["session"] as? JsonObject ?: return snapshot
    if (session["id"] != page["sessionId"] ||
        session["activeBranchId"] != page["activeBranchId"] ||
        (session["branchRevision"]?.jsonPrimitive?.longOrNull ?: 0L) !=
        (page["branchRevision"]?.jsonPrimitive?.longOrNull ?: 0L)) return snapshot
    return JsonObject(snapshot + mapOf(
        "transcript" to mergeProjectionList(page["items"], snapshot["transcript"], "sequence"),
        "responses" to mergeProjectionList(page["responses"], snapshot["responses"], "createdAt"),
        "recentRuns" to mergeProjectionList(page["runs"], snapshot["recentRuns"], "createdAt"),
        "history" to buildJsonObject {
            put("oldestMessageSequence", page["oldestSequence"] ?: JsonPrimitive(0))
            put("hasMoreBefore", page["hasMore"] ?: JsonPrimitive(false))
        },
    ))
}
