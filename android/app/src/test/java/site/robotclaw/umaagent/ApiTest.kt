package site.robotclaw.umaagent

import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ApiTest {
    @Test
    fun bootstrapPreservesTheAuthenticatedUserRole() = runBlocking {
        val captured = AtomicReference<Request>()
        val http = OkHttpClient.Builder()
            .addInterceptor(Interceptor { chain ->
                captured.set(chain.request())
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body(
                        """{"user":{"id":"user-1","role":"admin"},"sessions":[]}"""
                            .toResponseBody("application/json".toMediaType()),
                    )
                    .build()
            })
            .build()

        val bootstrap = UmaApi(token = "uma_pat_test", baseUrl = "https://core.test", http = http)
            .bootstrap()

        assertEquals("user-1", bootstrap.user?.id)
        assertEquals("admin", bootstrap.user?.role)
        assertEquals("POST", captured.get().method)
        assertTrue(captured.get().body != null)
    }

    @Test
    fun avatarUploadUsesTheSamePurposeFieldAsWeb() {
        val multipart = buildUploadMultipart(
            name = "avatar.png",
            sessionId = "session-1",
            body = byteArrayOf(1, 2, 3).toRequestBody("image/png".toMediaType()),
            purpose = "avatar",
        )
        val encoded = Buffer().also { multipart.writeTo(it) }.readUtf8()

        assertTrue(encoded.contains("name=\"file\"; filename=\"avatar.png\""))
        assertTrue(encoded.contains("name=\"sessionId\"\r\n"))
        assertTrue(encoded.contains("name=\"purpose\"\r\n"))
        assertTrue(encoded.contains("\r\n\r\navatar\r\n"))
    }

    @Test
    fun registerUsesSharedAuthContract() = runBlocking {
        val captured = AtomicReference<Request>()
        val http = OkHttpClient.Builder()
            .addInterceptor(Interceptor { chain ->
                val request = chain.request()
                captured.set(request)
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(201)
                    .message("Created")
                    .body(
                        """{"userId":"user-1","token":"uma_pat_test","tokenId":"token-1"}"""
                            .toResponseBody("application/json".toMediaType()),
                    )
                    .build()
            })
            .build()

        val registration = UmaApi(baseUrl = "https://core.test", http = http).register("phone")
        val request = captured.get()
        val body = Buffer().also { request.body?.writeTo(it) }.readUtf8()

        assertEquals("user-1", registration.userId)
        assertEquals("uma_pat_test", registration.token)
        assertEquals("token-1", registration.tokenId)
        assertEquals("POST", request.method)
        assertEquals("https://core.test/api/v15/auth/register", request.url.toString())
        assertEquals("{\"label\":\"phone\"}", body)
        assertNull(request.header("Authorization"))
    }

    @Test
    fun authenticatedRequestsIncludeBearerToken() = runBlocking {
        val captured = AtomicReference<Request>()
        val http = OkHttpClient.Builder()
            .addInterceptor(Interceptor { chain ->
                val request = chain.request()
                captured.set(request)
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body("""{"userId":"user-1"}""".toResponseBody("application/json".toMediaType()))
                    .build()
            })
            .build()

        UmaApi(token = "uma_pat_test", baseUrl = "https://core.test", http = http).authMe()

        assertEquals("Bearer uma_pat_test", captured.get().header("Authorization"))
    }

    @Test
    fun stagingGatewayKeepsBasicAndBearerCredentialsSeparate() = runBlocking {
        val captured = AtomicReference<Request>()
        val http = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            captured.set(chain.request())
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body("{}".toResponseBody("application/json".toMediaType())).build()
        }).build()

        UmaApi(token = "uma_pat_test", baseUrl = "https://staging.test", gatewayPassword = "staging-secret", http = http).authMe()

        assertTrue(captured.get().header("Authorization")?.startsWith("Basic ") == true)
        assertEquals("Bearer uma_pat_test", captured.get().header("X-Uma-Authorization"))
    }

    @Test
    fun sendPreservesSelectedInteractionMode() = runBlocking {
        val captured = AtomicReference<Request>()
        val http = OkHttpClient.Builder()
            .addInterceptor(Interceptor { chain ->
                val request = chain.request()
                captured.set(request)
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(202)
                    .message("Accepted")
                    .body("{}".toResponseBody("application/json".toMediaType()))
                    .build()
            })
            .build()

        UmaApi(token = "uma_pat_test", baseUrl = "https://core.test", http = http)
            .send("session-1", "规划这个任务", mode = "plan")

        val body = Buffer().also { captured.get().body?.writeTo(it) }.readUtf8()
        assertEquals("plan", Json.parseToJsonElement(body).jsonObject["mode"]?.jsonPrimitive?.content)
    }

    @Test
    fun resolveApprovalUsesTheSharedApprovalContract() = runBlocking {
        val captured = AtomicReference<Request>()
        val http = OkHttpClient.Builder()
            .addInterceptor(Interceptor { chain ->
                val request = chain.request()
                captured.set(request)
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body("{}".toResponseBody("application/json".toMediaType()))
                    .build()
            })
            .build()

        UmaApi(token = "uma_pat_test", baseUrl = "https://core.test", http = http)
            .resolveApproval("approval-1", true)

        val request = captured.get()
        val body = Buffer().also { request.body?.writeTo(it) }.readUtf8()
        assertEquals("POST", request.method)
        assertEquals("https://core.test/api/v15/approvals/approval-1", request.url.toString())
        assertEquals("{\"approved\":true}", body)
    }

    @Test
    fun backgroundTaskOperationsUseTheSharedTaskContract() = runBlocking {
        val requests = mutableListOf<Request>()
        val http = OkHttpClient.Builder()
            .addInterceptor(Interceptor { chain ->
                requests += chain.request()
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body("{}".toResponseBody("application/json".toMediaType()))
                    .build()
            })
            .build()
        val client = UmaApi(token = "uma_pat_test", baseUrl = "https://core.test", http = http)

        client.createTask("整理报告", "session-1")
        client.cancelTask("task-1")
        client.deleteTask("task-1")

        assertEquals("POST", requests[0].method)
        assertEquals("/api/v15/tasks", requests[0].url.encodedPath)
        val createBody = Buffer().also { requests[0].body?.writeTo(it) }.readUtf8()
        assertEquals("{\"prompt\":\"整理报告\",\"parentSessionId\":\"session-1\"}", createBody)
        assertEquals("POST", requests[1].method)
        assertEquals("/api/v15/tasks/task-1/cancel", requests[1].url.encodedPath)
        assertEquals("DELETE", requests[2].method)
        assertEquals("/api/v15/tasks/task-1", requests[2].url.encodedPath)
    }

    @Test
    fun scheduledTaskOperationsUseTheSharedContract() = runBlocking {
        val requests = mutableListOf<Request>()
        val http = OkHttpClient.Builder()
            .addInterceptor(Interceptor { chain ->
                val request = chain.request()
                requests += request
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body("{}".toResponseBody("application/json".toMediaType()))
                    .build()
            })
            .build()
        val client = UmaApi(token = "uma_pat_test", baseUrl = "https://core.test", http = http)

        client.createSchedule("一次性提醒", "检查部署", "once", "2026-09-01T08:30:00Z")
        client.createSchedule("每分钟同步", "同步状态", "interval", "60000")
        client.createSchedule("每日汇总", "汇总日报", "cron", "0 9 * * *", "Asia/Shanghai")
        client.updateSchedule("schedule/id", false)
        client.runSchedule("schedule/id")
        client.scheduleRuns("schedule/id")
        client.cancelScheduleRun("schedule-run/id")
        client.deleteSchedule("schedule/id")

        val createBodies = requests.take(3).map { request ->
            Json.parseToJsonElement(Buffer().also { request.body?.writeTo(it) }.readUtf8()).jsonObject
        }
        assertEquals("agent", createBodies[0]["messageMode"]?.jsonPrimitive?.content)
        assertEquals("once", createBodies[0]["schedule"]?.jsonObject?.get("kind")?.jsonPrimitive?.content)
        assertEquals("1788251400000", createBodies[0]["schedule"]?.jsonObject?.get("at")?.jsonPrimitive?.content)
        assertEquals("interval", createBodies[1]["schedule"]?.jsonObject?.get("kind")?.jsonPrimitive?.content)
        assertEquals("60000", createBodies[1]["schedule"]?.jsonObject?.get("everyMs")?.jsonPrimitive?.content)
        assertEquals("cron", createBodies[2]["schedule"]?.jsonObject?.get("kind")?.jsonPrimitive?.content)
        assertEquals("0 9 * * *", createBodies[2]["schedule"]?.jsonObject?.get("expression")?.jsonPrimitive?.content)
        assertEquals("Asia/Shanghai", createBodies[2]["schedule"]?.jsonObject?.get("timezone")?.jsonPrimitive?.content)

        assertEquals("PATCH", requests[3].method)
        assertEquals("/api/v15/schedules/schedule%2Fid", requests[3].url.encodedPath)
        assertEquals(false, Json.parseToJsonElement(
            Buffer().also { requests[3].body?.writeTo(it) }.readUtf8(),
        ).jsonObject["enabled"]?.jsonPrimitive?.boolean)
        assertEquals("POST", requests[4].method)
        assertEquals("/api/v15/schedules/schedule%2Fid/run", requests[4].url.encodedPath)
        assertEquals("GET", requests[5].method)
        assertEquals("/api/v15/schedules/schedule%2Fid/runs", requests[5].url.encodedPath)
        assertEquals("POST", requests[6].method)
        assertEquals("/api/v15/schedule-runs/schedule-run%2Fid/cancel", requests[6].url.encodedPath)
        assertEquals("DELETE", requests[7].method)
        assertEquals("/api/v15/schedules/schedule%2Fid", requests[7].url.encodedPath)
    }

    @Test
    fun queueOperationsUseTheSharedContract() = runBlocking {
        val requests = mutableListOf<Request>()
        val http = OkHttpClient.Builder()
            .addInterceptor(Interceptor { chain ->
                val request = chain.request()
                requests += request
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body("""{"id":"session/id","title":"Session"}""".toResponseBody("application/json".toMediaType()))
                    .build()
            })
            .build()
        val client = UmaApi(token = "uma_pat_test", baseUrl = "https://core.test", http = http)

        client.queue("session/id")
        client.reorderQueue("session/id", listOf("run/2", "run/1"))
        client.prioritizeRun("run/2")
        client.cancelRun("run/1")
        client.updateQueueMode("session/id", "preemptive")

        assertEquals("GET", requests[0].method)
        assertEquals("/api/v15/sessions/session%2Fid/queue", requests[0].url.encodedPath)
        assertEquals("POST", requests[1].method)
        assertEquals("/api/v15/sessions/session%2Fid/queue/reorder", requests[1].url.encodedPath)
        val reorderBody = Json.parseToJsonElement(
            Buffer().also { requests[1].body?.writeTo(it) }.readUtf8(),
        ).jsonObject
        assertEquals(
            listOf("run/2", "run/1"),
            reorderBody["runIds"]?.jsonArray?.map { it.jsonPrimitive.content },
        )
        assertEquals("POST", requests[2].method)
        assertEquals("/api/v15/runs/run%2F2/prioritize", requests[2].url.encodedPath)
        assertEquals("POST", requests[3].method)
        assertEquals("/api/v15/runs/run%2F1/cancel", requests[3].url.encodedPath)
        assertEquals("PATCH", requests[4].method)
        assertEquals("/api/v15/sessions/session%2Fid", requests[4].url.encodedPath)
        assertEquals("preemptive", Json.parseToJsonElement(
            Buffer().also { requests[4].body?.writeTo(it) }.readUtf8(),
        ).jsonObject["queueMode"]?.jsonPrimitive?.content)
    }

    @Test
    fun messageEditAndQualityOperationsUseTheSharedContract() = runBlocking {
        val requests = mutableListOf<Request>()
        val http = OkHttpClient.Builder()
            .addInterceptor(Interceptor { chain ->
                requests += chain.request()
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(202)
                    .message("Accepted")
                    .body("{}".toResponseBody("application/json".toMediaType()))
                    .build()
            })
            .build()
        val client = UmaApi(token = "uma_pat_test", baseUrl = "https://core.test", http = http)

        client.editMessage("user-1", "修订后的问题")
        client.reviewMessage("assistant-1")
        client.improveMessage("assistant-1")

        assertEquals("PATCH", requests[0].method)
        assertEquals("/api/v15/messages/user-1", requests[0].url.encodedPath)
        assertEquals("修订后的问题", Json.parseToJsonElement(
            Buffer().also { requests[0].body?.writeTo(it) }.readUtf8(),
        ).jsonObject["text"]?.jsonPrimitive?.content)
        assertEquals("POST", requests[1].method)
        assertEquals("/api/v15/messages/assistant-1/review", requests[1].url.encodedPath)
        assertEquals("", Json.parseToJsonElement(
            Buffer().also { requests[1].body?.writeTo(it) }.readUtf8(),
        ).jsonObject["feedback"]?.jsonPrimitive?.content)
        assertEquals("POST", requests[2].method)
        assertEquals("/api/v15/messages/assistant-1/improve", requests[2].url.encodedPath)
        val improveBody = Json.parseToJsonElement(
            Buffer().also { requests[2].body?.writeTo(it) }.readUtf8(),
        ).jsonObject
        assertEquals(false, improveBody["force"]?.jsonPrimitive?.boolean)
        assertEquals(false, improveBody["reset"]?.jsonPrimitive?.boolean)
    }

    @Test
    fun attachmentBytesUsesTheProvidedDescriptionForAnOversizedStream() = runBlocking {
        val responseBody = object : ResponseBody() {
            override fun contentType() = "image/png".toMediaType()
            override fun contentLength() = -1L
            override fun source() = Buffer().write(byteArrayOf(1, 2, 3, 4, 5))
        }
        val http = OkHttpClient.Builder()
            .addInterceptor(Interceptor { chain ->
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body(responseBody)
                    .build()
            })
            .build()

        val failure = runCatching {
            UmaApi(token = "uma_pat_test", baseUrl = "https://core.test", http = http)
                .attachmentBytes("image-1", maxBytes = 4, description = "图片")
        }.exceptionOrNull()

        assertEquals("图片超过大小限制", failure?.message)
    }
}
