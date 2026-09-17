package site.robotclaw.umaagent

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.cancel
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** 中文目录直接读取打包协议源；搜索和选择不发出网络写入。 */
@RunWith(AndroidJUnit4::class)
class ShortcutDialogTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun failedExecutionKeepsCommandAndRequiresDiscardConfirmation() {
        lateinit var model: UmaViewModel
        compose.runOnUiThread {
            PatStore(compose.activity.application).clear()
            model = UmaViewModel(compose.activity.application)
            model.viewModelScope.cancel()
        }
        compose.setContent { UmaAgentTheme { ShortcutDialog(model, "isolated") {} } }
        val editor = compose.onNodeWithText("命令，例如 /session status")
        editor.performTextReplacement("/session status")
        compose.onNodeWithText("执行").performClick()
        compose.waitUntil(5_000) {
            compose.onAllNodesWithText("请先登录").fetchSemanticsNodes().isNotEmpty()
        }
        editor.assertTextContains("/session status")
        compose.onNodeWithText("关闭").performClick()
        compose.onNodeWithText("放弃未保存内容？").assertIsDisplayed()
    }

    @Test
    fun chineseSearchSelectsCommandAndShowsPermissions() {
        lateinit var model: UmaViewModel
        compose.runOnUiThread { model = UmaViewModel(compose.activity.application) }
        try {
            compose.setContent { UmaAgentTheme { ShortcutDialog(model, "isolated") {} } }
            compose.onNodeWithText("搜索命令或中文说明").performTextInput("后台任务")
            compose.onNodeWithText("/btw status").performClick()
            compose.onNodeWithText("命令，例如 /session status").assertTextContains("/btw status")
            compose.onNodeWithText("搜索命令或中文说明").performTextReplacement("重新加载配置")
            compose.onNodeWithText("重新加载配置 · 仅管理员").assertIsDisplayed()
            compose.onNodeWithText("搜索命令或中文说明").performTextReplacement("不存在的命令")
            compose.onNodeWithText("没有匹配的命令").assertIsDisplayed()
            compose.onNodeWithText("关闭").performClick()
            compose.onNodeWithText("放弃未保存内容？").assertIsDisplayed()
            compose.onNodeWithText("继续编辑").performClick()
            compose.onNodeWithText("命令，例如 /session status").assertTextContains("/btw status")
        } finally {
            compose.runOnUiThread { model.viewModelScope.cancel() }
        }
    }
}
