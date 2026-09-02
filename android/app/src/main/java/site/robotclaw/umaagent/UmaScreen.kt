package site.robotclaw.umaagent

import android.content.Intent
import android.graphics.BitmapFactory
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel

private enum class MobileSection(val label: String) {
    Chat("对话"),
    Sessions("会话"),
    Tasks("任务"),
    Schedules("调度"),
    Resources("资源"),
    Settings("设置"),
}

@Composable
fun UmaScreen(model: UmaViewModel = viewModel()) {
    val state by model.uiState.collectAsState()
    val context = LocalContext.current
    val installPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) {
        val path = state.updateFilePath ?: return@rememberLauncherForActivityResult
        val file = java.io.File(path)
        if (!file.exists() || !context.packageManager.canRequestPackageInstalls()) {
            model.clearUpdateFile()
            return@rememberLauncherForActivityResult
        }
        runCatching { context.startActivity(UpdateService.installIntent(context, file)) }
            .onFailure { model.clearUpdateFile() }
    }

    LaunchedEffect(state.updateFilePath) {
        val path = state.updateFilePath ?: return@LaunchedEffect
        val file = java.io.File(path)
        if (!file.exists()) return@LaunchedEffect
        if (!context.packageManager.canRequestPackageInstalls()) {
            val settingsIntent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                data = android.net.Uri.parse("package:${context.packageName}")
            }
            runCatching { installPermissionLauncher.launch(settingsIntent) }
                .onFailure { model.clearUpdateFile() }
        } else {
            runCatching { context.startActivity(UpdateService.installIntent(context, file)) }
                .onFailure { model.clearUpdateFile() }
        }
    }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        if (state.stagingAccessRequired) {
            StagingAccessScreen(state, model)
        } else if (!state.tokenPresent) {
            AuthScreen(state, model)
        } else {
            AuthenticatedScreen(state, model)
        }
    }
}

@Composable
private fun StagingAccessScreen(state: UmaUiState, model: UmaViewModel) {
    var password by rememberSaveable { mutableStateOf("") }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("UmaAgent 测试版", style = MaterialTheme.typography.headlineMedium)
        Text("输入测试环境访问口令后继续。该口令只保存在此设备的 Android Keystore 中。", color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            modifier = Modifier.fillMaxWidth(),
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true,
            label = { Text("测试环境口令") },
            enabled = !state.loading,
        )
        Button(
            { model.configureStagingAccess(password) },
            Modifier.fillMaxWidth(),
            enabled = password.isNotBlank() && !state.loading,
        ) { Text("连接测试环境") }
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        ErrorBanner(state.error)
    }
}

@Composable
private fun AuthScreen(state: UmaUiState, model: UmaViewModel) {
    val clipboard = LocalClipboardManager.current
    var token by rememberSaveable { mutableStateOf("") }
    var authMode by rememberSaveable { mutableStateOf("login") }
    var label by rememberSaveable { mutableStateOf("android") }
    var copied by rememberSaveable(state.registrationToken) { mutableStateOf(false) }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("UmaAgent", style = MaterialTheme.typography.headlineMedium)
        Text(
            if (authMode == "register") "创建一个新的隔离账户" else "使用访问令牌连接 UmaAgent Core",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (authMode == "register") {
            if (state.registrationToken.isBlank()) {
                OutlinedTextField(
                    label,
                    { if (it.length <= 80) label = it },
                    Modifier.fillMaxWidth(),
                    singleLine = true,
                    label = { Text("令牌名称") },
                    enabled = !state.loading,
                )
                Button(
                    { model.register(label) },
                    Modifier.fillMaxWidth(),
                    enabled = !state.loading,
                ) { Text("注册") }
            } else {
                Text("注册成功，请立即保存此访问令牌", color = MaterialTheme.colorScheme.primary)
                OutlinedTextField(
                    state.registrationToken,
                    {},
                    Modifier.fillMaxWidth(),
                    readOnly = true,
                    minLines = 3,
                    label = { Text("访问令牌") },
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        {
                            clipboard.setText(AnnotatedString(state.registrationToken))
                            copied = true
                        },
                        Modifier.weight(1f),
                    ) { Text(if (copied) "已复制" else "复制令牌") }
                    Button(
                        { model.login(state.registrationToken) },
                        Modifier.weight(1f),
                        enabled = !state.loading,
                    ) { Text("继续进入") }
                }
            }
            OutlinedButton(
                { authMode = "login"; model.clearRegistration() },
                Modifier.fillMaxWidth(),
                enabled = !state.loading,
            ) { Text("已有令牌，返回登录") }
        } else {
            OutlinedTextField(
                token,
                { token = it },
                Modifier.fillMaxWidth(),
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true,
                label = { Text("访问令牌") },
            )
            Button(
                { model.login(token) },
                Modifier.fillMaxWidth(),
                enabled = token.isNotBlank() && !state.loading,
            ) { Text("登录") }
            OutlinedButton(
                { authMode = "register"; model.clearRegistration() },
                Modifier.fillMaxWidth(),
                enabled = !state.loading,
            ) { Text("创建新账户") }
        }
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        ErrorBanner(state.error)
        HorizontalDivider(Modifier.padding(vertical = 4.dp))
        UpdatePanel(state, model)
    }
}

