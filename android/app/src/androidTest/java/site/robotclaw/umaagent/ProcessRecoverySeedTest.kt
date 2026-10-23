package site.robotclaw.umaagent

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.cancel
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** 为外部 adb 强杀/离线重启测试建立真实 Core 回执后的缓存；故意保留该隔离账号的本机数据。 */
@RunWith(AndroidJUnit4::class)
class ProcessRecoverySeedTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun seedAcknowledgedConversationAndDraft() {
        if (InstrumentationRegistry.getArguments().getString("recoveryStage") == "verify") {
            verifyAfterProcessRestart()
            return
        }
        lateinit var model: UmaViewModel
        compose.runOnUiThread {
            val app = compose.activity.application
            PatStore(app).clear()
            SnapshotCache(app).clear()
            DraftStore(app).clear()
            model = UmaViewModel(app)
            model.login(
                "uma_pat_00000000-0000-4000-8000-000000000003_faux-user-3-token-012345678901234567890123"
            )
        }
        compose.setContent { UmaScreen(model) }
        try {
            compose.waitUntil(20_000) {
                model.uiState.value.executionSettingsLoaded && !model.uiState.value.loading
            }
            val created = java.util.concurrent.atomic.AtomicBoolean(false)
            var submitted = false
            // 就绪判断与提交必须在同一次主线程执行；WS 刷新可在两次调用之间重新置 loading。
            compose.waitUntil(10_000) {
                compose.runOnUiThread {
                    val state = model.uiState.value
                    if (!submitted && !state.loading && !state.offline) {
                        model.createSession("进程重建与离线阅读验收") { created.set(true) }
                        submitted = true
                    }
                }
                submitted
            }
            compose.waitUntil(10_000) {
                created.get() &&
                    model.uiState.value.conversation != null &&
                    !model.uiState.value.loading
            }
            compose.runOnUiThread { model.send("进程重建后仍应显示这条真实回复") }
            compose.waitUntil(30_000) {
                model.uiState.value.conversation
                    .orEmpty()
                    .filterIsInstance<UiConversationEntry.ResponseEntry>()
                    .any {
                        it.response.status == "completed" &&
                            it.response.content.contains("进程重建后仍应显示这条真实回复")
                    }
            }
            val id = model.uiState.value.selectedSessionId!!
            compose.runOnUiThread {
                model.saveDraftText(id, "进程恢复验收：离线草稿")
                model.flushCache()
            }
            compose.waitUntil(10_000) {
                runCatching {
                        File(compose.activity.filesDir, "drafts.json")
                            .readText()
                            .contains("进程恢复验收：离线草稿") &&
                            File(compose.activity.filesDir, "cache.json")
                                .readText()
                                .contains("进程重建后仍应显示这条真实回复")
                    }
                    .getOrDefault(false)
            }
            assertTrue(PatStore(compose.activity.application).read() != null)
            File(compose.activity.filesDir, "recovery-seed-pid").writeText(android.os.Process.myPid().toString())
        } finally {
            compose.runOnUiThread { model.viewModelScope.cancel() }
        }
    }

    /** 外部先强停应用并关闭隔离 Core，再启动本分支；不能用同进程重建冒充进程恢复。 */
    private fun verifyAfterProcessRestart() {
        lateinit var model: UmaViewModel
        compose.runOnUiThread { model = UmaViewModel(compose.activity.application) }
        compose.setContent { UmaScreen(model) }
        try {
            val originalPid = File(compose.activity.filesDir, "recovery-seed-pid").readText().toInt()
            assertTrue("恢复验收必须运行在新的进程中", originalPid != android.os.Process.myPid())
            compose.waitUntil(20_000) {
                val state = model.uiState.value
                state.offline && state.tokenPresent &&
                    state.conversation.orEmpty().filterIsInstance<UiConversationEntry.ResponseEntry>().any {
                        it.response.status == "completed" &&
                            it.response.content.contains("进程重建后仍应显示这条真实回复")
                    }
            }
            val id = checkNotNull(model.uiState.value.selectedSessionId)
            org.junit.Assert.assertEquals("进程恢复验收：离线草稿", model.draftText(id))
            assertTrue("离线不能开启发送", model.uiState.value.offline)
        } finally {
            compose.runOnUiThread { model.viewModelScope.cancel() }
        }
    }
}
