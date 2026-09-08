package site.robotclaw.umaagent

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RequestResultTest {
    @Test
    fun cancelledAccountRequestCannotRunSuccessOrFailureCallbacks() = runBlocking {
        val started = CompletableDeferred<Unit>()
        var callbackRan = false
        val job = launch {
            runRequestCatching {
                started.complete(Unit)
                CompletableDeferred<Unit>().await()
            }.onSuccess { callbackRan = true }.onFailure { callbackRan = true }
        }
        started.await()
        job.cancelAndJoin()
        assertFalse(callbackRan)
    }

    @Test
    fun ordinaryFailureIsReturnedButCancellationIsRethrown() = runBlocking {
        assertTrue(runRequestCatching { throw IllegalStateException("offline") }.isFailure)
        var cancelled = false
        try {
            runRequestCatching { throw CancellationException("account switched") }
        } catch (_: CancellationException) {
            cancelled = true
        }
        assertTrue(cancelled)
    }
}
