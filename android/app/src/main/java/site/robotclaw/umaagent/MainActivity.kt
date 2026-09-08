package site.robotclaw.umaagent

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.core.view.WindowCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.WebSocket
import android.os.Build

data class UmaUiState(
    val stagingAccessRequired: Boolean = false,
    val tokenPresent: Boolean = false,
    val userRole: String = "user",
    val registrationToken: String = "",
    val interactionMode: String = "agent",
    val sessions: List<Session> = emptyList(),
    val selectedSessionId: String? = null,
    val assistantAvatarBytes: ByteArray? = null,
    val snapshot: String = "",
    val xianyuStatus: String = "",
    val xianyuLogin: String = "",
    val workspace: String = "agent",
    val xianyuAutoReply: Boolean = false,
    val xianyuDraftMessageIds: Map<String, Set<String>> = emptyMap(),
    val xianyuData: String = "",
    val resourceData: String = "",
    val attachmentData: String = "",
    val attachmentPreview: AttachmentPreview? = null,
    val backgroundTasks: List<UiBackgroundTask> = emptyList(),
    val scheduledTasks: List<UiScheduledTask> = emptyList(),
    val scheduledRuns: Map<String, List<UiScheduledRun>> = emptyMap(),
    val queue: List<UiQueueItem> = emptyList(),
    val pendingAttachmentIds: List<String> = emptyList(),
    val pendingAttachments: List<PendingAttachment> = emptyList(),
    val offline: Boolean = false,
    val loading: Boolean = false,
    val error: String = "",
    val updateManifest: UpdateManifest? = null,
    val updateChecking: Boolean = false,
    val updateDownloading: Boolean = false,
    val updateProgress: Int = 0,
    val updateError: String = "",
    val updateFilePath: String? = null,
)

data class AttachmentPreview(
    val id: String,
    val name: String,
    val bytes: ByteArray,
)

class UmaViewModel(application: Application) : AndroidViewModel(application) {
    private val patStore = PatStore(application)
    private val stagingAuthStore = StagingAuthStore(application)
    private val cache = SnapshotCache(application)
    private val state = MutableStateFlow(UmaUiState())
    val uiState = state.asStateFlow()
    private var api: UmaApi? = null
    private var socket: WebSocket? = null
    private var reconnect: Job? = null
    private var xianyuLoginPoll: Job? = null
    private var sessions = emptyList<BootstrapEntry>()
    private val sequences = mutableMapOf<String, Long>()
    private val json = Json { ignoreUnknownKeys = true }
    private val localStorageLock = Any()

    /** 将后台存储写入与账号清理串行化，阻止旧账号的迟到写入恢复已删除的缓存。 */
    private suspend fun <T> localStorage(action: () -> T): T = withContext(Dispatchers.IO) {
        val context = coroutineContext
        synchronized(localStorageLock) {
            context.ensureActive()
            action()
        }
    }

    private fun stagingPassword(): String? = if (BuildConfig.STAGING_BUILD) stagingAuthStore.read() else null
    private fun client(token: String = ""): UmaApi = UmaApi(token, BuildConfig.UMA_BASE_URL, stagingPassword())

    init {
        val cached = cache.read()
        if (cached != null) {
            sequences.putAll(cached.sequences)
            state.value = state.value.copy(sessions = cached.sessions)
        }
        val stagingAccessMissing = BuildConfig.STAGING_BUILD && stagingPassword() == null
        state.value = state.value.copy(stagingAccessRequired = stagingAccessMissing)
        patStore.read()?.takeIf { !stagingAccessMissing }?.let {
            state.value = state.value.copy(tokenPresent = cached != null, offline = cached != null)
            login(it, persist = false)
        }
        if (!stagingAccessMissing) checkForUpdate()
    }

    fun checkForUpdate() {
        if (state.value.updateChecking || state.value.updateDownloading) return
        viewModelScope.launch {
            state.value = state.value.copy(updateChecking = true, updateError = "")
            runRequestCatching { UpdateService.check(stagingPassword()) }
                .onSuccess { manifest ->
                    state.value = state.value.copy(
                        updateManifest = manifest.takeIf { it.versionCode > BuildConfig.VERSION_CODE },
                        updateChecking = false,
                    )
                }
                .onFailure { error -> state.value = state.value.copy(updateChecking = false, updateError = error.message ?: "检查更新失败") }
        }
    }

    fun downloadUpdate() {
        val manifest = state.value.updateManifest ?: return
        if (state.value.updateDownloading) return
        viewModelScope.launch {
            state.value = state.value.copy(updateDownloading = true, updateProgress = 0, updateError = "", updateFilePath = null)
            runRequestCatching {
                UpdateService.download(getApplication(), manifest, stagingPassword()) { done, total ->
                    val progress = if (total > 0) ((done * 100) / total).toInt().coerceIn(0, 100) else 0
                    state.value = state.value.copy(updateProgress = progress)
                }
            }.onSuccess { file -> state.value = state.value.copy(updateDownloading = false, updateProgress = 100, updateFilePath = file.absolutePath) }
                .onFailure { error -> state.value = state.value.copy(updateDownloading = false, updateError = error.message ?: "下载更新失败") }
        }
    }

