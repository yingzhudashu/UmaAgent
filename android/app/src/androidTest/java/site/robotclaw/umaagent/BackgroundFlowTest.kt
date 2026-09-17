package site.robotclaw.umaagent

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.cancel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** 页面停止收集状态不应停止网络执行；恢复时读取最新终态和原草稿。 */
@RunWith(AndroidJUnit4::class)
class BackgroundFlowTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun runCompletesWhilePageIsStopped() {
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
            compose.runOnUiThread { model.createSession("后台完成验收") { created.set(true) } }
            compose.waitUntil(10_000) {
                created.get() &&
                    model.uiState.value.conversation != null &&
                    !model.uiState.value.loading
            }
            val id = model.uiState.value.selectedSessionId!!
            compose.runOnUiThread { model.send("后台继续完成这条回复") }
            compose.waitUntil(10_000) { !model.uiState.value.sending }
            compose.runOnUiThread { model.saveDraftText(id, "后台恢复保留草稿") }
            compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
            val deadline = android.os.SystemClock.elapsedRealtime() + 30_000
            fun completed() =
                model.uiState.value.conversation
                    .orEmpty()
                    .filterIsInstance<UiConversationEntry.ResponseEntry>()
                    .any {
                        it.response.status == "completed" &&
                            it.response.content.contains("后台继续完成这条回复")
                    }
            while (!completed() && android.os.SystemClock.elapsedRealtime() < deadline) Thread
                .sleep(50)
            assertTrue("后台应完成真实 Run", completed())
            assertEquals(Lifecycle.State.CREATED, compose.activity.lifecycle.currentState)
            compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
            compose.waitForIdle()
            assertEquals("后台恢复保留草稿", model.draftText(id))
            assertTrue(completed())
        } finally {
            compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
            compose.runOnUiThread { model.viewModelScope.cancel() }
        }
    }
}
