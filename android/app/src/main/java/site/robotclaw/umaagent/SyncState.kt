package site.robotclaw.umaagent

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

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

fun eventSubscriptionFrame(sessions: Iterable<Pair<String, Long>>): String = buildJsonObject {
    put("type", "subscribe")
    put("sessions", buildJsonArray {
        sessions.forEach { (id, lastSequence) ->
            add(buildJsonObject {
                put("id", id)
                put("lastSequence", JsonPrimitive(lastSequence.coerceAtLeast(0)))
            })
        }
    })
}.toString()

internal fun invalidatedResources(frame: JsonObject): Set<String> = when (
    frame["type"]?.jsonPrimitive?.contentOrNull
) {
    "resource.invalidated" -> frame["resource"]?.jsonPrimitive?.contentOrNull?.let(::setOf).orEmpty()
    "resource.resync_required" -> (frame["resources"] as? JsonArray)
        ?.mapNotNull { it.jsonPrimitive.contentOrNull }
        ?.toSet()
        .orEmpty()
    else -> emptySet()
}
