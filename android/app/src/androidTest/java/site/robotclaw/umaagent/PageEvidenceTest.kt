package site.robotclaw.umaagent

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.view.WindowCompat
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import kotlinx.coroutines.cancelChildren
import kotlinx.serialization.json.*
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** 同一合成正文用于 Git 基线和当前版本的设备截图，不访问真实账号或渠道。 */
@RunWith(AndroidJUnit4::class)
class PageEvidenceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun chatSessionsAndSettings() {
        val body =
            "## 本次检查\n\n已保留全部功能，并整理手机阅读体验。\n\n- **正文**：16sp 字号与舒适行距\n- **操作**：复制常显，其余进入更多\n\n公式：${'$'}E=mc^2${'$'}\n\n| 项目 | 状态 |\n| --- | --- |\n| 对话 | 可阅读 |\n| 草稿 | 已保留 |\n\n```kotlin\nval message = \"你好，UmaAgent\"\n```"
        val snapshot = buildJsonObject {
            put(
                "session",
                buildJsonObject {
                    put("id", "visual")
                    put("title", "手机阅读体验")
                },
            )
            put(
                "transcript",
                buildJsonArray {
                    for ((index, pair) in
                        listOf("user" to "请整理本次检查结果，保留公式和代码。", "assistant" to body).withIndex()) {
                        add(
                            buildJsonObject {
                                put("id", if (index == 0) "user-1" else "assistant-1")
                                put("runId", "run-visual")
                                put("role", pair.first)
                                put("content", pair.second)
                                put("status", "complete")
                                put("sequence", index + 1)
                                put("createdAt", 1)
                                put("updatedAt", 1)
                                put("attachments", buildJsonArray {})
                            }
                        )
                    }
                },
            )
            put(
                "responses",
                buildJsonArray {
                    add(
                        buildJsonObject {
                            put("id", "response-1")
                            put("runId", "run-visual")
                            put("messageId", "user-1")
                            put("status", "completed")
                            put("content", body)
                            put("createdAt", 1)
                            put("updatedAt", 1)
                            put("activities", buildJsonArray {})
                            put("attachments", buildJsonArray {})
                        }
                    )
                },
            )
            put("recentRuns", buildJsonArray {})
        }
            .toString()
        lateinit var model: UmaViewModel
        compose.runOnUiThread {
            WindowCompat.setDecorFitsSystemWindows(compose.activity.window, false)
            PatStore(compose.activity.application).clear()
            SnapshotCache(compose.activity.application).clear()
            model = UmaViewModel(compose.activity.application)
            model.viewModelScope.coroutineContext.cancelChildren()
        }
        compose.setContent {
            UmaAgentTheme {
                Surface(Modifier.fillMaxSize()) {
                    AuthenticatedScreen(
                        UmaUiState(
                            tokenPresent = true,
                            sessions = listOf(Session("visual", "手机阅读体验")),
                            selectedSessionId = "visual",
                            snapshot = snapshot,
                        ),
                        model,
                    )
                }
            }
        }
        fun capture(name: String) {
            compose.waitForIdle()
            val committed = java.util.concurrent.CountDownLatch(1)
            compose.runOnUiThread {
                val view = compose.activity.window.decorView
                view.viewTreeObserver.registerFrameCommitCallback { committed.countDown() }
                view.invalidate()
            }
            assertTrue(committed.await(5, java.util.concurrent.TimeUnit.SECONDS))
            File(compose.activity.cacheDir, "uma-compare-$name.png").outputStream().use {
                androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
                    .uiAutomation
                    .takeScreenshot()
                    .compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
        // 正文 WebView 与字体加载异步完成，截图证据留出稳定时间；该等待不参与性能采样。
        compose.waitForIdle()
        Thread.sleep(1500)
        compose.onNodeWithTag("conversation-messages").performScrollToIndex(0)
        capture("chat")
        compose.onNodeWithTag("navigation-sessions").performClick()
        compose.onNodeWithTag("workspace-title").assertTextEquals("会话")
        capture("sessions")
        compose.onNodeWithTag("navigation-more").performClick()
        compose.onNodeWithText("设置").performClick()
        compose.onNodeWithText("执行权限").assertIsDisplayed()
        capture("settings")
    }
}
