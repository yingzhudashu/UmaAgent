package site.robotclaw.umaagent

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

data class UiAttachment(
    val id: String,
    val name: String,
    val mimeType: String,
    val size: Long,
)

data class UiMessage(
    val id: String,
    val role: String,
    val status: String,
    val content: String,
    val attachments: List<UiAttachment>,
    val runId: String? = null,
    val name: String? = null,
    val sequence: Long = 0L,
    val createdAt: Long = 0L,
    val interactionMode: String? = null,
)

data class UiActivity(
    val kind: String,
    val status: String?,
    val text: String?,
    val toolName: String?,
)

data class UiResponse(
    val id: String,
    val runId: String,
    val messageId: String,
    val status: String,
    val content: String,
    val activities: List<UiActivity>,
    val attachments: List<UiAttachment>,
    val createdAt: Long,
    val updatedAt: Long,
)

data class UiPlanStep(
    val id: String,
    val position: Int,
    val title: String,
    val status: String,
    val error: String?,
)

data class UiRun(
    val id: String,
    val status: String,
    val interactionMode: String,
    val plan: List<UiPlanStep>,
    val error: String?,
)

data class UiXianyuLogin(
    val status: String,
    val message: String? = null,
    val qrDataUrl: String? = null,
    val expiresAt: Long? = null,
)

sealed interface UiConversationEntry {
    val id: String
    val sortOrder: Double

    data class MessageEntry(
        val item: UiMessage,
    ) : UiConversationEntry {
        override val id: String = item.id
        override val sortOrder: Double = item.sequence.toDouble()
    }

    data class ResponseEntry(
        val response: UiResponse,
        val items: List<UiMessage>,
        val run: UiRun?,
        val isCurrentSegment: Boolean,
        override val sortOrder: Double,
        override val id: String,
    ) : UiConversationEntry
}

data class UiApproval(
    val id: String,
    val toolName: String,
    val input: String,
)

data class PendingAttachment(
    val id: String,
    val name: String,
    val size: Long,
)

data class UiBackgroundTask(
    val id: String,
    val sessionId: String,
    val runId: String?,
    val prompt: String,
    val status: String,
    val result: String?,
    val error: String?,
)

data class UiScheduledTask(
    val id: String,
    val name: String,
    val prompt: String,
    val scheduleKind: String,
    val scheduleValue: String,
    val timezone: String?,
    val enabled: Boolean,
    val nextRunAt: Long?,
    val lastRunAt: Long?,
)

data class UiScheduledRun(
    val id: String,
    val status: String,
    val trigger: String,
    val scheduledFor: Long,
    val error: String?,
)

data class UiQueueItem(
    val runId: String,
    val messageId: String,
    val position: Int,
    val content: String,
    val status: String,
    val interactionMode: String,
)

private val userResourceActions = listOf(
    "/models" to "模型",
    "/profile" to "Profile",
    "/tasks" to "任务",
    "/schedules" to "计划",
    "/memory" to "Memory",
    "/knowledge" to "知识库",
)

private val adminResourceActions = listOf(
    "/skills" to "Skills",
    "/mcp" to "MCP",
    "/reports/diagnostics" to "诊断",
    "/evaluations" to "评测",
)

internal fun resourceActionsForRole(role: String): List<Pair<String, String>> =
    if (role == "admin") userResourceActions + adminResourceActions else userResourceActions

private val uiJson = Json { ignoreUnknownKeys = true; isLenient = true }

fun parseXianyuLogin(payload: String): UiXianyuLogin? {
    if (payload.isBlank()) return null
    return runCatching {
        val value = uiJson.parseToJsonElement(payload) as? JsonObject ?: return@runCatching null
        val login = value["login"] as? JsonObject ?: value
        UiXianyuLogin(
            status = login["status"]?.jsonPrimitive?.contentOrNull ?: "unknown",
            message = login["message"]?.jsonPrimitive?.contentOrNull,
            qrDataUrl = login["qrDataUrl"]?.jsonPrimitive?.contentOrNull,
            expiresAt = login["expiresAt"]?.jsonPrimitive?.longOrNull,
        )
    }.getOrNull()
}

