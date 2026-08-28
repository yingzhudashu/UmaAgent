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
        val snapshot = """{"transcript":[{"id":"m1","role":"user","status":"complete","content":"看图","attachments":[{"id":"a1"}]},{"id":"m2","role":"assistant","status":"streaming","content":"处理中"}]}"""
        assertEquals(
            listOf(
                UiMessage("m1", "user", "complete", "看图", 1),
                UiMessage("m2", "assistant", "streaming", "处理中", 0),
            ),
            parseSnapshotMessages(snapshot),
        )
        assertTrue(parseSnapshotMessages("not-json").isEmpty())
    }
}