@Composable
private fun AuthenticatedScreen(state: UmaUiState, model: UmaViewModel) {
    var sectionName by rememberSaveable { mutableStateOf(MobileSection.Chat.name) }
    val section = MobileSection.entries.firstOrNull { it.name == sectionName } ?: MobileSection.Chat
    val selectedSession = state.sessions.firstOrNull { it.id == state.selectedSessionId }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("UmaAgent", style = MaterialTheme.typography.titleLarge)
                Text(
                    selectedSession?.title ?: "未选择会话",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }
            Text(
                if (state.offline) "离线只读" else "已连接",
                style = MaterialTheme.typography.labelLarge,
                color = if (state.offline) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.secondary,
            )
            if (state.offline) {
                TextButton({ model.retryLogin() }, enabled = !state.loading) { Text("重新连接") }
            }
        }
        TabRow(selectedTabIndex = section.ordinal) {
            MobileSection.entries.forEach { item ->
                Tab(
                    selected = item == section,
                    onClick = { sectionName = item.name },
                    text = { Text(item.label) },
                )
            }
        }
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        ErrorBanner(state.error)
        when (section) {
            MobileSection.Chat -> ChatScreen(
                state,
                model,
                onOpenSessions = { sectionName = MobileSection.Sessions.name },
                modifier = Modifier.weight(1f),
            )
            MobileSection.Sessions -> SessionsScreen(
                state,
                model,
                onOpenChat = { sectionName = MobileSection.Chat.name },
                modifier = Modifier.weight(1f),
            )
            MobileSection.Tasks -> TasksScreen(
                state,
                model,
                onOpenTaskSession = { sessionId ->
                    model.selectSession(sessionId)
                    sectionName = MobileSection.Chat.name
                },
                modifier = Modifier.weight(1f),
            )
            MobileSection.Schedules -> SchedulesScreen(state, model, Modifier.weight(1f))
            MobileSection.Resources -> ResourcesScreen(state, model, Modifier.weight(1f))
            MobileSection.Settings -> SettingsScreen(state, model, Modifier.weight(1f))
        }
    }
}

