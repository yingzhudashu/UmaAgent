package site.robotclaw.umaagent

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** 编辑回执晚到或失败时保留表单；成功回执是唯一关闭编辑的条件。 */
@RunWith(AndroidJUnit4::class)
class MessageEditTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun leaveConfirmationKeepsOrDiscardsOnlyCurrentDraft() {
        var left = false
        compose.setContent {
            val leave = remember { LeaveConfirmation() }
            var draft by remember { mutableStateOf("") }
            UmaAgentTheme {
                CompositionLocalProvider(LocalLeaveConfirmation provides leave) {
                    ConfirmFormLeave({ draft.isNotBlank() }) { draft = "" }
                    Column {
                        OutlinedTextField(draft, { draft = it }, label = { Text("表单内容") })
                        TextButton({ leave.request { left = true } }) { Text("返回") }
                    }
                    LeaveConfirmationDialog(leave)
                }
            }
        }
        compose.onNodeWithText("表单内容").performTextInput("不能丢失的修改")
        compose.onNodeWithText("返回").performClick()
        compose.onNodeWithText("放弃未保存内容？").assertIsDisplayed()
        compose.onNodeWithText("继续编辑").performClick()
        compose.onNodeWithText("表单内容").assertTextContains("不能丢失的修改")
        assertEquals(false, left)
        compose.onNodeWithText("返回").performClick()
        compose.onNodeWithText("放弃并离开").performClick()
        assertEquals(true, left)
        compose.onNodeWithText("表单内容").assertTextEquals("表单内容", "")
    }

    @Test
    fun queueDraftSurvivesUntilConfirmed() {
        var submitted = ""
        var saved: (() -> Unit)? = null
        compose.setContent {
            UmaAgentTheme {
                Surface {
                    QueuePanel(
                        queue = listOf(UiQueueItem("run", "message", 1, "原始内容", "queued", "agent")),
                        enabled = true,
                        onReorder = {},
                        onPrioritize = {},
                        onCancel = {},
                        onEdit = { _, text, onSaved ->
                            submitted = text
                            saved = onSaved
                        },
                    )
                }
            }
        }
        compose.onNodeWithText("更多").performClick()
        compose.onNodeWithText("编辑").performClick()
        compose.onNodeWithText("消息内容").performTextReplacement("修订后的内容")
        compose.onNodeWithText("取消").performClick()
        compose.onNodeWithText("放弃未保存内容？").assertIsDisplayed()
        compose.onNodeWithText("继续编辑").performClick()
        compose.onNodeWithText("消息内容").assertTextContains("修订后的内容")
        compose.onNodeWithText("保存").performClick()
        compose.onNodeWithText("编辑队列消息").assertIsDisplayed()
        compose.onNodeWithText("消息内容").assertTextContains("修订后的内容")
        assertEquals("修订后的内容", submitted)
        compose.runOnUiThread { saved!!() }
        compose.onNodeWithText("编辑队列消息").assertDoesNotExist()
    }
}
