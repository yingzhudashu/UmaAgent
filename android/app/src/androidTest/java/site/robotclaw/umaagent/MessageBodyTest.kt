package site.robotclaw.umaagent

import android.graphics.Bitmap
import android.os.Build
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
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.Assume.assumeTrue
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

                正文 **强调**、行内代码 `state` 和行内公式 ${'$'}a^2+b^2=c^2${'$'}。

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
            evaluate("getComputedStyle(document.querySelector('#message p code')).paddingLeft === '5px'"),
        )
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
            assertEquals(
                "true",
                evaluate(
                    "getComputedStyle(document.querySelector('#message p code')).backgroundColor === '${if (isDark) "rgb(41, 62, 84)" else "rgb(230, 239, 231)"}'",
                ),
            )
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

    @Test
    fun staleWebViewHeightCallbacksAreIgnoredAfterContentChanges() {
        val observed = Collections.synchronizedList(mutableListOf<Int>())
        val body = AtomicReference<BodyWebView?>()
        compose.setContent {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { context ->
                    BodyWebView(context).also { view ->
                        view.onHeight = { observed.add(it) }
                        body.set(view)
                    }
                },
            )
        }
        compose.waitUntil(10_000) { findWeb(compose.activity.window.decorView) != null }
        compose.waitUntil(10_000) { evaluate("typeof window.updateMessage === 'function'") == "true" }
        compose.runOnUiThread {
            body.get()!!.updateBody(
                "window.updateMessage('新回复',{text:'#000000',background:'transparent',link:'#0000ff',size:16,code:'#eeeeee',border:'#cccccc'},'revision-new')",
                "revision-new",
            )
        }
        compose.waitForIdle()

        evaluate("window.UmaBody.height(777, 'revision-old'); true")
        android.os.SystemClock.sleep(100)
        assertFalse("旧正文的延迟高度回执不能覆盖新正文高度", synchronized(observed) { 777 in observed })

        evaluate("window.UmaBody.height(123, 'revision-new'); true")
        compose.waitUntil(5_000) { synchronized(observed) { 123 in observed } }
    }

    @Test
    fun rendererProcessExitFallsBackToReadableTextInsteadOfCrashingTheScreen() {
        val body = AtomicReference<BodyWebView?>()
        val rendererReady = AtomicInteger()
        val callbacks = AtomicInteger()
        compose.setContent {
            UmaAgentTheme {
                RichMessageContent(
                    "渲染进程退出后仍可阅读的回复",
                    modifier = Modifier.fillMaxSize(),
                    onRendererGone = { callbacks.incrementAndGet() },
                )
            }
        }
        compose.waitUntil(10_000) {
            body.set(findWeb(compose.activity.window.decorView) as? BodyWebView)
            body.get() != null
        }

        assumeTrue("WebViewRenderProcess.terminate requires Android 10+", Build.VERSION.SDK_INT >= 29)
        // renderer 句柄可能早于进程真正启动出现；先确认真实正文已被 JS 渲染，
        // 再终止进程，避免 terminate() 返回 false 后错误等待退出回调。
        compose.waitUntil(10_000) {
            evaluate("document.body.textContent.includes('渲染进程退出后仍可阅读的回复')") == "true"
        }
        compose.waitUntil(10_000) {
            compose.runOnUiThread {
                if (body.get()?.webViewRenderProcess != null) rendererReady.set(1)
            }
            rendererReady.get() == 1
        }
        compose.runOnUiThread {
            assertTrue("真实 renderer 必须接受终止请求", checkNotNull(body.get()?.webViewRenderProcess).terminate())
        }
        compose.waitUntil(10_000) { callbacks.get() == 1 }
        compose.onNodeWithText("渲染进程退出后仍可阅读的回复").assertIsDisplayed()
        assertEquals("同一次渲染进程退出只能通知一次", 1, callbacks.get())
    }
}
