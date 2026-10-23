package site.robotclaw.umaagent

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.coroutines.cancel
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OfflineRecoveryTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun currentConversationAndDraftRestoreBeforeNetworkResponse() {
        val app = compose.activity.application
        val session = Session("offline-session", "离线会话")
        val snapshot =
            """{"snapshotSequence":9,"transcript":[{"id":"saved-message","role":"assistant","status":"complete","content":"已保存的完整回复","sequence":1}]}"""
        PatStore(app).save("isolated-offline-recovery-test")
        SnapshotCache(app)
            .write(
                CacheEnvelope(
                    SNAPSHOT_CACHE_VERSION,
                    listOf(session),
                    mapOf(session.id to snapshot),
                    mapOf(session.id to 9L),
                    session.id,
                )
            )
        DraftStore(app).write(mapOf(session.id to SessionDraft("重建后继续编辑")))
        lateinit var model: UmaViewModel
        compose.runOnUiThread { model = UmaViewModel(app) }
        try {
            compose.waitUntil(10_000) {
                model.uiState.value.selectedSessionId == session.id &&
                    model.uiState.value.conversation?.isNotEmpty() == true
            }
            val state = model.uiState.value
            assertTrue(state.tokenPresent)
            assertTrue(state.offline)
            assertEquals(session.id, state.selectedSessionId)
            assertEquals("重建后继续编辑", model.draftText(session.id))
            val message = state.conversation!!.single() as UiConversationEntry.MessageEntry
            assertEquals("已保存的完整回复", message.item.content)
        } finally {
            // 取消无效测试令牌的登录，清理隔离数据。
            model.viewModelScope.cancel()
            PatStore(app).clear()
            SnapshotCache(app).clear()
            DraftStore(app).clear()
        }
    }

    @Test
    fun largeOfflineCacheDoesNotBlockViewModelConstructionOnMainThread() {
        val app = compose.activity.application
        val session = Session("large-offline-session", "Large offline cache")
        val content = "x".repeat(12_288)
        val count = 900
        val snapshot =
            buildJsonObject {
                put("snapshotSequence", count)
                put(
                    "transcript",
                    buildJsonArray {
                        repeat(count) { index ->
                            add(
                                buildJsonObject {
                                    put("id", "message-$index")
                                    put("role", "assistant")
                                    put("status", "complete")
                                    put("content", content)
                                    put("sequence", index + 1)
                                }
                            )
                        }
                    },
                )
            }
                .toString()
        SnapshotCache(app)
            .write(
                CacheEnvelope(
                    SNAPSHOT_CACHE_VERSION,
                    listOf(session),
                    mapOf(session.id to snapshot),
                    mapOf(session.id to count.toLong()),
                    session.id,
                )
            )

        var model: UmaViewModel? = null
        var constructorDurationMs = 0L
        var constructorCpuMs = 0.0
        try {
            compose.runOnUiThread {
                val started = android.os.SystemClock.elapsedRealtime()
                val cpuStarted = android.os.Debug.threadCpuTimeNanos()
                model = UmaViewModel(app)
                constructorDurationMs = android.os.SystemClock.elapsedRealtime() - started
                constructorCpuMs = (android.os.Debug.threadCpuTimeNanos() - cpuStarted) / 1_000_000.0
            }
            // 同时保留墙钟与主线程 CPU 时间，避免把调度停顿直接判成同步解析；原门槛不变。
            java.io.File(app.cacheDir, "uma-startup-performance.json").writeText(
                org.json.JSONObject()
                    .put("constructorWallMs", constructorDurationMs)
                    .put("constructorCpuMs", constructorCpuMs)
                    .put("messages", count)
                    .put("snapshotCharacters", snapshot.length)
                    .toString(2)
            )
            assertTrue(
                "构造 ViewModel 不应在主线程解析近 11 MiB 的离线缓存（${constructorDurationMs}ms）",
                constructorDurationMs < 500,
            )
            val activeModel = checkNotNull(model)
            compose.waitUntil(15_000) {
                activeModel.uiState.value.selectedSessionId == session.id &&
                    activeModel.uiState.value.conversation?.size == count
            }
        } finally {
            model?.viewModelScope?.cancel()
            SnapshotCache(app).clear()
            DraftStore(app).clear()
        }
    }
}