@Composable
private fun ChatScreen(
    state: UmaUiState,
    model: UmaViewModel,
    onOpenSessions: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var message by rememberSaveable { mutableStateOf("") }
    var pendingTranscriptDownloadId by rememberSaveable { mutableStateOf("") }
    var editingMessageId by rememberSaveable { mutableStateOf("") }
    var editingMessageDraft by rememberSaveable { mutableStateOf("") }
    val selectedSession = state.sessions.firstOrNull { it.id == state.selectedSessionId }
    val messages = remember(state.snapshot) { parseSnapshotMessages(state.snapshot) }
    val pendingPlanId = remember(state.snapshot) { pendingPlanRunId(state.snapshot) }
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

    LaunchedEffect(messages.size, selectedSession?.id) {
        if (messages.isNotEmpty()) listState.scrollToItem(messages.lastIndex)
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
        if (messages.isEmpty()) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text(if (state.offline) "暂无离线消息" else "暂无消息", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(messages, key = { it.id }) { item ->
                    MessageItem(
                        item = item,
                        assistantName = selectedSession.assistantName,
                        avatarBytes = state.assistantAvatarBytes,
                        downloadsEnabled = !state.offline && !state.loading,
                        onEditMessage = { editable ->
                            editingMessageId = editable.id
                            editingMessageDraft = editable.content
                        },
                        onReviewMessage = model::reviewMessage,
                        onImproveMessage = model::improveMessage,
                        onPreviewImage = model::previewImageAttachment,
                        onDownloadAttachment = { attachment ->
                            pendingTranscriptDownloadId = attachment.id
                            transcriptAttachmentSaver.launch(attachment.name)
                        },
                    )
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
        if (pendingPlanId != null) {
            Surface(
                Modifier.fillMaxWidth(),
                color = MaterialTheme.colorScheme.primaryContainer,
                shape = MaterialTheme.shapes.small,
            ) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(
                        "计划已生成，确认后开始执行",
                        Modifier.weight(1f),
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Button(
                        { model.confirmPlan(pendingPlanId) },
                        enabled = !state.offline && !state.loading,
                    ) { Text("确认执行") }
                }
            }
        }
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
private fun QueuePanel(
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
private fun InteractionModeSelector(value: String, onChange: (String) -> Unit, enabled: Boolean) {
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
private fun MessageItem(
    item: UiMessage,
    assistantName: String,
    avatarBytes: ByteArray?,
    downloadsEnabled: Boolean,
    onEditMessage: (UiMessage) -> Unit,
    onReviewMessage: (String) -> Unit,
    onImproveMessage: (String) -> Unit,
    onPreviewImage: (UiAttachment) -> Unit,
    onDownloadAttachment: (UiAttachment) -> Unit,
) {
    val isUser = item.role == "user"
    Column(
        Modifier.fillMaxWidth(),
        horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
        verticalArrangement = Arrangement.spacedBy(3.dp),
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
        Surface(
            color = if (isUser) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
            shape = MaterialTheme.shapes.small,
        ) {
            SelectionContainer {
                Text(
                    item.content,
                    Modifier.padding(horizontal = 12.dp, vertical = 9.dp),
                    color = if (isUser) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (item.attachments.isNotEmpty()) {
            LazyRow(
                Modifier.fillMaxWidth(),
                contentPadding = PaddingValues(top = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(item.attachments, key = { it.id }) { attachment ->
                    if (attachment.mimeType.startsWith("image/")) {
                        Column(horizontalAlignment = Alignment.Start) {
                            OutlinedButton(
                                { onPreviewImage(attachment) },
                                enabled = downloadsEnabled,
                            ) {
                                AttachmentLabel(attachment)
                            }
                            TextButton(
                                { onDownloadAttachment(attachment) },
                                enabled = downloadsEnabled,
                            ) { Text("下载") }
                        }
                    } else {
                        OutlinedButton(
                            { onDownloadAttachment(attachment) },
                            enabled = downloadsEnabled,
                        ) { AttachmentLabel(attachment) }
                    }
                }
            }
        }
        if (isUser && item.status == "complete") {
            TextButton(
                onClick = { onEditMessage(item) },
                enabled = downloadsEnabled,
            ) { Text("编辑") }
        }
        if (!isUser && item.role != "tool") {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(
                    onClick = { onReviewMessage(item.id) },
                    enabled = downloadsEnabled,
                ) { Text("审查") }
                TextButton(
                    onClick = { onImproveMessage(item.id) },
                    enabled = downloadsEnabled,
                ) { Text("改进") }
            }
        }
        if (item.status == "streaming") Text("生成中", style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun AttachmentLabel(attachment: UiAttachment) {
    Column(horizontalAlignment = Alignment.Start) {
        Text(attachment.name, maxLines = 1)
        Text(
            attachmentSizeLabel(attachment.size),
            style = MaterialTheme.typography.labelSmall,
        )
    }
}

@Composable
private fun AttachmentPreviewDialog(preview: AttachmentPreview, onDismiss: () -> Unit) {
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

private fun decodePreviewBitmap(bytes: ByteArray, maxDimension: Int = 2048): android.graphics.Bitmap? {
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

@Composable
private fun SessionsScreen(
    state: UmaUiState,
    model: UmaViewModel,
    onOpenChat: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var newSessionTitle by rememberSaveable { mutableStateOf("") }
    var renameTitle by rememberSaveable { mutableStateOf("") }
    var assistantName by rememberSaveable { mutableStateOf("UmaAgent") }
    var confirmDelete by rememberSaveable { mutableStateOf(false) }
    val selectedSession = state.sessions.firstOrNull { it.id == state.selectedSessionId }
    val avatarPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) model.uploadAssistantAvatar(uri, "assistant-avatar")
    }

    LaunchedEffect(selectedSession?.id, selectedSession?.title, selectedSession?.assistantName) {
        renameTitle = selectedSession?.title.orEmpty()
        assistantName = selectedSession?.assistantName ?: "UmaAgent"
    }

    LazyColumn(
        modifier,
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { Text("新建会话", style = MaterialTheme.typography.titleMedium) }
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    newSessionTitle,
                    { newSessionTitle = it },
                    Modifier.weight(1f),
                    label = { Text("会话标题") },
                    singleLine = true,
                )
                Button(
                    { model.createSession(newSessionTitle); newSessionTitle = "" },
                    enabled = !state.offline && newSessionTitle.isNotBlank() && !state.loading,
                ) { Text("新建") }
            }
        }
        item { Text("全部会话", style = MaterialTheme.typography.titleMedium) }
        if (state.sessions.isEmpty()) item { Text("暂无会话", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        items(state.sessions, key = { it.id }) { session ->
            val selectSession = {
                model.selectSession(session.id)
                onOpenChat()
            }
            if (session.id == state.selectedSessionId) {
                Button(selectSession, Modifier.fillMaxWidth()) { Text(session.title, maxLines = 1) }
            } else {
                OutlinedButton(selectSession, Modifier.fillMaxWidth()) { Text(session.title, maxLines = 1) }
            }
        }
        if (selectedSession != null) {
            item { HorizontalDivider(Modifier.padding(vertical = 4.dp)) }
            item { Text("当前会话", style = MaterialTheme.typography.titleMedium) }
            item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        renameTitle,
                        { renameTitle = it },
                        Modifier.weight(1f),
                        label = { Text("会话标题") },
                        singleLine = true,
                    )
                    Button(
                        { model.renameSession(renameTitle) },
                        enabled = !state.offline && renameTitle.isNotBlank() && !state.loading,
                    ) { Text("保存") }
                }
            }
            item {
                ActionRows(
                    listOf(
                        "取消运行" to { model.cancelSelectedSession() },
                        "压缩历史" to { model.compactSelectedSession() },
                        "删除会话" to { confirmDelete = true },
                    ),
                    enabled = !state.offline && !state.loading,
                )
            }
            item { HorizontalDivider(Modifier.padding(vertical = 4.dp)) }
            item { Text("执行策略", style = MaterialTheme.typography.titleMedium) }
            item {
                Text(
                    if (selectedSession.queueMode == "preemptive") {
                        "新消息会中断当前工作并优先执行"
                    } else {
                        "新消息按发送顺序等待执行"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("queue" to "队列", "preemptive" to "抢占").forEach { (mode, label) ->
                        val selected = selectedSession.queueMode == mode
                        if (selected) {
                            Button(
                                onClick = { model.updateQueueMode(mode) },
                                modifier = Modifier.weight(1f),
                                enabled = !state.offline && !state.loading,
                            ) { Text(label) }
                        } else {
                            OutlinedButton(
                                onClick = { model.updateQueueMode(mode) },
                                modifier = Modifier.weight(1f),
                                enabled = !state.offline && !state.loading,
                            ) { Text(label) }
                        }
                    }
                }
            }
            item { HorizontalDivider(Modifier.padding(vertical = 4.dp)) }
            item { Text("助手身份", style = MaterialTheme.typography.titleMedium) }
            item {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    AssistantAvatar(state.assistantAvatarBytes, 56.dp)
                    Column(Modifier.weight(1f)) {
                        Text(selectedSession.assistantName, style = MaterialTheme.typography.titleSmall)
                        Text(
                            if (selectedSession.assistantAvatarAttachmentId == null) "默认头像" else "自定义头像",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            item {
                OutlinedTextField(
                    assistantName,
                    { assistantName = it },
                    Modifier.fillMaxWidth(),
                    label = { Text("助手名称") },
                    singleLine = true,
                )
            }
            item {
                ActionRows(
                    listOf(
                        "保存名称" to { model.updateAssistantName(assistantName) },
                        "上传头像" to { avatarPicker.launch(arrayOf("image/*")) },
                        "恢复默认头像" to { model.resetAssistantAvatar() },
                    ),
                    enabled = !state.offline && !state.loading,
                )
            }
        }
    }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("删除会话") },
            text = { Text("删除后无法恢复。") },
            confirmButton = {
                TextButton({ confirmDelete = false; model.deleteSelectedSession() }) { Text("删除") }
            },
            dismissButton = { TextButton({ confirmDelete = false }) { Text("取消") } },
        )
    }
}

@Composable
private fun TasksScreen(
    state: UmaUiState,
    model: UmaViewModel,
    onOpenTaskSession: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var prompt by rememberSaveable { mutableStateOf("") }
    val selectedSession = state.sessions.firstOrNull { it.id == state.selectedSessionId }

    LaunchedEffect(Unit) { model.loadBackgroundTasks() }

    LazyColumn(
        modifier,
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { Text("后台任务", style = MaterialTheme.typography.titleMedium) }
        item {
            Text(
                selectedSession?.let { "将在会话“${it.title}”中运行" } ?: "请先选择一个会话",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        item {
            OutlinedTextField(
                value = prompt,
                onValueChange = { if (it.length <= 1_000_000) prompt = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("任务内容") },
                placeholder = { Text("描述需要在后台完成的工作") },
                minLines = 2,
                maxLines = 5,
                enabled = selectedSession != null && !state.offline && !state.loading,
            )
        }
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = { model.createBackgroundTask(prompt); prompt = "" },
                    modifier = Modifier.weight(1f),
                    enabled = selectedSession != null && prompt.isNotBlank() && !state.offline && !state.loading,
                ) { Text("创建任务") }
                OutlinedButton(
                    onClick = model::loadBackgroundTasks,
                    modifier = Modifier.weight(1f),
                    enabled = !state.offline && !state.loading,
                ) { Text("刷新") }
            }
        }
        if (state.backgroundTasks.isEmpty()) {
            item {
                Text("暂无后台任务", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            items(state.backgroundTasks, key = { it.id }) { task ->
                Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    shape = MaterialTheme.shapes.small,
                ) {
                    Column(
                        Modifier.fillMaxWidth().padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(backgroundTaskStatusLabel(task.status), style = MaterialTheme.typography.labelLarge)
                        Text(task.prompt, maxLines = 5)
                        task.result?.takeIf { it.isNotBlank() }?.let { result ->
                            Text(result, style = MaterialTheme.typography.bodySmall, maxLines = 6)
                        }
                        task.error?.takeIf { it.isNotBlank() }?.let { error ->
                            Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(
                                onClick = { onOpenTaskSession(task.sessionId) },
                                enabled = !state.loading,
                            ) { Text("打开会话") }
                            if (isActiveBackgroundTask(task)) {
                                OutlinedButton(
                                    onClick = { model.cancelBackgroundTask(task.id) },
                                    enabled = !state.offline && !state.loading,
                                ) { Text("取消") }
                            } else {
                                TextButton(
                                    onClick = { model.deleteBackgroundTask(task.id) },
                                    enabled = !state.offline && !state.loading,
                                ) { Text("删除") }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SchedulesScreen(state: UmaUiState, model: UmaViewModel, modifier: Modifier = Modifier) {
    var showForm by rememberSaveable { mutableStateOf(false) }
    var name by rememberSaveable { mutableStateOf("") }
    var prompt by rememberSaveable { mutableStateOf("") }
    var kind by rememberSaveable { mutableStateOf("interval") }
    var value by rememberSaveable { mutableStateOf("3600000") }
    var timezone by rememberSaveable { mutableStateOf("Asia/Shanghai") }

    LaunchedEffect(Unit) { model.loadScheduledTasks() }

    LazyColumn(
        modifier,
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text("调度", style = MaterialTheme.typography.titleMedium)
                OutlinedButton({ showForm = !showForm }, enabled = !state.offline && !state.loading) {
                    Text(if (showForm) "收起" else "新建")
                }
            }
        }
        if (showForm) {
            item {
                Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.small) {
                    Column(
                        Modifier.fillMaxWidth().padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        OutlinedTextField(
                            value = name,
                            onValueChange = { if (it.length <= 200) name = it },
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text("名称") },
                            singleLine = true,
                            enabled = !state.loading,
                        )
                        OutlinedTextField(
                            value = prompt,
                            onValueChange = { if (it.length <= 1_000_000) prompt = it },
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text("任务") },
                            minLines = 2,
                            maxLines = 5,
                            enabled = !state.loading,
                        )
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            listOf("once" to "一次性", "interval" to "按间隔", "cron" to "Cron").forEach { (candidate, label) ->
                                val selected = kind == candidate
                                if (selected) {
                                    Button({ kind = candidate }, Modifier.weight(1f), enabled = !state.loading) { Text(label) }
                                } else {
                                    OutlinedButton({
                                        kind = candidate
                                        value = when (candidate) {
                                            "once" -> java.time.Instant.ofEpochMilli(System.currentTimeMillis() + 60_000).toString()
                                            "cron" -> "0 9 * * *"
                                            else -> "3600000"
                                        }
                                    }, Modifier.weight(1f), enabled = !state.loading) { Text(label) }
                                }
                            }
                        }
                        OutlinedTextField(
                            value = value,
                            onValueChange = { if (it.length <= 200) value = it },
                            modifier = Modifier.fillMaxWidth(),
                            label = {
                                Text(when (kind) {
                                    "once" -> "ISO 时间"
                                    "cron" -> "Cron 表达式"
                                    else -> "间隔毫秒"
                                })
                            },
                            singleLine = true,
                            enabled = !state.loading,
                        )
                        if (kind == "cron") {
                            OutlinedTextField(
                                value = timezone,
                                onValueChange = { if (it.length <= 100) timezone = it },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text("时区") },
                                singleLine = true,
                                enabled = !state.loading,
                            )
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(
                                onClick = {
                                    model.createScheduledTask(name, prompt, kind, value, timezone)
                                    showForm = false
                                    name = ""
                                    prompt = ""
                                },
                                modifier = Modifier.weight(1f),
                                enabled = name.isNotBlank() && prompt.isNotBlank() && value.isNotBlank() &&
                                    !state.offline && !state.loading,
                            ) { Text("创建") }
                            OutlinedButton(
                                onClick = { showForm = false },
                                modifier = Modifier.weight(1f),
                                enabled = !state.loading,
                            ) { Text("取消") }
                        }
                    }
                }
            }
        }
        if (state.scheduledTasks.isEmpty()) {
            item { Text("暂无调度任务", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        } else {
            items(state.scheduledTasks, key = { it.id }) { schedule ->
                Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.small) {
                    Column(
                        Modifier.fillMaxWidth().padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Row(
                            Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(schedule.name, style = MaterialTheme.typography.titleSmall)
                            Text(
                                if (schedule.enabled) "已启用" else "已停用",
                                color = if (schedule.enabled) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.labelMedium,
                            )
                        }
                        Text(schedule.prompt, maxLines = 5)
                        Text(
                            "${scheduledKindLabel(schedule.scheduleKind)}：${schedule.scheduleValue}" +
                                (schedule.timezone?.let { " · $it" } ?: ""),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        schedule.nextRunAt?.let {
                            Text("下次运行：${java.text.DateFormat.getDateTimeInstance().format(java.util.Date(it))}", style = MaterialTheme.typography.bodySmall)
                        }
                        Row(
                            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            OutlinedButton(
                                onClick = { model.runScheduledTask(schedule.id) },
                                enabled = !state.offline && !state.loading,
                            ) { Text("立即运行") }
                            OutlinedButton(
                                onClick = { model.toggleScheduledTask(schedule.id, !schedule.enabled) },
                                enabled = !state.offline && !state.loading,
                            ) { Text(if (schedule.enabled) "停用" else "启用") }
                            OutlinedButton(
                                onClick = { model.loadScheduledRuns(schedule.id) },
                                enabled = !state.offline && !state.loading,
                            ) { Text("运行历史") }
                            TextButton(
                                onClick = { model.deleteScheduledTask(schedule.id) },
                                enabled = !state.offline && !state.loading,
                            ) { Text("删除") }
                        }
                        state.scheduledRuns[schedule.id]?.let { runs ->
                            HorizontalDivider()
                            if (runs.isEmpty()) {
                                Text("暂无运行记录", style = MaterialTheme.typography.bodySmall)
                            } else {
                                runs.forEach { run ->
                                    Row(
                                        Modifier.fillMaxWidth(),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.SpaceBetween,
                                    ) {
                                        Text(
                                            "${run.trigger} · ${scheduledRunStatusLabel(run.status)} · " +
                                                java.text.DateFormat.getDateTimeInstance().format(java.util.Date(run.scheduledFor)),
                                            modifier = Modifier.weight(1f),
                                            style = MaterialTheme.typography.bodySmall,
                                        )
                                        if (isActiveScheduledRun(run)) {
                                            TextButton(
                                                onClick = { model.cancelScheduledRun(schedule.id, run.id) },
                                                enabled = !state.offline && !state.loading,
                                            ) { Text("取消") }
                                        }
                                    }
                                    run.error?.takeIf { it.isNotBlank() }?.let { error ->
                                        Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ResourcesScreen(state: UmaUiState, model: UmaViewModel, modifier: Modifier = Modifier) {
    var attachmentId by rememberSaveable { mutableStateOf("") }
    var pendingDownloadId by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var conversationId by rememberSaveable { mutableStateOf("") }
    var itemId by rememberSaveable { mutableStateOf("") }
    var receiverId by rememberSaveable { mutableStateOf("") }
    var chatItemId by rememberSaveable { mutableStateOf("") }
    val saveAttachmentPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("application/octet-stream"),
    ) { uri ->
        if (uri != null && pendingDownloadId.isNotBlank()) model.downloadAttachment(pendingDownloadId, uri)
        pendingDownloadId = ""
    }
    val resourceActions = resourceActionsForRole(state.userRole)

    LazyColumn(
        modifier,
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { Text("服务端资源", style = MaterialTheme.typography.titleMedium) }
        item {
            resourceActions.chunked(2).forEach { row ->
                Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { (path, label) ->
                        OutlinedButton(
                            { model.loadResource(path) },
                            Modifier.weight(1f),
                            enabled = !state.offline && !state.loading,
                        ) { Text(label) }
                    }
                    if (row.size == 1) Box(Modifier.weight(1f))
                }
            }
        }
        if (state.resourceData.isNotBlank()) {
            item { ReadOnlyOutput(state.resourceData) }
        }
        item { HorizontalDivider(Modifier.padding(vertical = 4.dp)) }
        item { Text("附件下载", style = MaterialTheme.typography.titleMedium) }
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    attachmentId,
                    { attachmentId = it },
                    Modifier.weight(1f),
                    label = { Text("附件 ID") },
                    singleLine = true,
                )
                Button(
                    { pendingDownloadId = attachmentId.trim(); saveAttachmentPicker.launch("attachment") },
                    enabled = !state.offline && attachmentId.isNotBlank() && !state.loading,
                ) { Text("下载") }
            }
        }
        if (state.attachmentData.isNotBlank()) item { Text(state.attachmentData) }
        item { HorizontalDivider(Modifier.padding(vertical = 4.dp)) }
        item { Text("闲鱼控制", style = MaterialTheme.typography.titleMedium) }
        item {
            OutlinedTextField(
                password,
                { password = it },
                Modifier.fillMaxWidth(),
                visualTransformation = PasswordVisualTransformation(),
                label = { Text("管理员密码") },
                singleLine = true,
            )
        }
        item {
            Button(
                { model.unlockXianyu(password); password = "" },
                Modifier.fillMaxWidth(),
                enabled = password.isNotBlank() && !state.loading,
            ) { Text("解锁") }
        }
        if (state.xianyuStatus.isNotBlank()) {
            item { ReadOnlyOutput(state.xianyuStatus) }
            item {
                ActionRows(
                    listOf(
                        "启动" to { model.xianyuAction("start") },
                        "暂停" to { model.xianyuAction("pause") },
                        "恢复" to { model.xianyuAction("resume") },
                        "停止" to { model.xianyuAction("stop") },
                    ),
                    enabled = !state.offline && !state.loading,
                )
            }
            item {
                ResourceQuery(
                    "闲鱼会话 ID",
                    conversationId,
                    { conversationId = it },
                    "历史",
                    enabled = !state.offline && !state.loading,
                ) {
                    model.xianyuHistory(conversationId)
                }
            }
            item {
                ResourceQuery(
                    "商品 ID",
                    itemId,
                    { itemId = it },
                    "查询",
                    enabled = !state.offline && !state.loading,
                ) { model.xianyuItem(itemId) }
            }
            item {
                OutlinedTextField(receiverId, { receiverId = it }, Modifier.fillMaxWidth(), label = { Text("买家 ID") }, singleLine = true)
            }
            item {
                OutlinedTextField(chatItemId, { chatItemId = it }, Modifier.fillMaxWidth(), label = { Text("建聊商品 ID") }, singleLine = true)
            }
            item {
                Button(
                    { model.xianyuChat(receiverId, chatItemId) },
                    Modifier.fillMaxWidth(),
                    enabled = receiverId.isNotBlank() && chatItemId.isNotBlank() && !state.offline && !state.loading,
                ) { Text("发起会话") }
            }
            if (state.xianyuData.isNotBlank()) item { ReadOnlyOutput(state.xianyuData) }
        }
    }
}

@Composable
private fun SettingsScreen(state: UmaUiState, model: UmaViewModel, modifier: Modifier = Modifier) {
    LazyColumn(
        modifier,
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item { UpdatePanel(state, model) }
        item { HorizontalDivider() }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("连接", style = MaterialTheme.typography.titleMedium)
                Text(BuildConfig.UMA_BASE_URL, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(if (state.offline) "离线只读" else "服务正常", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        item {
            OutlinedButton({ model.logout() }, Modifier.fillMaxWidth()) { Text("退出登录") }
        }
    }
}

@Composable
private fun UpdatePanel(state: UmaUiState, model: UmaViewModel) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("应用更新", style = MaterialTheme.typography.titleMedium)
        Text("当前版本 ${BuildConfig.VERSION_NAME}（${BuildConfig.VERSION_CODE}）")
        when {
            state.updateChecking -> Text("正在检查更新")
            state.updateDownloading -> Text("正在下载 ${state.updateProgress}%")
            state.updateManifest != null -> {
                Text("发现新版本 ${state.updateManifest.versionName}", color = MaterialTheme.colorScheme.primary)
                state.updateManifest.releaseNotes.take(3).forEach { Text("• $it") }
                Button({ model.downloadUpdate() }, Modifier.fillMaxWidth()) { Text("下载并安装") }
            }
            else -> Text("已是最新版本", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (state.updateError.isNotBlank()) Text(state.updateError, color = MaterialTheme.colorScheme.error)
        OutlinedButton(
            { model.checkForUpdate() },
            Modifier.fillMaxWidth(),
            enabled = !state.updateChecking && !state.updateDownloading,
        ) { Text("检查更新") }
    }
}

@Composable
private fun AssistantAvatar(bytes: ByteArray?, size: Dp) {
    val bitmap = remember(bytes) { bytes?.let { BitmapFactory.decodeByteArray(it, 0, it.size) } }
    if (bitmap != null) {
        Image(
            bitmap.asImageBitmap(),
            contentDescription = "助手头像",
            modifier = Modifier.size(size).clip(CircleShape),
            contentScale = ContentScale.Crop,
        )
    } else {
        Image(
            painterResource(R.drawable.cat_avatar),
            contentDescription = "默认助手头像",
            modifier = Modifier.size(size).clip(CircleShape),
            contentScale = ContentScale.Crop,
        )
    }
}

@Composable
private fun ActionRows(actions: List<Pair<String, () -> Unit>>, enabled: Boolean) {
    actions.chunked(2).forEach { row ->
        Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            row.forEach { (label, action) ->
                OutlinedButton(action, Modifier.weight(1f), enabled = enabled) { Text(label) }
            }
            if (row.size == 1) Box(Modifier.weight(1f))
        }
    }
}

@Composable
private fun ResourceQuery(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    actionLabel: String,
    enabled: Boolean,
    action: () -> Unit,
) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(value, onValueChange, Modifier.weight(1f), label = { Text(label) }, singleLine = true)
        Button(action, enabled = enabled && value.isNotBlank()) { Text(actionLabel) }
    }
}

@Composable
private fun ReadOnlyOutput(value: String) {
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.small) {
        SelectionContainer {
            Text(value, Modifier.fillMaxWidth().padding(12.dp), style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun ErrorBanner(message: String) {
    if (message.isBlank()) return
    Surface(color = MaterialTheme.colorScheme.errorContainer) {
        Text(
            message,
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            color = MaterialTheme.colorScheme.onErrorContainer,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}
