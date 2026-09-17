package site.robotclaw.umaagent

import android.graphics.Bitmap
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.view.WindowCompat
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import kotlinx.coroutines.cancel
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** 仅连接 debug 构建的本机 Faux Core；与静态布局矩阵分开记录网络闭环证据。 */
@RunWith(AndroidJUnit4::class)
class CoreFlowTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun loginPolicyAttachmentToolTraceAndDraft() {
        lateinit var model: UmaViewModel
        compose.runOnUiThread {
            WindowCompat.setDecorFitsSystemWindows(compose.activity.window, false)
            val app = compose.activity.application
            PatStore(app).clear()
            SnapshotCache(app).clear()
            DraftStore(app).clear()
            model = UmaViewModel(app)
        }
        compose.setContent { UmaScreen(model) }
        fun snapshot(name: String) {
            compose.waitForIdle()
            val committed = java.util.concurrent.CountDownLatch(1)
            compose.runOnUiThread {
                val view = compose.activity.window.decorView
                view.viewTreeObserver.registerFrameCommitCallback { committed.countDown() }
                view.invalidate()
            }
            assertTrue("截图必须等待页面帧提交", committed.await(5, java.util.concurrent.TimeUnit.SECONDS))
            File(compose.activity.cacheDir, "uma-core-$name.png").outputStream().use {
                androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
                    .uiAutomation
                    .takeScreenshot()
                    .compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
        try {
            snapshot("login")
            compose
                .onNodeWithText("访问令牌")
                .performTextInput(
                    "uma_pat_00000000-0000-4000-8000-000000000003_faux-user-3-token-012345678901234567890123"
                )
            compose.onNodeWithText("登录", useUnmergedTree = true).performClick()
            compose.waitUntil(20_000) {
                model.uiState.value.executionSettingsLoaded && !model.uiState.value.loading
            }
            assertTrue(model.uiState.value.tokenPresent)
            assertTrue("新账号默认免审批", model.uiState.value.autoApprove)
            compose.runOnUiThread { model.setAutoApprove(false) }
            compose.waitUntil(10_000) {
                !model.uiState.value.autoApprove && !model.uiState.value.savingExecutionSettings
            }
            compose.runOnUiThread { model.setAutoApprove(true) }
            compose.waitUntil(10_000) {
                model.uiState.value.autoApprove && !model.uiState.value.savingExecutionSettings
            }
            val created = java.util.concurrent.atomic.AtomicBoolean(false)
            compose.runOnUiThread {
                model.createSession("设备闭环 ${System.currentTimeMillis()}") { created.set(true) }
            }
            compose.waitUntil(10_000) {
                created.get() &&
                    model.uiState.value.conversation != null &&
                    !model.uiState.value.loading
            }
            val sessionId = model.uiState.value.selectedSessionId!!
            val file =
                File(compose.activity.cacheDir, "device-note.txt").apply { writeText("隔离设备验收附件") }
            compose.runOnUiThread { model.uploadAttachment(Uri.fromFile(file), "device-note.txt") }
            compose.waitUntil(10_000) {
                model.uiState.value.pendingAttachments.isNotEmpty() && !model.uiState.value.loading
            }
            compose
                .onNodeWithTag("conversation-input")
                .performTextInput(
                    "Use the configured deterministic read tool and return its result."
                )
            compose.onNodeWithContentDescription("发送消息").performClick()
            compose.waitUntil(30_000) {
                model.uiState.value.conversation
                    .orEmpty()
                    .filterIsInstance<UiConversationEntry.ResponseEntry>()
                    .any {
                        it.response.status == "completed" &&
                            it.response.content.contains("FAUX_TOOL_RESULT")
                    }
            }
            assertTrue(model.uiState.value.pendingAttachments.isEmpty())
            assertEquals("", model.draftText(sessionId))
            fun webViews(view: android.view.View): List<android.webkit.WebView> =
                when (view) {
                    is android.webkit.WebView -> listOf(view)
                    is android.view.ViewGroup ->
                        (0 until view.childCount).flatMap { webViews(view.getChildAt(it)) }
                    else -> emptyList()
                }
            val painted = java.util.concurrent.atomic.AtomicBoolean(false)
            val bodyDiagnostic = java.util.concurrent.atomic.AtomicReference("no WebView")
            try {
                compose.waitUntil(10_000) {
                    compose.activity.runOnUiThread {
                        webViews(compose.activity.window.decorView).forEach { web ->
                            web.evaluateJavascript(
                                "JSON.stringify({url:location.href,text:document.body?.textContent,ready:document.readyState,renderer:typeof updateMessage})"
                            ) {
                                bodyDiagnostic.set(it)
                            }
                            web.evaluateJavascript(
                                "document.body.textContent.includes('FAUX_TOOL_RESULT')"
                            ) { result ->
                                if (result == "true")
                                    web.postVisualStateCallback(
                                        1L,
                                        object : android.webkit.WebView.VisualStateCallback() {
                                            override fun onComplete(requestId: Long) {
                                                // VisualStateCallback 表示内容可参与下一帧；再等宿主两帧提交后截图。
                                                web.postOnAnimation {
                                                    web.postOnAnimation { painted.set(true) }
                                                }
                                            }
                                        },
                                    )
                            }
                        }
                    }
                    painted.get()
                }
            } catch (error: Throwable) {
                snapshot("body-failure")
                throw AssertionError("正文未绘制: ${bodyDiagnostic.get()}", error)
            }
            // 设备截图必须实际包含正文像素，不能仅以 DOM 或可绘制回调冒充已显示。
            val bodyBounds = java.util.concurrent.atomic.AtomicReference<android.graphics.Rect>()
            compose.runOnUiThread {
                val web = webViews(compose.activity.window.decorView).first()
                val location = IntArray(2)
                web.getLocationOnScreen(location)
                bodyBounds.set(
                    android.graphics.Rect(
                        location[0],
                        location[1],
                        location[0] + web.width,
                        location[1] + web.height,
                    )
                )
            }
            compose.waitUntil(10_000) {
                val bitmap =
                    androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
                        .uiAutomation
                        .takeScreenshot()
                val bounds = bodyBounds.get()
                var ink = 0
                for (y in
                    bounds.top.coerceAtLeast(0) until
                        bounds.bottom.coerceAtMost(bitmap.height) step
                        2) for (x in
                    bounds.left.coerceAtLeast(0) until
                        bounds.right.coerceAtMost(bitmap.width) step
                        2) {
                    val pixel = bitmap.getPixel(x, y)
                    if (
                        android.graphics.Color.red(pixel) < 100 &&
                            android.graphics.Color.green(pixel) < 100 &&
                            android.graphics.Color.blue(pixel) < 100
                    )
                        ink++
                }
                val visible = ink > 20
                if (visible)
                    File(compose.activity.cacheDir, "uma-core-chat.png").outputStream().use {
                        bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
                    }
                bitmap.recycle()
                visible
            }
            val runId =
                model.uiState.value.conversation
                    .orEmpty()
                    .filterIsInstance<UiConversationEntry.ResponseEntry>()
                    .last()
                    .response
                    .runId
            compose.runOnUiThread { model.openRunTrace(runId) }
            compose.waitUntil(10_000) {
                model.uiState.value.traceData != null && !model.uiState.value.traceLoading
            }
            assertEquals("", model.uiState.value.traceError)
            assertTrue(model.uiState.value.traceData!!.contains("spans"))
            snapshot("trace")
            compose.runOnUiThread { model.closeRunTrace() }
            compose.onNodeWithTag("conversation-input").performTextInput("进程恢复草稿")
            compose.runOnUiThread { model.flushCache() }
            compose.waitUntil(10_000) {
                // 不用第二个 AtomicFile 实例轮询：openRead 会处理 .new，干扰正在提交的写入。
                runCatching {
                        File(compose.activity.filesDir, "drafts.json").readText().contains("进程恢复草稿")
                    }
                    .getOrDefault(false)
            }
            val cache = SnapshotCache(compose.activity.application).read()
            assertTrue("完成消息应写入离线缓存", cache?.snapshots?.containsKey(sessionId) == true)
            // 实际页面入口和系统导航截图；网络闭环与无网络的布局测试分开取证。
            compose.runOnUiThread {
                compose.activity.currentFocus?.clearFocus()
                androidx.core.view
                    .WindowInsetsControllerCompat(
                        compose.activity.window,
                        compose.activity.window.decorView,
                    )
                    .hide(androidx.core.view.WindowInsetsCompat.Type.ime())
            }
            fun openPage(label: String, key: String) {
                compose.waitForIdle()
                if (
                    compose
                        .onAllNodesWithContentDescription("返回")
                        .fetchSemanticsNodes()
                        .isNotEmpty()
                ) {
                    compose.onNodeWithContentDescription("返回").performClick()
                }
                if (compose.activity.resources.configuration.screenWidthDp >= 600)
                    compose.onNodeWithTag("navigation-$key").performScrollTo().performClick()
                else if (key in listOf("sessions", "tasks"))
                    compose.onNodeWithTag("navigation-$key").performClick()
                else {
                    compose.onNodeWithTag("navigation-more").performClick()
                    compose.onNodeWithText(label, useUnmergedTree = true).performClick()
                }
                compose.onNodeWithTag("workspace-title").assertTextEquals(label)
                val contentTitle =
                    when (key) {
                        "resources" -> "知识库"
                        "memory" -> "记忆审核"
                        "quality" -> "运行诊断"
                        "settings" -> "免审批"
                        "xianyu" -> "重试连接"
                        else -> null
                    }
                if (contentTitle != null)
                    compose.waitUntil(10_000) {
                        compose
                            .onAllNodesWithText(contentTitle, useUnmergedTree = true)
                            .fetchSemanticsNodes()
                            .isNotEmpty()
                    }
                compose.waitUntil(10_000) {
                    compose.onAllNodesWithText("正在读取或处理…").fetchSemanticsNodes().isEmpty()
                }
                snapshot(key)
            }
            for ((label, key) in
                listOf(
                    "会话" to "sessions",
                    "任务" to "tasks",
                    "调度" to "schedules",
                    "资源" to "resources",
                    "记忆" to "memory",
                    "设置" to "settings",
                )) openPage(label, key)
            compose.runOnUiThread { model.switchAccount() }
            compose.waitUntil(10_000) { !model.uiState.value.tokenPresent }
            assertTrue(DraftStore(compose.activity.application).read().isEmpty())
            assertNull(SnapshotCache(compose.activity.application).read())
            // 管理员仅查看质量及未配置渠道的错误状态，绝不启动渠道或发送真实消息。
            compose.runOnUiThread {
                model.login(
                    "uma_pat_00000000-0000-4000-8000-000000000001_faux-local-token-012345678901234567890123"
                )
            }
            compose.waitUntil(20_000) {
                model.uiState.value.userRole == "admin" && !model.uiState.value.loading
            }
            openPage("质量", "quality")
            compose.onNodeWithText("最近7天").performScrollTo().performClick()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("正在读取或处理…").fetchSemanticsNodes().isEmpty()
            }
            compose.onNodeWithText("最近7天").assertIsSelected()
            // 用量经过审计持久化后仍须为数值，不能被凭据脱敏规则误删。
            val usageNode = compose.onNodeWithText("模型平均耗时", substring = true).performScrollTo()
            val usageText = usageNode.fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.Text].joinToString { it.text }
            assertTrue("诊断必须显示真实用量数值：$usageText", Regex("Token [0-9]+").containsMatchIn(usageText))
            snapshot("quality-seven-days")
            openPage("咸鱼", "xianyu")
            compose.runOnUiThread { model.switchAccount() }
        } finally {
            compose.runOnUiThread { model.viewModelScope.cancel() }
        }
    }
}
