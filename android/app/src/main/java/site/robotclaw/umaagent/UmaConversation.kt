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
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 会话内容保留消息流、审批、队列和附件操作。 */
@Composable
internal fun ChatScreen(
    state: UmaUiState,
    model: UmaViewModel,
    onOpenSessions: () -> Unit,
    onOpenSettings: () -> Unit = onOpenSessions,
    xianyuDraftMessageIds: Set<String> = emptySet(),
    onSendXianyuDraft: ((String) -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    var message by
        rememberSaveable(state.selectedSessionId) {
            mutableStateOf(model.draftText(state.selectedSessionId))
        }
    var pendingTranscriptDownloadId by rememberSaveable { mutableStateOf("") }
    var editingMessageId by rememberSaveable { mutableStateOf("") }
    var editingMessageDraft by rememberSaveable { mutableStateOf("") }
    var editingMessageOriginal by rememberSaveable { mutableStateOf("") }
    var sessionAction by rememberSaveable(state.selectedSessionId) { mutableStateOf("") }
    var renameDraft by rememberSaveable(state.selectedSessionId) { mutableStateOf("") }
    val selectedSession = state.sessions.firstOrNull { it.id == state.selectedSessionId }
    val dismissRename =
        rememberDiscardAction({
            sessionAction == "rename" && renameDraft != selectedSession?.title.orEmpty()
        }) {
            sessionAction = ""
        }
    val dismissEdit =
        rememberDiscardAction({
            editingMessageId.isNotBlank() && editingMessageDraft != editingMessageOriginal
        }) {
            editingMessageId = ""
            editingMessageDraft = ""
        }
    if (sessionAction == "shortcuts" && selectedSession != null)
        ShortcutDialog(model, selectedSession.id) { sessionAction = "" }
    if (sessionAction == "rename")
        AlertDialog(
            onDismissRequest = { if (!state.loading) dismissRename() },
            title = { Text("重命名会话") },
            text = {
                OutlinedTextField(
                    renameDraft,
                    { renameDraft = it },
                    label = { Text("会话标题") },
                    singleLine = true,
                    enabled = !state.loading,
                )
            },
            confirmButton = {
                TextButton(
                    {
                        // 失败保留输入；只有服务端确认成功才退出编辑。
                        model.renameSession(renameDraft) { sessionAction = "" }
                    },
                    enabled = renameDraft.isNotBlank() && !state.loading,
                ) {
                    Text("保存")
                }
            },
            dismissButton = {
                TextButton(dismissRename, enabled = !state.loading) { Text("取消") }
            },
        )
    if (sessionAction == "delete")
        AlertDialog(
            onDismissRequest = { sessionAction = "" },
            title = { Text("删除会话") },
            text = { Text("删除“${selectedSession?.title.orEmpty()}”？此操作无法撤销。") },
            confirmButton = {
                TextButton({
                    model.deleteSelectedSession()
                    sessionAction = ""
                }) {
                    Text("删除")
                }
            },
            dismissButton = { TextButton({ sessionAction = "" }) { Text("取消") } },
        )
    val conversation =
        state.conversation ?: remember(state.snapshot) { parseSnapshotConversation(state.snapshot) }
    val activeRun =
        conversation.filterIsInstance<UiConversationEntry.ResponseEntry>().lastOrNull {
            it.run?.status in
                listOf("queued", "preflight", "running", "verifying", "awaiting_confirmation")
        }
    val approvals = state.approvals ?: remember(state.snapshot) { pendingApprovals(state.snapshot) }
    val listState = rememberLazyListState()
    var followTail by rememberSaveable(state.selectedSessionId) { mutableStateOf(true) }
    var scrollingToTail by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    if (state.traceRunId != null)
        TraceDialog(
            state.traceData.orEmpty(),
            model::closeRunTrace,
            state.traceLoading,
            model::loadMoreTrace,
            state.traceError,
        )
    suspend fun scrollToLatest() {
        if (conversation.isEmpty()) return
        scrollingToTail = true
        try {
            listState.requestScrollToItem(conversation.lastIndex, Int.MAX_VALUE)
            withFrameNanos {}
            listState.scrollToItem(conversation.lastIndex, Int.MAX_VALUE)
            // Use the measured height so a reply taller than the viewport ends at its last line.
            followTail = true
        } finally {
            scrollingToTail = false
        }
    }
    val attachmentPicker =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null) model.uploadAttachment(uri, "attachment")
        }
    val transcriptAttachmentSaver =
        rememberLauncherForActivityResult(
            ActivityResultContracts.CreateDocument("application/octet-stream")
        ) { uri ->
            val attachmentId = pendingTranscriptDownloadId
            pendingTranscriptDownloadId = ""
            if (uri != null && attachmentId.isNotBlank())
                model.downloadAttachment(attachmentId, uri)
        }

    state.attachmentPreview?.let { preview ->
        AttachmentPreviewDialog(preview, model::clearAttachmentPreview)
    }
    if (editingMessageId.isNotBlank()) {
        AlertDialog(
            onDismissRequest = {
                if (!state.loading) dismissEdit()
            },
            title = { Text("编辑消息") },
            text = {
                OutlinedTextField(
                    value = editingMessageDraft,
                    onValueChange = { if (it.length <= 1_000_000) editingMessageDraft = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("消息内容") },
                    minLines = 3,
                    maxLines = 8,
                    enabled = !state.loading,
                )
            },
            confirmButton = {
                Button(
                    onClick = {
                        model.editMessage(editingMessageId, editingMessageDraft) {
                            editingMessageId = ""
                            editingMessageDraft = ""
                        }
                    },
                    enabled = editingMessageDraft.isNotBlank() && !state.offline && !state.loading,
                ) {
                    Text("保存并重跑")
                }
            },
            dismissButton = {
                TextButton(
                    dismissEdit,
                    enabled = !state.loading,
                ) {
                    Text("取消")
                }
            },
        )
    }

    LaunchedEffect(listState, selectedSession?.id) {
        snapshotFlow {
            Triple(listState.isScrollInProgress, listState.canScrollForward, scrollingToTail)
        }
            .collect { (scrolling, canScrollForward, automatic) ->
                if (!automatic && scrolling) followTail = !canScrollForward
                if (!canScrollForward) followTail = true
            }
    }
    LaunchedEffect(conversation.lastOrNull(), selectedSession?.id) {
        if (followTail) scrollToLatest()
    }
    // WebView 的图片、字体和流式正文会异步改变高度。仅在已经跟随末尾时校准，
    // 手动回看历史不会被新的测量结果拉回底部。
    LaunchedEffect(listState, selectedSession?.id) {
        snapshotFlow {
            listState.layoutInfo.visibleItemsInfo.lastOrNull()?.let { it.key to it.size }
        }
            .collect {
                if (followTail && !listState.isScrollInProgress) {
                    withFrameNanos {}
                    scrollToLatest()
                }
            }
    }
    LaunchedEffect(selectedSession?.id) { model.loadQueue() }

    // Consume IME insets once at the conversation boundary. The composer itself
    // must not add a second imePadding, otherwise a large gap appears above the keyboard.
    BoxWithConstraints(modifier.imePadding()) {
        // 横屏键盘展开时优先保留输入；模式并入输入行，导航仍由 Shell 提供。
        val compactHeight = maxHeight < 240.dp
        Column(Modifier.padding(horizontal = 16.dp, vertical = if (compactHeight) 0.dp else 4.dp)) {
            if (selectedSession == null) {
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text("未选择会话", style = MaterialTheme.typography.titleMedium)
                        Button(onOpenSessions) { Text("打开会话") }
                    }
                }
                return@Column
            }

            if (!compactHeight)
                Row(
                    Modifier.fillMaxWidth().padding(bottom = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    IconButton(onOpenSessions) {
                        Icon(Icons.AutoMirrored.Filled.List, contentDescription = "打开会话列表")
                    }
                    Column(Modifier.weight(1f)) {
                        Text(
                            selectedSession.title,
                            Modifier.testTag("workspace-title"),
                            style = MaterialTheme.typography.titleSmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    if (state.models.isNotEmpty())
                        ActionMenu(
                            state.models.map { option ->
                                MenuAction(option.id, !state.offline && !state.loading) {
                                    model.selectModel(option)
                                }
                            },
                            label = selectedSession.model.id.ifBlank { "模型" },
                        )
                    ActionMenu(
                        listOf(
                            MenuAction("会话设置") { onOpenSettings() },
                            MenuAction("重命名", !state.offline && !state.loading) {
                                renameDraft = selectedSession.title
                                sessionAction = "rename"
                            },
                            MenuAction("压缩上下文", !state.offline && !state.loading) {
                                model.compactSelectedSession()
                            },
                            MenuAction("快捷命令", !state.offline && !state.loading) {
                                sessionAction = "shortcuts"
                            },
                            MenuAction("删除会话", !state.offline && !state.loading) {
                                sessionAction = "delete"
                            },
                        )
                    )
                }
            if (conversation.isEmpty()) {
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Text(
                        if (state.offline) "暂无离线消息" else "暂无消息",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.weight(1f).fillMaxWidth().testTag("conversation-messages"),
                    contentPadding = PaddingValues(vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(conversation, key = { it.id }) { entry ->
                        when (entry) {
                            is UiConversationEntry.MessageEntry ->
                                MessageItem(
                                    item = entry.item,
                                    assistantName = selectedSession.assistantName,
                                    avatar = state.assistantAvatar,
                                    downloadsEnabled = !state.offline && !state.loading,
                                    onEditMessage = { editable ->
                                        editingMessageId = editable.id
                                        editingMessageDraft = editable.content
                                        editingMessageOriginal = editable.content
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
                                    avatar = state.assistantAvatar,
                                    downloadsEnabled = !state.offline && !state.loading,
                                    onConfirmPlan = model::confirmPlan,
                                    onOpenTrace = model::openRunTrace,
                                    onReviewMessage = model::reviewMessage,
                                    onImproveMessage = model::improveMessage,
                                    onPreviewImage = model::previewImageAttachment,
                                    onDownloadAttachment = { attachment ->
                                        pendingTranscriptDownloadId = attachment.id
                                        transcriptAttachmentSaver.launch(attachment.name)
                                    },
                                )
                                val draft =
                                    entry.items.asReversed().firstOrNull {
                                        it.role == "assistant" &&
                                            it.status == "complete" &&
                                            it.id in xianyuDraftMessageIds
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
            if (!followTail && conversation.isNotEmpty()) {
                TextButton(
                    onClick = { scope.launch { scrollToLatest() } },
                    modifier = Modifier.align(Alignment.End),
                ) {
                    Text("最新消息")
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
                            OutlinedButton(
                                { model.removePendingAttachment(attachment.id) },
                                enabled = !state.loading && !state.unconfirmedSend,
                            ) {
                                Text("移除")
                            }
                        }
                    }
                }
            }
            if (!compactHeight)
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    ActionMenu(
                        listOf(
                            MenuAction(
                                "Agent · 直接执行",
                                !state.offline && !state.loading && !state.unconfirmedSend,
                            ) {
                                model.setInteractionMode("agent")
                            },
                            MenuAction(
                                "Plan · 先规划",
                                !state.offline && !state.loading && !state.unconfirmedSend,
                            ) {
                                model.setInteractionMode("plan")
                            },
                        ),
                        label = if (state.interactionMode == "plan") "Plan" else "Agent",
                    )
                    Text(
                        when {
                            state.cancelling -> "取消中…"
                            state.sending -> "发送中…"
                            state.loading -> "同步中…"
                            state.offline -> "离线 · 草稿保留"
                            state.unconfirmedSend -> "结果未确认 · 点击发送核对并重试"
                            activeRun != null -> queueStatusLabel(activeRun.run!!.status)
                            else -> ""
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (state.offline) TextButton({ model.retryLogin() }) { Text("重连") }
                }
            approvals.forEach { approval ->
                Surface(
                    Modifier.fillMaxWidth(),
                    color = MaterialTheme.colorScheme.tertiaryContainer,
                    shape = MaterialTheme.shapes.small,
                ) {
                    Column(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text(
                            "需要批准：${approval.toolName}",
                            style = MaterialTheme.typography.titleSmall,
                        )
                        if (approval.input.isNotBlank())
                            Text(
                                approval.input,
                                style = MaterialTheme.typography.bodySmall,
                                maxLines = 5,
                            )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(
                                { model.resolveApproval(approval.id, true) },
                                enabled = !state.offline && !state.loading,
                            ) {
                                Text("批准")
                            }
                            OutlinedButton(
                                { model.resolveApproval(approval.id, false) },
                                enabled = !state.offline && !state.loading,
                            ) {
                                Text("拒绝")
                            }
                        }
                    }
                }
            }
            Row(
                Modifier.fillMaxWidth().padding(top = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                IconButton(
                    { attachmentPicker.launch(arrayOf("*/*")) },
                    Modifier.size(48.dp),
                    enabled = !state.offline && !state.loading && !state.unconfirmedSend,
                ) {
                    Icon(Icons.Default.AttachFile, contentDescription = "添加附件")
                }
                if (compactHeight)
                    ActionMenu(
                        listOf(
                            MenuAction("Agent · 直接执行", !state.loading && !state.unconfirmedSend) {
                                model.setInteractionMode("agent")
                            },
                            MenuAction("Plan · 先规划", !state.loading && !state.unconfirmedSend) {
                                model.setInteractionMode("plan")
                            },
                        ),
                        label = if (state.interactionMode == "plan") "Plan" else "Agent",
                    )
                CompactMessageField(
                    value = message,
                    onValueChange = {
                        if (it.length <= 20_000) {
                            message = it
                            model.saveDraftText(state.selectedSessionId, it)
                        }
                    },
                    maxLines = if (compactHeight) 2 else 6,
                    enabled = !state.loading && !state.unconfirmedSend,
                    modifier = Modifier.weight(1f),
                )
                if (activeRun != null && message.isBlank() && state.pendingAttachmentIds.isEmpty())
                    FilledIconButton(
                        model::cancelSelectedSession,
                        Modifier.size(48.dp),
                        enabled = !state.offline && !state.cancelling,
                    ) {
                        Icon(
                            Icons.Default.Stop,
                            contentDescription = if (state.cancelling) "取消中" else "停止运行",
                        )
                    }
                else
                    FilledIconButton(
                        { model.send(message) { message = "" } },
                        Modifier.size(48.dp),
                        enabled =
                            !state.offline &&
                                !state.loading &&
                                (message.isNotBlank() || state.pendingAttachmentIds.isNotEmpty()),
                    ) {
                        Icon(
                            Icons.AutoMirrored.Filled.Send,
                            contentDescription = if (state.unconfirmedSend) "核对并重试发送" else "发送消息",
                        )
                    }
            }
        }
    }
}

@Composable
private fun CompactMessageField(
    value: String,
    onValueChange: (String) -> Unit,
    maxLines: Int,
    enabled: Boolean,
    modifier: Modifier = Modifier,
) {
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.heightIn(min = 48.dp, max = 120.dp).testTag("conversation-input"),
        enabled = enabled,
        textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp, lineHeight = 20.sp),
        minLines = 1,
        maxLines = maxLines,
        decorationBox = { innerTextField ->
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
                color = MaterialTheme.colorScheme.surface,
                border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
            ) {
                Box(
                    Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    if (value.isBlank())
                        Text(
                            "消息",
                            style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 20.sp),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    innerTextField()
                }
            }
        },
    )
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
    onEdit: (UiQueueItem, String, () -> Unit) -> Unit,
) {
    var editingRunId by rememberSaveable { mutableStateOf<String?>(null) }
    var draft by rememberSaveable { mutableStateOf("") }
    val editingItem = queue.firstOrNull { it.runId == editingRunId }
    val dismissEdit =
        rememberDiscardAction({ editingItem != null && draft != editingItem.content }) {
            editingRunId = null
            draft = ""
        }

    if (editingItem != null) {
        AlertDialog(
            onDismissRequest = {
                if (enabled) dismissEdit()
            },
            title = { Text("编辑队列消息") },
            text = {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { if (it.length <= 1_000_000) draft = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("消息内容") },
                    minLines = 3,
                    maxLines = 8,
                    enabled = enabled,
                )
            },
            confirmButton = {
                Button(
                    onClick = {
                        onEdit(editingItem, draft) {
                            editingRunId = null
                            draft = ""
                        }
                    },
                    enabled = enabled && draft.isNotBlank(),
                ) {
                    Text("保存")
                }
            },
            dismissButton = {
                TextButton(dismissEdit, enabled = enabled) {
                    Text("取消")
                }
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
                        ActionMenu(
                            listOf(
                                MenuAction("编辑", enabled) {
                                    editingRunId = item.runId
                                    draft = item.content
                                },
                                MenuAction("置顶", enabled && index > 0) { onPrioritize(item.runId) },
                                MenuAction("上移", enabled && index > 0) {
                                    val ids = queue.map { it.runId }.toMutableList()
                                    java.util.Collections.swap(ids, index, index - 1)
                                    onReorder(ids)
                                },
                                MenuAction("下移", enabled && index < queue.lastIndex) {
                                    val ids = queue.map { it.runId }.toMutableList()
                                    java.util.Collections.swap(ids, index, index + 1)
                                    onReorder(ids)
                                },
                                MenuAction("取消", enabled) { onCancel(item.runId) },
                            )
                        )
                    }
                }
                if (index < queue.lastIndex) HorizontalDivider()
            }
        }
    }
}

