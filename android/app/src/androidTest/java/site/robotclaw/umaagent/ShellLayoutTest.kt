package site.robotclaw.umaagent

import android.app.Application
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
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
    fun shellKeepsNavigationOutsideSystemBarsInBothThemes() {
        lateinit var model: UmaViewModel
        val dark = mutableStateOf(false)
        compose.runOnUiThread {
            WindowCompat.setDecorFitsSystemWindows(compose.activity.window, false)
            val application = compose.activity.application as Application
            PatStore(application).clear()
            SnapshotCache(application).clear()
            model = UmaViewModel(application)
            model.viewModelScope.coroutineContext.cancelChildren()
        }
        compose.setContent {
            MaterialTheme(colorScheme = if (dark.value) darkColorScheme() else lightColorScheme()) {
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
            if (compose.activity.resources.configuration.screenWidthDp >= 600) compose.onNodeWithText("设置").performScrollTo()
            val settings = compose.onNodeWithText("设置").fetchSemanticsNode().boundsInRoot
            val height = compose.activity.window.decorView.height
            assertTrue("导航按钮必须位于系统手势区上方", settings.bottom <= height - bars.bottom)
            compose.onNodeWithText("设置").performClick()
            compose.onNodeWithText("应用设置").assertIsDisplayed()
            val file = File(compose.activity.cacheDir, "uma-shell-${compose.activity.resources.configuration.screenWidthDp}-${if (isDark) "dark" else "light"}.png")
            file.outputStream().use {
                compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
            }
            if (compose.activity.resources.configuration.screenWidthDp < 600) {
                compose.onNodeWithText("更多").performClick()
                compose.onNodeWithText("调度").assertIsDisplayed().performClick()
            } else {
                compose.onNodeWithText("调度").performClick()
            }
        }
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
            cache.write(CacheEnvelope(2, emptyList(), emptyMap()))
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
}
