package site.robotclaw.umaagent

import android.app.Application
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextReplacement
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import kotlinx.coroutines.cancelChildren
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** 使用实际系统 Insets 验证布局；同一套测试分别在手机、平板与横屏模拟器执行。 */
@RunWith(AndroidJUnit4::class)
class ShellLayoutTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun rootBackProtectsTabletSessionDraft() {
        org.junit.Assume.assumeTrue(compose.activity.resources.configuration.screenWidthDp >= 840)
        lateinit var model: UmaViewModel
        compose.runOnUiThread {
            val app = compose.activity.application
            PatStore(app).clear()
            model = UmaViewModel(app)
            model.viewModelScope.coroutineContext.cancelChildren()
        }
        compose.setContent {
            UmaAgentTheme {
                Surface(Modifier.fillMaxSize()) {
                    AuthenticatedScreen(UmaUiState(tokenPresent = true), model)
                }
            }
        }
        // 双栏按扣除横向安全区后的可用宽度决定，配置宽度不能代表实际内容宽度。
        org.junit.Assume.assumeTrue(
            compose.onAllNodesWithTag("sessions-list").fetchSemanticsNodes().isNotEmpty()
        )
        // 大字号横屏下标题输入框可能在首屏之外，先滚动真实列表使其组合。
        compose
            .onNodeWithTag("sessions-list")
            .performScrollToNode(hasSetTextAction() and hasText("会话标题"))
        val title = compose.onNode(hasSetTextAction() and hasText("会话标题"))
        title.performTextReplacement("平板首页草稿")
        compose.waitForIdle()
        compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText("放弃未保存内容？").assertIsDisplayed()
        compose.onNodeWithText("继续编辑").performClick()
        title.assertTextContains("平板首页草稿")
        compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText("放弃并离开").performClick()
        compose.waitUntil(5_000) { !compose.activity.hasWindowFocus() }
    }

    @Test
    fun sessionFieldsKeepRestoredDraftsAcrossRemoteUpdates() {
        lateinit var model: UmaViewModel
        compose.runOnUiThread {
            val app = compose.activity.application
            PatStore(app).clear()
            model = UmaViewModel(app)
            model.viewModelScope.coroutineContext.cancelChildren()
        }
        val session = mutableStateOf(Session("restore-session", "原始标题"))
        val restoration = StateRestorationTester(compose)
        restoration.setContent {
            UmaAgentTheme {
                SessionsScreen(
                    UmaUiState(
                        sessions = listOf(session.value),
                        selectedSessionId = session.value.id,
                    ),
                    model,
                    onOpenChat = {},
                    settingsOnly = true,
                )
            }
        }
        val title = compose.onNode(hasSetTextAction() and hasText("会话标题"))
        title.performTextReplacement("本机未保存标题")
        restoration.emulateSavedInstanceStateRestore()
        title.assertTextContains("本机未保存标题")
        compose.runOnIdle { session.value = session.value.copy(title = "另一设备的新标题") }
        title.assertTextContains("本机未保存标题")
    }

    @Test
    fun shellKeepsNavigationOutsideSystemBarsInBothThemes() {
        lateinit var model: UmaViewModel
        val dark = mutableStateOf(false)
        compose.runOnUiThread {
            WindowCompat.setDecorFitsSystemWindows(compose.activity.window, false)
            val application = compose.activity.application as Application
            PatStore(application).clear()
            SnapshotCache(application).clear()
            DraftStore(application).clear()
            model = UmaViewModel(application)
            model.viewModelScope.coroutineContext.cancelChildren()
        }
        compose.setContent {
            UmaAgentTheme(darkTheme = dark.value) {
                Surface(Modifier.fillMaxSize()) {
                    AuthenticatedScreen(UmaUiState(tokenPresent = true, offline = true), model)
                }
            }
        }
        for (isDark in listOf(false, true)) {
            compose.runOnIdle { dark.value = isDark }
            compose.onNodeWithTag("workspace-title").assertIsDisplayed()
            val insets = ViewCompat.getRootWindowInsets(compose.activity.window.decorView)!!
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val title = compose.onNodeWithTag("workspace-title").fetchSemanticsNode().boundsInRoot
            assertTrue("顶栏标题必须位于系统状态栏下方", title.top >= bars.top)
            val titleBounds = compose.onNodeWithTag("workspace-title").getUnclippedBoundsInRoot()
            val topBarBounds = compose.onNodeWithTag("workspace-top-bar").getUnclippedBoundsInRoot()
            assertTrue("大字号标题必须完整位于顶栏内", titleBounds.bottom <= topBarBounds.bottom)
            if (compose.activity.resources.configuration.screenWidthDp >= 600)
                compose.onNodeWithText("设置").performScrollTo()
            else compose.onNodeWithTag("navigation-more").performClick()
            val settings = compose.onNodeWithText("设置").fetchSemanticsNode().boundsInRoot
            val height = compose.activity.window.decorView.height
            assertTrue("导航按钮必须位于系统手势区上方", settings.bottom <= height - bars.bottom)
            compose.onNodeWithText("设置").performClick()
            compose.onNodeWithText("执行权限").assertIsDisplayed()
            val settingsBody =
                compose.onNodeWithTag("settings-list").fetchSemanticsNode().boundsInRoot
            assertTrue("二级页面隐藏底栏后仍必须避开系统手势区", settingsBody.bottom <= height - bars.bottom)
            val file =
                File(
                    compose.activity.cacheDir,
                    "uma-shell-${compose.activity.resources.configuration.screenWidthDp}-${if (isDark) "dark" else "light"}.png",
                )
            file.outputStream().use {
                compose
                    .onRoot()
                    .captureToImage()
                    .asAndroidBitmap()
                    .compress(Bitmap.CompressFormat.PNG, 100, it)
            }
            compose.onNodeWithContentDescription("返回").assertIsDisplayed().performClick()
            if (compose.activity.resources.configuration.screenWidthDp < 600) {
                compose.onNodeWithTag("navigation-more").performClick()
                compose.onNodeWithText("调度").assertIsDisplayed().performClick()
            } else {
                compose.onNodeWithText("调度").performClick()
            }
            compose.onNodeWithTag("workspace-title").assertTextEquals("调度")
            compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
            compose.onNodeWithTag("navigation-chat").assertIsDisplayed()
        }
    }

    @Test
    fun profileSystemBackReturnsToSettings() {
        lateinit var model: UmaViewModel
        compose.runOnUiThread {
            WindowCompat.setDecorFitsSystemWindows(compose.activity.window, false)
            val application = compose.activity.application as Application
            PatStore(application).clear()
            SnapshotCache(application).clear()
            DraftStore(application).clear()
            model = UmaViewModel(application)
            model.viewModelScope.coroutineContext.cancelChildren()
        }
        compose.setContent {
            MaterialTheme {
                Surface(Modifier.fillMaxSize()) {
                    AuthenticatedScreen(
                        UmaUiState(
                            tokenPresent = true,
                            sessions = listOf(Session("layout-test", "长标题布局验收")),
                            selectedSessionId = "layout-test",
                        ),
                        model,
                    )
                }
            }
        }
        if (compose.activity.resources.configuration.screenWidthDp >= 600)
            compose.onNodeWithText("设置").performScrollTo()
        else compose.onNodeWithTag("navigation-more").performClick()
        compose.onNodeWithText("设置").performClick()
        compose.onNodeWithTag("settings-list").performScrollToNode(hasText("助手 Profile"))
        compose.onNodeWithText("助手 Profile").performClick()
        compose.onNodeWithContentDescription("返回设置").assertIsDisplayed()
        compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithTag("settings-list").performScrollToNode(hasText("执行权限"))
        compose.onNodeWithText("执行权限").assertIsDisplayed()
    }

    @Test
    fun switchAccountClearsLocalCredentialsAndCache() {
        compose.runOnUiThread {
            val application = compose.activity.application
            val pat = PatStore(application)
            val cache = SnapshotCache(application)
            pat.clear()
            cache.clear()
            val model = UmaViewModel(application)
            model.viewModelScope.coroutineContext.cancelChildren()
            pat.save("isolated-instrumentation-admin-token")
            cache.write(CacheEnvelope(SNAPSHOT_CACHE_VERSION, emptyList(), emptyMap()))
            model.switchAccount()
            assertNull(pat.read())
            assertNull(cache.read())
            assertFalse(model.uiState.value.tokenPresent)
            assertTrue(model.uiState.value.sessions.isEmpty())
            pat.save("isolated-instrumentation-user-token")
            model.logout()
            assertNull(pat.read())
        }
    }

    @Test
    fun accountActionProtectsDraftsFromOtherSessions() {
        lateinit var model: UmaViewModel
        compose.runOnUiThread {
            val app = compose.activity.application
            PatStore(app).clear()
            DraftStore(app).clear()
            model = UmaViewModel(app)
            model.viewModelScope.coroutineContext.cancelChildren()
            model.saveDraftText("another-session", "尚未发送的正文")
        }
        compose.setContent {
            UmaAgentTheme {
                Surface(Modifier.fillMaxSize()) {
                    SettingsScreen(UmaUiState(tokenPresent = true), model, {})
                }
            }
        }
        compose.onNodeWithTag("settings-list").performScrollToNode(hasText("切换账号"))
        compose.onNodeWithText("切换").performClick()
        compose.onNodeWithText("放弃未保存内容？").assertIsDisplayed()
        compose.onNodeWithText("继续编辑").performClick()
        assertTrue(model.hasUnsentDrafts())
        compose.onNodeWithText("切换").performClick()
        compose.onNodeWithText("放弃并离开").performClick()
        compose.runOnIdle { assertFalse(model.hasUnsentDrafts()) }
    }
}
