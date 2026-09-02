package site.robotclaw.umaagent

import android.app.Application
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
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
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.WebSocket

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
    private var grant: String? = null
    private var grantExpiry: Job? = null
    private var sessions = emptyList<BootstrapEntry>()
    private val sequences = mutableMapOf<String, Long>()
    private val json = Json { ignoreUnknownKeys = true }

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
            runCatching { UpdateService.check(stagingPassword()) }
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
            runCatching {
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
                if (persist) withContext(Dispatchers.IO) { patStore.save(token) }
                api = client
                sessions = bootstrap.sessions
                sequences.clear()
                bootstrap.sessions.forEach { sequences[it.session.id] = it.lastSequence }
                state.value = state.value.copy(
                    tokenPresent = true,
                    userRole = bootstrap.user?.role ?: "user",
                    registrationToken = "",
                    sessions = bootstrap.sessions.map { it.session },
                    offline = false,
                    loading = false,
                )
                val selected = state.value.selectedSessionId ?: bootstrap.sessions.firstOrNull()?.session?.id
                if (selected != null) selectSession(selected)
                openSocket()
            } catch (error: Throwable) {
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
            runCatching { UmaApi(baseUrl = BuildConfig.UMA_BASE_URL, gatewayPassword = password).getJson("/health/live") }
                .onSuccess {
                    withContext(Dispatchers.IO) { stagingAuthStore.save(password) }
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
        socket?.close(1000, "logout"); socket = null; reconnect?.cancel(); api = null
        grant = null; grantExpiry?.cancel(); grantExpiry = null
        patStore.clear(); stagingAuthStore.clear(); cache.clear(); sessions = emptyList(); sequences.clear()
        state.value = UmaUiState(stagingAccessRequired = BuildConfig.STAGING_BUILD)
    }

    fun selectSession(id: String) {
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(selectedSessionId = id, queue = emptyList(), loading = true, error = "")
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
                state.value = state.value.copy(queue = parseQueue(encoded))
            } catch (error: Throwable) {
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
            runCatching { client.queue(sessionId.trim()) }
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
            runCatching { client.reorderQueue(sessionId, normalized) }
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
            runCatching { client.prioritizeRun(runId.trim()); client.queue(sessionId) }
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
            runCatching { client.cancelRun(runId.trim()); client.queue(sessionId) }
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
            runCatching { client.editMessage(item.messageId, normalized); client.queue(sessionId) }
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
            runCatching { client.confirmPlan(runId.trim()) }
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
                state.value = state.value.copy(loading = false, offline = true, error = error.message ?: "发送失败")
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
            runCatching { client.editMessage(messageId.trim(), normalized) }
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
            runCatching { request(client) }
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

    fun previewImageAttachment(attachment: UiAttachment) {
        if (state.value.offline || attachment.id.isBlank() || !attachment.mimeType.startsWith("image/")) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runCatching { client.attachmentBytes(attachment.id, maxBytes = 4 * 1024 * 1024, description = "图片") }
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
            runCatching { client.tasks() }
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
            runCatching {
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
            runCatching { client.cancelTask(id.trim()); client.tasks() }
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
            runCatching { client.deleteTask(id.trim()); client.tasks() }
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
            runCatching { client.schedules() }
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
            runCatching {
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
            runCatching { client.updateSchedule(id.trim(), enabled); client.schedules() }
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
            runCatching { client.runSchedule(id.trim()); client.schedules() }
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
            runCatching { client.deleteSchedule(id.trim()); client.schedules() }
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
            runCatching { client.scheduleRuns(scheduleId.trim()) }
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
            runCatching { client.cancelScheduleRun(runId.trim()); client.scheduleRuns(scheduleId.trim()) }
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
            runCatching { client.createSession(title.trim()) }
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
            runCatching { client.renameSession(id, title.trim()) }
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
            runCatching { client.updateQueueMode(id, queueMode) }
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
            runCatching { client.cancelSession(id) }
                .onFailure { error -> state.value = state.value.copy(error = error.message ?: "取消失败") }
        }
    }

    fun resolveApproval(id: String, approved: Boolean) {
        if (state.value.offline || id.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            val sessionId = state.value.selectedSessionId ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runCatching { client.resolveApproval(id.trim(), approved) }
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
                    sendSubscriptions(webSocket)
                }
                state.value = state.value.copy(offline = false)
            },
            onText = { message -> viewModelScope.launch { handleEvent(message) } },
            onFailure = { error -> handleSocketFailure(error) },
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
        grant = null
        grantExpiry?.cancel()
        grantExpiry = null
        withContext(Dispatchers.IO) {
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
        runCatching {
            val snapshot = client.snapshot(sessionId)
            val encoded = snapshot.toString()
            withContext(Dispatchers.IO) {
                val current = cache.read()
                cache.write(CacheEnvelope(2, state.value.sessions, (current?.snapshots ?: emptyMap()) + (sessionId to encoded), sequences))
            }
            if (sessionId == state.value.selectedSessionId)
                state.value = state.value.copy(snapshot = encoded, queue = parseQueue(encoded), offline = false)
        }.onFailure {
            state.value = state.value.copy(offline = true)
        }
    }

    private suspend fun refreshBackgroundTasksSilently() {
        val client = api ?: return
        runCatching { client.tasks() }
            .onSuccess { tasks ->
                state.value = state.value.copy(backgroundTasks = parseBackgroundTasks(tasks.toString()))
            }
    }

    private suspend fun refreshScheduledTasksSilently() {
        val client = api ?: return
        runCatching { client.schedules() }
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
        setContent { UmaAgentTheme { UmaScreen() } }
    }
}
