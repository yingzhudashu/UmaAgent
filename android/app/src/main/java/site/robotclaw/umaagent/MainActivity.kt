package site.robotclaw.umaagent

import android.app.Application
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.Image
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import android.graphics.BitmapFactory
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.WebSocket

data class UmaUiState(
    val tokenPresent: Boolean = false,
    val sessions: List<Session> = emptyList(),
    val selectedSessionId: String? = null,
    val assistantAvatarBytes: ByteArray? = null,
    val snapshot: String = "",
    val xianyuStatus: String = "",
    val xianyuData: String = "",
    val resourceData: String = "",
    val attachmentData: String = "",
    val pendingAttachmentIds: List<String> = emptyList(),
    val pendingAttachments: List<PendingAttachment> = emptyList(),
    val offline: Boolean = false,
    val loading: Boolean = false,
    val error: String = "",
)

class UmaViewModel(application: Application) : AndroidViewModel(application) {
    private val patStore = PatStore(application)
    private val cache = SnapshotCache(application)
    private val state = MutableStateFlow(UmaUiState())
    val uiState = state.asStateFlow()
    private var api: UmaApi? = null
    private var socket: WebSocket? = null
    private var reconnect: Job? = null
    private var grant: String? = null
    private var grantExpiry: Job? = null
    private var sessions = emptyList<BootstrapEntry>()
    private val sequences = mutableMapOf<String, Long>()
    private val json = Json { ignoreUnknownKeys = true }

    init {
        val cached = cache.read()
        if (cached != null) {
            sequences.putAll(cached.sequences)
            state.value = state.value.copy(sessions = cached.sessions)
        }
        patStore.read()?.let {
            api = UmaApi(it)
            state.value = state.value.copy(tokenPresent = true, offline = cached != null)
            login(it, persist = false)
        }
    }

    fun login(token: String, persist: Boolean = true) {
        if (token.isBlank()) return
        viewModelScope.launch {
            state.value = state.value.copy(loading = true, error = "")
            try {
                val client = UmaApi(token)
                val bootstrap = client.bootstrap()
                api = client
                sessions = bootstrap.sessions
                sequences.clear()
                bootstrap.sessions.forEach { sequences[it.session.id] = it.lastSequence }
                if (persist) withContext(Dispatchers.IO) { patStore.save(token) }
                state.value = state.value.copy(tokenPresent = true, sessions = bootstrap.sessions.map { it.session }, offline = false, loading = false)
                val selected = state.value.selectedSessionId ?: bootstrap.sessions.firstOrNull()?.session?.id
                if (selected != null) selectSession(selected)
                openSocket()
            } catch (error: Throwable) {
                state.value = state.value.copy(loading = false, offline = true, error = error.message ?: "登录失败")
            }
        }
    }

    fun logout() {
        socket?.close(1000, "logout"); socket = null; reconnect?.cancel(); api = null
        grant = null; grantExpiry?.cancel(); grantExpiry = null
        patStore.clear(); cache.clear(); sessions = emptyList(); sequences.clear(); state.value = UmaUiState()
    }

