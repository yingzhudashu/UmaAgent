package site.robotclaw.umaagent

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** 会话内容保留消息流、审批、队列和附件操作。 */
@Composable
internal fun ChatScreen(
    state: UmaUiState,
    model: UmaViewModel,
    onOpenSessions: () -> Unit,
    xianyuDraftMessageIds: Set<String> = emptySet(),
    onSendXianyuDraft: ((String) -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    var message by rememberSaveable { mutableStateOf("") }
    var pendingTranscriptDownloadId by rememberSaveable { mutableStateOf("") }
    var editingMessageId by rememberSaveable { mutableStateOf("") }
    var editingMessageDraft by rememberSaveable { mutableStateOf("") }
    val selectedSession = state.sessions.firstOrNull { it.id == state.selectedSessionId }
    val conversation = remember(state.snapshot) { parseSnapshotConversation(state.snapshot) }
    val approvals = remember(state.snapshot) { pendingApprovals(state.snapshot) }
    val listState = rememberLazyListState()
    val attachmentPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) model.uploadAttachment(uri, "attachment")
    }
    val transcriptAttachmentSaver = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("application/octet-stream"),
    ) { uri ->
        val attachmentId = pendingTranscriptDownloadId
        pendingTranscriptDownloadId = ""
        if (uri != null && attachmentId.isNotBlank()) model.downloadAttachment(attachmentId, uri)
    }

    state.attachmentPreview?.let { preview ->
        AttachmentPreviewDialog(preview, model::clearAttachmentPreview)
    }
    if (editingMessageId.isNotBlank()) {
        AlertDialog(
            onDismissRequest = { editingMessageId = ""; editingMessageDraft = "" },
            title = { Text("编辑消息") },
            text = {
                OutlinedTextField(
                    value = editingMessageDraft,
                    onValueChange = { if (it.length <= 1_000_000) editingMessageDraft = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("消息内容") },
                    minLines = 3,
                    maxLines = 8,
                )
            },
            confirmButton = {
                Button(
                    onClick = {
                        model.editMessage(editingMessageId, editingMessageDraft)
                        editingMessageId = ""
                        editingMessageDraft = ""
                    },
                    enabled = editingMessageDraft.isNotBlank() && !state.offline && !state.loading,
                ) { Text("保存并重跑") }
            },
            dismissButton = {
                TextButton({ editingMessageId = ""; editingMessageDraft = "" }) { Text("取消") }
            },
        )
    }

    LaunchedEffect(conversation.size, selectedSession?.id) {
        if (conversation.isNotEmpty()) listState.scrollToItem(conversation.lastIndex)
    }
    LaunchedEffect(selectedSession?.id) { model.loadQueue() }

    Column(modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
        if (selectedSession == null) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("未选择会话", style = MaterialTheme.typography.titleMedium)
                    Button(onOpenSessions) { Text("打开会话") }
                }
            }
            return@Column
        }

        Row(
            Modifier.fillMaxWidth().padding(bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            AssistantAvatar(state.assistantAvatarBytes, 36.dp)
            Column(Modifier.weight(1f)) {
                Text(selectedSession.assistantName, style = MaterialTheme.typography.titleSmall)
                Text(selectedSession.title, style = MaterialTheme.typography.bodySmall, maxLines = 1)
            }
        }
        if (conversation.isEmpty()) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text(if (state.offline) "暂无离线消息" else "暂无消息", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(conversation, key = { it.id }) { entry ->
                    when (entry) {
                        is UiConversationEntry.MessageEntry -> MessageItem(
                            item = entry.item,
                            assistantName = selectedSession.assistantName,
                            avatarBytes = state.assistantAvatarBytes,
                            downloadsEnabled = !state.offline && !state.loading,
                            onEditMessage = { editable ->
                                editingMessageId = editable.id
                                editingMessageDraft = editable.content
                            },
                            onRetryMessage = model::retryMessage,
                            onPreviewImage = model::previewImageAttachment,
                            onDownloadAttachment = { attachment ->
                                pendingTranscriptDownloadId = attachment.id
                                transcriptAttachmentSaver.launch(attachment.name)
                            },
                        )
                        is UiConversationEntry.ResponseEntry -> {
                            ResponseItem(
                                entry = entry,
                                assistantName = selectedSession.assistantName,
                                avatarBytes = state.assistantAvatarBytes,
                                downloadsEnabled = !state.offline && !state.loading,
                                onConfirmPlan = model::confirmPlan,
                                onReviewMessage = model::reviewMessage,
                                onImproveMessage = model::improveMessage,
                                onPreviewImage = model::previewImageAttachment,
                                onDownloadAttachment = { attachment ->
                                    pendingTranscriptDownloadId = attachment.id
                                    transcriptAttachmentSaver.launch(attachment.name)
                                },
                            )
                            val draft = entry.items.asReversed().firstOrNull {
                                it.role == "assistant" && it.status == "complete" && it.id in xianyuDraftMessageIds
                            }
                            val sendDraft = onSendXianyuDraft
                            if (draft != null && sendDraft != null) {
                                XianyuDraftAction(
                                    enabled = !state.offline && !state.loading,
                                    onSend = { sendDraft(draft.id) },
                                )
                            }
                        }
                    }
                }
            }
        }
        if (state.queue.isNotEmpty()) {
            QueuePanel(
                queue = state.queue,
                enabled = !state.offline && !state.loading,
                onReorder = model::reorderQueue,
                onPrioritize = model::prioritizeRun,
                onCancel = model::cancelQueuedRun,
                onEdit = model::editQueuedMessage,
            )
        }
        if (state.pendingAttachments.isNotEmpty()) {
            LazyRow(
                Modifier.fillMaxWidth(),
                contentPadding = PaddingValues(vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(state.pendingAttachments, key = { it.id }) { attachment ->
                    Row(
                        Modifier,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(attachment.name, maxLines = 1)
                        OutlinedButton({ model.removePendingAttachment(attachment.id) }) { Text("移除") }
                    }
                }
            }
        }
        InteractionModeSelector(
            value = state.interactionMode,
            onChange = model::setInteractionMode,
            enabled = !state.offline && !state.loading,
        )
        approvals.forEach { approval ->
            Surface(
                Modifier.fillMaxWidth(),
                color = MaterialTheme.colorScheme.tertiaryContainer,
                shape = MaterialTheme.shapes.small,
            ) {
                Column(
                    Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text("需要批准：${approval.toolName}", style = MaterialTheme.typography.titleSmall)
                    if (approval.input.isNotBlank())
                        Text(approval.input, style = MaterialTheme.typography.bodySmall, maxLines = 5)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            { model.resolveApproval(approval.id, true) },
                            enabled = !state.offline && !state.loading,
                        ) { Text("批准") }
                        OutlinedButton(
                            { model.resolveApproval(approval.id, false) },
                            enabled = !state.offline && !state.loading,
                        ) { Text("拒绝") }
                    }
                }
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(top = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            OutlinedButton(
                { attachmentPicker.launch(arrayOf("*/*")) },
                enabled = !state.offline && !state.loading,
            ) { Text("附件") }
            OutlinedTextField(
                message,
                { message = it },
                Modifier.weight(1f),
                label = { Text("消息") },
                minLines = 1,
                maxLines = 4,
                enabled = !state.offline,
            )
            Button(
                { model.send(message); message = "" },
                enabled = !state.offline && !state.loading &&
                    (message.isNotBlank() || state.pendingAttachmentIds.isNotEmpty()),
            ) { Text("发送") }
        }
    }
}

