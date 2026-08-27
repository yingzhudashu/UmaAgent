package site.robotclaw.umaagent

import android.app.Application
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
        if (cached != null) state.value = state.value.copy(sessions = cached.sessions)
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
        patStore.clear(); state.value = UmaUiState()
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
                    cache.write(CacheEnvelope(1, state.value.sessions, next))
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
                state.value = state.value.copy(xianyuStatus = status.toString(), loading = false, offline = false)
            } catch (error: Throwable) {
                state.value = state.value.copy(loading = false, error = error.message ?: "咸鱼解锁失败")
            }
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
        if (sequence <= previous) return
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
        sequences[sessionId] = maxOf(latest, sequence)
        runCatching {
            val snapshot = client.snapshot(sessionId)
            val encoded = snapshot.toString()
            withContext(Dispatchers.IO) {
                val current = cache.read()
                cache.write(CacheEnvelope(1, state.value.sessions, (current?.snapshots ?: emptyMap()) + (sessionId to encoded)))
            }
            if (sessionId == state.value.selectedSessionId)
                state.value = state.value.copy(snapshot = encoded, offline = false)
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
            LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
                items(state.sessions) { session ->
                    Button({ model.selectSession(session.id) }, Modifier.fillMaxWidth()) { Text(session.title) }
                }
            }
            if (state.snapshot.isNotBlank()) Text(state.snapshot, Modifier.fillMaxWidth())
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
        }
        if (state.error.isNotBlank()) Text(state.error, color = MaterialTheme.colorScheme.error)
    }
}