    fun selectSession(id: String) {
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(selectedSessionId = id, loading = true, error = "")
            try {
                val snapshot = client.snapshot(id)
                val encoded = snapshot.toString()
                val avatarId = state.value.sessions.firstOrNull { it.id == id }?.assistantAvatarAttachmentId
                val avatarBytes = avatarId?.let { runCatching { client.attachmentBytes(it) }.getOrNull() }
                withContext(Dispatchers.IO) {
                    val current = cache.read()
                    val next = (current?.snapshots ?: emptyMap()) + (id to encoded)
                    cache.write(CacheEnvelope(2, state.value.sessions, next, sequences))
                }
                state.value = state.value.copy(snapshot = encoded, assistantAvatarBytes = avatarBytes, offline = false, loading = false)
            } catch (error: Throwable) {
                val cached = cache.read()?.snapshots?.get(id)
                state.value = state.value.copy(snapshot = cached ?: "", assistantAvatarBytes = null, offline = true, loading = false, error = error.message ?: "无法读取会话")
            }
        }
    }

    fun send(text: String) {
        val id = state.value.selectedSessionId ?: return
        if (state.value.offline || (text.isBlank() && state.value.pendingAttachmentIds.isEmpty())) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            try {
                client.send(id, text.ifBlank { "请分析这张图片。" }, state.value.pendingAttachmentIds)
                selectSession(id)
                state.value = state.value.copy(
                    offline = false,
                    pendingAttachmentIds = emptyList(),
                    pendingAttachments = emptyList(),
                    attachmentData = "",
                )
            } catch (error: Throwable) {
                state.value = state.value.copy(loading = false, offline = true, error = error.message ?: "发送失败")
            }
        }
    }

    fun uploadAttachment(uri: Uri, name: String) {
        val sessionId = state.value.selectedSessionId ?: return
        if (state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runCatching { client.upload(getApplication(), uri, name, sessionId) }
                .onSuccess { attachment ->
                    val id = attachment["id"]?.jsonPrimitive?.content
                    val uploaded = id?.let {
                        PendingAttachment(
                            id = it,
                            name = attachment["name"]?.jsonPrimitive?.content ?: name,
                            size = attachment["size"]?.jsonPrimitive?.longOrNull ?: 0L,
                        )
                    }
                    state.value = state.value.copy(
                        attachmentData = attachment.toString(),
                        pendingAttachmentIds = id?.let { state.value.pendingAttachmentIds + it }
                            ?: state.value.pendingAttachmentIds,
                        pendingAttachments = uploaded?.let { state.value.pendingAttachments + it }
                            ?: state.value.pendingAttachments,
                        loading = false,
                    )
                    selectSession(sessionId)
                }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "附件上传失败") }
        }
    }

    fun removePendingAttachment(id: String) {
        state.value = state.value.copy(
            pendingAttachmentIds = state.value.pendingAttachmentIds.filterNot { it == id },
            pendingAttachments = state.value.pendingAttachments.filterNot { it.id == id },
        )
    }

    fun downloadAttachment(id: String, destination: Uri) {
        if (state.value.offline || id.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runCatching { client.downloadAttachment(getApplication(), id.trim(), destination) }
                .onSuccess { bytes -> state.value = state.value.copy(attachmentData = "已下载 ${bytes} bytes", loading = false) }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "附件下载失败") }
        }
    }

    fun createSession(title: String) {
        if (state.value.offline || title.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runCatching { client.createSession(title.trim()) }
                .onSuccess { session ->
                    sessions = sessions + BootstrapEntry(session)
                    state.value = state.value.copy(sessions = sessions.map { it.session }, selectedSessionId = session.id, loading = false)
                    persistCache()
                    selectSession(session.id)
                }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "创建会话失败") }
        }
    }

    fun renameSession(title: String) {
        val id = state.value.selectedSessionId ?: return
        if (state.value.offline || title.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runCatching { client.renameSession(id, title.trim()) }
                .onSuccess { session ->
                    sessions = sessions.map { if (it.session.id == id) it.copy(session = session) else it }
                    state.value = state.value.copy(sessions = sessions.map { it.session }, loading = false)
                    persistCache()
                }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "重命名失败") }
        }
    }

    fun updateAssistantName(name: String) {
        val id = state.value.selectedSessionId ?: return
        if (state.value.offline || name.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runCatching { client.updateAssistantIdentity(id, name = name.trim()) }
                .onSuccess { session ->
                    sessions = sessions.map { if (it.session.id == id) it.copy(session = session) else it }
                    state.value = state.value.copy(sessions = sessions.map { it.session }, loading = false)
                    persistCache()
                }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "助手名称更新失败") }
        }
    }

    fun uploadAssistantAvatar(uri: Uri, name: String) {
        val id = state.value.selectedSessionId ?: return
        if (state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runCatching {
                val attachment = client.upload(getApplication(), uri, name, id)
                val attachmentId = attachment["id"]?.jsonPrimitive?.content ?: error("头像附件无 ID")
                client.updateAssistantIdentity(id, avatarAttachmentId = attachmentId)
            }.onSuccess { session ->
                sessions = sessions.map { if (it.session.id == id) it.copy(session = session) else it }
                state.value = state.value.copy(sessions = sessions.map { it.session }, loading = false)
                persistCache()
            }.onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "头像上传失败") }
        }
    }

    fun resetAssistantAvatar() {
        val id = state.value.selectedSessionId ?: return
        if (state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runCatching { client.updateAssistantIdentity(id, clearAvatar = true) }
                .onSuccess { session ->
                    sessions = sessions.map { if (it.session.id == id) it.copy(session = session) else it }
                    state.value = state.value.copy(sessions = sessions.map { it.session }, loading = false)
                    persistCache()
                }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "头像恢复失败") }
        }
    }

    fun deleteSelectedSession() {
        val id = state.value.selectedSessionId ?: return
        if (state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runCatching { client.deleteSession(id) }
                .onSuccess {
                    sessions = sessions.filterNot { it.session.id == id }
                    state.value = state.value.copy(sessions = sessions.map { it.session }, selectedSessionId = null, snapshot = "", loading = false)
                    persistCache()
                }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "删除会话失败") }
        }
    }

    fun cancelSelectedSession() {
        val id = state.value.selectedSessionId ?: return
        if (state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            runCatching { client.cancelSession(id) }
                .onFailure { error -> state.value = state.value.copy(error = error.message ?: "取消失败") }
        }
    }

    fun compactSelectedSession() {
        val id = state.value.selectedSessionId ?: return
        if (state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            runCatching { client.compactSession(id); selectSession(id) }
                .onFailure { error -> state.value = state.value.copy(error = error.message ?: "压缩失败") }
        }
    }

    fun unlockXianyu(password: String) {
        if (password.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            try {
                val unlocked = client.unlock(password)
                grant = unlocked.grant
                grantExpiry?.cancel()
                grantExpiry = viewModelScope.launch {
                    delay((unlocked.expiresAt - System.currentTimeMillis()).coerceAtLeast(0))
                    grant = null
                    state.value = state.value.copy(xianyuStatus = "")
                }
                val status = client.xianyuStatus(unlocked.grant)
                val conversations = client.xianyuConversations(unlocked.grant)
                state.value = state.value.copy(xianyuStatus = status.toString(), xianyuData = conversations.toString(), loading = false, offline = false)
            } catch (error: Throwable) {
                state.value = state.value.copy(loading = false, error = error.message ?: "咸鱼解锁失败")
            }
        }
    }

    fun xianyuAction(action: String) {
        val currentGrant = grant ?: return
        if (state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runCatching { client.xianyuControl(currentGrant, action); client.xianyuStatus(currentGrant) }
                .onSuccess { status -> state.value = state.value.copy(xianyuStatus = status.toString(), loading = false) }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "咸鱼操作失败") }
        }
    }

    fun xianyuHistory(conversationId: String) {
        val currentGrant = grant ?: return
        viewModelScope.launch {
            val client = api ?: return@launch
            runCatching { client.xianyuHistory(currentGrant, conversationId) }
                .onSuccess { value -> state.value = state.value.copy(xianyuData = value.toString(), error = "") }
                .onFailure { error -> state.value = state.value.copy(error = error.message ?: "历史查询失败") }
        }
    }

    fun xianyuItem(itemId: String) {
        val currentGrant = grant ?: return
        viewModelScope.launch {
            val client = api ?: return@launch
            runCatching { client.xianyuItem(currentGrant, itemId) }
                .onSuccess { value -> state.value = state.value.copy(xianyuData = value.toString(), error = "") }
                .onFailure { error -> state.value = state.value.copy(error = error.message ?: "商品查询失败") }
        }
    }

    fun xianyuChat(receiverId: String, itemId: String) {
        val currentGrant = grant ?: return
        if (receiverId.isBlank() || itemId.isBlank() || state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            runCatching { client.xianyuChat(currentGrant, receiverId.trim(), itemId.trim()) }
                .onSuccess { value -> state.value = state.value.copy(xianyuData = value.toString(), error = "") }
                .onFailure { error -> state.value = state.value.copy(error = error.message ?: "建聊失败") }
        }
    }

    fun loadResource(path: String) {
        if (state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            runCatching { client.getJson(path) }
                .onSuccess { value -> state.value = state.value.copy(resourceData = value.toString(), error = "") }
                .onFailure { error -> state.value = state.value.copy(error = error.message ?: "资源加载失败") }
        }
    }

    fun runResourceAction(path: String) {
        if (state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            runCatching { client.postJson(path) }
                .onSuccess { value -> state.value = state.value.copy(resourceData = value.toString(), error = "") }
                .onFailure { error -> state.value = state.value.copy(error = error.message ?: "操作失败") }
        }
    }

    private fun persistCache() {
        viewModelScope.launch(Dispatchers.IO) {
            val current = cache.read()
            cache.write(
                CacheEnvelope(
                    version = 2,
                    sessions = state.value.sessions,
                    snapshots = current?.snapshots ?: emptyMap(),
                    sequences = sequences.toMap(),
                ),
            )
        }
    }

    private fun openSocket() {
        val client = api ?: return
        socket?.close(1000, "reconnect")
        socket = client.connectEvents(
            onOpen = { webSocket ->
                val token = patStore.read()
                if (token != null) {
                    webSocket.send(buildJsonObject { put("type", "auth"); put("token", token) }.toString())
                    val subscriptions = buildJsonArray {
                        sessions.forEach { add(buildJsonObject { put("id", it.session.id); put("lastSequence", sequences[it.session.id] ?: 0) }) }
                    }
                    webSocket.send(buildJsonObject { put("type", "subscribe"); put("sessions", subscriptions) }.toString())
                }
                state.value = state.value.copy(offline = false)
            },
            onText = { message -> viewModelScope.launch { handleEvent(message) } },
            onFailure = { scheduleReconnect() },
        )
    }

    private suspend fun handleEvent(message: String) {
        val element = try { json.parseToJsonElement(message) } catch (_: Exception) { return }
        val objectValue = element as? JsonObject ?: return
        val sessionId = objectValue["sessionId"]?.jsonPrimitive?.content ?: return
        val sequence = objectValue["sequence"]?.jsonPrimitive?.longOrNull ?: return
        if (sequence == 0L) return
        val previous = sequences[sessionId] ?: 0
        val decision = SequenceTracker.inspect(previous, sequence)
        if (!decision.accept) return
        val client = api ?: return
        var latest = previous
        if (sequence > previous + 1) {
            var cursor = previous
            var hasMore = true
            while (hasMore) {
                val page = client.events(sessionId, cursor)
                val events = page["events"]?.let { element ->
                    (element as? kotlinx.serialization.json.JsonArray)?.mapNotNull { it as? JsonObject }
                }.orEmpty()
                for (event in events) {
                    val eventSequence = event["sequence"]?.jsonPrimitive?.longOrNull ?: continue
                    if (eventSequence > latest) latest = eventSequence
                }
                cursor = page["nextSequence"]?.jsonPrimitive?.longOrNull ?: latest
                latest = maxOf(latest, cursor)
                hasMore = page["hasMore"]?.jsonPrimitive?.booleanOrNull == true
                if (hasMore && cursor <= previous) break
            }
        }
        sequences[sessionId] = SequenceTracker.merge(previous, listOf(latest, sequence))
        runCatching {
            val snapshot = client.snapshot(sessionId)
            val encoded = snapshot.toString()
            withContext(Dispatchers.IO) {
                val current = cache.read()
                cache.write(CacheEnvelope(2, state.value.sessions, (current?.snapshots ?: emptyMap()) + (sessionId to encoded), sequences))
            }
            if (sessionId == state.value.selectedSessionId)
                state.value = state.value.copy(snapshot = encoded, offline = false)
        }.onFailure {
            state.value = state.value.copy(offline = true)
        }
    }

    private fun scheduleReconnect() {
        state.value = state.value.copy(offline = true)
        if (reconnect?.isActive == true) return
        reconnect = viewModelScope.launch {
            delay(2_000)
            if (api != null) openSocket()
        }
    }

    override fun onCleared() { socket?.close(1000, "cleared"); super.onCleared() }
}