    fun clearUpdateFile() { state.value = state.value.copy(updateFilePath = null) }

    fun login(token: String, persist: Boolean = true) {
        if (token.isBlank()) return
        viewModelScope.launch {
            state.value = state.value.copy(loading = true, error = "")
            try {
                val client = client(token)
                val bootstrap = client.bootstrap()
                if (persist) localStorage { patStore.save(token) }
                api = client
                sessions = bootstrap.sessions
                var workspace = "agent"
                var xianyuAutoReply = false
                var xianyuStatus = ""
                var xianyuLogin = ""
                var xianyuDraftMessageIds = emptyMap<String, Set<String>>()
                if (bootstrap.user?.role == "admin") {
                    runRequestCatching { client.xianyuWorkspace() }.onSuccess { workspacePayload ->
                        val channelSessions = parseXianyuSessions(workspacePayload)
                        xianyuDraftMessageIds = parseXianyuDraftMessageIds(workspacePayload)
                        if (channelSessions.isNotEmpty()) {
                            sessions = channelSessions.map { BootstrapEntry(it, 0) }
                            workspace = "xianyu"
                        }
                        xianyuAutoReply = workspacePayload["autoReplyEnabled"]?.jsonPrimitive?.booleanOrNull == true
                        xianyuStatus = workspacePayload["service"]?.toString().orEmpty()
                        xianyuLogin = workspacePayload["login"]?.toString().orEmpty()
                    }
                }
                sequences.clear()
                bootstrap.sessions.forEach { sequences[it.session.id] = it.lastSequence }
                state.value = state.value.copy(
                    tokenPresent = true,
                    userRole = bootstrap.user?.role ?: "user",
                    registrationToken = "",
                    sessions = sessions.map { it.session },
                    workspace = workspace,
                    xianyuAutoReply = xianyuAutoReply,
                    xianyuDraftMessageIds = xianyuDraftMessageIds,
                    xianyuStatus = xianyuStatus,
                    xianyuLogin = xianyuLogin,
                    offline = false,
                    loading = false,
                )
                val selected = state.value.selectedSessionId
                    ?.takeIf { id -> sessions.any { it.session.id == id } }
                    ?: sessions.firstOrNull()?.session?.id
                if (selected != null) selectSession(selected)
                openSocket()
            } catch (error: Throwable) {
                currentCoroutineContext().ensureActive()
                if (error is kotlinx.coroutines.CancellationException) throw error
                if (error is UmaApiException && error.status == 401) {
                    clearAuthentication("访问令牌无效或已被撤销")
                } else {
                    state.value = state.value.copy(
                        loading = false,
                        offline = state.value.tokenPresent,
                        error = error.message ?: "登录失败",
                    )
                }
            }
        }
    }

    fun register(label: String) {
        if (state.value.loading) return
        viewModelScope.launch {
            state.value = state.value.copy(loading = true, error = "", registrationToken = "")
            try {
                val issued = client().register(label.trim().ifBlank { "android" })
                state.value = state.value.copy(loading = false, registrationToken = issued.token)
            } catch (error: Throwable) {
                currentCoroutineContext().ensureActive()
                if (error is kotlinx.coroutines.CancellationException) throw error
                state.value = state.value.copy(
                    loading = false,
                    offline = false,
                    error = error.message ?: "注册失败",
                )
            }
        }
    }

    fun clearRegistration() {
        if (state.value.loading) return
        state.value = state.value.copy(registrationToken = "", error = "")
    }

    fun configureStagingAccess(password: String) {
        if (!BuildConfig.STAGING_BUILD || password.isBlank() || state.value.loading) return
        viewModelScope.launch {
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { UmaApi(baseUrl = BuildConfig.UMA_BASE_URL, gatewayPassword = password).getJson("/health/live") }
                .onSuccess {
                    localStorage { stagingAuthStore.save(password) }
                    state.value = state.value.copy(stagingAccessRequired = false, loading = false)
                    patStore.read()?.let { login(it, persist = false) }
                    checkForUpdate()
                }
                .onFailure { error ->
                    state.value = state.value.copy(loading = false, error = error.message ?: "测试环境认证失败")
                }
        }
    }

    fun retryLogin() {
        if (state.value.loading) return
        patStore.read()?.let { login(it, persist = false) }
    }

    fun logout() {
        clearLocalAuthentication(clearStaging = true)
    }