@Composable
internal fun MessageItem(
    item: UiMessage,
    assistantName: String,
    avatar: android.graphics.Bitmap?,
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
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (!isUser && item.role != "tool") AssistantAvatar(avatar, 34.dp)
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
                color =
                    if (isUser) MaterialTheme.colorScheme.primaryContainer
                    else MaterialTheme.colorScheme.surfaceVariant,
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
                            onAttachment = { id ->
                                item.attachments.find { it.id == id }?.let(onDownloadAttachment)
                            },
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
                    }
                ) {
                    Text(if (copied) "已复制" else "复制")
                }
                ActionMenu(
                    listOf(
                        MenuAction("重试", downloadsEnabled) { onRetryMessage(item) },
                        MenuAction("编辑", downloadsEnabled) { onEditMessage(item) },
                    )
                )
            }
        }
        if (item.status == "streaming") Text("生成中", style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
internal fun ResponseItem(
    entry: UiConversationEntry.ResponseEntry,
    assistantName: String,
    avatar: android.graphics.Bitmap?,
    downloadsEnabled: Boolean,
    onConfirmPlan: (String) -> Unit,
    onOpenTrace: (String) -> Unit,
    onReviewMessage: (String) -> Unit,
    onImproveMessage: (String) -> Unit,
    onPreviewImage: (UiAttachment) -> Unit,
    onDownloadAttachment: (UiAttachment) -> Unit,
) {
    val clipboard = LocalClipboardManager.current
    var copied by rememberSaveable(entry.id) { mutableStateOf(false) }
    var detailsExpanded by rememberSaveable(entry.id) { mutableStateOf(false) }
    val finalAssistant = entry.items.lastOrNull { it.role == "assistant" }
    val finalContent = finalAssistant?.content?.takeIf { it.isNotBlank() } ?: entry.response.content
    val intermediateItems =
        entry.items.filter { item ->
            item.role != "user" && item.id != finalAssistant?.id
        }
    val attachments =
        (entry.response.attachments + finalAssistant?.attachments.orEmpty()).distinctBy { it.id }
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
            Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                AssistantAvatar(avatar, 24.dp)
                Column(Modifier.weight(1f)) {
                    Text(assistantName, style = MaterialTheme.typography.labelLarge)
                    if (entry.isCurrentSegment) {
                        Text(
                            responseStatusLabel(entry.response.status),
                            style = MaterialTheme.typography.labelSmall,
                            color =
                                if (entry.response.status == "failed") {
                                    MaterialTheme.colorScheme.error
                                } else {
                                    MaterialTheme.colorScheme.onSurfaceVariant
                                },
                        )
                    }
                }
                if (entry.run?.interactionMode == "plan") {
                    Text(
                        "计划",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
                if (entry.isCurrentSegment && entry.response.status == "awaiting_confirmation") {
                    TextButton(
                        onClick = { onConfirmPlan(entry.response.runId) },
                        enabled = downloadsEnabled,
                    ) {
                        Text("确认执行")
                    }
                }
            }

            if (finalContent.isBlank()) {
                Text("正在准备回复…", color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                SelectionContainer {
                    RichMessageContent(
                        finalContent,
                        onAttachment = { id ->
                            if (downloadsEnabled)
                                attachments.find { it.id == id }?.let(onDownloadAttachment)
                        },
                    )
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
                    Text(
                        if (detailsExpanded) "⌃" else "⌄",
                        modifier = Modifier.padding(start = 6.dp),
                    )
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
                ) {
                    Text(if (copied) "已复制" else "复制")
                }
                if (finalAssistant != null) {
                    ActionMenu(
                        listOf(
                            MenuAction("链路与耗时", downloadsEnabled) {
                                onOpenTrace(entry.response.runId)
                            },
                            MenuAction("审查", downloadsEnabled) {
                                onReviewMessage(finalAssistant.id)
                            },
                            MenuAction("改进", downloadsEnabled) {
                                onImproveMessage(finalAssistant.id)
                            },
                        )
                    )
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
                            Text(
                                "${step.position + 1}",
                                style = MaterialTheme.typography.labelLarge,
                            )
                            Text(
                                step.title,
                                Modifier.weight(1f),
                                style = MaterialTheme.typography.bodySmall,
                            )
                            Text(
                                when (step.status) {
                                    "completed" -> "已完成"
                                    "running" -> "进行中"
                                    "failed" -> "失败"
                                    else -> "待执行"
                                },
                                style = MaterialTheme.typography.labelSmall,
                                color =
                                    if (step.status == "failed") MaterialTheme.colorScheme.error
                                    else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        step.error
                            ?.takeIf { it.isNotBlank() }
                            ?.let {
                                Text(
                                    it,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.error,
                                )
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
                            RichMessageContent(
                                item.content,
                                Modifier.padding(10.dp),
                                compact = true,
                            )
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
                Modifier.fillMaxWidth()
                    .clickable { expanded = !expanded }
                    .padding(horizontal = 10.dp, vertical = 9.dp),
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
                    color =
                        if (item.status == "error") MaterialTheme.colorScheme.error
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text("${item.content.length} 字", style = MaterialTheme.typography.labelSmall)
            }
            if (expanded && item.content.isNotBlank()) {
                HorizontalDivider()
                SelectionContainer {
                    Text(
                        item.content,
                        Modifier.fillMaxWidth()
                            .horizontalScroll(rememberScrollState())
                            .padding(10.dp),
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
        }
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
                    TextButton({ onDownloadAttachment(attachment) }, enabled = enabled) {
                        Text("下载")
                    }
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
    // 文件读取结束不代表解码完成；大附件解码不能占用输入、返回等交互的主线程。
    var decoded by
        remember(preview.bytes) {
            mutableStateOf<Pair<Boolean, android.graphics.Bitmap?>>(false to null)
        }
    LaunchedEffect(preview.bytes) {
        decoded = true to withContext(Dispatchers.Default) { decodePreviewBitmap(preview.bytes) }
    }
    val bitmap = decoded.second
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
            } else if (!decoded.first) {
                androidx.compose.material3.CircularProgressIndicator()
            } else {
                Text("无法预览此图片")
            }
        },
        confirmButton = { TextButton(onDismiss) { Text("关闭") } },
    )
}

internal fun decodePreviewBitmap(
    bytes: ByteArray,
    maxDimension: Int = 2048,
): android.graphics.Bitmap? {
    if (bytes.isEmpty()) return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sampleSize = 1
    while (
        bounds.outWidth / sampleSize > maxDimension || bounds.outHeight / sampleSize > maxDimension
    ) {
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
    }
        .getOrNull()
}
