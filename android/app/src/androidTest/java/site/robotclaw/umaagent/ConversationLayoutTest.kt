package site.robotclaw.umaagent

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.click
import androidx.compose.ui.test.swipeDown
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.cancelChildren
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ConversationLayoutTest {
    private fun evidence(name: String) {
        val bitmap =
            androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
                .uiAutomation
                .takeScreenshot()
        java.io.File(compose.activity.cacheDir, "uma-debug-$name.png").outputStream().use {
            bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }
    }

    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val state =
        mutableStateOf(
            UmaUiState(
                tokenPresent = true,
                sessions = listOf(Session("layout-test", "会话布局验收")),
                selectedSessionId = "layout-test",
            )
        )

    private fun openConversation() {
        lateinit var model: UmaViewModel
        compose.runOnUiThread {
            WindowCompat.setDecorFitsSystemWindows(compose.activity.window, false)
            compose.activity.window.setSoftInputMode(
                android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
            )
            val application = compose.activity.application as Application
            PatStore(application).clear()
            SnapshotCache(application).clear()
            DraftStore(application).clear()
            model = UmaViewModel(application)
            model.viewModelScope.coroutineContext.cancelChildren()
        }
        compose.setContent {
            UmaAgentTheme {
                Surface(Modifier.fillMaxSize()) { AuthenticatedScreen(state.value, model) }
            }
        }
    }

    @Test
    fun realKeyboardKeepsComposerAboveIme() {
        openConversation()
        // 用真实触摸进入输入框；语义 click 不能证明窗口已取得系统输入焦点。
        compose.onNodeWithTag("conversation-input").performTouchInput { click() }
        // View 的焦点状态在 UI 线程读取，避免测试线程直接观察非线程安全的窗口字段。
        compose.waitUntil(10_000) {
            var focused = false
            compose.runOnUiThread { focused = compose.activity.hasWindowFocus() }
            focused
        }
        compose.onNodeWithTag("conversation-input").assertIsFocused().performTextInput("保留草稿")
        compose.runOnUiThread {
            WindowCompat.getInsetsController(
                    compose.activity.window,
                    compose.activity.window.decorView,
                )
                .show(WindowInsetsCompat.Type.ime())
        }
        compose.waitUntil(10_000) {
            ViewCompat.getRootWindowInsets(compose.activity.window.decorView)
                ?.isVisible(WindowInsetsCompat.Type.ime()) == true
        }
        // Insets 在系统键盘动画开始时就报告可见；截图必须等待系统窗口实际绘制。
        android.os.SystemClock.sleep(600)
        evidence("keyboard")
        val send =
            compose
                .onNodeWithContentDescription("发送消息")
                .assertIsDisplayed()
                .fetchSemanticsNode()
                .boundsInRoot
        val insets = ViewCompat.getRootWindowInsets(compose.activity.window.decorView)!!
        assertTrue(
            "发送操作不得被键盘遮挡",
            send.bottom <=
                compose.activity.window.decorView.height -
                    insets.getInsets(WindowInsetsCompat.Type.ime()).bottom,
        )
        compose.onNodeWithTag("conversation-input").assertTextContains("保留草稿")
        compose.runOnUiThread {
            WindowCompat.getInsetsController(
                    compose.activity.window,
                    compose.activity.window.decorView,
                )
                .hide(WindowInsetsCompat.Type.ime())
        }
        compose.waitUntil(5_000) {
            !ViewCompat.getRootWindowInsets(compose.activity.window.decorView)!!.isVisible(
                WindowInsetsCompat.Type.ime()
            )
        }
        compose.onNodeWithContentDescription("发送消息").assertIsDisplayed()
        compose.onNodeWithTag("conversation-input").assertTextContains("保留草稿")
    }

    @Test
    fun stopRemainsAvailableDuringPreparationAndVerification() {
        openConversation()
        for (status in listOf("preflight", "running", "verifying")) {
            compose.runOnIdle {
                state.value =
                    state.value.copy(
                        conversation =
                            listOf(
                                UiConversationEntry.ResponseEntry(
                                    UiResponse(
                                        "response",
                                        "run",
                                        "message",
                                        "running",
                                        "",
                                        emptyList(),
                                        emptyList(),
                                        0,
                                        0,
                                    ),
                                    emptyList(),
                                    UiRun("run", status, "agent", emptyList(), null),
                                    true,
                                    1.0,
                                    "response",
                                )
                            )
                    )
            }
            compose.onNodeWithContentDescription("停止运行").assertIsDisplayed()
        }
    }

    @Test
    fun pendingSendPreventsEditingTheDraftAwaitingReceipt() {
        openConversation()
        compose.onNodeWithTag("conversation-input").performTextInput("提交中的草稿")
        compose.runOnIdle { state.value = state.value.copy(loading = true) }
        compose
            .onNodeWithTag("conversation-input")
            .assertIsNotEnabled()
            .assertTextContains("提交中的草稿")
        compose.onNodeWithContentDescription("发送消息").assertIsNotEnabled()
    }

    @Test
    fun newMessagesRespectHistoryReadingAndLatestResumesFollowing() {
        state.value = state.value.copy(snapshot = transcript(40))
        openConversation()
        val messages = compose.onNodeWithTag("conversation-messages")
        messages.performTouchInput { swipeDown() }
        compose.onNodeWithText("最新消息").assertIsDisplayed()
        val previousScroll =
            messages
                .fetchSemanticsNode()
                .config[SemanticsProperties.VerticalScrollAxisRange]
                .value()
        compose.runOnIdle { state.value = state.value.copy(snapshot = transcript(41)) }
        compose.waitForIdle()
        assertEquals(
            "新消息不能打断历史阅读",
            previousScroll,
            messages
                .fetchSemanticsNode()
                .config[SemanticsProperties.VerticalScrollAxisRange]
                .value(),
            0.01f,
        )
        compose.onNodeWithText("最新消息").performClick()
        compose.onNodeWithText("最新消息").assertDoesNotExist()
        compose.onNodeWithText("消息40").assertIsDisplayed()
        compose.runOnIdle { state.value = state.value.copy(snapshot = transcript(42)) }
        evidence("history")
        compose.onNodeWithText("消息41").assertIsDisplayed()
        compose.runOnIdle {
            state.value = state.value.copy(snapshot = transcript(42, "\n流式更新".repeat(50)))
        }
        compose.onNodeWithText("最新消息").assertDoesNotExist()
        compose.onNodeWithContentDescription("发送消息").assertIsDisplayed()
    }

    @Test
    fun delayedContentMeasurementDoesNotPullAUserBackToTheTail() {
        state.value = state.value.copy(snapshot = responseTranscript(40))
        openConversation()
        val messages = compose.onNodeWithTag("conversation-messages")
        messages.performTouchInput { swipeDown() }
        compose.onNodeWithText("最新消息").assertIsDisplayed()
        val previousScroll =
            messages
                .fetchSemanticsNode()
                .config[SemanticsProperties.VerticalScrollAxisRange]
                .value()

        // Simulate asynchronous Markdown/WebView remeasurement while the reader is
        // inspecting old entries. The viewport must stay where the gesture left it.
        compose.runOnIdle {
            state.value = state.value.copy(snapshot = responseTranscript(40, "\n" + "延迟排版变化".repeat(80)))
        }
        compose.waitForIdle()
        assertEquals(
            "异步内容高度变化不能把历史阅读者拉回最新消息",
            previousScroll,
            messages
                .fetchSemanticsNode()
                .config[SemanticsProperties.VerticalScrollAxisRange]
                .value(),
            0.01f,
        )
        compose.onNodeWithText("最新消息").assertIsDisplayed()
    }

    @Test
    fun responseCardDoesNotOverlapTheFollowingQuestion() {
        state.value = state.value.copy(snapshot = responseTranscript(2, "简短的完整回答"))
        openConversation()

        // 大字号横屏只能容纳少量内容；LazyColumn 不会保留完全离屏的卡片。
        // 逐段回滚到相邻条目都已布局，比较同一次布局的未裁切边界。
        // 矮视口放不下两项完整内容，因此分别滚动验证可达性，不要求它们同时完整显示。
        val messages = compose.onNodeWithTag("conversation-messages")
        val step = (messages.fetchSemanticsNode().boundsInRoot.height / 4f).coerceAtLeast(1f)
        for (attempt in 0 until 20) {
            if (
                compose.onAllNodesWithTag("response-card-response-1:question-1").fetchSemanticsNodes().isNotEmpty() &&
                    compose.onAllNodesWithText("随后提出的问题").fetchSemanticsNodes().isNotEmpty()
            ) break
            messages.performSemanticsAction(SemanticsActions.ScrollBy) { scroll -> scroll(0f, -step) }
        }
        val responseCard = compose.onNodeWithTag("response-card-response-1:question-1")
        val following = compose.onNodeWithText("随后提出的问题")
        val cardBounds = responseCard.getUnclippedBoundsInRoot()
        val nextQuestion = following.getUnclippedBoundsInRoot()
        assertTrue("相邻条目必须有实际布局高度", cardBounds.bottom > cardBounds.top && nextQuestion.bottom > nextQuestion.top)
        assertTrue("回复卡片与后续提问必须保持可见间隔", nextQuestion.top >= cardBounds.bottom)
        messages.performScrollToNode(hasTestTag("response-card-response-1:question-1"))
        compose.onNodeWithTag("response-card-response-1:question-1").assertIsDisplayed()
        messages.performScrollToNode(hasText("随后提出的问题"))
        compose.onNodeWithText("随后提出的问题").assertIsDisplayed()
        evidence("response-spacing")
    }

    private fun transcript(count: Int, tail: String = "") = buildJsonObject {
        put(
            "transcript",
            buildJsonArray {
                repeat(count) { index ->
                    add(
                        buildJsonObject {
                            put("id", "message-$index")
                            put("sequence", index + 1)
                            put("role", "user")
                            put("status", "complete")
                            put("content", "消息$index" + if (index == count - 1) tail else "")
                        }
                    )
                }
            },
        )
    }
        .toString()

    private fun responseTranscript(count: Int, content: String = "流式回答") = buildJsonObject {
        put(
            "transcript",
            buildJsonArray {
                repeat(count) { index ->
                    add(
                        buildJsonObject {
                            val responseQuestion = index == count - 1
                            put("id", if (responseQuestion) "question-1" else "message-$index")
                            put("sequence", index + 1)
                            put("role", "user")
                            put("status", "complete")
                            put("content", if (responseQuestion) "回复前的问题" else "历史问题$index")
                            if (responseQuestion) put("runId", "run-1")
                        }
                    )
                }
                add(
                    buildJsonObject {
                        put("id", "answer-1")
                        put("sequence", count + 1)
                        put("role", "assistant")
                        put("status", "streaming")
                        put("content", content)
                        put("runId", "run-1")
                    }
                )
                add(
                    buildJsonObject {
                        put("id", "question-2")
                        put("sequence", count + 2)
                        put("role", "user")
                        put("status", "complete")
                        put("content", "随后提出的问题")
                    }
                )
            },
        )
        put(
            "recentRuns",
            buildJsonArray {
                add(
                    buildJsonObject {
                        put("id", "run-1")
                        put("status", "running")
                        put("interactionMode", "agent")
                        put("plan", buildJsonArray {})
                    }
                )
            },
        )
        put(
            "responses",
            buildJsonArray {
                add(
                    buildJsonObject {
                        put("id", "response-1")
                        put("runId", "run-1")
                        put("messageId", "question-1")
                        put("status", "streaming")
                        put("content", content)
                        put("activities", buildJsonArray {})
                        put("attachments", buildJsonArray {})
                    }
                )
            },
        )
    }
        .toString()
}
