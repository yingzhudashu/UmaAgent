package site.robotclaw.umaagent

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.cancel
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ResourceFormTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun failedDirectorySubmissionKeepsDraftAndCancelRequiresConfirmation() {
        lateinit var model: UmaViewModel
        compose.runOnUiThread {
            val app = compose.activity.application
            PatStore(app).clear()
            SnapshotCache(app).clear()
            DraftStore(app).clear()
            model = UmaViewModel(app)
            model.login(
                "uma_pat_00000000-0000-4000-8000-000000000001_faux-local-token-012345678901234567890123"
            )
        }
        try {
            compose.waitUntil(20_000) {
                model.uiState.value.executionSettingsLoaded && !model.uiState.value.loading
            }
            compose.setContent {
                val state by model.uiState.collectAsState()
                val leave = remember { LeaveConfirmation() }
                UmaAgentTheme {
                    CompositionLocalProvider(LocalLeaveConfirmation provides leave) {
                        ManagementScreen(state, model)
                        LeaveConfirmationDialog(leave)
                    }
                }
            }
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("正在读取或处理…").fetchSemanticsNodes().isEmpty()
            }
            compose.onNodeWithText("添加服务器目录").performScrollTo().performClick()
            compose.onNodeWithText("添加服务器目录").assertIsNotEnabled()
            compose.onNodeWithText("来源名称").performScrollTo().performTextReplacement("失败后保留名称")
            compose
                .onNode(hasSetTextAction() and hasText("服务器目录"))
                .performScrollTo()
                .performTextReplacement("/outside-authorized-workspace/missing")
            compose.onNodeWithText("提交").performScrollTo().performClick()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("正在读取或处理…").fetchSemanticsNodes().isEmpty()
            }
            compose.onNodeWithText("来源名称").performScrollTo().assertTextContains("失败后保留名称")
            compose.onNodeWithText("取消").performScrollTo().performClick()
            compose.onNodeWithText("放弃未保存内容？").assertIsDisplayed()
            compose.onNodeWithText("继续编辑").performClick()
            compose.onNodeWithText("来源名称").performScrollTo().assertTextContains("失败后保留名称")
            compose.onNodeWithText("取消").performScrollTo().performClick()
            compose.onNodeWithText("放弃并离开").performClick()
            compose.onNodeWithText("添加服务器目录").performScrollTo().assertIsEnabled()
        } finally {
            compose.runOnUiThread { model.viewModelScope.cancel() }
        }
    }
}
