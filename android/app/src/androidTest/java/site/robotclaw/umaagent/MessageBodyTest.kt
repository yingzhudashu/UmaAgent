package site.robotclaw.umaagent

import android.graphics.Bitmap
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** 验证 APK 中真正打包的 WebView 正文，而不是用 JVM 或浏览器替代 Android 渲染。 */
@RunWith(AndroidJUnit4::class)
class MessageBodyTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun findWeb(view: View): WebView? =
        when (view) {
            is WebView -> view
            is ViewGroup ->
                (0 until view.childCount).firstNotNullOfOrNull { findWeb(view.getChildAt(it)) }
            else -> null
        }

    private fun evaluate(script: String): String {
        val result = AtomicReference<String?>(null)
        compose.runOnUiThread {
            checkNotNull(findWeb(compose.activity.window.decorView)).evaluateJavascript(script) {
                result.set(it)
            }
        }
        compose.waitUntil(10_000) { result.get() != null }
        return result.get()!!
    }

    @Test
    fun offlineMarkdownMathCodeAndSanitization() {
        val text =
            mutableStateOf(
                """
                # 手机阅读

                正文 **强调** 和行内公式 ${'$'}a^2+b^2=c^2${'$'}。

                > 引用内容

                1. 第一项
                   - 嵌套项目

                | 参数 | 说明 |
                | --- | --- |
                | 耗时 | 保留效果并优化 |

                ```kotlin
                val result = "${'$'}notMath${'$'}"
                ```

                <script>window.injected = true</script><img src="https://invalid.invalid/x" onerror="window.injected=true">
                """
                    .trimIndent()
            )
        val dark = mutableStateOf(false)
        compose.setContent {
            UmaAgentTheme(darkTheme = dark.value) {
                Surface {
                    Column(
                        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)
                    ) {
                        RichMessageContent(text.value)
                    }
                }
            }
        }
        compose.waitUntil(10_000) { findWeb(compose.activity.window.decorView) != null }
        var ready = false
        repeat(30) {
            if (!ready)
                ready =
                    evaluate(
                        "typeof window.updateMessage === 'function' && document.querySelectorAll('.katex').length > 0"
                    ) == "true"
        }
        assertTrue("离线数学资源必须实际加载", ready)
        assertEquals("1", evaluate("document.querySelectorAll('table').length"))
        assertEquals("1", evaluate("document.querySelectorAll('pre').length"))
        assertEquals("0", evaluate("document.querySelectorAll('pre .katex').length"))
        assertEquals(
            "true",
            evaluate(
                "!window.injected && !document.querySelector('#message script') && !document.querySelector('[onerror]')"
            ),
        )
        assertEquals("true", evaluate("document.documentElement.scrollWidth <= innerWidth"))
        assertEquals("true", evaluate("!!document.querySelector('.code-copy')"))
        for (isDark in listOf(false, true)) {
            compose.runOnIdle { dark.value = isDark }
            compose.waitForIdle()
            val file =
                File(
                    compose.activity.cacheDir,
                    "uma-body-${compose.activity.resources.configuration.screenWidthDp}-${compose.activity.resources.configuration.fontScale}-${if(isDark) "dark" else "light"}.png",
                )
            file.outputStream().use {
                compose
                    .onRoot()
                    .captureToImage()
                    .asAndroidBitmap()
                    .compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
        evaluate("window.originalHeading = document.querySelector('h1'); true")
        compose.runOnIdle { text.value += "\n\n流式终态已完成" }
        var completed = false
        repeat(30) {
            if (!completed)
                completed = evaluate("document.body.textContent.includes('流式终态已完成')") == "true"
        }
        assertTrue(completed)
        assertEquals("true", evaluate("window.originalHeading === document.querySelector('h1')"))
    }
}
