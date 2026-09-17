package site.robotclaw.umaagent

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.cancel
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** 使用真实设备按钮取消长流式回复，随后同一会话继续发送，验证取消不会破坏订阅。 */
@RunWith(AndroidJUnit4::class)
class RunCancellationTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun stopStreamingThenSendAgain() {
        lateinit var model: UmaViewModel
        compose.runOnUiThread {
            val app = compose.activity.application
            PatStore(app).clear()
            SnapshotCache(app).clear()
            DraftStore(app).clear()
            model = UmaViewModel(app)
        }
        try {
            compose.setContent { UmaScreen(model) }
            compose.runOnUiThread {
                model.login(
                    "uma_pat_00000000-0000-4000-8000-000000000003_faux-user-3-token-012345678901234567890123"
                )
            }
            compose.waitUntil(20_000) {
                model.uiState.value.executionSettingsLoaded && !model.uiState.value.loading
            }
            compose.runOnUiThread { model.createSession("停止与恢复 ${System.currentTimeMillis()}") }
            compose.waitUntil(10_000) {
                model.uiState.value.conversation != null && !model.uiState.value.loading
            }
            compose.onNodeWithTag("conversation-input").performTextInput("FAUX_LARGE_REPLY")
            compose.onNodeWithContentDescription("发送消息").performClick()
            compose.waitUntil(15_000) {
                model.uiState.value.conversation
                    .orEmpty()
                    .filterIsInstance<UiConversationEntry.ResponseEntry>()
                    .any { entry -> entry.items.any { it.content.contains("FAUX_LARGE_BEGIN") } }
            }
            compose.onNodeWithContentDescription("停止运行").performClick()
            compose.waitUntil(15_000) {
                model.uiState.value.conversation
                    .orEmpty()
                    .filterIsInstance<UiConversationEntry.ResponseEntry>()
                    .any { it.run?.status == "cancelled" } && !model.uiState.value.cancelling
            }
            assertEquals("", model.uiState.value.error)
            compose.onNodeWithTag("conversation-input").performTextInput("Reply with FAUX_DIRECT.")
            compose.onNodeWithContentDescription("发送消息").performClick()
            compose.waitUntil(20_000) {
                model.uiState.value.conversation
                    .orEmpty()
                    .filterIsInstance<UiConversationEntry.ResponseEntry>()
                    .lastOrNull()
                    ?.run
                    ?.status == "completed" && !model.uiState.value.loading
            }
            assertFalse(model.uiState.value.offline)
        } finally {
            compose.runOnUiThread { model.viewModelScope.cancel() }
        }
    }
}
