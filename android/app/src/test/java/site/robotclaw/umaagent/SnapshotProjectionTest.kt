package site.robotclaw.umaagent

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SnapshotProjectionTest {
    private fun parse(value: String) = Json.parseToJsonElement(value) as JsonObject

    @Test
    fun transientDeltaDoesNotAdvanceCursorAndCompletionWins() {
        val initial =
            parse(
                """{"snapshotSequence":4,"transcript":[{"id":"m","status":"streaming","content":"你"}]}"""
            )
        val delta =
            parse(
                """{"sequence":0,"type":"message.delta","payload":{"messageId":"m","append":"好","offset":1}}"""
            )
        val streamed = projectSnapshot(initial, delta)
        assertEquals(4, streamed["snapshotSequence"]!!.jsonPrimitive.int)
        assertEquals(
            "你好",
            streamed["transcript"]!!.jsonArray[0].jsonObject["content"]!!.jsonPrimitive.content,
        )
        assertEquals(streamed, projectSnapshot(streamed, delta))
        val complete =
            projectSnapshot(
                streamed,
                parse(
                    """{"sequence":5,"type":"message.completed","payload":{"id":"m","status":"complete","content":"最终答案"}}"""
                ),
            )
        assertEquals(5, complete["snapshotSequence"]!!.jsonPrimitive.int)
        assertEquals(complete, projectSnapshot(complete, delta))
        assertEquals(
            complete,
            projectSnapshot(
                complete,
                parse(
                    """{"sequence":4,"type":"message.started","payload":{"id":"m","content":"旧数据"}}"""
                ),
            ),
        )
    }

    @Test
    fun approvalsResolveAndActivitiesAreDeduplicated() {
        val initial =
            parse(
                """{"snapshotSequence":0,"pendingApprovals":[],"responses":[{"id":"r","activities":[]}]}"""
            )
        val pending =
            projectSnapshot(
                initial,
                parse("""{"sequence":1,"type":"approval.requested","payload":{"id":"a"}}"""),
            )
        assertEquals(1, pending["pendingApprovals"]!!.jsonArray.size)
        val resolved =
            projectSnapshot(
                pending,
                parse("""{"sequence":2,"type":"approval.resolved","payload":{"id":"a"}}"""),
            )
        assertEquals(0, resolved["pendingApprovals"]!!.jsonArray.size)
        val activity =
            parse(
                """{"sequence":3,"type":"response.activity","payload":{"responseId":"r","activity":{"id":"tool","status":"running"}}}"""
            )
        val result = projectSnapshot(projectSnapshot(resolved, activity), activity)
        assertEquals(
            1,
            result["responses"]!!.jsonArray[0].jsonObject["activities"]!!.jsonArray.size,
        )
    }
}
