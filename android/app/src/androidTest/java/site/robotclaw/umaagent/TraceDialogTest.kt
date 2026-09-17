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
            {"spanId":"root","name":"运行","status":"ok","durationMs":100},
            {"spanId":"child","parentSpanId":"root","name":"模型","status":"error","durationMs":40,"errorMessage":"供应商失败"}
        ]}"""
        compose.setContent { UmaAgentTheme { TraceDialog(payload, {}, false, {}, "") } }
        val root = compose.onNodeWithText("运行").fetchSemanticsNode().boundsInRoot
        val child = compose.onNodeWithText("模型").fetchSemanticsNode().boundsInRoot
        org.junit.Assert.assertTrue(child.left > root.left)
        compose.onNodeWithText("供应商失败").assertIsDisplayed()
        compose.onNodeWithText("复制 Trace ID").performClick()
        compose.onNodeWithText("已复制").assertIsDisplayed()
    }
}
