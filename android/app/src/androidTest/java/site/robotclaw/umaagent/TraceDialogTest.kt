package site.robotclaw.umaagent

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TraceDialogTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun nestedStagesAndCopyFeedback() {
        val payload =
            """{"traceId":"device-trace","spans":[
            {"spanId":"root","depth":0,"name":"运行","status":"ok","durationMs":100},
            {"spanId":"child","depth":1,"parentSpanId":"root","name":"模型","status":"error","durationMs":40,"errorMessage":"供应商失败"},
            {"spanId":"deep","depth":99,"parentSpanId":"child","name":"深层工具","status":"ok","durationMs":10}
        ]}"""
        compose.setContent { UmaAgentTheme { TraceDialog(payload, {}, false, {}, "") } }
        val stages = compose.onNode(hasScrollAction())
        stages.performScrollToNode(hasText("运行"))
        val root = compose.onNodeWithText("运行").fetchSemanticsNode().boundsInRoot
        stages.performScrollToNode(hasText("模型"))
        val child = compose.onNodeWithText("模型").fetchSemanticsNode().boundsInRoot
        org.junit.Assert.assertTrue(child.left > root.left)
        stages.performScrollToNode(hasText("供应商失败"))
        compose.onNodeWithText("供应商失败").assertIsDisplayed()
        // 矮横屏的后续阶段是离屏项，滚动使其组成后再核对缩进，不省略深层断言。
        stages.performScrollToNode(hasText("深层工具"))
        val deep = compose.onNodeWithText("深层工具").fetchSemanticsNode().boundsInRoot
        val density = compose.activity.resources.displayMetrics.density
        org.junit.Assert.assertEquals(48 * density, deep.left - root.left, 1f)
        compose.onNodeWithText("复制 Trace ID").performClick()
        stages.performScrollToNode(hasText("已复制"))
        compose.onNodeWithText("已复制").assertIsDisplayed()
    }
}
