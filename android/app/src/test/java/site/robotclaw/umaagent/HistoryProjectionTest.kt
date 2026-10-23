package site.robotclaw.umaagent

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class HistoryProjectionTest {
    private fun parse(value: String) = Json.parseToJsonElement(value).jsonObject
    private val latest = parse("""{
        "session":{"id":"session","activeBranchId":"main","branchRevision":1},
        "snapshotSequence":100,
        "transcript":[{"id":"new","sequence":100,"role":"user","status":"complete","content":"新问题"}],
        "responses":[],"recentRuns":[],
        "history":{"oldestMessageSequence":100,"hasMoreBefore":true}
    }""")
    private val page = parse("""{
        "sessionId":"session","activeBranchId":"main","branchRevision":1,
        "oldestSequence":2,"hasMore":true,
        "items":[
            {"id":"q","runId":"run","sequence":1,"role":"user","status":"complete","content":"历史问题"},
            {"id":"step","runId":"run","sequence":2,"role":"tool","status":"complete","name":"read","content":"历史步骤"},
            {"id":"a","runId":"run","sequence":3,"role":"assistant","status":"complete","content":"完整答案"}
        ],
        "responses":[{"id":"response","messageId":"q","runId":"run","status":"completed","content":"完整答案","activities":[],"attachments":[],"updatedAt":10}],
        "runs":[{"id":"run","status":"completed","plan":[],"updatedAt":10}]
    }""")

    @Test fun completeResponsesSurviveDuplicatePagesRefreshAndCacheRoundTrip() {
        val loaded = mergeSnapshotHistoryPage(latest, page)
        assertEquals(loaded, mergeSnapshotHistoryPage(loaded, page))
        assertEquals(2L, snapshotHistoryCursor(loaded))
        assertTrue(snapshotHistoryHasMore(loaded))
        val refreshed = mergeSessionSnapshots(loaded, latest)
        val restored = parse(refreshed.toString())
        val answers = parseSnapshotConversation(restored).filterIsInstance<UiConversationEntry.ResponseEntry>()
        assertEquals(1, answers.size)
        assertEquals("完整答案", answers.single().response.content)
        assertEquals(3, answers.single().items.size)
        assertEquals("completed", answers.single().run?.status)
        assertEquals(2L, snapshotHistoryCursor(restored))
    }

    @Test fun lateHistoryCannotCrossSessionOrBranchBoundaries() {
        assertSame(latest, mergeSnapshotHistoryPage(latest, JsonObject(page + ("sessionId" to JsonPrimitive("other")))))
        assertSame(latest, mergeSnapshotHistoryPage(latest, JsonObject(page + ("branchRevision" to JsonPrimitive(2)))))
        val different = JsonObject(latest + ("session" to parse("""{"id":"session","activeBranchId":"other","branchRevision":2}""")))
        assertEquals(different, mergeSessionSnapshots(mergeSnapshotHistoryPage(latest, page), different))
    }

    @Test fun lateSnapshotCannotUndoLiveEventsOrLoadedHistory() {
        val loaded = mergeSnapshotHistoryPage(latest, page)
        val stale = JsonObject(latest + ("snapshotSequence" to JsonPrimitive(99)))
        assertSame(loaded, mergeSessionSnapshots(loaded, stale))
    }
}
