package site.robotclaw.umaagent

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncStateTest {
    @Test
    fun resourceActionsRespectTheBootstrapRole() {
        val userPaths = resourceActionsForRole("user").map { it.first }
        val adminPaths = resourceActionsForRole("admin").map { it.first }

        assertFalse(userPaths.contains("/skills"))
        assertFalse(userPaths.contains("/reports/diagnostics"))
        assertTrue(adminPaths.contains("/skills"))
        assertTrue(adminPaths.contains("/reports/diagnostics"))
        assertTrue(adminPaths.containsAll(userPaths))
    }

    @Test
    fun parsesPendingApprovalsFromSnapshot() {
        val approvals = pendingApprovals(
            """{"pendingApprovals":[{"id":"a1","toolName":"shell.exec","input":{"command":"ls"},"status":"pending"}]}""",
        )

        assertEquals(1, approvals.size)
        assertEquals("a1", approvals.single().id)
        assertEquals("shell.exec", approvals.single().toolName)
        assertTrue(approvals.single().input.contains("command"))
    }

    @Test fun sequenceRejectsDuplicatesAndInvalidValues() {
        assertFalse(SequenceTracker.inspect(4, 4).accept)
        assertFalse(SequenceTracker.inspect(4, 0).accept)
        assertEquals(4, SequenceTracker.inspect(4, 4).next)
    }

    @Test fun sequenceDetectsGapsAndAcceptsNextEvent() {
        assertTrue(SequenceTracker.inspect(4, 6).gap)
        assertEquals(5, SequenceTracker.inspect(4, 5).next)
    }

    @Test fun mergeKeepsCursorMonotonic() {
        assertEquals(12, SequenceTracker.merge(4, listOf(8, 12, 7), 10))
        assertEquals(4, SequenceTracker.merge(4, emptyList()))
    }

    @Test fun cacheEnvelopeIsStrictlyVersionedJson() {
        val value = CacheEnvelope(2, listOf(Session("s1", "One")), mapOf("s1" to "{}"), mapOf("s1" to 3L))
        val json = Json.encodeToString(value)
        assertEquals(value, Json.decodeFromString<CacheEnvelope>(json))
        assertEquals(2, Json.decodeFromString<CacheEnvelope>(json).version)
    }

    @Test fun sessionIdentityFieldsRoundTripThroughV15Json() {
        val value = Session(
            "s1",
            "One",
            assistantName = "猫猫球",
            assistantAvatarAttachmentId = "a1",
            queueMode = "preemptive",
        )
        val decoded = Json.decodeFromString<Session>(Json.encodeToString(value))
        assertEquals("猫猫球", decoded.assistantName)
        assertEquals("a1", decoded.assistantAvatarAttachmentId)
        assertEquals("preemptive", decoded.queueMode)
    }

    @Test fun v15EventFixturesHaveStableEnvelopeFields() {
        listOf("v15-event.json", "v15-transient-delta.json").forEach { name ->
            val stream = javaClass.classLoader?.getResourceAsStream("fixtures/$name")
            checkNotNull(stream) { "missing fixture $name" }
            val event = stream.bufferedReader().use { Json.parseToJsonElement(it.readText()).jsonObject }
            assertEquals(15, event.getValue("protocolVersion").jsonPrimitive.int)
            assertEquals("session-1", event.getValue("sessionId").jsonPrimitive.content)
            assertTrue(event.getValue("timestamp").jsonPrimitive.long > 0)
        }
    }

    @Test fun snapshotMessagesAreStructuredAndMalformedSnapshotsAreEmpty() {
        val snapshot = """{"transcript":[{"id":"m1","role":"user","status":"complete","content":"看图","attachments":[{"id":"a1","name":"diagram.png","mimeType":"image/png","size":1537}]},{"id":"m2","role":"assistant","status":"streaming","content":"处理中"}]}"""
        assertEquals(
            listOf(
                UiMessage(
                    "m1",
                    "user",
                    "complete",
                    "看图",
                    listOf(UiAttachment("a1", "diagram.png", "image/png", 1537)),
                ),
                UiMessage("m2", "assistant", "streaming", "处理中", emptyList()),
            ),
            parseSnapshotMessages(snapshot),
        )
        assertTrue(parseSnapshotMessages("not-json").isEmpty())
    }

    @Test
    fun attachmentMetadataFallsBackSafelyAndFormatsSizes() {
        val message = parseSnapshotMessages(
            """{"transcript":[{"id":"m1","attachments":[{"id":"a1","size":-1}]}]}""",
        ).single()

        assertEquals(UiAttachment("a1", "附件", "application/octet-stream", 0), message.attachments.single())
        assertEquals("999 B", attachmentSizeLabel(999))
        assertEquals("1 KB", attachmentSizeLabel(1024))
        assertEquals("2 KB", attachmentSizeLabel(1025))
    }

    @Test
    fun backgroundTasksExposeTheSharedLifecycleAndIgnoreMalformedEntries() {
        val tasks = parseBackgroundTasks(
            """[{"id":"task-1","sessionId":"session-1","runId":"run-1","prompt":"整理报告","status":"running"},{"id":"task-2","sessionId":"session-2","prompt":"已完成任务","status":"completed","result":"完成"},{"id":"invalid","prompt":"缺少会话"}]""",
        )

        assertEquals(2, tasks.size)
        assertEquals("run-1", tasks[0].runId)
        assertTrue(isActiveBackgroundTask(tasks[0]))
        assertFalse(isActiveBackgroundTask(tasks[1]))
        assertEquals("运行中", backgroundTaskStatusLabel(tasks[0].status))
        assertEquals("已完成", backgroundTaskStatusLabel(tasks[1].status))
        assertTrue(parseBackgroundTasks("not-json").isEmpty())
    }

    @Test
    fun scheduledTasksParseEachScheduleTypeAndIgnoreMalformedEntries() {
        val tasks = parseScheduledTasks(
            """{"schedules":[{"id":"once-1","name":"一次性","prompt":"提醒我","schedule":{"kind":"once","at":1788251400000},"enabled":true,"nextRunAt":1788251400000},{"id":"interval-1","name":"间隔","prompt":"同步","schedule":{"kind":"interval","everyMs":60000},"enabled":false,"lastRunAt":1788247800000},{"id":"cron-1","name":"日报","prompt":"汇总","schedule":{"kind":"cron","expression":"0 9 * * *","timezone":"Asia/Shanghai"},"enabled":true},{"id":"invalid","name":"无计划","prompt":"跳过"}]}""",
        )

        assertEquals(3, tasks.size)
        assertEquals("1788251400000", tasks[0].scheduleValue)
        assertEquals(1788251400000, tasks[0].nextRunAt)
        assertEquals("60000", tasks[1].scheduleValue)
        assertEquals(1788247800000, tasks[1].lastRunAt)
        assertEquals("0 9 * * *", tasks[2].scheduleValue)
        assertEquals("Asia/Shanghai", tasks[2].timezone)
        assertTrue(tasks[0].enabled)
        assertFalse(tasks[1].enabled)
        assertEquals("一次性", scheduledKindLabel("once"))
        assertEquals("按间隔", scheduledKindLabel("interval"))
        assertEquals("Cron", scheduledKindLabel("cron"))
        assertTrue(parseScheduledTasks("not-json").isEmpty())
    }

    @Test
    fun scheduledRunsExposeLifecycleAndIgnoreMalformedEntries() {
        val runs = parseScheduledRuns(
            """[{"id":"run-1","status":"claimed","trigger":"manual","scheduledFor":1788251400000},{"id":"run-2","status":"awaiting_resume","trigger":"scheduled","scheduledFor":1788255000000},{"id":"run-3","status":"failed","trigger":"catchup","scheduledFor":1788258600000,"error":"执行失败"},{"id":"invalid","status":"running"}]""",
        )

        assertEquals(3, runs.size)
        assertTrue(isActiveScheduledRun(runs[0]))
        assertTrue(isActiveScheduledRun(runs[1]))
        assertFalse(isActiveScheduledRun(runs[2]))
        assertEquals("manual", runs[0].trigger)
        assertEquals("等待恢复", scheduledRunStatusLabel(runs[1].status))
        assertEquals("失败", scheduledRunStatusLabel(runs[2].status))
        assertEquals("执行失败", runs[2].error)
        assertTrue(parseScheduledRuns("not-json").isEmpty())
    }

    @Test
    fun queueItemsParseNestedRunAndMessageDataInPositionOrder() {
        val queue = parseQueue(
            """{"queue":[{"position":2,"run":{"id":"run-2","status":"queued","interactionMode":"plan"},"message":{"id":"message-2","content":"第二条"}},{"position":1,"run":{"id":"run-1","status":"preflight","interactionMode":"agent"},"message":{"id":"message-1","content":"第一条"}},{"position":3,"run":{"id":"run-3","status":"running"},"message":{"id":"message-3","content":"第三条"}},{"position":4,"run":{"id":"bad"},"message":{}}]}""",
        )

        assertEquals(listOf("run-1", "run-2", "run-3"), queue.map { it.runId })
        assertEquals(listOf("第一条", "第二条", "第三条"), queue.map { it.content })
        assertEquals("plan", queue[1].interactionMode)
        assertEquals("等待处理", queueStatusLabel(queue[1].status))
        assertEquals("准备中", queueStatusLabel(queue[0].status))
        assertEquals("执行中", queueStatusLabel(queue[2].status))
        assertTrue(parseQueue("not-json").isEmpty())
        assertTrue(parseQueue("{\"queue\":[]}").isEmpty())
    }

    @Test
    fun responseFilesAppearWithTheFinalAssistantMessageWithoutDuplicates() {
        val messages = parseSnapshotMessages(
            """{"transcript":[{"id":"m1","role":"user","runId":"run-1","attachments":[]},{"id":"m2","role":"assistant","runId":"run-1","attachments":[{"id":"shared","name":"result.txt","mimeType":"text/plain","size":2}]}],"responses":[{"runId":"run-1","messageId":"m1","attachments":[{"id":"shared","name":"result.txt","mimeType":"text/plain","size":2},{"id":"generated","name":"chart.png","mimeType":"image/png","size":2048}]}]}""",
        )

        assertEquals(listOf("shared", "generated"), messages[1].attachments.map { it.id })
        assertEquals("chart.png", messages[1].attachments.last().name)
    }

    @Test
    fun responseFilesFallBackToTheLinkedMessageBeforeAnAssistantReplyExists() {
        val messages = parseSnapshotMessages(
            """{"transcript":[{"id":"m1","role":"user","runId":"run-1","attachments":[]}],"responses":[{"runId":"run-1","messageId":"m1","attachments":[{"id":"generated","name":"output.pdf","mimeType":"application/pdf","size":1024}]}]}""",
        )

        assertEquals(listOf("generated"), messages.single().attachments.map { it.id })
    }

    @Test
    fun malformedResponseWithoutARunIdDoesNotAttachToAnUnrelatedAssistantMessage() {
        val messages = parseSnapshotMessages(
            """{"transcript":[{"id":"m1","role":"assistant","attachments":[]},{"id":"m2","role":"user","attachments":[]}],"responses":[{"messageId":"m2","attachments":[{"id":"generated","name":"output.txt","mimeType":"text/plain","size":1}]}]}""",
        )

        assertTrue(messages[0].attachments.isEmpty())
        assertEquals(listOf("generated"), messages[1].attachments.map { it.id })
    }

    @Test
    fun pendingPlanRunIsExposedForConfirmation() {
        val snapshot = """{"responses":[{"runId":"run-1","status":"completed"},{"runId":"run-2","status":"awaiting_confirmation"}]}"""
        assertEquals("run-2", pendingPlanRunId(snapshot))
        assertEquals(null, pendingPlanRunId("{\"responses\":[]}"))
        assertEquals(null, pendingPlanRunId("not-json"))
    }

    @Test
    fun subscriptionFrameCarriesCurrentSessionsAndCursors() {
        val frame = Json.parseToJsonElement(
            eventSubscriptionFrame(listOf("session-1" to 7L, "session-2" to -1L)),
        ).jsonObject
        val subscriptions = frame.getValue("sessions") as kotlinx.serialization.json.JsonArray

        assertEquals("subscribe", frame.getValue("type").jsonPrimitive.content)
        assertEquals("session-1", subscriptions[0].jsonObject.getValue("id").jsonPrimitive.content)
        assertEquals(7, subscriptions[0].jsonObject.getValue("lastSequence").jsonPrimitive.long)
        assertEquals(0, subscriptions[1].jsonObject.getValue("lastSequence").jsonPrimitive.long)
    }

    @Test
    fun resourceInvalidationFramesExposeInvalidatedResources() {
        val taskFrame = Json.parseToJsonElement(
            """{"type":"resource.invalidated","resource":"tasks"}""",
        ).jsonObject
        val resyncFrame = Json.parseToJsonElement(
            """{"type":"resource.resync_required","resources":["tasks","memory","tasks"]}""",
        ).jsonObject

        assertEquals(setOf("tasks"), invalidatedResources(taskFrame))
        assertEquals(setOf("tasks", "memory"), invalidatedResources(resyncFrame))
        assertTrue(invalidatedResources(Json.parseToJsonElement("{}" ).jsonObject).isEmpty())
    }
}