class MainActivity : ComponentActivity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setContent { MaterialTheme { UmaScreen() } }
    }
}

@Composable
fun UmaScreen(model: UmaViewModel = viewModel()) {
    val state by model.uiState.collectAsState()
    var token by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("") }
    var newTitle by remember { mutableStateOf("") }
    var assistantName by remember { mutableStateOf("UmaAgent") }
    var itemId by remember { mutableStateOf("") }
    var conversationId by remember { mutableStateOf("") }
    var receiverId by remember { mutableStateOf("") }
    var chatItemId by remember { mutableStateOf("") }
    var attachmentId by remember { mutableStateOf("") }
    var pendingDownloadId by remember { mutableStateOf("") }
    val attachmentPicker = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.OpenDocument(),
    ) { uri ->
        if (uri != null) model.uploadAttachment(uri, "attachment")
    }
    val saveAttachmentPicker = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.CreateDocument("application/octet-stream"),
    ) { uri ->
        if (uri != null && pendingDownloadId.isNotBlank()) model.downloadAttachment(pendingDownloadId, uri)
        pendingDownloadId = ""
    }
    val avatarPicker = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.OpenDocument(),
    ) { uri -> if (uri != null) model.uploadAssistantAvatar(uri, "assistant-avatar") }
    val selectedSession = state.sessions.firstOrNull { it.id == state.selectedSessionId }
    LaunchedEffect(selectedSession?.id, selectedSession?.assistantName) {
        assistantName = selectedSession?.assistantName ?: "UmaAgent"
    }
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (!state.tokenPresent) {
            OutlinedTextField(
                token,
                { token = it },
                Modifier.fillMaxWidth(),
                visualTransformation = PasswordVisualTransformation(),
                label = { Text("PAT") },
            )
            Button({ model.login(token) }, enabled = token.isNotBlank() && !state.loading) { Text("登录") }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(if (state.offline) "离线只读" else "已连接", style = MaterialTheme.typography.titleMedium)
                Button({ model.logout() }) { Text("退出") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(newTitle, { newTitle = it }, label = { Text("新会话标题") }, modifier = Modifier.weight(1f))
                Button({ model.createSession(newTitle); newTitle = "" }, enabled = !state.offline && newTitle.isNotBlank() && !state.loading) { Text("新建") }
            }
            LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
                items(state.sessions) { session ->
                    Button({ model.selectSession(session.id) }, Modifier.fillMaxWidth()) { Text(session.title) }
                }
            }
            Text("助手身份", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                assistantName,
                { assistantName = it },
                Modifier.fillMaxWidth(),
                label = { Text("助手名称") },
                enabled = !state.offline && !state.loading,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    { model.updateAssistantName(assistantName) },
                    enabled = !state.offline && assistantName.isNotBlank() && !state.loading && selectedSession != null,
                ) { Text("保存名称") }
                Button(
                    { avatarPicker.launch(arrayOf("image/*")) },
                    enabled = !state.offline && !state.loading && selectedSession != null,
                ) { Text("上传头像") }
                Button(
                    { model.resetAssistantAvatar() },
                    enabled = !state.offline && !state.loading && selectedSession?.assistantAvatarAttachmentId != null,
                ) { Text("恢复默认") }
            }
            Text(
                if (selectedSession?.assistantAvatarAttachmentId == null) "当前头像：默认 UmaAgent 头像"
                else "当前头像附件：" + selectedSession.assistantAvatarAttachmentId,
                Modifier.fillMaxWidth(),
            )
            state.assistantAvatarBytes?.let { bytes ->
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let { bitmap ->
                    Image(
                        bitmap.asImageBitmap(),
                        contentDescription = "助手头像预览",
                        modifier = Modifier.fillMaxWidth(),
                        contentScale = ContentScale.Fit,
                    )
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button({ model.renameSession(newTitle); newTitle = "" }, enabled = !state.offline && newTitle.isNotBlank() && state.selectedSessionId != null) { Text("重命名") }
                Button({ model.deleteSelectedSession() }, enabled = !state.offline && state.selectedSessionId != null) { Text("删除") }
                Button({ model.cancelSelectedSession() }, enabled = !state.offline && state.selectedSessionId != null) { Text("取消") }
                Button({ model.compactSelectedSession() }, enabled = !state.offline && state.selectedSessionId != null) { Text("压缩") }
            }
            val messages = parseSnapshotMessages(state.snapshot)
            if (messages.isNotEmpty()) {
                LazyColumn(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(messages, key = { it.id }) { item ->
                        val label = when (item.role) {
                            "user" -> "你"
                            "tool" -> "工具"
                            else -> state.sessions.firstOrNull { it.id == state.selectedSessionId }?.assistantName ?: "UmaAgent"
                        }
                        Text(
                            "$label${if (item.status == "streaming") "（生成中）" else ""}: ${item.content}" +
                                if (item.attachmentCount > 0) "\n附件 ${item.attachmentCount} 个" else "",
                            Modifier.fillMaxWidth(),
                        )
                    }
                }
            } else if (!state.offline) {
                Text("暂无消息", Modifier.fillMaxWidth())
            }
            Button({ attachmentPicker.launch(arrayOf("*/*")) }, enabled = !state.offline && state.selectedSessionId != null && !state.loading) { Text("上传附件") }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.fillMaxWidth()) {
                state.pendingAttachments.forEach { attachment ->
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.fillMaxWidth()) {
                        Text("${attachment.name} (${attachment.size} bytes)", modifier = Modifier.weight(1f))
                        Button({ model.removePendingAttachment(attachment.id) }, enabled = !state.loading) { Text("删除") }
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                OutlinedTextField(attachmentId, { attachmentId = it }, label = { Text("附件 ID") }, modifier = Modifier.weight(1f))
                Button({ pendingDownloadId = attachmentId.trim(); saveAttachmentPicker.launch("attachment") }, enabled = !state.offline && attachmentId.isNotBlank() && !state.loading) { Text("下载") }
            }
            if (state.attachmentData.isNotBlank()) Text(state.attachmentData, Modifier.fillMaxWidth())
            Text("服务端资源", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf("/models" to "模型", "/profile" to "Profile", "/tasks" to "任务", "/schedules" to "计划", "/memory" to "Memory").forEach { (path, label) ->
                    Button({ model.loadResource(path) }, enabled = !state.offline) { Text(label) }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf("/knowledge" to "知识库", "/skills" to "Skills", "/mcp" to "MCP", "/reports/diagnostics" to "诊断", "/evaluations" to "评测").forEach { (path, label) ->
                    Button({ model.loadResource(path) }, enabled = !state.offline) { Text(label) }
                }
            }
            if (state.resourceData.isNotBlank()) Text(state.resourceData, Modifier.fillMaxWidth())
            OutlinedTextField(message, { message = it }, Modifier.fillMaxWidth(), label = { Text("消息") })
            Button({ model.send(message); message = "" }, enabled = !state.offline && (message.isNotBlank() || state.pendingAttachmentIds.isNotEmpty()) && !state.loading) { Text("发送") }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    password,
                    { password = it },
                    visualTransformation = PasswordVisualTransformation(),
                    label = { Text("咸鱼管理员密码") },
                )
                Button({ model.unlockXianyu(password); password = "" }, enabled = password.isNotBlank() && !state.loading) { Text("解锁") }
            }
            if (state.xianyuStatus.isNotBlank()) Text(state.xianyuStatus)
            if (state.xianyuStatus.isNotBlank()) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("start" to "启动", "pause" to "暂停", "resume" to "恢复", "stop" to "停止").forEach { (action, label) ->
                        Button({ model.xianyuAction(action) }, enabled = !state.offline && !state.loading) { Text(label) }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(conversationId, { conversationId = it }, label = { Text("闲鱼会话 ID") }, modifier = Modifier.weight(1f))
                    Button({ model.xianyuHistory(conversationId) }, enabled = conversationId.isNotBlank() && !state.offline) { Text("历史") }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(itemId, { itemId = it }, label = { Text("商品 ID") }, modifier = Modifier.weight(1f))
                    Button({ model.xianyuItem(itemId) }, enabled = itemId.isNotBlank() && !state.offline) { Text("商品") }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(receiverId, { receiverId = it }, label = { Text("买家 ID") }, modifier = Modifier.weight(1f))
                    OutlinedTextField(chatItemId, { chatItemId = it }, label = { Text("建聊商品 ID") }, modifier = Modifier.weight(1f))
                    Button({ model.xianyuChat(receiverId, chatItemId) }, enabled = receiverId.isNotBlank() && chatItemId.isNotBlank() && !state.offline) { Text("建聊") }
                }
                if (state.xianyuData.isNotBlank()) Text(state.xianyuData, Modifier.fillMaxWidth())
            }
        }
        if (state.error.isNotBlank()) Text(state.error, color = MaterialTheme.colorScheme.error)
    }
}