@Composable
internal fun XianyuDraftAction(enabled: Boolean, onSend: () -> Unit) {
    Surface(
        Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.tertiaryContainer,
        shape = MaterialTheme.shapes.small,
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("草稿待发送", style = MaterialTheme.typography.labelMedium)
            Button(onClick = onSend, enabled = enabled) { Text("发送给买家") }
        }
    }
}

@Composable
internal fun QueuePanel(
    queue: List<UiQueueItem>,
    enabled: Boolean,
    onReorder: (List<String>) -> Unit,
    onPrioritize: (String) -> Unit,
    onCancel: (String) -> Unit,
    onEdit: (UiQueueItem, String) -> Unit,
) {
    var editingRunId by rememberSaveable { mutableStateOf<String?>(null) }
    var draft by rememberSaveable { mutableStateOf("") }
    val editingItem = queue.firstOrNull { it.runId == editingRunId }

    if (editingItem != null) {
        AlertDialog(
            onDismissRequest = { editingRunId = null; draft = "" },
            title = { Text("编辑队列消息") },
            text = {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { if (it.length <= 1_000_000) draft = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("消息内容") },
                    minLines = 3,
                    maxLines = 8,
                )
            },
            confirmButton = {
                Button(
                    onClick = {
                        onEdit(editingItem, draft)
                        editingRunId = null
                        draft = ""
                    },
                    enabled = enabled && draft.isNotBlank(),
                ) { Text("保存") }
            },
            dismissButton = {
                TextButton({ editingRunId = null; draft = "" }) { Text("取消") }
            },
        )
    }

    Surface(
        Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = MaterialTheme.shapes.small,
    ) {
        Column(
            Modifier.fillMaxWidth().padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text("消息队列", style = MaterialTheme.typography.titleSmall)
                Text("${queue.size} 条待处理", style = MaterialTheme.typography.labelMedium)
            }
            queue.forEachIndexed { index, item ->
                Column(
                    Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.Top,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text("${item.position}", style = MaterialTheme.typography.labelLarge)
                        Column(Modifier.weight(1f)) {
                            Text(
                                item.content.ifBlank { "（无文字消息）" },
                                maxLines = 3,
                                style = MaterialTheme.typography.bodySmall,
                            )
                            Text(
                                "${if (item.interactionMode == "plan") "计划" else "Agent"} · ${queueStatusLabel(item.status)}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    Row(
                        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        TextButton(
                            onClick = { editingRunId = item.runId; draft = item.content },
                            enabled = enabled,
                        ) { Text("编辑") }
                        TextButton(
                            onClick = { onPrioritize(item.runId) },
                            enabled = enabled && index > 0,
                        ) { Text("置顶") }
                        TextButton(
                            onClick = {
                                val ids = queue.map { it.runId }.toMutableList()
                                ids[index] = ids[index - 1].also { ids[index - 1] = ids[index] }
                                onReorder(ids)
                            },
                            enabled = enabled && index > 0,
                        ) { Text("上移") }
                        TextButton(
                            onClick = {
                                val ids = queue.map { it.runId }.toMutableList()
                                ids[index] = ids[index + 1].also { ids[index + 1] = ids[index] }
                                onReorder(ids)
                            },
                            enabled = enabled && index < queue.lastIndex,
                        ) { Text("下移") }
                        TextButton(
                            onClick = { onCancel(item.runId) },
                            enabled = enabled,
                        ) { Text("取消") }
                    }
                }
                if (index < queue.lastIndex) HorizontalDivider()
            }
        }
    }
}

