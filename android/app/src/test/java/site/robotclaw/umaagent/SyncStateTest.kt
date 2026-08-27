package site.robotclaw.umaagent

import kotlinx.serialization.json.Json
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
        val value = CacheEnvelope(1, listOf(Session("s1", "One")), mapOf("s1" to "{}"))
        val json = Json.encodeToString(value)
        assertEquals(value, Json.decodeFromString<CacheEnvelope>(json))
        assertEquals(2, Json.decodeFromString<CacheEnvelope>(json.replace("\"version\":1", "\"version\":2")).version)
    }
}
