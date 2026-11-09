package io.kodera.android.auth

import io.kodera.android.client.BackendException
import io.kodera.android.client.BackendFailure
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class BrowserStepTests {
    /** The failure [block] ended with, or null when it returned. */
    private fun failure(block: () -> Unit): BackendFailure? =
        try { block(); null } catch (error: BackendException) { error.failure }

    /** Runs [block] on another thread; the returned function waits (bounded) for the failure it ended with. */
    private fun onWorker(block: () -> Unit): () -> BackendFailure? {
        var outcome: BackendFailure? = null
        val done = CountDownLatch(1)
        thread { outcome = failure(block); done.countDown() }
        return {
            check(done.await(5, TimeUnit.SECONDS)) { "the sign-in is still waiting" }
            outcome
        }
    }

    @Test fun testThePresentedClaimTakesTheAnswer() {
        val step = BrowserStep<String>(limitMillis = 5000)
        val claim = checkNotNull(step.claim())
        step.presenting(claim)
        assertTrue(step.deliver("answer"))
        assertEquals("answer", step.await(claim))
        assertFalse("one answer per browser step", step.deliver("again"))
    }

    @Test fun testAResultBeforeTheBrowserOpensIsNotThisSignIns() {
        assertFalse("no sign-in at all", BrowserStep<String>().deliver("stale"))
        val step = BrowserStep<String>(limitMillis = 5000)
        val claim = checkNotNull(step.claim())
        assertFalse("a result left over from an earlier sign-in", step.deliver("stale"))
        step.presenting(claim)
        assertTrue(step.deliver("fresh"))
        assertEquals("fresh", step.await(claim))
    }

    @Test fun testCancelEndsAWaitingSignInAtOnce() {
        val step = BrowserStep<String>(limitMillis = 60_000)
        val claim = checkNotNull(step.claim())
        step.presenting(claim)
        val started = System.nanoTime()
        val outcome = onWorker { step.await(claim) }
        assertTrue(step.cancel())
        assertEquals(BackendFailure.CANCELLED, outcome())
        assertTrue("well before the limit", System.nanoTime() - started < TimeUnit.SECONDS.toNanos(5))
        assertFalse("an answer after the cancel is not taken", step.deliver("late"))
        assertFalse("nothing left to cancel", step.cancel())
    }

    @Test fun testCancelBeforeTheBrowserStopsTheNextStep() {
        val step = BrowserStep<String>(limitMillis = 5000)
        val claim = checkNotNull(step.claim())
        assertNull(failure { step.ensureLive(claim) })
        assertTrue("cancelled during discovery", step.cancel())
        assertEquals(BackendFailure.CANCELLED, failure { step.ensureLive(claim) })
        step.presenting(claim)
        assertFalse("a cancelled claim never takes an answer", step.deliver("answer"))
        assertEquals(BackendFailure.CANCELLED, failure { step.await(claim) })
    }

    @Test fun testTheWaitIsBounded() {
        val step = BrowserStep<String>(limitMillis = 50)
        val claim = checkNotNull(step.claim())
        step.presenting(claim)
        assertEquals(BackendFailure.CANCELLED, failure { step.await(claim) })
        assertTrue(claim.cancelled)
        assertFalse("an answer past the limit is not taken", step.deliver("late"))
        assertEquals("ten minutes, as kodera-ios's browser watchdog", 600_000L, BrowserStep.LIMIT_MILLIS)
    }

    @Test fun testAnAnswerWithoutDataIsACancel() {
        val step = BrowserStep<String>(limitMillis = 5000)
        val claim = checkNotNull(step.claim())
        step.presenting(claim)
        assertTrue(step.deliver(null))
        assertEquals(BackendFailure.CANCELLED, failure { step.await(claim) })
    }

    @Test fun testOneSignInHoldsTheStepUntilItReleasesIt() {
        val step = BrowserStep<String>()
        val first = checkNotNull(step.claim())
        assertNull("one at a time", step.claim())
        step.release(first)
        val second = checkNotNull(step.claim())
        step.release(first)
        assertNull("a stale release leaves the newer claim", step.claim())
        step.release(second)
        assertNotNull(step.claim())
    }

    @Test fun testCloseCancelsTheSignInAndRefusesNewOnes() {
        val step = BrowserStep<String>(limitMillis = 60_000)
        val claim = checkNotNull(step.claim())
        step.presenting(claim)
        val outcome = onWorker { step.await(claim) }
        step.close()
        assertEquals(BackendFailure.CANCELLED, outcome())
        step.release(claim)
        assertNull(step.claim())
    }
}
