package site.robotclaw.umaagent

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** 普通工作区按页面进入时加载数据，列表使用稳定业务标识。 */
@Composable
internal fun SessionsScreen(
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
internal fun TasksScreen(
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
internal fun SchedulesScreen(state: UmaUiState, model: UmaViewModel, modifier: Modifier = Modifier) {
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
internal fun ResourcesScreen(state: UmaUiState, model: UmaViewModel, modifier: Modifier = Modifier) {
    var attachmentId by rememberSaveable { mutableStateOf("") }
    var pendingDownloadId by rememberSaveable { mutableStateOf("") }
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
            item { ReadOnlyOutput(state.resourceData, "资源结果") }
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
        if (state.attachmentData.isNotBlank()) item { ReadOnlyOutput(state.attachmentData, "附件状态") }
    }
}
