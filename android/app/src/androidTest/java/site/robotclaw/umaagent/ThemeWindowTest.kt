package site.robotclaw.umaagent

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.view.WindowCompat
import androidx.lifecycle.viewModelScope
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.cancelChildren
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** 核对真实窗口图标标志与全屏截图，不用 Compose 裁图冒充系统栏验收。 */
class ThemeWindowTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun loginSystemBarsFollowApplicationTheme() {
        val dark = mutableStateOf(false)
        lateinit var model: UmaViewModel
        compose.runOnUiThread {
            WindowCompat.setDecorFitsSystemWindows(compose.activity.window, false)
            PatStore(compose.activity.application).clear()
            model = UmaViewModel(compose.activity.application)
            model.viewModelScope.coroutineContext.cancelChildren()
        }
        compose.setContent {
            UmaAgentTheme(darkTheme = dark.value) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    AuthScreen(UmaUiState(), model)
                }
            }
        }
        for (isDark in listOf(false, true)) {
            compose.runOnIdle { dark.value = isDark }
            compose.waitUntil(5_000) { compose.activity.hasWindowFocus() }
            compose.runOnIdle {
                val bars =
                    WindowCompat.getInsetsController(
                        compose.activity.window,
                        compose.activity.window.decorView,
                    )
                assertEquals(!isDark, bars.isAppearanceLightStatusBars)
                assertEquals(!isDark, bars.isAppearanceLightNavigationBars)
            }
            // 系统栏属于 SystemUI，等待其下一帧处理窗口属性，不能仅等待 Compose 空闲。
            InstrumentationRegistry.getInstrumentation().uiAutomation.waitForIdle(150, 3_000)
            // SystemUI 的颜色过渡不产生可访问性事件；直接核对手势条像素，避免属性正确而屏幕仍不可读。
            fun screenshot() =
                InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
            fun readable(bitmap: Bitmap): Boolean {
                val x = bitmap.width / 2
                val background = bitmap.getPixel(x, bitmap.height - 45)
                val backgroundLuma =
                    androidx.core.graphics.ColorUtils.calculateLuminance(background)
                return (bitmap.height - 40 until bitmap.height - 5).any { y ->
                    val luma =
                        androidx.core.graphics.ColorUtils.calculateLuminance(bitmap.getPixel(x, y))
                    if (isDark) luma > backgroundLuma + 0.25 else luma < backgroundLuma - 0.25
                }
            }
            var image = screenshot()
            val deadline = android.os.SystemClock.elapsedRealtime() + 3_000
            while (!readable(image) && android.os.SystemClock.elapsedRealtime() < deadline) {
                image.recycle()
                android.os.SystemClock.sleep(100)
                image = screenshot()
            }
            File(compose.activity.cacheDir, "uma-login-bars-$isDark.png").outputStream().use {
                image.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
            assertTrue("系统手势条必须与实际背景有可读对比度", readable(image))
            image.recycle()
        }
    }
}
