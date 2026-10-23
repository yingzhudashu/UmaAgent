package site.robotclaw.umaagent

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** 真实 HTTP → Core 持久化 → Android 翻页，仅连接隔离 Faux，不触碰用户会话。 */
@RunWith(AndroidJUnit4::class)
class HistoryPaginationTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun buttonAndScrollLoadCompleteAnswersAndPersistHistory() = runBlocking {
        val token = "uma_pat_00000000-0000-4000-8000-000000000003_faux-user-3-token-012345678901234567890123"
        val api = UmaApi(token)
        val session = api.createSession("历史分页设备验收 ${System.currentTimeMillis()}")
        var model: UmaViewModel? = null
        try {
            // 超过两页，第一条含工具过程，确保最后一页也使用完整回答卡片。
            for (index in 0..102) {
                val text = if (index == 0) "Use the configured deterministic read tool and return its result."
                    else "history-$index"
                val receipt = api.send(session.id, text)
                val runId = receipt["runId"]!!.jsonPrimitive.content
                withTimeout(30_000) {
                    while (true) {
                        val status = api.run(runId).jsonObject["status"]!!.jsonPrimitive.content
                        if (status == "completed") break
                        check(status !in listOf("failed", "cancelled")) { "Fixture run $index: $status" }
                        delay(50)
                    }
                }
            }
            val initial = api.snapshot(session.id)
            assertTrue(snapshotHistoryHasMore(initial))
            val firstCursor = snapshotHistoryCursor(initial)
            lateinit var active: UmaViewModel
            compose.runOnUiThread {
                val app = compose.activity.application
                PatStore(app).clear()
                SnapshotCache(app).clear()
                DraftStore(app).clear()
                active = UmaViewModel(app)
                model = active
            }
            compose.setContent { UmaScreen(active) }
            compose.runOnUiThread { active.login(token) }
            compose.waitUntil(20_000) { active.uiState.value.tokenPresent && !active.uiState.value.loading }
            compose.runOnUiThread { active.selectSession(session.id) }
            compose.waitUntil(20_000) {
                active.uiState.value.selectedSessionId == session.id && !active.uiState.value.loading &&
                    active.uiState.value.historyHasMore
            }
            val messages = compose.onNodeWithTag("conversation-messages")
            messages.performScrollToNode(hasTestTag("load-earlier-messages"))
            compose.onNodeWithTag("load-earlier-messages").assertIsDisplayed().assertIsEnabled().performClick()
            // UI只持有解析后的列表；生产投影避免重复序列化到旧snapshot字符串字段。
            fun currentSnapshot(): JsonObject {
                lateinit var value: JsonObject
                compose.runOnUiThread {
                    value = UmaViewModel::class.java.getDeclaredField("projectedSnapshot")
                        .apply { isAccessible = true }.get(active) as JsonObject
                }
                return value
            }
            compose.waitUntil(15_000) {
                !active.uiState.value.historyLoading && snapshotHistoryCursor(currentSnapshot()) < firstCursor
            }
            assertTrue("第二页之后仍有更早记录", active.uiState.value.historyHasMore)
            val secondCursor = snapshotHistoryCursor(currentSnapshot())
            // 把阅读位置移到已加载窗口开头附近，再实际下拉回看，触发顶部自动翻页。
            messages.performScrollToIndex(3)
            messages.performTouchInput { swipeDown() }
            compose.waitUntil(15_000) {
                !active.uiState.value.historyLoading && !active.uiState.value.historyHasMore
            }
            assertTrue(snapshotHistoryCursor(currentSnapshot()) < secondCursor)
            val answers = active.uiState.value.conversation.orEmpty().filterIsInstance<UiConversationEntry.ResponseEntry>()
            assertEquals(103, answers.size)
            assertEquals(103, answers.map { it.response.runId }.toSet().size)
            val old = answers.single { it.response.content.contains("FAUX_TOOL_RESULT") }
            assertTrue(old.items.any { it.role == "tool" })
            val oldCard = compose.onNodeWithTag("response-card-${old.id}")
            messages.performScrollToNode(hasTestTag("response-card-${old.id}"))
            oldCard.assertIsDisplayed()
            compose.onAllNodesWithText("收起执行详情").assertCountEquals(0)
            java.io.File(compose.activity.cacheDir, "uma-history.png").outputStream().use {
                androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation
                    .takeScreenshot().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
            }
            compose.onNode(hasText("查看执行详情", substring = true) and
                hasAnyAncestor(hasTestTag("response-card-${old.id}"))).performClick()
            compose.onNodeWithText("收起执行详情").assertExists()
            compose.onNodeWithText("收起执行详情").performClick()
            compose.onAllNodesWithTag("load-earlier-messages").assertCountEquals(0)
            // 手动刷新与落盘都必须保留旧页，不能恢复成只有最新100条。
            compose.runOnUiThread { active.selectSession(session.id) }
            compose.waitUntil(15_000) { !active.uiState.value.loading }
            assertEquals(103, active.uiState.value.conversation.orEmpty().filterIsInstance<UiConversationEntry.ResponseEntry>().size)
            compose.waitUntil(10_000) {
                val saved = SnapshotCache(compose.activity.application).read()?.snapshots?.get(session.id)
                saved != null && !snapshotHistoryHasMore(Json.parseToJsonElement(saved).jsonObject)
            }
        } finally {
            compose.runOnUiThread { model?.viewModelScope?.cancel() }
            api.deleteSession(session.id)
        }
    }
}