@Composable
internal fun InteractionModeSelector(value: String, onChange: (String) -> Unit, enabled: Boolean) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("消息模式", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        listOf("agent" to "Agent", "plan" to "Plan").forEach { (mode, label) ->
            val selected = value == mode
            if (selected) {
                Button({ onChange(mode) }, enabled = enabled) { Text(label) }
            } else {
                OutlinedButton({ onChange(mode) }, enabled = enabled) { Text(label) }
            }
        }
    }
}

@Composable
internal fun MessageItem(
    item: UiMessage,
    assistantName: String,
    avatarBytes: ByteArray?,
    downloadsEnabled: Boolean,
    onEditMessage: (UiMessage) -> Unit,
    onRetryMessage: (UiMessage) -> Unit,
    onPreviewImage: (UiAttachment) -> Unit,
    onDownloadAttachment: (UiAttachment) -> Unit,
) {
    val isUser = item.role == "user"
    val clipboard = LocalClipboardManager.current
    var copied by rememberSaveable(item.id) { mutableStateOf(false) }
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 4.dp),
        horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (!isUser && item.role != "tool") AssistantAvatar(avatarBytes, 28.dp)
            Text(
                when (item.role) {
                    "user" -> "你"
                    "tool" -> "工具"
                    else -> assistantName
                },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (item.role == "tool") {
            CollapsibleToolItem(item)
        } else {
            Surface(
                color = if (isUser) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                shape = MaterialTheme.shapes.medium,
            ) {
                if (isUser) {
                    SelectionContainer {
                        Text(
                            item.content,
                            Modifier.padding(horizontal = 13.dp, vertical = 10.dp),
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                } else {
                    SelectionContainer {
                        RichMessageContent(
                            item.content,
                            Modifier.padding(horizontal = 13.dp, vertical = 10.dp),
                        )
                    }
                }
            }
        }
        AttachmentStrip(item.attachments, downloadsEnabled, onPreviewImage, onDownloadAttachment)
        if (isUser && item.status == "complete") {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(
                    onClick = {
                        clipboard.setText(AnnotatedString(item.content))
                        copied = true
                    },
                    enabled = downloadsEnabled,
                ) { Text(if (copied) "已复制" else "复制") }
                TextButton(onClick = { onRetryMessage(item) }, enabled = downloadsEnabled) { Text("重试") }
                TextButton(onClick = { onEditMessage(item) }, enabled = downloadsEnabled) { Text("编辑") }
            }
        }
        if (item.status == "streaming") Text("生成中", style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
internal fun ResponseItem(
    entry: UiConversationEntry.ResponseEntry,
    assistantName: String,
    avatarBytes: ByteArray?,
    downloadsEnabled: Boolean,
    onConfirmPlan: (String) -> Unit,
    onReviewMessage: (String) -> Unit,
    onImproveMessage: (String) -> Unit,
    onPreviewImage: (UiAttachment) -> Unit,
    onDownloadAttachment: (UiAttachment) -> Unit,
) {
    val clipboard = LocalClipboardManager.current
    var copied by rememberSaveable(entry.id) { mutableStateOf(false) }
    var detailsExpanded by rememberSaveable(entry.id) { mutableStateOf(false) }
    val finalAssistant = entry.items.lastOrNull { it.role == "assistant" }
    val finalContent = finalAssistant?.content?.takeIf { it.isNotBlank() }
        ?: entry.response.content
    val intermediateItems = entry.items.filter { item ->
        item.role != "user" && item.id != finalAssistant?.id
    }
    val attachments = (entry.response.attachments + finalAssistant?.attachments.orEmpty())
        .distinctBy { it.id }
    val plan = entry.run?.plan.orEmpty()
    val detailCount = plan.size + intermediateItems.size + entry.response.activities.size
    val hasDetails = detailCount > 0 || entry.response.activities.isNotEmpty()

    Surface(
        Modifier.fillMaxWidth().padding(horizontal = 4.dp),
        color = MaterialTheme.colorScheme.surface,
        shape = MaterialTheme.shapes.medium,
        tonalElevation = 1.dp,
    ) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                AssistantAvatar(avatarBytes, 30.dp)
                Column(Modifier.weight(1f)) {
                    Text(assistantName, style = MaterialTheme.typography.labelLarge)
                    if (entry.isCurrentSegment) {
                        Text(
                            responseStatusLabel(entry.response.status),
                            style = MaterialTheme.typography.labelSmall,
                            color = if (entry.response.status == "failed") {
                                MaterialTheme.colorScheme.error
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                        )
                    }
                }
                if (entry.run?.interactionMode == "plan") {
                    Text("计划", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                }
                if (entry.isCurrentSegment && entry.response.status == "awaiting_confirmation") {
                    TextButton(
                        onClick = { onConfirmPlan(entry.response.runId) },
                        enabled = downloadsEnabled,
                    ) { Text("确认执行") }
                }
            }

            if (finalContent.isBlank()) {
                Text("正在准备回复…", color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                SelectionContainer {
                    RichMessageContent(finalContent)
                }
            }
            AttachmentStrip(attachments, downloadsEnabled, onPreviewImage, onDownloadAttachment)

            if (hasDetails) {
                TextButton(
                    onClick = { detailsExpanded = !detailsExpanded },
                    modifier = Modifier.fillMaxWidth(),
                    contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp),
                ) {
                    Text(if (detailsExpanded) "收起执行详情" else "查看执行详情 · $detailCount 项")
                    Text(if (detailsExpanded) "⌃" else "⌄", modifier = Modifier.padding(start = 6.dp))
                }
                if (detailsExpanded) {
                    ExecutionDetails(
                        plan = plan,
                        items = intermediateItems,
                        responseActivityCount = entry.response.activities.size,
                    )
                }
            }

            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                TextButton(
                    onClick = {
                        clipboard.setText(AnnotatedString(finalContent))
                        copied = true
                    },
                    enabled = finalContent.isNotBlank(),
                ) { Text(if (copied) "已复制" else "复制") }
                if (finalAssistant != null) {
                    TextButton(
                        onClick = { onReviewMessage(finalAssistant.id) },
                        enabled = downloadsEnabled,
                    ) { Text("审查") }
                    TextButton(
                        onClick = { onImproveMessage(finalAssistant.id) },
                        enabled = downloadsEnabled,
                    ) { Text("改进") }
                }
            }
        }
    }
}

@Composable
internal fun ExecutionDetails(
    plan: List<UiPlanStep>,
    items: List<UiMessage>,
    responseActivityCount: Int,
) {
    Column(
        Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (plan.isNotEmpty()) {
            Text("执行计划 · ${plan.size} 步", style = MaterialTheme.typography.labelLarge)
            plan.forEach { step ->
                Surface(
                    Modifier.fillMaxWidth(),
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    shape = MaterialTheme.shapes.small,
                ) {
                    Column(Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) {
                        Row(
                            Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.Top,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text("${step.position + 1}", style = MaterialTheme.typography.labelLarge)
                            Text(step.title, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                            Text(
                                when (step.status) {
                                    "completed" -> "已完成"
                                    "running" -> "进行中"
                                    "failed" -> "失败"
                                    else -> "待执行"
                                },
                                style = MaterialTheme.typography.labelSmall,
                                color = if (step.status == "failed") MaterialTheme.colorScheme.error
                                else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        step.error?.takeIf { it.isNotBlank() }?.let {
                            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        }
        if (items.isNotEmpty()) {
            Text("过程输出 · ${items.size} 项", style = MaterialTheme.typography.labelLarge)
            items.forEach { item ->
                if (item.role == "tool") {
                    CollapsibleToolItem(item)
                } else {
                    Surface(
                        Modifier.fillMaxWidth(),
                        color = MaterialTheme.colorScheme.surfaceVariant,
                        shape = MaterialTheme.shapes.small,
                    ) {
                        SelectionContainer {
                            RichMessageContent(item.content, Modifier.padding(10.dp), compact = true)
                        }
                    }
                }
            }
        } else if (responseActivityCount > 0) {
            Text(
                "执行活动 · $responseActivityCount 项",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
internal fun CollapsibleToolItem(item: UiMessage) {
    var expanded by rememberSaveable(item.id) { mutableStateOf(false) }
    Surface(
        Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = MaterialTheme.shapes.small,
    ) {
        Column(Modifier.fillMaxWidth()) {
            Row(
                Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(horizontal = 10.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(if (expanded) "⌄" else "›", style = MaterialTheme.typography.titleMedium)
                Text(
                    toolDisplayName(item.name),
                    Modifier.weight(1f),
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    toolStatusLabel(item.status),
                    style = MaterialTheme.typography.labelSmall,
                    color = if (item.status == "error") MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text("${item.content.length} 字", style = MaterialTheme.typography.labelSmall)
            }
            if (expanded && item.content.isNotBlank()) {
                HorizontalDivider()
                SelectionContainer {
                    Text(
                        item.content,
                        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(10.dp),
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
        }
    }
}

private data class ContentBlock(val kind: String, val text: String)

private fun contentBlocks(content: String): List<ContentBlock> {
    val blocks = mutableListOf<ContentBlock>()
    val paragraph = mutableListOf<String>()
    val code = mutableListOf<String>()
    var inCode = false
    fun flushParagraph() {
        if (paragraph.isNotEmpty()) {
            blocks += ContentBlock("paragraph", paragraph.joinToString("\n").trim())
            paragraph.clear()
        }
    }
    fun flushCode() {
        if (code.isNotEmpty()) {
            blocks += ContentBlock("code", code.joinToString("\n"))
            code.clear()
        }
    }
    content.replace("\r\n", "\n").split('\n').forEach { line ->
        val trimmed = line.trim()
        if (trimmed.startsWith("```")) {
            if (inCode) flushCode() else flushParagraph()
            inCode = !inCode
        } else if (inCode) {
            code += line
        } else if (trimmed.isBlank()) {
            flushParagraph()
        } else if (trimmed.startsWith("### ") || trimmed.startsWith("## ") || trimmed.startsWith("# ")) {
            flushParagraph()
            blocks += ContentBlock("heading", trimmed.trimStart('#').trim())
        } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ") || trimmed.startsWith("+ ")) {
            flushParagraph()
            blocks += ContentBlock("bullet", trimmed.drop(2).trim())
        } else if (trimmed.matches(Regex("^\\d+[.)]\\s+.+"))) {
            flushParagraph()
            blocks += ContentBlock("numbered", trimmed)
        } else {
            paragraph += line
        }
    }
    if (inCode) flushCode() else flushParagraph()
    return blocks
}

private fun numberedParts(value: String): Pair<String, String>? {
    val match = Regex("^\\s*(\\d+)[.)]\\s+(.+)$").matchEntire(value) ?: return null
    return match.groupValues[1] to match.groupValues[2]
}

@Composable
internal fun RichMessageContent(content: String, modifier: Modifier = Modifier, compact: Boolean = false) {
    val blocks = remember(content) { contentBlocks(content) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(if (compact) 5.dp else 8.dp)) {
        blocks.forEachIndexed { index, block ->
            when (block.kind) {
                "heading" -> Text(
                    block.text,
                    style = if (compact) MaterialTheme.typography.labelLarge else MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                "bullet" -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("•", fontWeight = FontWeight.Bold)
                    Text(block.text, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                }
                "numbered" -> {
                    val parts = numberedParts(block.text)
                    if (parts == null) {
                        Text(block.text, style = MaterialTheme.typography.bodyMedium)
                    } else {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(parts.first, fontWeight = FontWeight.SemiBold)
                            Text(parts.second, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
                "code" -> Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    shape = MaterialTheme.shapes.small,
                ) {
                    Text(
                        block.text,
                        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(10.dp),
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                    )
                }
                else -> Text(
                    block.text,
                    style = if (compact) MaterialTheme.typography.bodySmall else MaterialTheme.typography.bodyMedium,
                )
            }
        }
        if (blocks.isEmpty() && content.isNotEmpty()) Text(content, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
internal fun AttachmentStrip(
    attachments: List<UiAttachment>,
    enabled: Boolean,
    onPreviewImage: (UiAttachment) -> Unit,
    onDownloadAttachment: (UiAttachment) -> Unit,
) {
    if (attachments.isEmpty()) return
    LazyRow(
        Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(top = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(attachments, key = { it.id }) { attachment ->
            if (attachment.mimeType.startsWith("image/")) {
                Column(horizontalAlignment = Alignment.Start) {
                    OutlinedButton({ onPreviewImage(attachment) }, enabled = enabled) {
                        AttachmentLabel(attachment)
                    }
                    TextButton({ onDownloadAttachment(attachment) }, enabled = enabled) { Text("下载") }
                }
            } else {
                OutlinedButton({ onDownloadAttachment(attachment) }, enabled = enabled) {
                    AttachmentLabel(attachment)
                }
            }
        }
    }
}

@Composable
internal fun AttachmentLabel(attachment: UiAttachment) {
    Column(horizontalAlignment = Alignment.Start) {
        Text(attachment.name, maxLines = 1)
        Text(
            attachmentSizeLabel(attachment.size),
            style = MaterialTheme.typography.labelSmall,
        )
    }
}

@Composable
internal fun AttachmentPreviewDialog(preview: AttachmentPreview, onDismiss: () -> Unit) {
    val bitmap = remember(preview.bytes) { decodePreviewBitmap(preview.bytes) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(preview.name) },
        text = {
            if (bitmap != null) {
                Image(
                    bitmap = bitmap.asImageBitmap(),
                    contentDescription = preview.name,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxWidth().heightIn(max = 420.dp),
                )
            } else {
                Text("无法预览此图片")
            }
        },
        confirmButton = { TextButton(onDismiss) { Text("关闭") } },
    )
}

internal fun decodePreviewBitmap(bytes: ByteArray, maxDimension: Int = 2048): android.graphics.Bitmap? {
    if (bytes.isEmpty()) return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sampleSize = 1
    while (bounds.outWidth / sampleSize > maxDimension || bounds.outHeight / sampleSize > maxDimension) {
        sampleSize *= 2
    }
    return BitmapFactory.decodeByteArray(
        bytes,
        0,
        bytes.size,
        BitmapFactory.Options().apply { inSampleSize = sampleSize },
    )
}

internal fun decodeDataUrlBitmap(dataUrl: String?): android.graphics.Bitmap? {
    if (dataUrl.isNullOrBlank()) return null
    val encoded = dataUrl.substringAfter("base64,", "")
    if (encoded.isBlank() || encoded == dataUrl) return null
    return runCatching {
        Base64.decode(encoded, Base64.DEFAULT).let { bytes ->
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }
    }.getOrNull()
}
