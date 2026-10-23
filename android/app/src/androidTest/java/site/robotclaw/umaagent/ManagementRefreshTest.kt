package site.robotclaw.umaagent

import androidx.activity.ComponentActivity
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.*
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** 同一页面、同一进程连续刷新，覆盖真实 HTTP 回执到 Compose 显示的交接。 */
@RunWith(AndroidJUnit4::class)
class ManagementRefreshTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun diagnosticWindowsStayConsistentAcrossRepeatedRefreshes() {
        lateinit var model: UmaViewModel
        val contentVisible = mutableStateOf(true)
        val samples = mutableListOf<JsonElement>()
        val dateFormat = DateTimeFormatter.ofPattern("yyyy-MM-dd").withZone(ZoneId.systemDefault())
        compose.runOnUiThread {
            val app = compose.activity.application
            PatStore(app).clear()
            SnapshotCache(app).clear()
            DraftStore(app).clear()
            model = UmaViewModel(app)
            model.login(
                "uma_pat_00000000-0000-4000-8000-000000000001_faux-local-token-012345678901234567890123"
            )
        }
        try {
            compose.waitUntil(20_000) {
                model.uiState.value.userRole == "admin" && !model.uiState.value.loading
            }
            compose.setContent {
                if (contentVisible.value) {
                    val state by model.uiState.collectAsState()
                    UmaAgentTheme { ManagementScreen(state, model, "quality") }
                }
            }
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("统计范围").fetchSemanticsNodes().isNotEmpty() &&
                    compose.onAllNodesWithText("正在读取或处理…").fetchSemanticsNodes().isEmpty()
            }
            val initialPssKb = android.os.Debug.getPss()
            val initialCpuMs = android.os.Process.getElapsedCpuTime()
            val initialWallMs = android.os.SystemClock.elapsedRealtime()
            try {
                // 连续四组40次覆盖自然GC周期，不强制回收来压低内存样本。
                repeat(160) { index ->
                    val (days, label) =
                        listOf(7 to "最近7天", 30 to "最近30天", 1 to "最近24小时")[index % 3]
                    val started = android.os.SystemClock.elapsedRealtime()
                    val expectedDate = dateFormat.format(
                        Instant.ofEpochMilli(System.currentTimeMillis() - days * 86_400_000L)
                    )
                    compose.onNodeWithText(label).performScrollTo().assertIsEnabled().performClick()
                    // 不仅检查转圈消失：旧回执、只改选中项而未更新数据都必须失败。
                    try {
                        compose.waitUntil(10_000) {
                            compose.onAllNodesWithText("正在读取或处理…").fetchSemanticsNodes().isEmpty() &&
                                compose.onAllNodesWithText(expectedDate, substring = true)
                                    .fetchSemanticsNodes().isNotEmpty()
                        }
                    } catch (failure: Throwable) {
                        try {
                            File(compose.activity.cacheDir, "uma-management-failure.txt").writeText(
                                "index=$index days=$days expected=$expectedDate\n" +
                                    compose.onRoot(useUnmergedTree = true).printToString()
                            )
                        } catch (captureFailure: Throwable) {
                            failure.addSuppressed(captureFailure)
                        }
                        throw failure
                    }
                    compose.onNodeWithText(label).assertIsSelected().assertIsEnabled()
                    val usage = compose.onNodeWithText("模型平均耗时", substring = true).performScrollTo()
                        .fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.Text]
                        .joinToString { it.text }
                    assertTrue("刷新后应保留数值用量：$usage", Regex("Token [0-9]+").containsMatchIn(usage))
                    samples += buildJsonObject {
                        put("index", index)
                        put("days", days)
                        put("expectedDate", expectedDate)
                        put("elapsedMs", android.os.SystemClock.elapsedRealtime() - started)
                        put("pssKb", android.os.Debug.getPss())
                    }
                }
            } finally {
                // 包含测试驱动开销；失败时也保留已完成样本，PSS 差值不直接等于泄漏。
                File(compose.activity.cacheDir, "uma-management-refresh.json").writeText(
                    buildJsonObject {
                        put("samples", JsonArray(samples))
                        put("initialPssKb", initialPssKb)
                        put("finalPssKb", android.os.Debug.getPss())
                        put("cpuMs", android.os.Process.getElapsedCpuTime() - initialCpuMs)
                        put("wallMs", android.os.SystemClock.elapsedRealtime() - initialWallMs)
                    }.toString()
                )
            }
        } finally {
            try {
                // 在同一个测试根组合中销毁页面，避免重新 setContent 触发旧页面恢复和额外请求。
                compose.runOnIdle { contentVisible.value = false }
                compose.waitForIdle()
            } finally {
                compose.runOnUiThread { model.viewModelScope.cancel() }
            }
        }
    }
}