    /**
     * 切换到另一枚普通用户令牌。咸鱼 Adapter 是独立后台进程，
     * 因此这里只清理本机管理员会话，不向咸鱼服务发送停止或退出请求。
     */
    fun switchAccount() {
        clearLocalAuthentication(clearStaging = false)
    }

    private fun clearLocalAuthentication(clearStaging: Boolean) {
        // 账号切换先取消所有旧账号请求，防止迟到的回调把管理员数据写回普通账号界面。
        viewModelScope.coroutineContext.cancelChildren()
        socket?.close(1000, "account-switch"); socket = null; reconnect?.cancel(); reconnect = null; api = null
        xianyuLoginPoll?.cancel(); xianyuLoginPoll = null
        synchronized(localStorageLock) {
            patStore.clear()
            if (clearStaging) stagingAuthStore.clear()
            cache.clear()
        }
        sessions = emptyList(); sequences.clear()
        state.value = UmaUiState(stagingAccessRequired = BuildConfig.STAGING_BUILD && stagingPassword() == null)
    }

    fun selectSession(id: String) {
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(selectedSessionId = id, queue = emptyList(), loading = true, error = "")
            try {
                val snapshot = client.snapshot(id)
                val encoded = snapshot.toString()
                val avatarId = state.value.sessions.firstOrNull { it.id == id }?.assistantAvatarAttachmentId
                val avatarBytes = avatarId?.let { runRequestCatching { client.attachmentBytes(it) }.getOrNull() }
                localStorage {
                    val current = cache.read()
                    val next = (current?.snapshots ?: emptyMap()) + (id to encoded)
                    cache.write(CacheEnvelope(2, state.value.sessions, next, sequences))
                }
                state.value = state.value.copy(snapshot = encoded, assistantAvatarBytes = avatarBytes, offline = false, loading = false)
                state.value = state.value.copy(queue = parseQueue(encoded))
            } catch (error: Throwable) {
                currentCoroutineContext().ensureActive()
                if (error is kotlinx.coroutines.CancellationException) throw error
                val cached = cache.read()?.snapshots?.get(id)
                state.value = state.value.copy(
                    snapshot = cached ?: "",
                    queue = parseQueue(cached.orEmpty()),
                    assistantAvatarBytes = null,
                    offline = true,
                    loading = false,
                    error = error.message ?: "无法读取会话",
                )
            }
        }
    }

    fun setInteractionMode(mode: String) {
        if (mode == "agent" || mode == "plan") state.value = state.value.copy(interactionMode = mode)
    }

    fun loadQueue(sessionId: String = state.value.selectedSessionId.orEmpty()) {
        if (state.value.offline || sessionId.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            runRequestCatching { client.queue(sessionId.trim()) }
                .onSuccess { queue -> state.value = state.value.copy(queue = parseQueue(queue.toString()), error = "") }
                .onFailure { error -> state.value = state.value.copy(error = error.message ?: "队列读取失败") }
        }
    }

    fun reorderQueue(runIds: List<String>) {
        val sessionId = state.value.selectedSessionId ?: return
        val normalized = runIds.map(String::trim).filter(String::isNotBlank)
        if (state.value.offline || normalized.isEmpty()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.reorderQueue(sessionId, normalized) }
                .onSuccess { queue -> state.value = state.value.copy(queue = parseQueue(queue.toString()), loading = false) }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "队列重排失败") }
        }
    }

    fun prioritizeRun(runId: String) {
        val sessionId = state.value.selectedSessionId ?: return
        if (state.value.offline || runId.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.prioritizeRun(runId.trim()); client.queue(sessionId) }
                .onSuccess { queue -> state.value = state.value.copy(queue = parseQueue(queue.toString()), loading = false) }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "队列置顶失败") }
        }
    }

    fun cancelQueuedRun(runId: String) {
        val sessionId = state.value.selectedSessionId ?: return
        if (state.value.offline || runId.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.cancelRun(runId.trim()); client.queue(sessionId) }
                .onSuccess { queue -> state.value = state.value.copy(queue = parseQueue(queue.toString()), loading = false) }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "队列消息取消失败") }
        }
    }

    fun editQueuedMessage(item: UiQueueItem, text: String) {
        val sessionId = state.value.selectedSessionId ?: return
        val normalized = text.trim()
        if (state.value.offline || normalized.isBlank() || item.messageId.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.editMessage(item.messageId, normalized); client.queue(sessionId) }
                .onSuccess { queue -> state.value = state.value.copy(queue = parseQueue(queue.toString()), loading = false) }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "队列消息编辑失败") }
        }
    }

    fun confirmPlan(runId: String) {
        if (state.value.offline || runId.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            val sessionId = state.value.selectedSessionId ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.confirmPlan(runId.trim()) }
                .onSuccess {
                    state.value = state.value.copy(loading = false)
                    selectSession(sessionId)
                }
                .onFailure { error ->
                    state.value = state.value.copy(loading = false, error = error.message ?: "确认计划失败")
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
                client.send(
                    id,
                    text.ifBlank { "请分析这张图片。" },
                    state.value.pendingAttachmentIds,
                    state.value.interactionMode,
                )
                selectSession(id)
                state.value = state.value.copy(
                    offline = false,
                    pendingAttachmentIds = emptyList(),
                    pendingAttachments = emptyList(),
                    attachmentData = "",
                )
            } catch (error: Throwable) {
                currentCoroutineContext().ensureActive()
                if (error is kotlinx.coroutines.CancellationException) throw error
                state.value = state.value.copy(loading = false, offline = true, error = error.message ?: "发送失败")
            }
        }
    }

    fun retryMessage(item: UiMessage) {
        val id = state.value.selectedSessionId ?: return
        if (item.role != "user" || state.value.offline || state.value.loading) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching {
                client.send(
                    id,
                    item.content.ifBlank { "请分析这张图片。" },
                    item.attachments.map { it.id },
                    item.interactionMode ?: state.value.interactionMode,
                )
            }.onSuccess {
                selectSession(id)
            }.onFailure { error ->
                state.value = state.value.copy(loading = false, error = error.message ?: "重试失败")
            }
        }
    }

    fun editMessage(messageId: String, text: String) {
        val sessionId = state.value.selectedSessionId ?: return
        val normalized = text.trim()
        if (state.value.offline || messageId.isBlank() || normalized.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.editMessage(messageId.trim(), normalized) }
                .onSuccess {
                    state.value = state.value.copy(loading = false)
                    selectSession(sessionId)
                }
                .onFailure { error ->
                    state.value = state.value.copy(loading = false, error = error.message ?: "消息编辑失败")
                }
        }
    }

    fun reviewMessage(messageId: String) = runMessageQualityAction(messageId, "审查") { client ->
        client.reviewMessage(messageId.trim())
    }

    fun improveMessage(messageId: String) = runMessageQualityAction(messageId, "改进") { client ->
        client.improveMessage(messageId.trim())
    }

    private fun runMessageQualityAction(
        messageId: String,
        action: String,
        request: suspend (UmaApi) -> Unit,
    ) {
        val sessionId = state.value.selectedSessionId ?: return
        if (state.value.offline || messageId.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { request(client) }
                .onSuccess {
                    state.value = state.value.copy(loading = false)
                    selectSession(sessionId)
                }
                .onFailure { error ->
                    state.value = state.value.copy(loading = false, error = error.message ?: "${action}失败")
                }
        }
    }

    fun uploadAttachment(uri: Uri, name: String) {
        val sessionId = state.value.selectedSessionId ?: return
        if (state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.upload(getApplication(), uri, name, sessionId) }
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
            runRequestCatching { client.downloadAttachment(getApplication(), id.trim(), destination) }
                .onSuccess { bytes -> state.value = state.value.copy(attachmentData = "已下载 ${bytes} bytes", loading = false) }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "附件下载失败") }
        }
    }

    fun previewImageAttachment(attachment: UiAttachment) {
        if (state.value.offline || attachment.id.isBlank() || !attachment.mimeType.startsWith("image/")) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.attachmentBytes(attachment.id, maxBytes = 4 * 1024 * 1024, description = "图片") }
                .onSuccess { bytes ->
                    state.value = state.value.copy(
                        attachmentPreview = AttachmentPreview(attachment.id, attachment.name, bytes),
                        loading = false,
                    )
                }
                .onFailure { error ->
                    state.value = state.value.copy(loading = false, error = error.message ?: "图片预览失败")
                }
        }
    }

    fun clearAttachmentPreview() {
        state.value = state.value.copy(attachmentPreview = null)
    }

    fun loadBackgroundTasks() {
        if (state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.tasks() }
                .onSuccess { tasks ->
                    state.value = state.value.copy(
                        backgroundTasks = parseBackgroundTasks(tasks.toString()),
                        loading = false,
                        offline = false,
                    )
                }
                .onFailure { error ->
                    state.value = state.value.copy(loading = false, error = error.message ?: "后台任务读取失败")
                }
        }
    }

    fun createBackgroundTask(prompt: String) {
        val parentSessionId = state.value.selectedSessionId ?: return
        val normalized = prompt.trim()
        if (state.value.offline || normalized.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching {
                client.createTask(normalized, parentSessionId)
                client.bootstrap() to client.tasks()
            }.onSuccess { (bootstrap, tasks) ->
                sessions = bootstrap.sessions
                bootstrap.sessions.forEach { entry ->
                    sequences[entry.session.id] = maxOf(sequences[entry.session.id] ?: 0L, entry.lastSequence)
                }
                state.value = state.value.copy(
                    sessions = bootstrap.sessions.map { it.session },
                    backgroundTasks = parseBackgroundTasks(tasks.toString()),
                    loading = false,
                    offline = false,
                )
                sendSubscriptions()
            }.onFailure { error ->
                state.value = state.value.copy(loading = false, error = error.message ?: "后台任务创建失败")
            }
        }
    }

    fun cancelBackgroundTask(id: String) {
        if (state.value.offline || id.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.cancelTask(id.trim()); client.tasks() }
                .onSuccess { tasks ->
                    state.value = state.value.copy(
                        backgroundTasks = parseBackgroundTasks(tasks.toString()),
                        loading = false,
                    )
                }
                .onFailure { error ->
                    state.value = state.value.copy(loading = false, error = error.message ?: "后台任务取消失败")
                }
        }
    }

    fun deleteBackgroundTask(id: String) {
        if (state.value.offline || id.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.deleteTask(id.trim()); client.tasks() }
                .onSuccess { tasks ->
                    state.value = state.value.copy(
                        backgroundTasks = parseBackgroundTasks(tasks.toString()),
                        loading = false,
                    )
                }
                .onFailure { error ->
                    state.value = state.value.copy(loading = false, error = error.message ?: "后台任务删除失败")
                }
        }
    }

    fun loadScheduledTasks() {
        if (state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.schedules() }
                .onSuccess { schedules ->
                    state.value = state.value.copy(
                        scheduledTasks = parseScheduledTasks(schedules.toString()),
                        loading = false,
                        offline = false,
                    )
                }
                .onFailure { error ->
                    state.value = state.value.copy(loading = false, error = error.message ?: "调度读取失败")
                }
        }
    }

    fun createScheduledTask(name: String, prompt: String, kind: String, value: String, timezone: String) {
        val normalizedName = name.trim()
        val normalizedPrompt = prompt.trim()
        val normalizedValue = value.trim()
        if (state.value.offline || normalizedName.isBlank() || normalizedPrompt.isBlank() || normalizedValue.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching {
                client.createSchedule(normalizedName, normalizedPrompt, kind, normalizedValue, timezone.trim())
                client.schedules()
            }.onSuccess { schedules ->
                state.value = state.value.copy(
                    scheduledTasks = parseScheduledTasks(schedules.toString()),
                    loading = false,
                )
            }.onFailure { error ->
                state.value = state.value.copy(loading = false, error = error.message ?: "调度创建失败")
            }
        }
    }

    fun toggleScheduledTask(id: String, enabled: Boolean) {
        if (state.value.offline || id.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.updateSchedule(id.trim(), enabled); client.schedules() }
                .onSuccess { schedules ->
                    state.value = state.value.copy(scheduledTasks = parseScheduledTasks(schedules.toString()), loading = false)
                }
                .onFailure { error ->
                    state.value = state.value.copy(loading = false, error = error.message ?: "调度状态更新失败")
                }
        }
    }

    fun runScheduledTask(id: String) {
        if (state.value.offline || id.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.runSchedule(id.trim()); client.schedules() }
                .onSuccess { schedules ->
                    state.value = state.value.copy(scheduledTasks = parseScheduledTasks(schedules.toString()), loading = false)
                }
                .onFailure { error ->
                    state.value = state.value.copy(loading = false, error = error.message ?: "调度运行失败")
                }
        }
    }

    fun deleteScheduledTask(id: String) {
        if (state.value.offline || id.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.deleteSchedule(id.trim()); client.schedules() }
                .onSuccess { schedules ->
                    state.value = state.value.copy(
                        scheduledTasks = parseScheduledTasks(schedules.toString()),
                        scheduledRuns = state.value.scheduledRuns - id.trim(),
                        loading = false,
                    )
                }
                .onFailure { error ->
                    state.value = state.value.copy(loading = false, error = error.message ?: "调度删除失败")
                }
        }
    }

    fun loadScheduledRuns(scheduleId: String) {
        if (state.value.offline || scheduleId.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            runRequestCatching { client.scheduleRuns(scheduleId.trim()) }
                .onSuccess { runs ->
                    state.value = state.value.copy(
                        scheduledRuns = state.value.scheduledRuns + (scheduleId.trim() to parseScheduledRuns(runs.toString())),
                        error = "",
                    )
                }
                .onFailure { error -> state.value = state.value.copy(error = error.message ?: "运行历史读取失败") }
        }
    }

    fun cancelScheduledRun(scheduleId: String, runId: String) {
        if (state.value.offline || runId.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.cancelScheduleRun(runId.trim()); client.scheduleRuns(scheduleId.trim()) }
                .onSuccess { runs ->
                    state.value = state.value.copy(
                        scheduledRuns = state.value.scheduledRuns + (scheduleId.trim() to parseScheduledRuns(runs.toString())),
                        loading = false,
                    )
                }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "调度运行取消失败") }
        }
    }

    fun createSession(title: String) {
        if (state.value.offline || title.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.createSession(title.trim()) }
                .onSuccess { session ->
                    sessions = sessions + BootstrapEntry(session)
                    state.value = state.value.copy(sessions = sessions.map { it.session }, selectedSessionId = session.id, loading = false)
                    persistCache()
                    sendSubscriptions()
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
            runRequestCatching { client.renameSession(id, title.trim()) }
                .onSuccess { session ->
                    sessions = sessions.map { if (it.session.id == id) it.copy(session = session) else it }
                    state.value = state.value.copy(sessions = sessions.map { it.session }, loading = false)
                    persistCache()
                }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "重命名失败") }
        }
    }

    fun updateQueueMode(queueMode: String) {
        val id = state.value.selectedSessionId ?: return
        if (state.value.offline || (queueMode != "queue" && queueMode != "preemptive")) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.updateQueueMode(id, queueMode) }
                .onSuccess { session ->
                    sessions = sessions.map { if (it.session.id == id) it.copy(session = session) else it }
                    state.value = state.value.copy(sessions = sessions.map { it.session }, loading = false)
                    persistCache()
                }
                .onFailure { error ->
                    state.value = state.value.copy(loading = false, error = error.message ?: "执行策略更新失败")
                }
        }
    }

    fun updateAssistantName(name: String) {
        val id = state.value.selectedSessionId ?: return
        if (state.value.offline || name.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.updateAssistantIdentity(id, name = name.trim()) }
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
            runRequestCatching {
                val attachment = client.upload(getApplication(), uri, name, id, purpose = "avatar")
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
            runRequestCatching { client.updateAssistantIdentity(id, clearAvatar = true) }
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
            runRequestCatching { client.deleteSession(id) }
                .onSuccess {
                    sessions = sessions.filterNot { it.session.id == id }
                    state.value = state.value.copy(
                        sessions = sessions.map { it.session },
                        selectedSessionId = null,
                        snapshot = "",
                        queue = emptyList(),
                        loading = false,
                    )
                    persistCache()
                    sendSubscriptions()
                }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "删除会话失败") }
        }
    }

    fun cancelSelectedSession() {
        val id = state.value.selectedSessionId ?: return
        if (state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            runRequestCatching { client.cancelSession(id) }
                .onFailure { error -> state.value = state.value.copy(error = error.message ?: "取消失败") }
        }
    }

    fun resolveApproval(id: String, approved: Boolean) {
        if (state.value.offline || id.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            val sessionId = state.value.selectedSessionId ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.resolveApproval(id.trim(), approved) }
                .onSuccess {
                    state.value = state.value.copy(loading = false)
                    selectSession(sessionId)
                }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "审批操作失败") }
        }
    }

    fun compactSelectedSession() {
        val id = state.value.selectedSessionId ?: return
        if (state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            runRequestCatching { client.compactSession(id); selectSession(id) }
                .onFailure { error -> state.value = state.value.copy(error = error.message ?: "压缩失败") }
        }
    }

    fun xianyuStartLogin() {
        if (state.value.userRole != "admin") return
        if (state.value.offline || state.value.loading) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.xianyuLoginStart() }
                .onSuccess { login ->
                    state.value = state.value.copy(xianyuLogin = login.toString(), loading = false)
                    xianyuLoginPoll?.cancel()
                    xianyuLoginPoll = viewModelScope.launch {
                        while (state.value.workspace == "xianyu") {
                            delay(3_000)
                            try {
                                val next = client.xianyuLoginStatus()
                                state.value = state.value.copy(xianyuLogin = next.toString(), error = "")
                                val loginStatus = next["status"]?.jsonPrimitive?.content
                                if (loginStatus == "authenticated") {
                                    val workspace = client.xianyuWorkspace()
                                    state.value = state.value.copy(
                                        xianyuStatus = workspace["service"]?.toString().orEmpty(),
                                        xianyuLogin = workspace["login"]?.toString() ?: next.toString(),
                                    )
                                    refreshXianyuWorkspace()
                                    return@launch
                                }
                                if (loginStatus == "expired" || loginStatus == "failed") return@launch
                            } catch (error: Throwable) {
                currentCoroutineContext().ensureActive()
                if (error is kotlinx.coroutines.CancellationException) throw error
                                state.value = state.value.copy(error = error.message ?: "咸鱼登录状态查询失败")
                                return@launch
                            }
                        }
                    }
                }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "咸鱼二维码生成失败") }
        }
    }

    fun setXianyuAutoReply(enabled: Boolean) {
        if (state.value.userRole != "admin" || state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.xianyuSetAutoReply(enabled) }
                .onSuccess { state.value = state.value.copy(xianyuAutoReply = enabled, loading = false) }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "自动回复设置失败") }
        }
    }

    fun refreshXianyuWorkspace() {
        if (state.value.userRole != "admin") return
        viewModelScope.launch {
            val client = api ?: return@launch
                    runRequestCatching { client.xianyuWorkspace() }.onSuccess { payload ->
                        val next = parseXianyuSessions(payload)
                        if (next.isEmpty()) return@onSuccess
                        sessions = next.map { BootstrapEntry(it, sequences[it.id] ?: 0L) }
                        state.value = state.value.copy(
                            workspace = "xianyu",
                            sessions = next,
                            xianyuDraftMessageIds = parseXianyuDraftMessageIds(payload),
                            xianyuAutoReply = payload["autoReplyEnabled"]?.jsonPrimitive?.booleanOrNull == true,
                    xianyuStatus = payload["service"]?.toString().orEmpty(),
                    xianyuLogin = payload["login"]?.toString().orEmpty(),
                )
                sendSubscriptions()
            }
        }
    }

    /** 仅切换当前管理员客户端显示的工作区，不影响咸鱼后台服务。 */
    fun loadAgentWorkspace() {
        if (state.value.userRole != "admin") return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.bootstrap() }
                .onSuccess { bootstrap ->
                    sessions = bootstrap.sessions
                    sequences.clear()
                    bootstrap.sessions.forEach { sequences[it.session.id] = it.lastSequence }
                    state.value = state.value.copy(
                        workspace = "agent",
                        sessions = bootstrap.sessions.map { it.session },
                        selectedSessionId = bootstrap.sessions.firstOrNull()?.session?.id,
                        loading = false,
                        offline = false,
                    )
                    sendSubscriptions()
                    state.value.selectedSessionId?.let(::selectSession)
                }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "普通工作区加载失败") }
        }
    }

    fun sendXianyuDraft(messageId: String) {
        val sessionId = state.value.selectedSessionId ?: return
        if (state.value.userRole != "admin" || state.value.workspace != "xianyu" ||
            state.value.offline || state.value.loading || messageId.isBlank()
        ) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching {
                client.xianyuSendDraft(sessionId, messageId.trim())
                client.snapshot(sessionId)
            }.onSuccess { snapshot ->
                state.value = state.value.copy(
                    snapshot = snapshot.toString(),
                    queue = parseQueue(snapshot.toString()),
                    loading = false,
                    offline = false,
                )
                refreshXianyuWorkspace()
            }.onFailure { error ->
                state.value = state.value.copy(loading = false, error = error.message ?: "发送草稿失败")
            }
        }
    }

    fun xianyuAction(action: String) {
        if (state.value.userRole != "admin") return
        if (state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.xianyuControl(action); client.xianyuStatus() }
                .onSuccess { status ->
                    state.value = state.value.copy(
                        xianyuStatus = status.toString(),
                        xianyuLogin = status["login"]?.toString() ?: state.value.xianyuLogin,
                        loading = false,
                    )
                }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "咸鱼操作失败") }
        }
    }

    fun xianyuHistory(conversationId: String) {
        if (conversationId.isBlank() || state.value.offline || state.value.loading) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.xianyuHistory(conversationId.trim()) }
                .onSuccess { value -> state.value = state.value.copy(xianyuData = value.toString(), loading = false) }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "历史查询失败") }
        }
    }

    fun xianyuItem(itemId: String) {
        if (itemId.isBlank() || state.value.offline || state.value.loading) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.xianyuItem(itemId.trim()) }
                .onSuccess { value -> state.value = state.value.copy(xianyuData = value.toString(), loading = false) }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "商品查询失败") }
        }
    }

    fun xianyuChat(receiverId: String, itemId: String) {
        if (receiverId.isBlank() || itemId.isBlank() || state.value.offline || state.value.loading) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.xianyuChat(receiverId.trim(), itemId.trim()) }
                .onSuccess { value -> state.value = state.value.copy(xianyuData = value.toString(), loading = false) }
                .onFailure { error -> state.value = state.value.copy(loading = false, error = error.message ?: "建聊失败") }
        }
    }

    fun loadResource(path: String) {
        if (state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            runRequestCatching { client.getJson(path) }
                .onSuccess { value -> state.value = state.value.copy(resourceData = value.toString(), error = "") }
                .onFailure { error -> state.value = state.value.copy(error = error.message ?: "资源加载失败") }
        }
    }

    fun runResourceAction(path: String) {
        if (state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            runRequestCatching { client.postJson(path) }
                .onSuccess { value -> state.value = state.value.copy(resourceData = value.toString(), error = "") }
                .onFailure { error -> state.value = state.value.copy(error = error.message ?: "操作失败") }
        }
    }

    private fun persistCache() {
        viewModelScope.launch {
            localStorage {
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
    }

    private fun openSocket() {
        val client = api ?: return
        socket?.close(1000, "reconnect")
        socket = client.connectEvents(
            onOpen = { webSocket ->
                if (api !== client) {
                    webSocket.close(1000, "account-changed")
                    return@connectEvents
                }
                val token = patStore.read()
                if (token != null) {
                    webSocket.send(buildJsonObject { put("type", "auth"); put("token", token) }.toString())
                    sendSubscriptions(webSocket)
                }
                state.value = state.value.copy(offline = false)
                refreshXianyuWorkspace()
            },
            onText = { message -> viewModelScope.launch { if (api === client) handleEvent(message) } },
            onFailure = { error -> if (api === client) handleSocketFailure(error) },
        )
    }

    private fun sendSubscriptions(target: WebSocket? = socket) {
        target?.send(eventSubscriptionFrame(sessions.map { it.session.id to (sequences[it.session.id] ?: 0L) }))
    }

    private fun handleSocketFailure(error: Throwable) {
        if (error is UmaWebSocketException && error.code == 1000) return
        if (
            error is UmaWebSocketException &&
            error.code == 1008 &&
            error.reason.startsWith("Authentication", ignoreCase = true)
        ) {
            viewModelScope.launch { clearAuthentication("访问令牌无效或已被撤销") }
        } else {
            scheduleReconnect()
        }
    }

    private suspend fun clearAuthentication(message: String) {
        val activeSocket = socket
        socket = null
        activeSocket?.cancel()
        reconnect?.cancel()
        reconnect = null
        api = null
        xianyuLoginPoll?.cancel()
        xianyuLoginPoll = null
        localStorage {
            patStore.clear()
            cache.clear()
        }
        sessions = emptyList()
        sequences.clear()
        state.value = UmaUiState(error = message)
    }

    private suspend fun handleEvent(message: String) {
        val element = try { json.parseToJsonElement(message) } catch (_: Exception) { return }
        val objectValue = element as? JsonObject ?: return
        notifyXianyuInbound(objectValue)
        val resources = invalidatedResources(objectValue)
        if (resources.isNotEmpty()) {
            if ("tasks" in resources) refreshBackgroundTasksSilently()
            if ("schedules" in resources) refreshScheduledTasksSilently()
            return
        }
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
        runRequestCatching {
            val snapshot = client.snapshot(sessionId)
            val encoded = snapshot.toString()
            localStorage {
                val current = cache.read()
                cache.write(CacheEnvelope(2, state.value.sessions, (current?.snapshots ?: emptyMap()) + (sessionId to encoded), sequences))
            }
            if (sessionId == state.value.selectedSessionId)
                state.value = state.value.copy(snapshot = encoded, queue = parseQueue(encoded), offline = false)
        }.onFailure {
            state.value = state.value.copy(offline = true)
        }
    }

    private fun notifyXianyuInbound(event: JsonObject) {
        if (state.value.workspace != "xianyu" || event["type"]?.jsonPrimitive?.content != "message.started") return
        val sessionId = event["sessionId"]?.jsonPrimitive?.content ?: return
        if (state.value.sessions.none { it.id == sessionId }) return
        val payload = event["payload"] as? JsonObject ?: return
        if (payload["role"]?.jsonPrimitive?.content != "user") return
        if (Build.VERSION.SDK_INT >= 33 && getApplication<Application>().checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) return
        val manager = getApplication<Application>().getSystemService(NotificationManager::class.java)
        val channelId = "xianyu-inbound"
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel(channelId, "咸鱼新消息", NotificationManager.IMPORTANCE_DEFAULT))
        val title = state.value.sessions.firstOrNull { it.id == sessionId }?.title ?: "咸鱼新消息"
        val body = payload["content"]?.jsonPrimitive?.content?.take(120).orEmpty().ifBlank { "收到一条新的买家消息" }
        manager.notify(sessionId.hashCode(), NotificationCompat.Builder(getApplication(), channelId)
            .setSmallIcon(site.robotclaw.umaagent.R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .build())
    }

    private suspend fun refreshBackgroundTasksSilently() {
        val client = api ?: return
        runRequestCatching { client.tasks() }
            .onSuccess { tasks ->
                state.value = state.value.copy(backgroundTasks = parseBackgroundTasks(tasks.toString()))
            }
    }

    private suspend fun refreshScheduledTasksSilently() {
        val client = api ?: return
        runRequestCatching { client.schedules() }
            .onSuccess { schedules ->
                state.value = state.value.copy(scheduledTasks = parseScheduledTasks(schedules.toString()))
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
        // 让 Compose 自己处理系统栏 Insets，避免顶部内容覆盖 Android 通知栏。
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContent { UmaAgentTheme { UmaScreen() } }
    }
}
