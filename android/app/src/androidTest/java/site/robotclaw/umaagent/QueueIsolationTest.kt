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

/** 在真实主线程运行 ViewModel，以受控 HTTP 回执重现切换会话后的队列污染。 */
@RunWith(AndroidJUnit4::class)
class QueueIsolationTest {
    @Test
    fun lateQueueReceiptsCannotReplaceAnotherConversation() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = ApplicationProvider.getApplicationContext<android.app.Application>()
        val oldItem = UiQueueItem("old-run", "old-message", 1, "旧消息", "queued", "agent")
        val currentItem = oldItem.copy(runId = "current-run", messageId = "current-message")
        for (operation in listOf("read", "reorder", "prioritize", "cancel", "edit")) {
            for (switchSession in listOf(false, true)) {
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
                                .code(200)
                                .message("OK")
                                .body(
                                    """[{"position":1,"run":{"id":"old-run","status":"queued"},"message":{"id":"old-message","content":"旧消息"}}]"""
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
                            "read" -> model.loadQueue()
                            "reorder" -> model.reorderQueue(listOf(oldItem.runId))
                            "prioritize" -> model.prioritizeRun(oldItem.runId)
                            "cancel" -> model.cancelQueuedRun(oldItem.runId)
                            "edit" -> model.editQueuedMessage(oldItem, "修改") { saved = true }
                        }
                        pending =
                            model.viewModelScope.coroutineContext[Job]!!
                                .children
                                .filter { it !in existing }
                                .toList()
                    }
                    assertTrue("请求必须到达传输层", arrived.await(5, TimeUnit.SECONDS))
                    if (switchSession)
                        instrumentation.runOnMainSync {
                            state.value =
                                state.value.copy(
                                    selectedSessionId = "current",
                                    queue = listOf(currentItem),
                                    loading = true,
                                )
                        }
                    release.countDown()
                    runBlocking { withTimeout(5_000) { pending.forEach { it.join() } } }
                    instrumentation.runOnMainSync {
                        assertEquals(
                            "$operation 的回执归属",
                            if (switchSession) listOf(currentItem) else listOf(oldItem),
                            state.value.queue,
                        )
                        assertEquals("不能清掉另一会话的加载状态", switchSession, state.value.loading)
                        if (operation == "edit") assertEquals(!switchSession, saved)
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
