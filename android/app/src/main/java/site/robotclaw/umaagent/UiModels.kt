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
)

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
        val messages = transcript.mapNotNull { item ->
            val value = item as? JsonObject ?: return@mapNotNull null
            SnapshotMessage(
                message = UiMessage(
                    id = value["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                    role = value["role"]?.jsonPrimitive?.contentOrNull ?: "assistant",
                    status = value["status"]?.jsonPrimitive?.contentOrNull ?: "complete",
                    content = value["content"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    attachments = parseAttachments(value),
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