internal fun xianyuLoginStatusLabel(status: String): String = when (status) {
    "pending_login" -> "待扫码"
    "waiting_scan" -> "等待扫码"
    "scanned" -> "已扫码，等待确认"
    "confirmed" -> "已确认，正在登录"
    "authenticated" -> "已登录"
    "expired" -> "二维码已过期"
    "failed" -> "登录失败"
    else -> status
}

private data class SnapshotMessage(val message: UiMessage, val runId: String?)

private data class ResponseAttachments(
    val runId: String?,
    val messageId: String?,
    val attachments: List<UiAttachment>,
)

private fun parseAttachments(value: JsonObject): List<UiAttachment> =
    (value["attachments"] as? JsonArray)?.mapNotNull { attachment ->
        val metadata = attachment as? JsonObject ?: return@mapNotNull null
        val id = metadata["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
        UiAttachment(
            id = id,
            name = metadata["name"]?.jsonPrimitive?.contentOrNull ?: "附件",
            mimeType = metadata["mimeType"]?.jsonPrimitive?.contentOrNull
                ?: "application/octet-stream",
            size = metadata["size"]?.jsonPrimitive?.longOrNull?.coerceAtLeast(0) ?: 0L,
        )
    }.orEmpty()

fun parseBackgroundTasks(payload: String): List<UiBackgroundTask> {
    if (payload.isBlank()) return emptyList()
    return runCatching {
        val root = uiJson.parseToJsonElement(payload)
        val tasks = when (root) {
            is JsonArray -> root
            is JsonObject -> root["tasks"] as? JsonArray ?: return@runCatching emptyList()
            else -> return@runCatching emptyList()
        }
        tasks.mapNotNull { item ->
            val value = item as? JsonObject ?: return@mapNotNull null
            val id = value["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val sessionId = value["sessionId"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val prompt = value["prompt"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            UiBackgroundTask(
                id = id,
                sessionId = sessionId,
                runId = value["runId"]?.jsonPrimitive?.contentOrNull,
                prompt = prompt,
                status = value["status"]?.jsonPrimitive?.contentOrNull ?: "pending",
                result = value["result"]?.jsonPrimitive?.contentOrNull,
                error = value["error"]?.jsonPrimitive?.contentOrNull,
            )
        }
    }.getOrDefault(emptyList())
}

internal fun isActiveBackgroundTask(task: UiBackgroundTask): Boolean =
    task.status == "pending" || task.status == "running"

internal fun backgroundTaskStatusLabel(status: String): String = when (status) {
    "pending" -> "等待中"
    "running" -> "运行中"
    "completed" -> "已完成"
    "failed" -> "失败"
    "cancelled" -> "已取消"
    "interrupted" -> "已中断"
    else -> status
}

fun parseScheduledTasks(payload: String): List<UiScheduledTask> {
    if (payload.isBlank()) return emptyList()
    return runCatching {
        val root = uiJson.parseToJsonElement(payload)
        val schedules = when (root) {
            is JsonArray -> root
            is JsonObject -> root["schedules"] as? JsonArray ?: return@runCatching emptyList()
            else -> return@runCatching emptyList()
        }
        schedules.mapNotNull { item ->
            val value = item as? JsonObject ?: return@mapNotNull null
            val schedule = value["schedule"] as? JsonObject ?: return@mapNotNull null
            val id = value["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val name = value["name"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val prompt = value["prompt"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val kind = schedule["kind"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val scheduleValue = when (kind) {
                "once" -> schedule["at"]?.jsonPrimitive?.longOrNull?.toString()
                "interval" -> schedule["everyMs"]?.jsonPrimitive?.longOrNull?.toString()
                "cron" -> schedule["expression"]?.jsonPrimitive?.contentOrNull
                else -> null
            } ?: return@mapNotNull null
            UiScheduledTask(
                id = id,
                name = name,
                prompt = prompt,
                scheduleKind = kind,
                scheduleValue = scheduleValue,
                timezone = schedule["timezone"]?.jsonPrimitive?.contentOrNull,
                enabled = value["enabled"]?.jsonPrimitive?.booleanOrNull ?: false,
                nextRunAt = value["nextRunAt"]?.jsonPrimitive?.longOrNull,
                lastRunAt = value["lastRunAt"]?.jsonPrimitive?.longOrNull,
            )
        }
    }.getOrDefault(emptyList())
}

fun parseScheduledRuns(payload: String): List<UiScheduledRun> {
    if (payload.isBlank()) return emptyList()
    return runCatching {
        val root = uiJson.parseToJsonElement(payload)
        val runs = when (root) {
            is JsonArray -> root
            is JsonObject -> root["runs"] as? JsonArray ?: return@runCatching emptyList()
            else -> return@runCatching emptyList()
        }
        runs.mapNotNull { item ->
            val value = item as? JsonObject ?: return@mapNotNull null
            UiScheduledRun(
                id = value["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                status = value["status"]?.jsonPrimitive?.contentOrNull ?: "claimed",
                trigger = value["trigger"]?.jsonPrimitive?.contentOrNull ?: "scheduled",
                scheduledFor = value["scheduledFor"]?.jsonPrimitive?.longOrNull ?: return@mapNotNull null,
                error = value["error"]?.jsonPrimitive?.contentOrNull,
            )
        }
    }.getOrDefault(emptyList())
}

fun parseQueue(payload: String): List<UiQueueItem> {
    if (payload.isBlank()) return emptyList()
    return runCatching {
        val root = uiJson.parseToJsonElement(payload)
        val queue = when (root) {
            is JsonArray -> root
            is JsonObject -> root["queue"] as? JsonArray ?: return@runCatching emptyList()
            else -> return@runCatching emptyList()
        }
        queue.mapNotNull { item ->
            val value = item as? JsonObject ?: return@mapNotNull null
            val run = value["run"] as? JsonObject ?: return@mapNotNull null
            val message = value["message"] as? JsonObject ?: return@mapNotNull null
            UiQueueItem(
                runId = run["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                messageId = message["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                position = value["position"]?.jsonPrimitive?.intOrNull ?: return@mapNotNull null,
                content = message["content"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                status = run["status"]?.jsonPrimitive?.contentOrNull ?: "queued",
                interactionMode = run["interactionMode"]?.jsonPrimitive?.contentOrNull ?: "agent",
            )
        }.sortedBy { it.position }
    }.getOrDefault(emptyList())
}

internal fun queueStatusLabel(status: String): String = when (status) {
    "queued" -> "等待处理"
    "preflight" -> "准备中"
    "running" -> "执行中"
    "verifying" -> "校验中"
    "awaiting_input" -> "等待输入"
    "awaiting_confirmation" -> "等待确认"
    "completed" -> "已完成"
    "failed" -> "失败"
    "cancelled" -> "已取消"
    "interrupted" -> "已中断"
    else -> status
}

internal fun scheduledKindLabel(kind: String): String = when (kind) {
    "once" -> "一次性"
    "interval" -> "按间隔"
    "cron" -> "Cron"
    else -> kind
}

internal fun scheduledRunStatusLabel(status: String): String = when (status) {
    "claimed" -> "已领取"
    "running" -> "执行中"
    "awaiting_resume" -> "等待恢复"
    "completed" -> "已完成"
    "failed" -> "失败"
    "cancelled" -> "已取消"
    else -> status
}

internal fun isActiveScheduledRun(run: UiScheduledRun): Boolean =
    run.status == "claimed" || run.status == "running" || run.status == "awaiting_resume"

fun parseSnapshotMessages(snapshot: String): List<UiMessage> {
    if (snapshot.isBlank()) return emptyList()
    return runCatching {
        val root = uiJson.parseToJsonElement(snapshot) as? JsonObject ?: return@runCatching emptyList()
        val transcript = root["transcript"] as? JsonArray
            ?: return@runCatching emptyList()
        val messages = transcript.mapIndexedNotNull { index, item ->
            val value = item as? JsonObject ?: return@mapIndexedNotNull null
            SnapshotMessage(
                message = UiMessage(
                    id = value["id"]?.jsonPrimitive?.contentOrNull ?: return@mapIndexedNotNull null,
                    role = value["role"]?.jsonPrimitive?.contentOrNull ?: "assistant",
                    status = value["status"]?.jsonPrimitive?.contentOrNull ?: "complete",
                    content = value["content"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    attachments = parseAttachments(value),
                    runId = value["runId"]?.jsonPrimitive?.contentOrNull,
                    name = value["name"]?.jsonPrimitive?.contentOrNull,
                    sequence = value["sequence"]?.jsonPrimitive?.longOrNull ?: (index + 1).toLong(),
                    createdAt = value["createdAt"]?.jsonPrimitive?.longOrNull ?: 0L,
                ),
                runId = value["runId"]?.jsonPrimitive?.contentOrNull,
            )
        }
        val generatedFiles = (root["responses"] as? JsonArray).orEmpty().mapNotNull { item ->
            val value = item as? JsonObject ?: return@mapNotNull null
            ResponseAttachments(
                runId = value["runId"]?.jsonPrimitive?.contentOrNull,
                messageId = value["messageId"]?.jsonPrimitive?.contentOrNull,
                attachments = parseAttachments(value),
            )
        }.filter { it.attachments.isNotEmpty() }
        val attachmentsByMessageId = mutableMapOf<String, List<UiAttachment>>()
        generatedFiles.forEach { response ->
            val assistantTargetId = response.runId?.let { runId ->
                messages.lastOrNull {
                    it.runId == runId && it.message.role == "assistant"
                }?.message?.id
            }
            val linkedMessageTargetId = response.messageId?.let { messageId ->
                messages.firstOrNull { it.message.id == messageId }?.message?.id
            }
            val runTargetId = response.runId?.let { runId ->
                messages.lastOrNull {
                    it.runId == runId && it.message.role != "tool"
                }?.message?.id
            }
            val targetId = assistantTargetId
                ?: linkedMessageTargetId
                ?: runTargetId
                ?: return@forEach
            attachmentsByMessageId[targetId] =
                (attachmentsByMessageId[targetId].orEmpty() + response.attachments).distinctBy { it.id }
        }
        messages.map { snapshotMessage ->
            val generated = attachmentsByMessageId[snapshotMessage.message.id].orEmpty()
            snapshotMessage.message.copy(
                attachments = (snapshotMessage.message.attachments + generated).distinctBy { it.id },
            )
        }
    }.getOrDefault(emptyList())
}

private fun parseResponse(value: JsonObject): UiResponse? {
    val id = value["id"]?.jsonPrimitive?.contentOrNull ?: return null
    val runId = value["runId"]?.jsonPrimitive?.contentOrNull ?: return null
    val messageId = value["messageId"]?.jsonPrimitive?.contentOrNull ?: return null
    val activities = (value["activities"] as? JsonArray).orEmpty().mapNotNull { item ->
        val activity = item as? JsonObject ?: return@mapNotNull null
        UiActivity(
            kind = activity["kind"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
            status = activity["status"]?.jsonPrimitive?.contentOrNull,
            text = activity["text"]?.jsonPrimitive?.contentOrNull,
            toolName = activity["toolName"]?.jsonPrimitive?.contentOrNull,
        )
    }
    return UiResponse(
        id = id,
        runId = runId,
        messageId = messageId,
        status = value["status"]?.jsonPrimitive?.contentOrNull ?: "completed",
        content = value["content"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        activities = activities,
        attachments = parseAttachments(value),
        createdAt = value["createdAt"]?.jsonPrimitive?.longOrNull ?: 0L,
        updatedAt = value["updatedAt"]?.jsonPrimitive?.longOrNull ?: 0L,
    )
}

private fun parseRun(value: JsonObject): UiRun? {
    val id = value["id"]?.jsonPrimitive?.contentOrNull ?: return null
    val plan = (value["plan"] as? JsonArray).orEmpty().mapNotNull { item ->
        val step = item as? JsonObject ?: return@mapNotNull null
        UiPlanStep(
            id = step["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
            position = step["position"]?.jsonPrimitive?.intOrNull ?: return@mapNotNull null,
            title = step["title"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
            status = step["status"]?.jsonPrimitive?.contentOrNull ?: "pending",
            error = step["error"]?.jsonPrimitive?.contentOrNull,
        )
    }.sortedBy { it.position }
    return UiRun(
        id = id,
        status = value["status"]?.jsonPrimitive?.contentOrNull ?: "completed",
        interactionMode = value["interactionMode"]?.jsonPrimitive?.contentOrNull ?: "agent",
        plan = plan,
        error = value["error"]?.jsonPrimitive?.contentOrNull,
    )
}

private fun parseSnapshotResponseData(
    snapshot: String,
): Triple<List<UiResponse>, Map<String, UiRun>, List<UiMessage>>? {
    if (snapshot.isBlank()) return null
    return runCatching {
        val root = uiJson.parseToJsonElement(snapshot) as? JsonObject ?: return@runCatching null
        val responses = (root["responses"] as? JsonArray).orEmpty().mapNotNull { item ->
            parseResponse(item as? JsonObject ?: return@mapNotNull null)
        }.groupBy { it.runId }.values.mapNotNull { it.maxByOrNull { response -> response.updatedAt } }
        val runs = (root["recentRuns"] as? JsonArray).orEmpty().mapNotNull { item ->
            parseRun(item as? JsonObject ?: return@mapNotNull null)
        }.associateBy { it.id }
        Triple(responses, runs, parseSnapshotMessages(snapshot))
    }.getOrNull()
}

fun parseSnapshotConversation(snapshot: String): List<UiConversationEntry> {
    val parsed = parseSnapshotResponseData(snapshot) ?: return emptyList()
    val (responses, runs, parsedMessages) = parsed
    val messages = parsedMessages.map { item ->
        item.copy(interactionMode = item.runId?.let { runs[it]?.interactionMode })
    }
    if (messages.isEmpty()) return emptyList()
    if (responses.isEmpty()) return messages.map { UiConversationEntry.MessageEntry(it) }

    val responsesByRun = responses.associateBy { it.runId }
    val responsesByMessage = responses.associateBy { it.messageId }
    val itemsByRun = messages.filter { !it.runId.isNullOrBlank() }.groupBy { it.runId }
    val renderedSegments = mutableSetOf<String>()
    val entries = mutableListOf<UiConversationEntry>()

    messages.forEach { item ->
        val response = responsesByMessage[item.id] ?: item.runId?.let { responsesByRun[it] }
        if (response == null) {
            entries += UiConversationEntry.MessageEntry(item)
            return@forEach
        }
        if (item.role != "user") return@forEach
        entries += UiConversationEntry.MessageEntry(item)
        val runItems = itemsByRun[response.runId].orEmpty()
        val nextUserSequence = runItems
            .filter { it.role == "user" && it.sequence > item.sequence }
            .minOfOrNull { it.sequence }
        val segment = runItems.filter { candidate ->
            candidate.sequence >= item.sequence &&
                (nextUserSequence == null || candidate.sequence < nextUserSequence)
        }
        val segmentId = "${response.id}:${item.id}"
        if (renderedSegments.add(segmentId)) {
            entries += UiConversationEntry.ResponseEntry(
                response = response,
                items = segment,
                run = runs[response.runId],
                isCurrentSegment = nextUserSequence == null,
                sortOrder = item.sequence + 0.1,
                id = segmentId,
            )
        }
    }

    responses.forEach { response ->
        if (entries.none { it is UiConversationEntry.ResponseEntry && it.response.runId == response.runId }) {
            val items = itemsByRun[response.runId].orEmpty()
            val first = items.firstOrNull()
            entries += UiConversationEntry.ResponseEntry(
                response = response,
                items = items,
                run = runs[response.runId],
                isCurrentSegment = true,
                sortOrder = (first?.sequence?.toDouble() ?: -0.1),
                id = "${response.id}:orphan",
            )
        }
    }
    return entries.sortedBy { it.sortOrder }
}

internal fun responseStatusLabel(status: String): String = when (status) {
    "queued" -> "等待处理"
    "thinking", "planning" -> "正在分析"
    "clarifying" -> "等待回复"
    "awaiting_confirmation" -> "等待确认"
    "executing" -> "正在执行"
    "awaiting_approval" -> "等待审批"
    "verifying" -> "正在验证"
    "completed" -> "已完成"
    "failed" -> "执行失败"
    "cancelled" -> "已取消"
    else -> status
}

internal fun toolStatusLabel(status: String): String = when (status) {
    "streaming" -> "执行中"
    "error" -> "执行失败"
    "cancelled" -> "已取消"
    else -> "已完成"
}

internal fun toolDisplayName(name: String?): String = when (name) {
    "read" -> "读取文件"
    "write" -> "写入文件"
    "edit" -> "编辑文件"
    "shell" -> "执行命令"
    "skill_read" -> "读取技能说明"
    "http_get" -> "获取网页"
    "search" -> "搜索"
    "mcp_browser_open" -> "打开网页"
    "mcp_browser_extract" -> "提取网页"
    "mcp_browser_click" -> "点击网页元素"
    "mcp_browser_fill" -> "填写网页表单"
    "mcp_browser_screenshot" -> "网页截图"
    "mcp_browser_close" -> "关闭网页"
    "image_generate" -> "生成图片"
    null, "" -> "工具操作"
    else -> name
}

internal fun attachmentSizeLabel(size: Long): String {
    val bytes = size.coerceAtLeast(0)
    return if (bytes < 1024) "$bytes B" else "${(bytes + 1023) / 1024} KB"
}

fun pendingPlanRunId(snapshot: String): String? {
    if (snapshot.isBlank()) return null
    return runCatching {
        val responses = (uiJson.parseToJsonElement(snapshot) as? JsonObject)?.get("responses") as? JsonArray
            ?: return@runCatching null
        responses.mapNotNull { item ->
            val value = item as? JsonObject ?: return@mapNotNull null
            val status = value["status"]?.jsonPrimitive?.content
            val runId = value["runId"]?.jsonPrimitive?.content
            if (status == "awaiting_confirmation" && !runId.isNullOrBlank()) runId else null
        }.lastOrNull()
    }.getOrNull()
}

fun pendingApprovals(snapshot: String): List<UiApproval> {
    if (snapshot.isBlank()) return emptyList()
    return runCatching {
        val approvals = (uiJson.parseToJsonElement(snapshot) as? JsonObject)?.get("pendingApprovals") as? JsonArray
            ?: return@runCatching emptyList()
        approvals.mapNotNull { item ->
            val value = item as? JsonObject ?: return@mapNotNull null
            val id = value["id"]?.jsonPrimitive?.content ?: return@mapNotNull null
            val toolName = value["toolName"]?.jsonPrimitive?.content ?: "工具操作"
            val input = value["input"]?.toString().orEmpty()
            UiApproval(id, toolName, input)
        }
    }.getOrDefault(emptyList())
}
