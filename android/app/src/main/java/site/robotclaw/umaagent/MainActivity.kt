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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
    val snapshot: String = "",
    val xianyuStatus: String = "",
    val xianyuData: String = "",
    val resourceData: String = "",
    val attachmentData: String = "",
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
                withContext(Dispatchers.IO) {
                    val current = cache.read()
                    val next = (current?.snapshots ?: emptyMap()) + (id to encoded)
                    cache.write(CacheEnvelope(2, state.value.sessions, next, sequences))
                }
                state.value = state.value.copy(snapshot = encoded, offline = false, loading = false)
            } catch (error: Throwable) {
                val cached = cache.read()?.snapshots?.get(id)
                state.value = state.value.copy(snapshot = cached ?: "", offline = true, loading = false, error = error.message ?: "无法读取会话")
            }
        }
    }

    fun send(text: String) {
        val id = state.value.selectedSessionId ?: return
        if (state.value.offline || text.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            try {
                client.send(id, text); selectSession(id); state.value = state.value.copy(offline = false)
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
                    state.value = state.value.copy(attachmentData = attachment.toString(), loading = false)
                    selectSession(sessionId)
                }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "附件上传失败") }
        }
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
                }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "重命名失败") }
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

    fun xianyuPublish(description: String, images: String, delivery: String) {
        val currentGrant = grant ?: return
        val imagePaths = images.split(",").map { it.trim() }.filter { it.isNotEmpty() }
        if (description.isBlank() || imagePaths.isEmpty() || state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            runCatching { client.xianyuPublish(currentGrant, description.trim(), imagePaths, delivery) }
                .onSuccess { value -> state.value = state.value.copy(xianyuData = value.toString(), error = "") }
                .onFailure { error -> state.value = state.value.copy(error = error.message ?: "发布失败") }
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
    var itemId by remember { mutableStateOf("") }
    var conversationId by remember { mutableStateOf("") }
    var receiverId by remember { mutableStateOf("") }
    var chatItemId by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var images by remember { mutableStateOf("") }
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
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button({ model.renameSession(newTitle); newTitle = "" }, enabled = !state.offline && newTitle.isNotBlank() && state.selectedSessionId != null) { Text("重命名") }
                Button({ model.deleteSelectedSession() }, enabled = !state.offline && state.selectedSessionId != null) { Text("删除") }
                Button({ model.cancelSelectedSession() }, enabled = !state.offline && state.selectedSessionId != null) { Text("取消") }
                Button({ model.compactSelectedSession() }, enabled = !state.offline && state.selectedSessionId != null) { Text("压缩") }
            }
            if (state.snapshot.isNotBlank()) Text(state.snapshot, Modifier.fillMaxWidth())
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button({ attachmentPicker.launch(arrayOf("*/*")) }, enabled = !state.offline && state.selectedSessionId != null && !state.loading) { Text("上传附件") }
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
            Button({ model.send(message); message = "" }, enabled = !state.offline && message.isNotBlank() && !state.loading) { Text("发送") }
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
                OutlinedTextField(description, { description = it }, Modifier.fillMaxWidth(), label = { Text("发布描述") })
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(images, { images = it }, label = { Text("图片路径（逗号分隔）") }, modifier = Modifier.weight(1f))
                    Button({ model.xianyuPublish(description, images, "free_shipping") }, enabled = description.isNotBlank() && images.isNotBlank() && !state.offline) { Text("发布") }
                }
                if (state.xianyuData.isNotBlank()) Text(state.xianyuData, Modifier.fillMaxWidth())
            }
            if (state.error.isNotBlank()) Text(state.error, color = MaterialTheme.colorScheme.error)
        }
        if (state.error.isNotBlank()) Text(state.error, color = MaterialTheme.colorScheme.error)
    }
}
