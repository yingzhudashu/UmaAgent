package site.robotclaw.umaagent

import android.os.SystemClock
import android.view.FrameMetrics
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Surface
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.activity.compose.setContent
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** 受控本机增量到 WebView 提交绘制的延迟，包含与实际投影相同的 UI 合并窗口。 */
@RunWith(AndroidJUnit4::class)
class BodyPerformanceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private lateinit var activity: ComponentActivity
    private fun onUi(action: () -> Unit) = instrumentation.runOnMainSync(action)

    private fun web(view: View): WebView? =
        when (view) {
            is WebView -> view
            is ViewGroup ->
                (0 until view.childCount).firstNotNullOfOrNull { web(view.getChildAt(it)) }
            else -> null
        }

    @Test
    fun controlledStreamingLatencyAndFrames() {
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        try {
            scenario.onActivity { activity = it }
            val content = mutableStateOf("# 流式性能\n\n" + "正文阅读与公式 ${'$'}x^2${'$'}。\n\n".repeat(4))
            onUi {
                activity.setContent {
                    UmaAgentTheme {
                        Surface {
                            Column(Modifier.fillMaxSize().padding(16.dp)) {
                                RichMessageContent(content.value)
                            }
                        }
                    }
                }
            }
            val ready = CountDownLatch(1)
            onUi {
                fun check() {
                    val body = web(activity.window.decorView)
                    if (body == null) {
                        activity.window.decorView.postDelayed({ check() }, 16)
                        return
                    }
                    body.evaluateJavascript(
                        "typeof updateMessage === 'function' && document.querySelectorAll('.katex').length > 0 && document.fonts.status === 'loaded'"
                    ) {
                        if (it == "true")
                            body.postVisualStateCallback(
                                -1L,
                                object : WebView.VisualStateCallback() {
                                    override fun onComplete(requestId: Long) {
                                        ready.countDown()
                                    }
                                },
                            )
                        else body.postDelayed({ check() }, 20)
                    }
                }
                check()
            }
            assertTrue(ready.await(10, TimeUnit.SECONDS))
            val frames = java.util.Collections.synchronizedList(mutableListOf<Double>())
            val listener =
                android.view.Window.OnFrameMetricsAvailableListener { _, metrics, _ ->
                    frames.add(metrics.getMetric(FrameMetrics.TOTAL_DURATION) / 1_000_000.0)
                }
            onUi {
                activity.window.addOnFrameMetricsAvailableListener(
                    listener,
                    android.os.Handler(android.os.Looper.getMainLooper()),
                )
            }
            val samples = mutableListOf<Double>()
            val stages = org.json.JSONArray()
            try {
                repeat(40) { index ->
                    val marker = "增量标记$index"
                    val latch = CountDownLatch(1)
                    val started = SystemClock.elapsedRealtimeNanos()
                    fun elapsed() = (SystemClock.elapsedRealtimeNanos() - started) / 1_000_000.0
                    val stage = JSONObject().put("index", index)
                    onUi {
                        stage.put("uiDispatchMs", elapsed())
                        val body = web(activity.window.decorView)!!
                        body.postDelayed(
                            {
                                stage.put("stateWriteMs", elapsed())
                                content.value += "\n\n$marker"
                            },
                            STREAM_PUBLISH_INTERVAL_MS,
                        )
                        fun check() {
                            body.evaluateJavascript(
                                "document.body.textContent.includes('${marker}')"
                            ) { result ->
                                if (result == "true") {
                                    stage.put("domObservedMs", elapsed())
                                    body.postVisualStateCallback(
                                        index.toLong(),
                                        object : WebView.VisualStateCallback() {
                                            override fun onComplete(requestId: Long) {
                                                stage.put("visualReadyMs", elapsed())
                                                // 可绘制不等于已经显示；纳入宿主真正提交到渲染缓冲的帧。
                                                body.viewTreeObserver.registerFrameCommitCallback {
                                                    samples.add(
                                                        (SystemClock.elapsedRealtimeNanos() - started) /
                                                            1_000_000.0
                                                    )
                                                    stage.put("frameCommittedMs", elapsed())
                                                    stages.put(stage)
                                                    latch.countDown()
                                                }
                                                body.invalidate()
                                            }
                                        },
                                    )
                                } else body.postDelayed({ check() }, 2)
                            }
                        }
                        check()
                    }
                    // Activity 使用真实 Choreographer 时钟；测试线程等待不会接管或推进重组帧。
                    assertTrue("增量必须到达绘制状态", latch.await(5, TimeUnit.SECONDS))
                }
            } finally {
                onUi {
                    activity.window.removeOnFrameMetricsAvailableListener(listener)
                }
            }
            val p95 = samples.sorted()[(samples.size * .95).toInt() - 1]
            val maxFrame = frames.maxOrNull() ?: error("未采集到帧数据")
            val report =
                JSONObject()
                    .put("clock", "real-choreographer")
                    .put("samplesMs", org.json.JSONArray(samples))
                    .put("stages", stages)
                    .put("p95Ms", p95)
                    .put("maxFrameMs", maxFrame)
                    .put("frameCount", frames.size)
            val automation =
                androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation
            for ((name, command) in
                listOf(
                    "memory" to "dumpsys meminfo",
                    "cpu" to "dumpsys cpuinfo",
                    "frames" to "dumpsys gfxinfo site.robotclaw.umaagent.debug framestats",
                )) {
                automation.executeShellCommand(command).use { descriptor ->
                    java.io.FileInputStream(descriptor.fileDescriptor).use { input ->
                        File(activity.cacheDir, "uma-performance-$name.txt")
                            .writeBytes(input.readBytes())
                    }
                }
            }
            File(activity.cacheDir, "uma-performance.json").writeText(report.toString(2))
            assertTrue("增量显示 p95 ${p95}ms 超过 100ms", p95 <= 100)
            assertTrue("存在超过 700ms 的冻结帧：$maxFrame", maxFrame <= 700)
        } finally {
            scenario.close()
        }
    }
}
