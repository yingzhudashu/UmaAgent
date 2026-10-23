package site.robotclaw.umaagent

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
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
                        ManagementScreen(state, model, modifier = Modifier.testTag("resource-form-list"))
                        LeaveConfirmationDialog(leave)
                    }
                }
            }
            fun visible(matcher: SemanticsMatcher): SemanticsNodeInteraction {
                // 横屏大字号时 LazyColumn 不组成离屏节点，必须由列表滚动查找，不能等待它凭空出现。
                compose.onNodeWithTag("resource-form-list").performScrollToNode(matcher)
                return compose.onNode(matcher)
            }
            visible(hasText("添加服务器目录")).assertIsEnabled().performClick()
            compose.onNodeWithText("添加服务器目录").assertIsNotEnabled()
            visible(hasText("来源名称")).performTextReplacement("失败后保留名称")
            visible(hasSetTextAction() and hasText("服务器目录"))
                .performTextReplacement("/outside-authorized-workspace/missing")
            visible(hasText("提交")).performClick()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("正在读取或处理…").fetchSemanticsNodes().isEmpty()
            }
            visible(hasText("来源名称")).assertTextContains("失败后保留名称")
            visible(hasText("取消")).performClick()
            compose.onNodeWithText("放弃未保存内容？").assertIsDisplayed()
            compose.onNodeWithText("继续编辑").performClick()
            visible(hasText("来源名称")).assertTextContains("失败后保留名称")
            visible(hasText("取消")).performClick()
            compose.onNodeWithText("放弃并离开").performClick()
            visible(hasText("添加服务器目录")).assertIsEnabled()
        } finally {
            compose.runOnUiThread { model.viewModelScope.cancel() }
        }
    }
}
