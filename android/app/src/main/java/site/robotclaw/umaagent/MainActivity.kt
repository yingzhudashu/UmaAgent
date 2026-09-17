package site.robotclaw.umaagent

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.core.app.NotificationCompat
import androidx.core.view.WindowCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
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
    val autoApprove: Boolean = true,
    val executionSettingsLoaded: Boolean = false,
    val savingExecutionSettings: Boolean = false,
    val sessions: List<Session> = emptyList(),
    val selectedSessionId: String? = null,
    val assistantAvatar: android.graphics.Bitmap? = null,
    val snapshot: String = "",
    val approvals: List<UiApproval>? = null,
    val conversation: List<UiConversationEntry>? = null,
    val xianyuStatus: String = "",
    val xianyuLogin: String = "",
    val xianyuLoaded: Boolean = false,
    val xianyuError: String = "",
    val workspace: String = "agent",
    val xianyuAutoReply: Boolean = false,
    val xianyuDraftMessageIds: Map<String, Set<String>> = emptyMap(),
    val xianyuData: String = "",
    val models: List<ModelReference> = emptyList(),
    val traceData: String? = null,
    val traceRunId: String? = null,
    val traceLoading: Boolean = false,
    val traceError: String = "",
    val themeMode: String = "system",
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
    val updateChecked: Boolean = false,
    val cancelling: Boolean = false,
    val unconfirmedSend: Boolean = false,
    val sending: Boolean = false,
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
    private val appearance =
        application.getSharedPreferences("appearance", android.content.Context.MODE_PRIVATE)
    private val patStore = PatStore(application)
    private val stagingAuthStore = StagingAuthStore(application)
    private val cache = SnapshotCache(application)
    private val draftStore = DraftStore(application)
    private val drafts = draftStore.read().toMutableMap()
    private var draftJob: Job? = null
    private val state =
        MutableStateFlow(
            UmaUiState(themeMode = appearance.getString("theme", "system") ?: "system")
        )
    val uiState = state.asStateFlow()
    private var api: UmaApi? = null
    private var socket: WebSocket? = null
    private var reconnect: Job? = null
    private var xianyuLoginPoll: Job? = null
    private val eventMutex = Mutex()
    private var projectedSession: String? = null
    private var projectedSnapshot: JsonObject? = null
    private var selectionJob: Job? = null
    private var publishJob: Job? = null
    private var cacheJob: Job? = null
    private var traceJob: Job? = null
    private var avatarJob: Job? = null
    private var sessions = emptyList<BootstrapEntry>()
    private val sequences = mutableMapOf<String, Long>()
    private val json = Json { ignoreUnknownKeys = true }
    private val localStorageLock = Any()

    /** 将后台存储写入与账号清理串行化，阻止旧账号的迟到写入恢复已删除的缓存。 */
    private suspend fun <T> localStorage(action: () -> T): T =
        withContext(Dispatchers.IO) {
            val context = coroutineContext
            synchronized(localStorageLock) {
                context.ensureActive()
                action()
            }
        }

    private fun stagingPassword(): String? =
        if (BuildConfig.STAGING_BUILD) stagingAuthStore.read() else null

    private fun client(token: String = ""): UmaApi =
        UmaApi(token, BuildConfig.UMA_BASE_URL, stagingPassword())

    init {
        val cached = cache.read()
        if (cached != null) {
            sequences.putAll(cached.sequences)
            // 在联网前恢复当前会话和正文；冷启动离线也能直接阅读，不依赖登录回执。
            val selected =
                cached.selectedSessionId?.takeIf { id -> cached.sessions.any { it.id == id } }
            val snapshot = cached.snapshots[selected].orEmpty()
            val parsed = runCatching { json.parseToJsonElement(snapshot) as JsonObject }.getOrNull()
            projectedSession = selected
            projectedSnapshot = parsed
            val attachments = drafts[selected]?.attachments.orEmpty()
            state.value =
                state.value.copy(
                    sessions = cached.sessions,
                    selectedSessionId = selected,
                    snapshot = snapshot,
                    conversation = parsed?.let(::parseSnapshotConversation),
                    approvals = parsed?.let(::pendingApprovals),
                    queue = parsed?.let(::parseQueue).orEmpty(),
                    pendingAttachments = attachments,
                    pendingAttachmentIds = attachments.map { it.id },
                    unconfirmedSend = drafts[selected]?.pending != null,
                    interactionMode = drafts[selected]?.pending?.mode ?: "agent",
                )
        }
        val stagingAccessMissing = BuildConfig.STAGING_BUILD && stagingPassword() == null
        state.value = state.value.copy(stagingAccessRequired = stagingAccessMissing)
        patStore
            .read()
            ?.takeIf { !stagingAccessMissing }
            ?.let {
                state.value =
                    state.value.copy(tokenPresent = cached != null, offline = cached != null)
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
                    state.value =
                        state.value.copy(
                            updateChecked = true,
                            updateManifest =
                                manifest.takeIf { it.versionCode > BuildConfig.VERSION_CODE },
                            updateChecking = false,
                        )
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            updateChecking = false,
                            updateError = requestErrorMessage(error, "检查更新失败"),
                        )
                }
        }
    }

    fun downloadUpdate() {
        val manifest = state.value.updateManifest ?: return
        if (state.value.updateDownloading) return
        viewModelScope.launch {
            state.value =
                state.value.copy(
                    updateDownloading = true,
                    updateProgress = 0,
                    updateError = "",
                    updateFilePath = null,
                )
            runRequestCatching {
                UpdateService.download(getApplication(), manifest, stagingPassword()) { done, total
                    ->
                    val progress =
                        if (total > 0) ((done * 100) / total).toInt().coerceIn(0, 100) else 0
                    state.value = state.value.copy(updateProgress = progress)
                }
            }
                .onSuccess { file ->
                    state.value =
                        state.value.copy(
                            updateDownloading = false,
                            updateProgress = 100,
                            updateFilePath = file.absolutePath,
                        )
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            updateDownloading = false,
                            updateError = requestErrorMessage(error, "下载更新失败"),
                        )
                }
        }
    }

    fun clearUpdateFile() {
        state.value = state.value.copy(updateFilePath = null)
    }

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
                var xianyuError = ""
                var xianyuDraftMessageIds = emptyMap<String, Set<String>>()
                if (bootstrap.user?.role == "admin") {
                    runRequestCatching { client.xianyuWorkspace() }
                        .onSuccess { workspacePayload ->
                            val channelSessions = parseXianyuSessions(workspacePayload)
                            xianyuDraftMessageIds = parseXianyuDraftMessageIds(workspacePayload)
                            if (channelSessions.isNotEmpty()) {
                                sessions = channelSessions.map { BootstrapEntry(it, 0) }
                                workspace = "xianyu"
                            }
                            xianyuAutoReply =
                                workspacePayload["autoReplyEnabled"]
                                    ?.jsonPrimitive
                                    ?.booleanOrNull == true
                            xianyuStatus = workspacePayload["service"]?.toString().orEmpty()
                            xianyuLogin = workspacePayload["login"]?.toString().orEmpty()
                        }
                        .onFailure { xianyuError = xianyuErrorMessage(it) }
                }
                sequences.clear()
                bootstrap.sessions.forEach { sequences[it.session.id] = it.lastSequence }
                state.value =
                    state.value.copy(
                        tokenPresent = true,
                        userRole = bootstrap.user?.role ?: "user",
                        registrationToken = "",
                        sessions = sessions.map { it.session },
                        workspace = workspace,
                        xianyuAutoReply = xianyuAutoReply,
                        xianyuDraftMessageIds = xianyuDraftMessageIds,
                        xianyuStatus = xianyuStatus,
                        xianyuLogin = xianyuLogin,
                        xianyuLoaded = bootstrap.user?.role == "admin",
                        xianyuError = xianyuError,
                        offline = false,
                        loading = false,
                    )
                val selected =
                    state.value.selectedSessionId?.takeIf { id ->
                        sessions.any { it.session.id == id }
                    } ?: sessions.firstOrNull()?.session?.id
                if (selected != null) selectSession(selected)
                refreshExecutionSettings()
                loadModels()
                openSocket()
            } catch (error: Throwable) {
                currentCoroutineContext().ensureActive()
                if (error is kotlinx.coroutines.CancellationException) throw error
                if (error is UmaApiException && error.status == 401) {
                    clearAuthentication("访问令牌无效或已被撤销")
                } else {
                    state.value =
                        state.value.copy(
                            loading = false,
                            offline = state.value.tokenPresent,
                            error = requestErrorMessage(error, "登录失败"),
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
                state.value =
                    state.value.copy(
                        loading = false,
                        offline = false,
                        error = requestErrorMessage(error, "注册失败"),
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
            runRequestCatching {
                UmaApi(baseUrl = BuildConfig.UMA_BASE_URL, gatewayPassword = password)
                    .getJson("/health/live")
            }
                .onSuccess {
                    localStorage { stagingAuthStore.save(password) }
                    state.value = state.value.copy(stagingAccessRequired = false, loading = false)
                    patStore.read()?.let { login(it, persist = false) }
                    checkForUpdate()
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "测试环境认证失败"),
                        )
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

    /** 切换到另一枚普通用户令牌。咸鱼 Adapter 是独立后台进程， 因此这里只清理本机管理员会话，不向咸鱼服务发送停止或退出请求。 */
    fun switchAccount() {
        clearLocalAuthentication(clearStaging = false)
    }

    private fun clearLocalAuthentication(clearStaging: Boolean) {
        // 账号切换先取消所有旧账号请求，防止迟到的回调把管理员数据写回普通账号界面。
        viewModelScope.coroutineContext.cancelChildren()
        socket?.close(1000, "account-switch")
        socket = null
        reconnect?.cancel()
        reconnect = null
        api = null
        xianyuLoginPoll?.cancel()
        xianyuLoginPoll = null
        synchronized(localStorageLock) {
            patStore.clear()
            if (clearStaging) stagingAuthStore.clear()
            cache.clear()
            draftStore.clear()
            drafts.clear()
        }
        sessions = emptyList()
        sequences.clear()
        projectedSession = null
        projectedSnapshot = null
        state.value =
            UmaUiState(
                themeMode = state.value.themeMode,
                stagingAccessRequired = BuildConfig.STAGING_BUILD && stagingPassword() == null,
            )
    }

    fun draftText(id: String?): String = drafts[id]?.text.orEmpty()

    /** 退出会清除所有会话草稿，确认范围不能仅限当前可见会话。 */
    fun hasUnsentDrafts(): Boolean =
        drafts.values.any {
            it.text.isNotBlank() || it.attachments.isNotEmpty() || it.pending != null
        }

    suspend fun executeShortcut(sessionId: String, command: String): String {
        check(!state.value.offline) { "离线时无法执行命令" }
        val result =
            managementRequest(
                "/sessions/${java.net.URLEncoder.encode(sessionId, "UTF-8")}/shortcuts",
                "POST",
                buildJsonObject { put("command", command) },
            )
        return (result as? JsonObject)?.get("output")?.jsonPrimitive?.content ?: error("命令响应不完整")
    }

    fun saveDraftText(id: String?, text: String) {
        if (id == null) return
        drafts[id] = (drafts[id] ?: SessionDraft()).copy(text = text)
        persistDrafts()
    }

    private fun saveDraftAttachments(id: String, attachments: List<PendingAttachment>) {
        drafts[id] = (drafts[id] ?: SessionDraft()).copy(attachments = attachments)
        persistDrafts()
    }

    private fun persistDrafts(immediate: Boolean = false) {
        draftJob?.cancel()
        val current = drafts.toMap()
        draftJob = viewModelScope.launch {
            if (!immediate) delay(250)
            runRequestCatching { localStorage { draftStore.write(current) } }
                .onFailure { state.value = state.value.copy(error = "草稿保存失败：${it.message}") }
        }
    }

    fun selectSession(id: String) {
        selectionJob?.cancel()
        val client = api
        val changed = state.value.selectedSessionId != id
        if (changed) {
            publishJob?.cancel()
            projectedSession = id
            projectedSnapshot = null
            state.value =
                state.value.copy(
                    selectedSessionId = id,
                    snapshot = "",
                    conversation = null,
                    approvals = null,
                    sending = false,
                    cancelling = false,
                    assistantAvatar = null,
                    queue = emptyList(),
                    unconfirmedSend = drafts[id]?.pending != null,
                    interactionMode = drafts[id]?.pending?.mode ?: state.value.interactionMode,
                    pendingAttachments = drafts[id]?.attachments.orEmpty(),
                    pendingAttachmentIds = drafts[id]?.attachments.orEmpty().map { it.id },
                )
        }
        selectionJob = viewModelScope.launch {
            state.value = state.value.copy(loading = true, error = "")
            try {
                // 快照与增量串行提交。offset 保证网络队列中早于快照的临时增量不会重复拼接。
                eventMutex.withLock {
                    val snapshot = client?.snapshot(id) ?: error("离线模式")
                    if (api !== client || state.value.selectedSessionId != id) return@launch
                    updateSessionMetadata(client, snapshot, reloadAvatar = true)
                    projectedSession = id
                    projectedSnapshot = snapshot
                    sequences[id] = snapshot["snapshotSequence"]?.jsonPrimitive?.longOrNull ?: 0L
                    publishProjection(client, id)
                    state.value = state.value.copy(loading = false)
                }
                flushCache()
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                if (api !== client || state.value.selectedSessionId != id) return@launch
                val cached = localStorage { cache.read()?.snapshots?.get(id) }.orEmpty()
                val parsed = withContext(Dispatchers.Default) { parseSnapshotConversation(cached) }
                projectedSession = id
                projectedSnapshot =
                    runCatching { json.parseToJsonElement(cached) as JsonObject }.getOrNull()
                state.value =
                    state.value.copy(
                        snapshot = cached,
                        conversation = parsed,
                        approvals = pendingApprovals(cached),
                        queue = parseQueue(cached),
                        assistantAvatar = null,
                        offline = true,
                        loading = false,
                        error = requestErrorMessage(error, "无法读取会话"),
                    )
            }
        }
    }

    /** 快照中的会话身份也是事实源；列表、设置和正文共用同一投影，不另拉全量列表。 */
    private fun updateSessionMetadata(
        client: UmaApi,
        snapshot: JsonObject,
        reloadAvatar: Boolean = false,
    ) {
        val value = snapshot["session"] ?: return
        val session =
            runCatching { json.decodeFromJsonElement(Session.serializer(), value) }.getOrNull()
                ?: return
        val previous = state.value.sessions.firstOrNull { it.id == session.id } ?: return
        if (previous == session && !reloadAvatar) return
        sessions = sessions.map {
            if (it.session.id == session.id) it.copy(session = session) else it
        }
        state.value =
            state.value.copy(
                sessions = state.value.sessions.map { if (it.id == session.id) session else it }
            )
        if (previous != session) persistCache()
        if (
            state.value.selectedSessionId != session.id ||
                (!reloadAvatar &&
                    previous.assistantAvatarAttachmentId == session.assistantAvatarAttachmentId)
        )
            return
        avatarJob?.cancel()
        state.value = state.value.copy(assistantAvatar = null)
        val avatarId = session.assistantAvatarAttachmentId ?: return
        avatarJob = viewModelScope.launch {
            // 所有消息共享后台采样结果；新的附件ID会取消过期读取，原始字节不入UI状态。
            runRequestCatching {
                val bytes = client.attachmentBytes(avatarId)
                withContext(Dispatchers.Default) { decodePreviewBitmap(bytes, 512) }
            }
                .onSuccess { avatar ->
                    if (
                        api === client &&
                            state.value.selectedSessionId == session.id &&
                            state.value.sessions
                                .firstOrNull { it.id == session.id }
                                ?.assistantAvatarAttachmentId == avatarId
                    )
                        state.value = state.value.copy(assistantAvatar = avatar)
                }
                .onFailure { error ->
                    if (
                        api === client &&
                            state.value.selectedSessionId == session.id &&
                            state.value.sessions
                                .firstOrNull { it.id == session.id }
                                ?.assistantAvatarAttachmentId == avatarId
                    )
                        state.value =
                            state.value.copy(
                                error = "头像预览读取失败：${requestErrorMessage(error, "请重新进入会话重试")}"
                            )
                }
        }
    }

    /** 后台切换与终态复用同一缓存入口，写入完成前切换账号会取消旧任务。 */
    fun flushCache() {
        persistDrafts(immediate = true)
        cacheJob?.cancel()
        val client = api
        val sessionId = projectedSession ?: return
        val snapshot = projectedSnapshot?.toString() ?: return
        val visibleSessions = state.value.sessions
        val cursors = sequences.toMap()
        cacheJob = viewModelScope.launch {
            runRequestCatching {
                localStorage {
                    if (api === client && state.value.selectedSessionId == sessionId) {
                        val previous = cache.read()?.snapshots.orEmpty() - sessionId
                        cache.write(
                            CacheEnvelope(
                                SNAPSHOT_CACHE_VERSION,
                                visibleSessions,
                                (previous + (sessionId to snapshot))
                                    .entries
                                    .toList()
                                    .takeLast(4)
                                    .associate { it.toPair() },
                                cursors,
                                sessionId,
                            )
                        )
                    }
                }
            }
                .onFailure {
                    if (api === client)
                        state.value = state.value.copy(error = "离线缓存保存失败：${it.message}")
                }
        }
    }

    private fun loadModels() {
        val client = api ?: return
        viewModelScope.launch {
            runRequestCatching { client.getJson("/models") as kotlinx.serialization.json.JsonArray }
                .onSuccess { result ->
                    if (api === client)
                        state.value =
                            state.value.copy(
                                models =
                                    result.mapNotNull {
                                        val obj = it as? JsonObject ?: return@mapNotNull null
                                        ModelReference(
                                            obj["provider"]?.jsonPrimitive?.content.orEmpty(),
                                            obj["id"]?.jsonPrimitive?.content.orEmpty(),
                                        )
                                    }
                            )
                }
                .onFailure {
                    if (api === client)
                        state.value = state.value.copy(error = requestErrorMessage(it, "读取模型失败"))
                }
        }
    }

    fun selectModel(model: ModelReference) {
        val client = api ?: return
        val id = state.value.selectedSessionId ?: return
        if (state.value.loading || state.value.offline) return
        state.value = state.value.copy(loading = true)
        viewModelScope.launch {
            runRequestCatching {
                client.patchJson(
                    "/sessions/${Uri.encode(id)}",
                    buildJsonObject {
                        put(
                            "model",
                            buildJsonObject {
                                put("provider", model.provider)
                                put("id", model.id)
                            },
                        )
                    },
                )
            }
                .onSuccess {
                    if (api === client) {
                        sessions = sessions.map {
                            if (it.session.id == id)
                                it.copy(session = it.session.copy(model = model))
                            else it
                        }
                        state.value =
                            state.value.copy(
                                sessions =
                                    state.value.sessions.map {
                                        if (it.id == id) it.copy(model = model) else it
                                    }
                            )
                        persistCache()
                    }
                }
                .onFailure {
                    if (api === client && state.value.selectedSessionId == id)
                        state.value = state.value.copy(error = requestErrorMessage(it, "模型切换失败"))
                }
            if (api === client && state.value.selectedSessionId == id)
                state.value = state.value.copy(loading = false)
        }
    }

    fun setTheme(mode: String) {
        if (mode !in listOf("system", "light", "dark")) return
        appearance.edit().putString("theme", mode).apply()
        state.value = state.value.copy(themeMode = mode)
    }

    fun openRunTrace(runId: String) {
        traceJob?.cancel()
        state.value =
            state.value.copy(
                traceRunId = runId,
                traceData = null,
                traceError = "",
                traceLoading = false,
            )
        loadMoreTrace()
    }

    fun loadMoreTrace() {
        val client = api ?: return
        val runId = state.value.traceRunId ?: return
        if (state.value.traceLoading) return
        val previous = state.value.traceData?.let { json.parseToJsonElement(it) as JsonObject }
        val offset = previous?.get("nextOffset")?.jsonPrimitive?.longOrNull ?: 0L
        state.value = state.value.copy(traceLoading = true, traceError = "")
        // 关闭后重开同一个 Run 也要取消旧页请求，单凭 Run ID 不能区分两次查看。
        traceJob = viewModelScope.launch {
            runRequestCatching {
                client.getJson("/traces?runId=${Uri.encode(runId)}&offset=$offset&limit=100")
                    as JsonObject
            }
                .onSuccess { page ->
                    if (api === client && state.value.traceRunId == runId) {
                        val items =
                            (previous?.get("spans") as? kotlinx.serialization.json.JsonArray)
                                .orEmpty() +
                                (page["spans"] as? kotlinx.serialization.json.JsonArray).orEmpty()
                        state.value =
                            state.value.copy(
                                traceData =
                                    JsonObject(
                                            page +
                                                ("spans" to
                                                    kotlinx.serialization.json.JsonArray(items))
                                        )
                                        .toString()
                            )
                    }
                }
                .onFailure {
                    if (api === client && state.value.traceRunId == runId)
                        state.value =
                            state.value.copy(traceError = requestErrorMessage(it, "读取链路失败"))
                }
            if (api === client && state.value.traceRunId == runId)
                state.value = state.value.copy(traceLoading = false)
        }
    }

    fun closeRunTrace() {
        traceJob?.cancel()
        traceJob = null
        state.value = state.value.copy(traceData = null, traceRunId = null, traceLoading = false)
    }

    fun setInteractionMode(mode: String) {
        if (state.value.unconfirmedSend || state.value.loading) return
        if (mode == "agent" || mode == "plan")
            state.value = state.value.copy(interactionMode = mode)
    }

    // 队列回执只更新发起会话；旧会话请求不得覆盖新会话或清除它的加载状态。
    fun loadQueue(sessionId: String = state.value.selectedSessionId.orEmpty()) {
        if (state.value.offline || sessionId.isBlank()) return
        val client = api ?: return
        viewModelScope.launch {
            runRequestCatching { client.queue(sessionId.trim()) }
                .onSuccess { queue ->
                    if (api !== client || state.value.selectedSessionId != sessionId)
                        return@onSuccess
                    state.value = state.value.copy(queue = parseQueue(queue.toString()), error = "")
                }
                .onFailure { error ->
                    if (api !== client || state.value.selectedSessionId != sessionId)
                        return@onFailure
                    state.value = state.value.copy(error = requestErrorMessage(error, "队列读取失败"))
                }
        }
    }

    fun reorderQueue(runIds: List<String>) {
        val sessionId = state.value.selectedSessionId ?: return
        val normalized = runIds.map(String::trim).filter(String::isNotBlank)
        if (state.value.offline || state.value.loading || normalized.isEmpty()) return
        val client = api ?: return
        state.value = state.value.copy(loading = true, error = "")
        viewModelScope.launch {
            runRequestCatching { client.reorderQueue(sessionId, normalized) }
                .onSuccess { queue ->
                    if (api !== client || state.value.selectedSessionId != sessionId)
                        return@onSuccess
                    state.value =
                        state.value.copy(queue = parseQueue(queue.toString()), loading = false)
                }
                .onFailure { error ->
                    if (api !== client || state.value.selectedSessionId != sessionId)
                        return@onFailure
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "队列重排失败"),
                        )
                }
        }
    }

    fun prioritizeRun(runId: String) {
        val sessionId = state.value.selectedSessionId ?: return
        if (state.value.offline || state.value.loading || runId.isBlank()) return
        val client = api ?: return
        state.value = state.value.copy(loading = true, error = "")
        viewModelScope.launch {
            runRequestCatching {
                client.prioritizeRun(runId.trim())
                client.queue(sessionId)
            }
                .onSuccess { queue ->
                    if (api !== client || state.value.selectedSessionId != sessionId)
                        return@onSuccess
                    state.value =
                        state.value.copy(queue = parseQueue(queue.toString()), loading = false)
                }
                .onFailure { error ->
                    if (api !== client || state.value.selectedSessionId != sessionId)
                        return@onFailure
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "队列置顶失败"),
                        )
                }
        }
    }

    fun cancelQueuedRun(runId: String) {
        val sessionId = state.value.selectedSessionId ?: return
        if (state.value.offline || state.value.loading || runId.isBlank()) return
        val client = api ?: return
        state.value = state.value.copy(loading = true, error = "")
        viewModelScope.launch {
            runRequestCatching {
                client.cancelRun(runId.trim())
                client.queue(sessionId)
            }
                .onSuccess { queue ->
                    if (api !== client || state.value.selectedSessionId != sessionId)
                        return@onSuccess
                    state.value =
                        state.value.copy(queue = parseQueue(queue.toString()), loading = false)
                }
                .onFailure { error ->
                    if (api !== client || state.value.selectedSessionId != sessionId)
                        return@onFailure
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "队列消息取消失败"),
                        )
                }
        }
    }

    fun editQueuedMessage(item: UiQueueItem, text: String, onSaved: () -> Unit) {
        val sessionId = state.value.selectedSessionId ?: return
        val normalized = text.trim()
        if (
            state.value.offline ||
                state.value.loading ||
                normalized.isBlank() ||
                item.messageId.isBlank()
        )
            return
        val client = api ?: return
        state.value = state.value.copy(loading = true, error = "")
        viewModelScope.launch {
            runRequestCatching {
                client.editMessage(item.messageId, normalized)
                // 写入已确认；后续读取队列失败不能诱导用户重复执行编辑。
                if (api === client && state.value.selectedSessionId == sessionId) onSaved()
                client.queue(sessionId)
            }
                .onSuccess { queue ->
                    if (api !== client || state.value.selectedSessionId != sessionId)
                        return@onSuccess
                    state.value =
                        state.value.copy(queue = parseQueue(queue.toString()), loading = false)
                }
                .onFailure { error ->
                    if (api !== client || state.value.selectedSessionId != sessionId)
                        return@onFailure
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "队列消息编辑失败"),
                        )
                }
        }
    }

    fun confirmPlan(runId: String) {
        if (state.value.loading || state.value.offline || runId.isBlank()) return
        val sessionId = state.value.selectedSessionId ?: return
        val client = api ?: return
        state.value = state.value.copy(loading = true, error = "")
        viewModelScope.launch {
            runRequestCatching { client.confirmPlan(runId.trim()) }
                .onSuccess {
                    if (api !== client || state.value.selectedSessionId != sessionId)
                        return@onSuccess
                    state.value = state.value.copy(loading = false)
                    selectSession(sessionId)
                }
                .onFailure { error ->
                    if (api !== client || state.value.selectedSessionId != sessionId)
                        return@onFailure
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "确认计划失败"),
                        )
                }
        }
    }

    fun send(text: String, onAccepted: () -> Unit = {}) {
        val id = state.value.selectedSessionId ?: return
        val client = api ?: return
        if (
            state.value.offline ||
                state.value.loading ||
                (text.isBlank() && state.value.pendingAttachmentIds.isEmpty())
        )
            return
        val draft = drafts[id] ?: SessionDraft(text, state.value.pendingAttachments)
        val previous = draft.pending
        if (
            previous != null &&
                (previous.text != text.ifBlank { "请查看附件。" } ||
                    previous.attachmentIds != state.value.pendingAttachmentIds ||
                    previous.mode != state.value.interactionMode)
        ) {
            state.value = state.value.copy(error = "上次发送结果尚未核实，请恢复原草稿后重试，避免重复执行。")
            return
        }
        val request =
            previous
                ?: PendingSend(
                    java.util.UUID.randomUUID().toString(),
                    text.ifBlank { "请查看附件。" },
                    state.value.pendingAttachmentIds.toList(),
                    state.value.interactionMode,
                )
        drafts[id] = draft.copy(pending = request)
        val persisted = drafts.toMap()
        draftJob?.cancel()
        state.value = state.value.copy(loading = true, sending = true, error = "")
        viewModelScope.launch {
            try {
                // 先持久化幂等标识再提交。进程在回执前退出，重试仍使用同一个 messageId。
                localStorage { draftStore.write(persisted) }
                if (api !== client) return@launch
                var accepted = false
                if (previous != null) {
                    var before: Long? = null
                    do {
                        val page = client.history(id, before)
                        val items = page["items"] as? kotlinx.serialization.json.JsonArray
                        accepted =
                            items?.any {
                                (it as? JsonObject)?.get("id")?.jsonPrimitive?.content ==
                                    request.messageId
                            } == true
                        val next = page["oldestSequence"]?.jsonPrimitive?.longOrNull
                        if (
                            accepted ||
                                page["hasMore"]?.jsonPrimitive?.booleanOrNull != true ||
                                next == null ||
                                next == before
                        )
                            break
                        before = next
                    } while (true)
                }
                if (!accepted)
                    client.send(
                        id,
                        request.text,
                        request.attachmentIds,
                        request.mode,
                        request.messageId,
                    )
                if (api !== client) return@launch
                drafts[id] = SessionDraft()
                persistDrafts(immediate = true)
                if (state.value.selectedSessionId == id) {
                    onAccepted()
                    state.value =
                        state.value.copy(
                            offline = false,
                            loading = false,
                            sending = false,
                            unconfirmedSend = false,
                            pendingAttachmentIds = emptyList(),
                            pendingAttachments = emptyList(),
                        )
                    selectSession(id)
                }
            } catch (error: Throwable) {
                currentCoroutineContext().ensureActive()
                if (error is kotlinx.coroutines.CancellationException) throw error
                if (api !== client) return@launch
                // 明确的请求拒绝允许修正输入；超时或服务端异常保留标识供核对。
                if (error is UmaApiException && error.status in 400..499) {
                    drafts[id] = (drafts[id] ?: draft).copy(pending = null)
                    persistDrafts(immediate = true)
                }
                if (state.value.selectedSessionId == id)
                    state.value =
                        state.value.copy(
                            loading = false,
                            sending = false,
                            unconfirmedSend = drafts[id]?.pending != null,
                            offline = error !is UmaApiException,
                            error = requestErrorMessage(error, "发送失败，草稿已保留"),
                        )
            }
        }
    }

    fun retryMessage(item: UiMessage) {
        val id = state.value.selectedSessionId ?: return
        if (item.role != "user" || state.value.offline || state.value.loading) return
        val client = api ?: return
        state.value = state.value.copy(loading = true, error = "")
        viewModelScope.launch {
            runRequestCatching {
                client.send(
                    id,
                    item.content.ifBlank { "请查看附件。" },
                    item.attachments.map { it.id },
                    item.interactionMode ?: state.value.interactionMode,
                )
            }
                .onSuccess {
                    if (api !== client || state.value.selectedSessionId != id) return@onSuccess
                    selectSession(id)
                }
                .onFailure { error ->
                    if (api !== client || state.value.selectedSessionId != id) return@onFailure
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "重试失败"),
                        )
                }
        }
    }

    fun editMessage(messageId: String, text: String, onSaved: () -> Unit) {
        val sessionId = state.value.selectedSessionId ?: return
        val normalized = text.trim()
        if (
            state.value.loading ||
                state.value.offline ||
                messageId.isBlank() ||
                normalized.isBlank()
        )
            return
        val client = api ?: return
        state.value = state.value.copy(loading = true, error = "")
        viewModelScope.launch {
            runRequestCatching { client.editMessage(messageId.trim(), normalized) }
                .onSuccess {
                    if (api !== client || state.value.selectedSessionId != sessionId)
                        return@onSuccess
                    state.value = state.value.copy(loading = false)
                    onSaved()
                    selectSession(sessionId)
                }
                .onFailure { error ->
                    if (api !== client || state.value.selectedSessionId != sessionId)
                        return@onFailure
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "消息编辑失败"),
                        )
                }
        }
    }

    fun reviewMessage(messageId: String) =
        runMessageQualityAction(messageId, "审查") { client ->
            client.reviewMessage(messageId.trim())
        }

    fun improveMessage(messageId: String) =
        runMessageQualityAction(messageId, "改进") { client ->
            client.improveMessage(messageId.trim())
        }

    private fun runMessageQualityAction(
        messageId: String,
        action: String,
        request: suspend (UmaApi) -> Unit,
    ) {
        val sessionId = state.value.selectedSessionId ?: return
        if (state.value.loading || state.value.offline || messageId.isBlank()) return
        val client = api ?: return
        state.value = state.value.copy(loading = true, error = "")
        viewModelScope.launch {
            runRequestCatching { request(client) }
                .onSuccess {
                    if (api !== client || state.value.selectedSessionId != sessionId)
                        return@onSuccess
                    state.value = state.value.copy(loading = false)
                    selectSession(sessionId)
                }
                .onFailure { error ->
                    if (api !== client || state.value.selectedSessionId != sessionId)
                        return@onFailure
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "${action}失败"),
                        )
                }
        }
    }

    fun uploadAttachment(uri: Uri, name: String) {
        val sessionId = state.value.selectedSessionId ?: return
        val client = api ?: return
        if (state.value.offline) return
        viewModelScope.launch {
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.upload(getApplication(), uri, name, sessionId) }
                .onSuccess { attachment ->
                    // 上传结果只归属发起时的账号和会话，切换页面不能把附件带到别人的草稿。
                    if (api !== client) return@onSuccess
                    val id = attachment["id"]?.jsonPrimitive?.content
                    val uploaded = id?.let {
                        PendingAttachment(
                            id = it,
                            name = attachment["name"]?.jsonPrimitive?.content ?: name,
                            size = attachment["size"]?.jsonPrimitive?.longOrNull ?: 0L,
                        )
                    }
                    val pending = drafts[sessionId]?.attachments.orEmpty() + listOfNotNull(uploaded)
                    saveDraftAttachments(sessionId, pending)
                    if (state.value.selectedSessionId != sessionId) return@onSuccess
                    state.value =
                        state.value.copy(
                            pendingAttachmentIds = pending.map { it.id },
                            pendingAttachments = pending,
                            loading = false,
                        )
                }
                .onFailure { error ->
                    if (api === client && state.value.selectedSessionId == sessionId)
                        state.value =
                            state.value.copy(
                                loading = false,
                                error = requestErrorMessage(error, "附件上传失败"),
                            )
                }
        }
    }

    fun removePendingAttachment(id: String) {
        if (state.value.unconfirmedSend || state.value.loading) return
        state.value =
            state.value.copy(
                pendingAttachmentIds = state.value.pendingAttachmentIds.filterNot { it == id },
                pendingAttachments = state.value.pendingAttachments.filterNot { it.id == id },
            )
        state.value.selectedSessionId?.let {
            saveDraftAttachments(it, state.value.pendingAttachments)
        }
    }

    fun downloadAttachment(id: String, destination: Uri) {
        if (state.value.offline || id.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching {
                client.downloadAttachment(getApplication(), id.trim(), destination)
            }
                .onSuccess {
                    state.value = state.value.copy(loading = false)
                    android.widget.Toast.makeText(
                            getApplication(),
                            "附件已保存",
                            android.widget.Toast.LENGTH_SHORT,
                        )
                        .show()
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "附件下载失败"),
                        )
                }
        }
    }

    fun previewImageAttachment(attachment: UiAttachment) {
        if (
            state.value.offline ||
                attachment.id.isBlank() ||
                !attachment.mimeType.startsWith("image/")
        )
            return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching {
                client.attachmentBytes(
                    attachment.id,
                    maxBytes = 4 * 1024 * 1024,
                    description = "图片",
                )
            }
                .onSuccess { bytes ->
                    state.value =
                        state.value.copy(
                            attachmentPreview =
                                AttachmentPreview(attachment.id, attachment.name, bytes),
                            loading = false,
                        )
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "图片预览失败"),
                        )
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
                    state.value =
                        state.value.copy(
                            backgroundTasks = parseBackgroundTasks(tasks.toString()),
                            loading = false,
                            offline = false,
                        )
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "后台任务读取失败"),
                        )
                }
        }
    }

    fun createBackgroundTask(prompt: String, onCreated: () -> Unit = {}) {
        val parentSessionId = state.value.selectedSessionId ?: return
        val normalized = prompt.trim()
        if (state.value.offline || normalized.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching {
                client.createTask(normalized, parentSessionId)
                if (api !== client) return@runRequestCatching null
                onCreated()
                client.bootstrap() to client.tasks()
            }
                .onSuccess { result ->
                    if (api !== client || result == null) return@onSuccess
                    val (bootstrap, tasks) = result
                    sessions = bootstrap.sessions
                    bootstrap.sessions.forEach { entry ->
                        sequences[entry.session.id] =
                            maxOf(sequences[entry.session.id] ?: 0L, entry.lastSequence)
                    }
                    state.value =
                        state.value.copy(
                            sessions = bootstrap.sessions.map { it.session },
                            backgroundTasks = parseBackgroundTasks(tasks.toString()),
                            loading = false,
                            offline = false,
                        )
                    sendSubscriptions()
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "后台任务创建失败"),
                        )
                }
        }
    }

    fun cancelBackgroundTask(id: String) {
        if (state.value.offline || id.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching {
                client.cancelTask(id.trim())
                client.tasks()
            }
                .onSuccess { tasks ->
                    state.value =
                        state.value.copy(
                            backgroundTasks = parseBackgroundTasks(tasks.toString()),
                            loading = false,
                        )
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "后台任务取消失败"),
                        )
                }
        }
    }

    fun deleteBackgroundTask(id: String) {
        if (state.value.offline || id.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching {
                client.deleteTask(id.trim())
                client.tasks()
            }
                .onSuccess { tasks ->
                    state.value =
                        state.value.copy(
                            backgroundTasks = parseBackgroundTasks(tasks.toString()),
                            loading = false,
                        )
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "后台任务删除失败"),
                        )
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
                    state.value =
                        state.value.copy(
                            scheduledTasks = parseScheduledTasks(schedules.toString()),
                            loading = false,
                            offline = false,
                        )
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "调度读取失败"),
                        )
                }
        }
    }

    fun createScheduledTask(
        name: String,
        prompt: String,
        kind: String,
        value: String,
        timezone: String,
        onCreated: () -> Unit = {},
    ) {
        val normalizedName = name.trim()
        val normalizedPrompt = prompt.trim()
        val normalizedValue = value.trim()
        if (
            state.value.offline ||
                normalizedName.isBlank() ||
                normalizedPrompt.isBlank() ||
                normalizedValue.isBlank()
        )
            return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching {
                client.createSchedule(
                    normalizedName,
                    normalizedPrompt,
                    kind,
                    normalizedValue,
                    timezone.trim(),
                )
                if (api !== client) return@runRequestCatching null
                onCreated()
                client.schedules()
            }
                .onSuccess { schedules ->
                    if (api !== client || schedules == null) return@onSuccess
                    state.value =
                        state.value.copy(
                            scheduledTasks = parseScheduledTasks(schedules.toString()),
                            loading = false,
                        )
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "调度创建失败"),
                        )
                }
        }
    }

    fun toggleScheduledTask(id: String, enabled: Boolean) {
        if (state.value.offline || id.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching {
                client.updateSchedule(id.trim(), enabled)
                client.schedules()
            }
                .onSuccess { schedules ->
                    state.value =
                        state.value.copy(
                            scheduledTasks = parseScheduledTasks(schedules.toString()),
                            loading = false,
                        )
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "调度状态更新失败"),
                        )
                }
        }
    }

    fun runScheduledTask(id: String) {
        if (state.value.offline || id.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching {
                client.runSchedule(id.trim())
                client.schedules()
            }
                .onSuccess { schedules ->
                    state.value =
                        state.value.copy(
                            scheduledTasks = parseScheduledTasks(schedules.toString()),
                            loading = false,
                        )
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "调度运行失败"),
                        )
                }
        }
    }

    fun deleteScheduledTask(id: String) {
        if (state.value.offline || id.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching {
                client.deleteSchedule(id.trim())
                client.schedules()
            }
                .onSuccess { schedules ->
                    state.value =
                        state.value.copy(
                            scheduledTasks = parseScheduledTasks(schedules.toString()),
                            scheduledRuns = state.value.scheduledRuns - id.trim(),
                            loading = false,
                        )
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "调度删除失败"),
                        )
                }
        }
    }

    fun loadScheduledRuns(scheduleId: String) {
        if (state.value.offline || scheduleId.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            runRequestCatching { client.scheduleRuns(scheduleId.trim()) }
                .onSuccess { runs ->
                    state.value =
                        state.value.copy(
                            scheduledRuns =
                                state.value.scheduledRuns +
                                    (scheduleId.trim() to parseScheduledRuns(runs.toString())),
                            error = "",
                        )
                }
                .onFailure { error ->
                    state.value = state.value.copy(error = requestErrorMessage(error, "运行历史读取失败"))
                }
        }
    }

    fun cancelScheduledRun(scheduleId: String, runId: String) {
        if (state.value.offline || runId.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching {
                client.cancelScheduleRun(runId.trim())
                client.scheduleRuns(scheduleId.trim())
            }
                .onSuccess { runs ->
                    state.value =
                        state.value.copy(
                            scheduledRuns =
                                state.value.scheduledRuns +
                                    (scheduleId.trim() to parseScheduledRuns(runs.toString())),
                            loading = false,
                        )
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "调度运行取消失败"),
                        )
                }
        }
    }

    fun createSession(title: String, onCreated: () -> Unit = {}) {
        if (state.value.offline || state.value.loading || title.isBlank()) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.createSession(title.trim()) }
                .onSuccess { session ->
                    sessions = sessions + BootstrapEntry(session)
                    state.value =
                        state.value.copy(
                            sessions = sessions.map { it.session },
                            selectedSessionId = session.id,
                            assistantAvatar = null,
                            snapshot = "",
                            conversation = null,
                            approvals = null,
                            queue = emptyList(),
                            loading = false,
                        )
                    onCreated()
                    persistCache()
                    sendSubscriptions()
                    selectSession(session.id)
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "创建会话失败"),
                        )
                }
        }
    }

    fun renameSession(title: String, onSaved: () -> Unit = {}) {
        val id = state.value.selectedSessionId ?: return
        if (state.value.loading || state.value.offline || title.isBlank()) return
        val client = api ?: return
        state.value = state.value.copy(loading = true, error = "")
        viewModelScope.launch {
            runRequestCatching { client.renameSession(id, title.trim()) }
                .onSuccess { session ->
                    if (api !== client) return@onSuccess
                    sessions = sessions.map {
                        if (it.session.id == id) it.copy(session = session) else it
                    }
                    state.value =
                        state.value.copy(
                            sessions = sessions.map { it.session },
                            loading =
                                if (state.value.selectedSessionId == id) false
                                else state.value.loading,
                        )
                    persistCache()
                    if (state.value.selectedSessionId == id) onSaved()
                }
                .onFailure { error ->
                    if (api !== client || state.value.selectedSessionId != id) return@onFailure
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "重命名失败"),
                        )
                }
        }
    }

    fun updateQueueMode(queueMode: String) {
        val id = state.value.selectedSessionId ?: return
        if (
            state.value.loading ||
                state.value.offline ||
                (queueMode != "queue" && queueMode != "preemptive")
        )
            return
        val client = api ?: return
        state.value = state.value.copy(loading = true, error = "")
        viewModelScope.launch {
            runRequestCatching { client.updateQueueMode(id, queueMode) }
                .onSuccess { session ->
                    if (api !== client) return@onSuccess
                    sessions = sessions.map {
                        if (it.session.id == id) it.copy(session = session) else it
                    }
                    state.value =
                        state.value.copy(
                            sessions = sessions.map { it.session },
                            loading =
                                if (state.value.selectedSessionId == id) false
                                else state.value.loading,
                        )
                    persistCache()
                }
                .onFailure { error ->
                    if (api !== client || state.value.selectedSessionId != id) return@onFailure
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "执行策略更新失败"),
                        )
                }
        }
    }

    fun updateAssistantName(name: String) {
        val id = state.value.selectedSessionId ?: return
        if (state.value.loading || state.value.offline || name.isBlank()) return
        val client = api ?: return
        state.value = state.value.copy(loading = true, error = "")
        viewModelScope.launch {
            runRequestCatching { client.updateAssistantIdentity(id, name = name.trim()) }
                .onSuccess { session ->
                    if (api !== client) return@onSuccess
                    sessions = sessions.map {
                        if (it.session.id == id) it.copy(session = session) else it
                    }
                    state.value =
                        state.value.copy(
                            sessions = sessions.map { it.session },
                            loading =
                                if (state.value.selectedSessionId == id) false
                                else state.value.loading,
                        )
                    persistCache()
                }
                .onFailure { error ->
                    if (api !== client || state.value.selectedSessionId != id) return@onFailure
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "助手名称更新失败"),
                        )
                }
        }
    }

    fun uploadAssistantAvatar(uri: Uri, name: String) {
        val id = state.value.selectedSessionId ?: return
        if (state.value.offline || state.value.loading) return
        val client = api ?: return
        state.value = state.value.copy(loading = true, error = "")
        viewModelScope.launch {
            runRequestCatching {
                val attachment = client.upload(getApplication(), uri, name, id, purpose = "avatar")
                val attachmentId = attachment["id"]?.jsonPrimitive?.content ?: error("头像附件无 ID")
                client.updateAssistantIdentity(id, avatarAttachmentId = attachmentId)
            }
                .onSuccess { session ->
                    if (api !== client) return@onSuccess
                    updateSessionMetadata(
                        client,
                        buildJsonObject {
                            put("session", json.encodeToJsonElement(Session.serializer(), session))
                        },
                    )
                    if (state.value.selectedSessionId == id)
                        state.value = state.value.copy(loading = false)
                    persistCache()
                }
                .onFailure { error ->
                    if (api !== client || state.value.selectedSessionId != id) return@onFailure
                    state.value =
                        state.value.copy(
                            loading =
                                if (state.value.selectedSessionId == id) false
                                else state.value.loading,
                            error = requestErrorMessage(error, "头像上传失败"),
                        )
                }
        }
    }

    fun resetAssistantAvatar() {
        val id = state.value.selectedSessionId ?: return
        if (state.value.offline || state.value.loading) return
        val client = api ?: return
        state.value = state.value.copy(loading = true, error = "")
        viewModelScope.launch {
            runRequestCatching { client.updateAssistantIdentity(id, clearAvatar = true) }
                .onSuccess { session ->
                    if (api !== client) return@onSuccess
                    sessions = sessions.map {
                        if (it.session.id == id) it.copy(session = session) else it
                    }
                    state.value =
                        state.value.copy(
                            sessions = sessions.map { it.session },
                            loading =
                                if (state.value.selectedSessionId == id) false
                                else state.value.loading,
                            assistantAvatar =
                                if (state.value.selectedSessionId == id) null
                                else state.value.assistantAvatar,
                        )
                    persistCache()
                }
                .onFailure { error ->
                    if (api !== client || state.value.selectedSessionId != id) return@onFailure
                    state.value =
                        state.value.copy(
                            loading =
                                if (state.value.selectedSessionId == id) false
                                else state.value.loading,
                            error = requestErrorMessage(error, "头像恢复失败"),
                        )
                }
        }
    }

    fun deleteSelectedSession() {
        val id = state.value.selectedSessionId ?: return
        val client = api ?: return
        if (state.value.offline || state.value.loading) return
        state.value = state.value.copy(loading = true, error = "")
        viewModelScope.launch {
            runRequestCatching { client.deleteSession(id) }
                .onSuccess {
                    if (api !== client) return@onSuccess
                    sessions = sessions.filterNot { it.session.id == id }
                    drafts.remove(id)
                    persistDrafts(immediate = true)
                    if (state.value.selectedSessionId == id) {
                        selectionJob?.cancel()
                        publishJob?.cancel()
                        avatarJob?.cancel()
                        projectedSession = null
                        projectedSnapshot = null
                        state.value =
                            state.value.copy(
                                sessions = sessions.map { it.session },
                                selectedSessionId = null,
                                assistantAvatar = null,
                                snapshot = "",
                                conversation = null,
                                approvals = null,
                                queue = emptyList(),
                                sending = false,
                                cancelling = false,
                                unconfirmedSend = false,
                                pendingAttachments = emptyList(),
                                pendingAttachmentIds = emptyList(),
                                loading = false,
                            )
                    } else state.value = state.value.copy(sessions = sessions.map { it.session })
                    persistCache()
                    sendSubscriptions()
                }
                .onFailure { error ->
                    if (api !== client || state.value.selectedSessionId != id) return@onFailure
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "删除会话失败"),
                        )
                }
        }
    }

    fun cancelSelectedSession() {
        val id = state.value.selectedSessionId ?: return
        if (state.value.offline || state.value.cancelling) return
        val client = api ?: return
        state.value = state.value.copy(cancelling = true, error = "")
        viewModelScope.launch {
            try {
                runRequestCatching { client.cancelSession(id) }
                    .onFailure { error ->
                        if (api !== client || state.value.selectedSessionId != id) return@onFailure
                        state.value = state.value.copy(error = requestErrorMessage(error, "取消失败"))
                    }
            } finally {
                if (api === client && state.value.selectedSessionId == id)
                    state.value = state.value.copy(cancelling = false)
            }
        }
    }

    fun resolveApproval(id: String, approved: Boolean) {
        if (state.value.loading || state.value.offline || id.isBlank()) return
        val sessionId = state.value.selectedSessionId ?: return
        val client = api ?: return
        state.value = state.value.copy(loading = true, error = "")
        viewModelScope.launch {
            runRequestCatching { client.resolveApproval(id.trim(), approved) }
                .onSuccess {
                    if (api !== client || state.value.selectedSessionId != sessionId)
                        return@onSuccess
                    state.value = state.value.copy(loading = false)
                    selectSession(sessionId)
                }
                .onFailure { error ->
                    if (api !== client || state.value.selectedSessionId != sessionId)
                        return@onFailure
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "审批操作失败"),
                        )
                }
        }
    }

    fun compactSelectedSession() {
        val id = state.value.selectedSessionId ?: return
        val client = api ?: return
        if (state.value.offline || state.value.loading) return
        state.value = state.value.copy(loading = true, error = "")
        viewModelScope.launch {
            runRequestCatching {
                client.compactSession(id)
                if (api === client && state.value.selectedSessionId == id) selectSession(id)
            }
                .onFailure { error ->
                    if (api !== client || state.value.selectedSessionId != id) return@onFailure
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "压缩失败"),
                        )
                }
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
                                state.value =
                                    state.value.copy(xianyuLogin = next.toString(), error = "")
                                val loginStatus = next["status"]?.jsonPrimitive?.content
                                if (loginStatus == "authenticated") {
                                    val workspace = client.xianyuWorkspace()
                                    state.value =
                                        state.value.copy(
                                            xianyuStatus =
                                                workspace["service"]?.toString().orEmpty(),
                                            xianyuLogin =
                                                workspace["login"]?.toString() ?: next.toString(),
                                        )
                                    refreshXianyuWorkspace()
                                    return@launch
                                }
                                if (loginStatus == "expired" || loginStatus == "failed")
                                    return@launch
                            } catch (error: Throwable) {
                                currentCoroutineContext().ensureActive()
                                if (error is kotlinx.coroutines.CancellationException) throw error
                                state.value =
                                    state.value.copy(
                                        error = requestErrorMessage(error, "咸鱼登录状态查询失败")
                                    )
                                return@launch
                            }
                        }
                    }
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "咸鱼二维码生成失败"),
                        )
                }
        }
    }

    fun setXianyuAutoReply(enabled: Boolean) {
        if (state.value.userRole != "admin" || state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.xianyuSetAutoReply(enabled) }
                .onSuccess {
                    state.value = state.value.copy(xianyuAutoReply = enabled, loading = false)
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "自动回复设置失败"),
                        )
                }
        }
    }

    fun refreshXianyuWorkspace() {
        if (state.value.userRole != "admin") return
        viewModelScope.launch {
            val client = api ?: return@launch
            runRequestCatching { client.xianyuWorkspace() }
                .onSuccess { payload ->
                    if (api !== client) return@onSuccess
                    val next = parseXianyuSessions(payload)
                    if (next.isNotEmpty())
                        sessions = next.map { BootstrapEntry(it, sequences[it.id] ?: 0L) }
                    state.value =
                        state.value.copy(
                            workspace = if (next.isNotEmpty()) "xianyu" else state.value.workspace,
                            sessions = if (next.isNotEmpty()) next else state.value.sessions,
                            xianyuLoaded = true,
                            xianyuError = "",
                            xianyuDraftMessageIds = parseXianyuDraftMessageIds(payload),
                            xianyuAutoReply =
                                payload["autoReplyEnabled"]?.jsonPrimitive?.booleanOrNull == true,
                            xianyuStatus = payload["service"]?.toString().orEmpty(),
                            xianyuLogin = payload["login"]?.toString().orEmpty(),
                        )
                    sendSubscriptions()
                }
                .onFailure {
                    if (api === client)
                        state.value =
                            state.value.copy(
                                xianyuLoaded = true,
                                xianyuError = xianyuErrorMessage(it),
                            )
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
                    state.value =
                        state.value.copy(
                            workspace = "agent",
                            sessions = bootstrap.sessions.map { it.session },
                            selectedSessionId = bootstrap.sessions.firstOrNull()?.session?.id,
                            loading = false,
                            offline = false,
                        )
                    sendSubscriptions()
                    state.value.selectedSessionId?.let(::selectSession)
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "普通工作区加载失败"),
                        )
                }
        }
    }

    fun sendXianyuDraft(messageId: String) {
        val sessionId = state.value.selectedSessionId ?: return
        if (
            state.value.userRole != "admin" ||
                state.value.workspace != "xianyu" ||
                state.value.offline ||
                state.value.loading ||
                messageId.isBlank()
        )
            return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching {
                client.xianyuSendDraft(sessionId, messageId.trim())
                client.snapshot(sessionId)
            }
                .onSuccess { snapshot ->
                    state.value =
                        state.value.copy(
                            snapshot = snapshot.toString(),
                            conversation = parseSnapshotConversation(snapshot),
                            approvals = pendingApprovals(snapshot),
                            queue = parseQueue(snapshot),
                            loading = false,
                            offline = false,
                        )
                    refreshXianyuWorkspace()
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "发送草稿失败"),
                        )
                }
        }
    }

    fun xianyuAction(action: String) {
        if (state.value.userRole != "admin") return
        if (state.value.offline) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching {
                client.xianyuControl(action)
                client.xianyuStatus()
            }
                .onSuccess { status ->
                    state.value =
                        state.value.copy(
                            xianyuStatus = status.toString(),
                            xianyuLogin = status["login"]?.toString() ?: state.value.xianyuLogin,
                            loading = false,
                        )
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "咸鱼操作失败"),
                        )
                }
        }
    }

    fun xianyuHistory(conversationId: String) {
        if (conversationId.isBlank() || state.value.offline || state.value.loading) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.xianyuHistory(conversationId.trim()) }
                .onSuccess { value ->
                    state.value = state.value.copy(xianyuData = value.toString(), loading = false)
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "历史查询失败"),
                        )
                }
        }
    }

    fun xianyuItem(itemId: String) {
        if (itemId.isBlank() || state.value.offline || state.value.loading) return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.xianyuItem(itemId.trim()) }
                .onSuccess { value ->
                    state.value = state.value.copy(xianyuData = value.toString(), loading = false)
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "商品查询失败"),
                        )
                }
        }
    }

    fun xianyuChat(receiverId: String, itemId: String) {
        if (receiverId.isBlank() || itemId.isBlank() || state.value.offline || state.value.loading)
            return
        viewModelScope.launch {
            val client = api ?: return@launch
            state.value = state.value.copy(loading = true, error = "")
            runRequestCatching { client.xianyuChat(receiverId.trim(), itemId.trim()) }
                .onSuccess { value ->
                    state.value = state.value.copy(xianyuData = value.toString(), loading = false)
                }
                .onFailure { error ->
                    state.value =
                        state.value.copy(
                            loading = false,
                            error = requestErrorMessage(error, "建聊失败"),
                        )
                }
        }
    }

    suspend fun managementRequest(
        path: String,
        method: String = "GET",
        body: kotlinx.serialization.json.JsonObject = kotlinx.serialization.json.buildJsonObject {},
    ): JsonElement {
        val client = api ?: error("请先登录")
        // 读取跟随页面取消；写入归账号 ViewModel 所有，离页只停止等待，不中断已发出的操作。
        // 换账号会取消 viewModelScope 的子任务，旧账号回执也不能更新新账号状态。
        if (method != "GET")
            return viewModelScope
                .async {
                    try {
                        val result = managementWrite(client, path, method, body)
                        check(api === client) { "账户已切换，已忽略旧账户结果" }
                        result
                    } catch (error: Exception) {
                        if (error !is kotlinx.coroutines.CancellationException && api === client)
                            state.value =
                                state.value.copy(error = requestErrorMessage(error, "管理操作失败"))
                        throw error
                    }
                }
                .await()
        val result = client.getJson(path)
        check(api === client) { "账户已切换，已忽略旧账户结果" }
        return result
    }

    private suspend fun managementWrite(
        client: UmaApi,
        path: String,
        method: String,
        body: JsonObject,
    ): JsonElement =
        when (method) {
            "PUT" -> client.putJson(path, body)
            "POST" -> client.postJson(path, body)
            "PATCH" -> client.patchJson(path, body)
            "DELETE" -> {
                client.delete(path)
                kotlinx.serialization.json.JsonNull
            }
            else -> error("不支持的管理写入方法：$method")
        }

    suspend fun uploadKnowledgeSource(uri: android.net.Uri): JsonElement {
        val client = api ?: error("请先登录")
        val sessionId = state.value.selectedSessionId ?: error("请先选择会话")
        // 文件与知识源登记是一个用户操作；页面离开不能只留下已上传但未登记的附件。
        // 捕获发起时的账号和会话，切换账号取消任务，不自动重试结果未知的写请求。
        return viewModelScope
            .async {
                try {
                    val attachment = client.upload(getApplication(), uri, "knowledge", sessionId)
                    check(api === client) { "账户已切换" }
                    val id = attachment["id"]?.jsonPrimitive?.content ?: error("附件上传未返回标识")
                    val result =
                        client.postJson(
                            "/knowledge",
                            buildJsonObject {
                                put("name", attachment["name"]?.jsonPrimitive?.content ?: "上传资料")
                                put("attachmentId", id)
                                put("sessionId", sessionId)
                            },
                        )
                    check(api === client) { "账户已切换" }
                    result
                } catch (error: Exception) {
                    if (error !is kotlinx.coroutines.CancellationException && api === client)
                        state.value = state.value.copy(error = requestErrorMessage(error, "知识上传失败"))
                    throw error
                }
            }
            .await()
    }

    private fun persistCache() {
        // 主线程取得一致的身份与游标，再交给存储线程；禁止后台遍历可变 sequences。
        val visibleSessions = state.value.sessions
        val liveIds = visibleSessions.map { it.id }.toSet()
        val cursors = sequences.filterKeys { it in liveIds }
        val selected = state.value.selectedSessionId
        viewModelScope.launch {
            runRequestCatching {
                localStorage {
                    val current = cache.read()
                    cache.write(
                        CacheEnvelope(
                            version = SNAPSHOT_CACHE_VERSION,
                            sessions = visibleSessions,
                            snapshots = current?.snapshots.orEmpty().filterKeys { it in liveIds },
                            sequences = cursors,
                            selectedSessionId = selected,
                        )
                    )
                }
            }
                .onFailure { state.value = state.value.copy(error = "离线缓存保存失败：${it.message}") }
        }
    }

    private fun openSocket() {
        val client = api ?: return
        socket?.close(1000, "reconnect")
        socket =
            client.connectEvents(
                onOpen = { webSocket ->
                    if (api !== client) {
                        webSocket.close(1000, "account-changed")
                        return@connectEvents
                    }
                    val token = patStore.read()
                    if (token != null) {
                        webSocket.send(
                            buildJsonObject {
                                put("type", "auth")
                                put("token", token)
                            }
                                .toString()
                        )
                        sendSubscriptions(webSocket)
                    }
                    viewModelScope.launch { state.value.selectedSessionId?.let(::selectSession) }
                    refreshXianyuWorkspace()
                },
                onText = { message ->
                    viewModelScope.launch {
                        if (api === client) eventMutex.withLock { handleEvent(message) }
                    }
                },
                onFailure = { error -> if (api === client) handleSocketFailure(error) },
            )
    }

    private fun sendSubscriptions(target: WebSocket? = socket) {
        target?.send(
            eventSubscriptionFrame(
                sessions.map { it.session.id to (sequences[it.session.id] ?: 0L) }
            )
        )
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
        draftJob?.cancel()
        selectionJob?.cancel()
        publishJob?.cancel()
        cacheJob?.cancel()
        projectedSnapshot = null
        projectedSession = null
        xianyuLoginPoll?.cancel()
        xianyuLoginPoll = null
        localStorage {
            patStore.clear()
            cache.clear()
            draftStore.clear()
            drafts.clear()
        }
        sessions = emptyList()
        sequences.clear()
        state.value = UmaUiState(themeMode = state.value.themeMode, error = message)
    }

    /** 只在服务端确认后更新开关，账号切换后的迟到响应直接丢弃。 */
    fun refreshExecutionSettings() {
        val client = api ?: return
        viewModelScope.launch {
            runRequestCatching { client.getJson("/account/execution-settings") as JsonObject }
                .onSuccess { value ->
                    if (api === client)
                        state.value =
                            state.value.copy(
                                autoApprove =
                                    value["autoApprove"]?.jsonPrimitive?.booleanOrNull == true,
                                executionSettingsLoaded = true,
                            )
                }
                .onFailure {
                    if (api === client)
                        state.value = state.value.copy(error = requestErrorMessage(it, "读取执行设置失败"))
                }
        }
    }

    fun setAutoApprove(enabled: Boolean) {
        val client = api ?: return
        if (state.value.offline || state.value.savingExecutionSettings) return
        state.value = state.value.copy(savingExecutionSettings = true)
        viewModelScope.launch {
            runRequestCatching {
                client.patchJson(
                    "/account/execution-settings",
                    buildJsonObject { put("autoApprove", enabled) },
                ) as JsonObject
            }
                .onSuccess { value ->
                    if (api === client)
                        state.value =
                            state.value.copy(
                                autoApprove =
                                    value["autoApprove"]?.jsonPrimitive?.booleanOrNull == true,
                                executionSettingsLoaded = true,
                            )
                }
                .onFailure {
                    if (api === client)
                        state.value = state.value.copy(error = requestErrorMessage(it, "保存执行设置失败"))
                }
            if (api === client) state.value = state.value.copy(savingExecutionSettings = false)
        }
    }

    private suspend fun handleEvent(message: String) {
        val event =
            runCatching { json.parseToJsonElement(message) as? JsonObject }.getOrNull() ?: return
        notifyXianyuInbound(event)
        val resources = invalidatedResources(event)
        if (resources.isNotEmpty()) {
            if ("execution-settings" in resources) refreshExecutionSettings()
            if ("tasks" in resources) refreshBackgroundTasksSilently()
            if ("schedules" in resources) refreshScheduledTasksSilently()
            return
        }
        val sessionId = event["sessionId"]?.jsonPrimitive?.content ?: return
        val sequence = event["sequence"]?.jsonPrimitive?.longOrNull ?: return
        val client = api ?: return
        if (
            sequence > (sequences[sessionId] ?: 0L) &&
                event["type"]?.jsonPrimitive?.content == "session.snapshot"
        ) {
            (event["payload"] as? JsonObject)?.let { updateSessionMetadata(client, it) }
        }
        // 非当前会话无需加载正文；进入时读取服务端快照即可，不按后台 token 发请求。
        if (sessionId != state.value.selectedSessionId) return
        if (projectedSession != sessionId || projectedSnapshot == null) {
            projectedSession = sessionId
            projectedSnapshot =
                runCatching { json.parseToJsonElement(state.value.snapshot) as JsonObject }
                    .getOrNull() ?: client.snapshot(sessionId)
        }
        var current = projectedSnapshot ?: return
        val previous = current["snapshotSequence"]?.jsonPrimitive?.longOrNull ?: 0L
        if (sequence > 0 && sequence <= previous) return
        if (sequence > previous + 1) {
            var cursor = previous
            do {
                val page = client.events(sessionId, cursor)
                if (api !== client || state.value.selectedSessionId != sessionId) return
                val events = (page["events"] as? kotlinx.serialization.json.JsonArray).orEmpty()
                for (item in events) if (item is JsonObject)
                    current = projectSnapshot(current, item)
                val next = page["nextSequence"]?.jsonPrimitive?.longOrNull ?: cursor
                if (next <= cursor) break
                cursor = next
            } while (page["hasMore"]?.jsonPrimitive?.booleanOrNull == true)
            updateSessionMetadata(client, current)
        }
        if (api !== client || state.value.selectedSessionId != sessionId) return
        current = projectSnapshot(current, event)
        projectedSnapshot = current
        sequences[sessionId] = current["snapshotSequence"]?.jsonPrimitive?.longOrNull ?: previous
        val terminal =
            event["type"]?.jsonPrimitive?.content in
                listOf("message.completed", "response.completed", "run.updated")
        if (terminal) {
            publishJob?.cancel()
            publishProjection(client, sessionId)
        } else if (publishJob?.isActive != true)
            publishJob = viewModelScope.launch {
                delay(STREAM_PUBLISH_INTERVAL_MS)
                publishProjection(client, sessionId)
            }
        if (sequence > 0) {
            // 磁盘保存独立于 UI 增量；终态立即排队，其他持久事件在一秒内合并。
            if (terminal) cacheJob?.cancel()
            if (terminal || cacheJob?.isActive != true)
                cacheJob = viewModelScope.launch {
                    if (!terminal) delay(1_000)
                    val encoded = projectedSnapshot?.toString() ?: return@launch
                    val cursors = sequences.toMap()
                    val visibleSessions = state.value.sessions
                    localStorage {
                        if (api === client && projectedSession == sessionId) {
                            val previousCache = cache.read()?.snapshots.orEmpty()
                            cache.write(
                                CacheEnvelope(
                                    SNAPSHOT_CACHE_VERSION,
                                    visibleSessions,
                                    (previousCache + (sessionId to encoded))
                                        .entries
                                        .toList()
                                        .takeLast(4)
                                        .associate { it.toPair() },
                                    cursors,
                                    sessionId,
                                )
                            )
                        }
                    }
                }
        }
    }

    private suspend fun publishProjection(client: UmaApi, sessionId: String) {
        while (api === client && state.value.selectedSessionId == sessionId) {
            val snapshot = projectedSnapshot ?: return
            val parsed = withContext(Dispatchers.Default) { parseSnapshotConversation(snapshot) }
            // 挂起期间到达的终态具有优先权；重算最新投影，不能丢掉最后一次刷新。
            if (projectedSnapshot !== snapshot) continue
            if (api !== client || state.value.selectedSessionId != sessionId) return
            state.value =
                state.value.copy(
                    conversation = parsed,
                    approvals = pendingApprovals(snapshot),
                    queue = parseQueue(snapshot),
                    offline = false,
                )
            return
        }
    }

    private fun notifyXianyuInbound(event: JsonObject) {
        if (
            state.value.workspace != "xianyu" ||
                event["type"]?.jsonPrimitive?.content != "message.started"
        )
            return
        val sessionId = event["sessionId"]?.jsonPrimitive?.content ?: return
        if (state.value.sessions.none { it.id == sessionId }) return
        val payload = event["payload"] as? JsonObject ?: return
        if (payload["role"]?.jsonPrimitive?.content != "user") return
        if (
            Build.VERSION.SDK_INT >= 33 &&
                getApplication<Application>()
                    .checkSelfPermission("android.permission.POST_NOTIFICATIONS") !=
                    PackageManager.PERMISSION_GRANTED
        )
            return
        val manager =
            getApplication<Application>().getSystemService(NotificationManager::class.java)
        val channelId = "xianyu-inbound"
        manager.createNotificationChannel(
            NotificationChannel(channelId, "咸鱼新消息", NotificationManager.IMPORTANCE_DEFAULT)
        )
        val title = state.value.sessions.firstOrNull { it.id == sessionId }?.title ?: "咸鱼新消息"
        val body =
            payload["content"]?.jsonPrimitive?.content?.take(120).orEmpty().ifBlank { "收到一条新的买家消息" }
        manager.notify(
            sessionId.hashCode(),
            NotificationCompat.Builder(getApplication(), channelId)
                .setSmallIcon(site.robotclaw.umaagent.R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setAutoCancel(true)
                .build(),
        )
    }

    private suspend fun refreshBackgroundTasksSilently() {
        val client = api ?: return
        runRequestCatching { client.tasks() }
            .onSuccess { tasks ->
                state.value =
                    state.value.copy(backgroundTasks = parseBackgroundTasks(tasks.toString()))
            }
    }

    private suspend fun refreshScheduledTasksSilently() {
        val client = api ?: return
        runRequestCatching { client.schedules() }
            .onSuccess { schedules ->
                state.value =
                    state.value.copy(scheduledTasks = parseScheduledTasks(schedules.toString()))
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

    override fun onCleared() {
        publishJob?.cancel()
        cacheJob?.cancel()
        socket?.close(1000, "cleared")
        super.onCleared()
    }
}

class MainActivity : ComponentActivity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        // 让 Compose 自己处理系统栏 Insets，避免顶部内容覆盖 Android 通知栏。
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContent { UmaScreen() }
    }
}
