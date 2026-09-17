package site.robotclaw.umaagent

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
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
            compose.runOnUiThread { model.createSession("进程重建与离线阅读验收") { created.set(true) } }
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
        } finally {
            compose.runOnUiThread { model.viewModelScope.cancel() }
        }
    }
}
