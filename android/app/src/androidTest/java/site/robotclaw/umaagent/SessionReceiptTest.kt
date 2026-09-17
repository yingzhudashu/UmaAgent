package site.robotclaw.umaagent

import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** 在写入处理中切换会话，受控回执不得导航回旧会话或清掉新会话状态。 */
@RunWith(AndroidJUnit4::class)
class SessionReceiptTest {
    @Test
    fun lateSessionWritesCannotNavigateOrClearAnotherConversation() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = ApplicationProvider.getApplicationContext<android.app.Application>()
        val oldItem = UiQueueItem("old-run", "old-message", 1, "旧消息", "queued", "agent")
        val currentItem = oldItem.copy(runId = "current-run", messageId = "current-message")
        for (operation in
            listOf(
                "confirm",
                "edit",
                "review",
                "improve",
                "approval",
                "compact",
                "cancel",
                "delete",
                "rename",
                "queueMode",
                "assistant",
                "resetAvatar",
                "model",
            )) {
            for (receiptStatus in listOf(200, 500)) {
                val arrived = CountDownLatch(1)
                val release = CountDownLatch(1)
                var saved = false
                val http =
                    OkHttpClient.Builder()
                        .addInterceptor { chain ->
                            arrived.countDown()
                            check(release.await(5, TimeUnit.SECONDS)) { "测试未释放 HTTP 回执" }
                            Response.Builder()
                                .request(chain.request())
                                .protocol(Protocol.HTTP_1_1)
                                .code(receiptStatus)
                                .message("OK")
                                .body(
                                    (if (
                                            operation in
                                                listOf(
                                                    "rename",
                                                    "queueMode",
                                                    "assistant",
                                                    "resetAvatar",
                                                )
                                        )
                                            """{"id":"old","title":"已修改"}"""
                                        else "{}")
                                        .toResponseBody("application/json".toMediaType())
                                )
                                .build()
                        }
                        .build()
                lateinit var model: UmaViewModel
                lateinit var state: MutableStateFlow<UmaUiState>
                lateinit var pending: List<Job>
                try {
                    instrumentation.runOnMainSync {
                        PatStore(app).clear()
                        SnapshotCache(app).clear()
                        DraftStore(app).clear()
                        model = UmaViewModel(app)
                        model.viewModelScope.coroutineContext.cancelChildren()
                        // 仅测试注入传输与起始状态，不给生产 API 增加测试配置入口。
                        UmaViewModel::class
                            .java
                            .getDeclaredField("api")
                            .apply { isAccessible = true }
                            .set(model, UmaApi(baseUrl = "https://queue.test", http = http))
                        @Suppress("UNCHECKED_CAST")
                        state =
                            UmaViewModel::class
                                .java
                                .getDeclaredField("state")
                                .apply { isAccessible = true }
                                .get(model) as MutableStateFlow<UmaUiState>
                        state.value = UmaUiState(selectedSessionId = "old", queue = emptyList())
                        val existing = model.viewModelScope.coroutineContext[Job]!!.children.toSet()
                        when (operation) {
                            "confirm" -> model.confirmPlan("old-run")
                            "edit" -> model.editMessage("old-message", "修改") { saved = true }
                            "review" -> model.reviewMessage("old-message")
                            "improve" -> model.improveMessage("old-message")
                            "approval" -> model.resolveApproval("old-approval", true)
                            "compact" -> model.compactSelectedSession()
                            "cancel" -> model.cancelSelectedSession()
                            "delete" -> model.deleteSelectedSession()
                            "rename" -> model.renameSession("已修改") { saved = true }
                            "queueMode" -> model.updateQueueMode("preemptive")
                            "assistant" -> model.updateAssistantName("已修改")
                            "resetAvatar" -> model.resetAssistantAvatar()
                            "model" -> model.selectModel(ModelReference("faux", "faux-1"))
                        }
                        pending =
                            model.viewModelScope.coroutineContext[Job]!!
                                .children
                                .filter { it !in existing }
                                .toList()
                    }
                    assertTrue("请求必须到达传输层", arrived.await(5, TimeUnit.SECONDS))
                    instrumentation.runOnMainSync {
                        state.value =
                            state.value.copy(
                                selectedSessionId = "current",
                                queue = listOf(currentItem),
                                loading = true,
                                cancelling = true,
                                error = "当前会话错误",
                            )
                    }
                    release.countDown()
                    runBlocking { withTimeout(5_000) { pending.forEach { it.join() } } }
                    instrumentation.runOnMainSync {
                        assertEquals(
                            "$operation 的回执归属",
                            listOf(currentItem),
                            state.value.queue,
                        )
                        assertEquals("不能跳回发起会话", "current", state.value.selectedSessionId)
                        assertEquals("旧回执不能覆盖新会话错误", "当前会话错误", state.value.error)
                        assertTrue("不能清掉另一会话的加载状态", state.value.loading)
                        assertTrue("不能清掉另一会话的取消状态", state.value.cancelling)
                        if (operation in listOf("edit", "rename")) assertFalse(saved)
                    }
                } finally {
                    release.countDown()
                    instrumentation.runOnMainSync {
                        model.viewModelScope.coroutineContext.cancelChildren()
                    }
                    http.connectionPool.evictAll()
                    http.dispatcher.executorService.shutdown()
                }
            }
        }
    }
}
