package site.robotclaw.umaagent

/** Pure sequence decisions used by the WebSocket consumer and easy to verify off-device. */
data class SequenceDecision(val accept: Boolean, val gap: Boolean, val next: Long)

object SequenceTracker {
    fun inspect(previous: Long, incoming: Long): SequenceDecision = when {
        incoming <= 0L || incoming <= previous -> SequenceDecision(accept = false, gap = false, next = previous)
        incoming > previous + 1L -> SequenceDecision(accept = true, gap = true, next = incoming)
        else -> SequenceDecision(accept = true, gap = false, next = incoming)
    }

    fun merge(previous: Long, fetchedSequences: Iterable<Long>, nextCursor: Long? = null): Long =
        maxOf(previous, fetchedSequences.filter { it > previous }.maxOrNull() ?: previous, nextCursor ?: previous)
}
