package site.robotclaw.umaagent

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import kotlin.math.ceil
import kotlin.math.roundToInt
import org.json.JSONObject

/** 正文唯一宿主：离线资源与受控桥接，导航、输入和消息操作仍使用 Compose。 */
@Composable
internal fun RichMessageContent(
    content: String,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
    onAttachment: (String) -> Unit = {},
) {
    val colors = MaterialTheme.colorScheme
    val density = LocalDensity.current
    val scale = density.fontScale
    var height by remember { mutableIntStateOf(24) }
    var previewUrl by remember { mutableStateOf<String?>(null) }
    previewUrl?.let { RemoteImagePreview(it) { previewUrl = null } }
    fun color(value: androidx.compose.ui.graphics.Color) =
        "#%06x".format(value.toArgb() and 0xffffff)
    val theme =
        remember(colors, scale, compact) {
            JSONObject()
                .put("text", color(colors.onSurface))
                .put("background", "transparent")
                .put("link", color(colors.primary))
                .put("code", color(colors.surfaceVariant))
                .put("size", (if (compact) 14 else 16) * scale)
                .toString()
        }
    val payload =
        remember(content, theme) { "window.updateMessage(${JSONObject.quote(content)},$theme)" }
    AndroidView(
        // 高度回执只使布局重新测量，不重新组合正文、更不重复转义整段长回复。
        modifier =
            modifier.fillMaxWidth().layout { measurable, constraints ->
                val pixels = constraints.constrainHeight((height * density.density).roundToInt())
                val child =
                    measurable.measure(constraints.copy(minHeight = pixels, maxHeight = pixels))
                layout(child.width, child.height) { child.placeRelative(0, 0) }
            },
        factory = { context ->
            BodyWebView(context).also { web ->
                web.onHeight = { pixels -> height = pixels.coerceAtLeast(24) }
            }
        },
        update = { web ->
            web.onHeight = { pixels -> height = pixels.coerceAtLeast(24) }
            web.onAttachment = onAttachment
            web.onImage = { previewUrl = it }
            web.updateBody(payload)
        },
        onRelease = { it.releaseBody() },
    )
}

/** AndroidView 的复用只保留可见列表节点；移出组合后销毁，不保留全历史 WebView。 */
internal class BodyWebView(context: Context) : WebView(context) {
    var onHeight: (Int) -> Unit = {}
    var onAttachment: (String) -> Unit = {}
    var onImage: (String) -> Unit = {}
    private var released = false
    private var ready = false
    private var payload = ""
    private var applied = ""
    private val loader =
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .build()

    init {
        setBackgroundColor(Color.TRANSPARENT)
        settings.javaScriptEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.domStorageEnabled = false
        settings.setSupportZoom(false)
        settings.textZoom = 100 // 系统字体缩放由共享正文的 CSS 像素显式处理一次。
        isVerticalScrollBarEnabled = false
        addJavascriptInterface(
            object {
                @JavascriptInterface
                fun height(value: Double) {
                    post { if (!released && value.isFinite()) onHeight(ceil(value).toInt()) }
                }

                @JavascriptInterface
                fun ready() {
                    post {
                        if (!released) {
                            ready = true
                            applyBody()
                        }
                    }
                }

                @JavascriptInterface
                fun attachment(id: String) {
                    post {
                        if (!released && id.matches(Regex("[A-Za-z0-9._:-]+"))) onAttachment(id)
                    }
                }

                @JavascriptInterface
                fun image(url: String) {
                    post {
                        if (!released && Uri.parse(url).scheme == "https") onImage(url)
                    }
                }

                @JavascriptInterface
                fun copy(value: String): Boolean =
                    // ClipboardManager 通过 Binder 调用系统服务，桥接线程可直接获取真实结果。
                    // 不提前显示“已复制”，拒绝访问时让正文保留选择复制入口。
                    runCatching {
                        context
                            .getSystemService(ClipboardManager::class.java)
                            .setPrimaryClip(ClipData.newPlainText("代码", value))
                        true
                    }.getOrDefault(false)
            },
            "UmaBody",
        )
        webViewClient =
            object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? {
                    val local = loader.shouldInterceptRequest(request.url)
                    if (local != null) return local
                    if (
                        request.url.host == "appassets.androidplatform.net" ||
                            request.url.scheme != "https"
                    )
                        return WebResourceResponse(
                            "text/plain",
                            "utf-8",
                            403,
                            "Forbidden",
                            emptyMap(),
                            null,
                        )
                    return null // CSP 仅允许远程图片；脚本、连接和框架只能来自离线资源。
                }

                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest,
                ): Boolean {
                    val uri = request.url
                    if (uri.scheme in listOf("https", "http", "mailto"))
                        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                    return true
                }
            }
        loadUrl("https://appassets.androidplatform.net/assets/message/android.html")
    }

    fun updateBody(value: String) {
        payload = value
        applyBody()
    }

    private fun applyBody() {
        if (ready && payload != applied && payload.isNotEmpty()) {
            applied = payload
            evaluateJavascript(payload, null)
        }
    }

    fun resetBody() {
        onHeight = {}
        onAttachment = {}
        onImage = {}
        payload = ""
        applied = ""
        if (ready) evaluateJavascript("document.getElementById('message').replaceChildren()", null)
    }

    fun releaseBody() {
        released = true
        resetBody()
        removeJavascriptInterface("UmaBody")
        stopLoading()
        destroy()
    }
}
