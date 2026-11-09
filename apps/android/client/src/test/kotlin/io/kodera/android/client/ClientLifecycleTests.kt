package io.kodera.android.client

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class ClientLifecycleTests {
    @Test fun testCancelClosesActualExchangeAndPublishesOnce() {
        val hold = CountDownLatch(1)
        val callbacks = CallbackExecutor()
        WireFixture(reply = { WireReply(hold = hold) }).use { wire -> wire.client(callbacks = callbacks.executor).use { client ->
            try { val result = OutcomeProbe(); val operation = client.discover("atelier", result::receive); wire.awaitRequests()
                val exactPeer = wire.requests.single()
                operation.cancel(); assertEquals(AnonymousDiscoveryOutcome.Cancelled, result.await())
                wire.awaitPeerClosed(exactPeer); assertEquals("Reply gate remains withheld during peer-close proof", 1L, hold.count)
                operation.cancel(); callbacks.drain()
                assertEquals("A second cancel publishes nothing", listOf(AnonymousDiscoveryOutcome.Cancelled), result.values.toList())
            } finally { hold.countDown() }
        } }
    }
    @Test fun testReplacementWaitsForOldTerminalBeforeStartingLatestCall() {
        // Calibration proves an open held old exchange cannot hide a second TLS request.
        val calibrationHold = CountDownLatch(1)
        WireFixture(reply = { if (it.body.toString(Charsets.UTF_8).contains("alpha")) WireReply(hold = calibrationHold) else WireReply() }).use { calibration ->
            try { calibration.openCalibrationRequest("alpha").use { first ->
                calibration.awaitRequests(); val oldPeer = calibration.requests.single()
                calibration.openCalibrationRequest("bravo").use {
                    calibration.awaitRequests(2)
                    assertFalse("Deliberately live calibration peer must not be reported closed", calibration.hasObservedPeerClose(oldPeer))
                    assertEquals(1L, calibrationHold.count)
                    first.close(); calibration.awaitPeerClosed(oldPeer)
                }
            } } finally { calibrationHold.countDown() }
        }
        val hold = CountDownLatch(1)
        WireFixture(reply = { if (it.body.toString(Charsets.UTF_8).contains("alpha")) WireReply(hold = hold) else WireReply() }).use { wire -> wire.client().use { client ->
            try { val old = OutcomeProbe(); client.discover("alpha", old::receive); wire.awaitRequests()
                val oldPeer = wire.requests.single()
                val current = OutcomeProbe(); client.discover("bravo", current::receive)
                assertEquals(AnonymousDiscoveryOutcome.Cancelled, old.await())
                wire.awaitPeerClosed(oldPeer); wire.awaitRequests(2)
                assertEquals("Both observations occur before first reply is released", 1L, hold.count)
                assertEquals(AnonymousDiscoveryOutcome.Result(AnonymousDiscoveryResult.NoMatch), current.await())
                assertEquals(listOf("alpha", "bravo"), wire.requests.map { com.google.gson.JsonParser.parseString(it.body.toString(Charsets.UTF_8)).asJsonObject["slug"].asString })
                // Independent worker timestamps cannot establish a network-wide total order.
                // The local Call-terminal-before-replacement invariant also needs source review.
            } finally { hold.countDown() }
        } }
    }
    @Test fun testCloseCancelsOwnedWorkAndClosedClientRefuses() {
        val hold = CountDownLatch(1)
        WireFixture(reply = { WireReply(hold = hold) }).use { wire -> wire.client().use { client ->
            try { val result = OutcomeProbe(); client.discover("atelier", result::receive); wire.awaitRequests(); client.close()
                assertEquals(AnonymousDiscoveryOutcome.Cancelled, result.await())
                val refused = OutcomeProbe(); client.discover("atelier", refused::receive); assertEquals(AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.NotConfigured), refused.await()); assertEquals(1, wire.requests.size)
            } finally { hold.countDown() }
        } }
    }
    @Test fun testLateBytesAndDuplicateCompletionCannotResurrectOldGeneration() {
        val hold = CountDownLatch(1)
        val callbacks = CallbackExecutor()
        WireFixture(reply = { WireReply(body = Fixtures.data(), hold = hold) }).use { wire -> wire.client(callbacks = callbacks.executor).use { client ->
            try {
                val result = OutcomeProbe()
                val operation = client.discover("atelier", result::receive)
                wire.awaitRequests()
                val exactPeer = wire.requests.single()
                operation.cancel()
                assertEquals("Cancel before any reply byte must publish Cancelled first", AnonymousDiscoveryOutcome.Cancelled, result.await())
                wire.awaitPeerClosed(exactPeer)
                // The reply bytes are released only now, after cancel; the drain proves every callback has returned.
                hold.countDown()
                callbacks.drain()
                assertEquals("No late or duplicate outcome after cancel", listOf(AnonymousDiscoveryOutcome.Cancelled), result.values.toList())
                val state = DiscoveryState(); val old = state.begin(); state.cancel()
                state.receive(AnonymousDiscoveryOutcome.Result(AnonymousDiscoveryResult.Single(Fixtures.selected())), old)
                assertEquals("A late outcome cannot resurrect a cancelled discovery state", AnonymousDiscoveryState.Cancelled, state.value)
            } finally { hold.countDown() }
        } }
    }
    @Test fun testCancelBetweenDecodedReplyAndPublicationPublishesOnlyCancelled() {
        // Forces the window the test above cannot reach: the whole reply is read and decoded on the callback
        // thread, and cancel() returns before that outcome is published.
        val decoded = CountDownLatch(1)
        val publish = CountDownLatch(1)
        val callbacks = CallbackExecutor()
        WireFixture(reply = { WireReply(body = Fixtures.data()) }).use { wire ->
            wire.client(callbacks = callbacks.executor, beforePublish = {
                decoded.countDown(); publish.await(Fixtures.COLD_START_MILLIS, TimeUnit.MILLISECONDS)
            }).use { client ->
                try {
                    val result = OutcomeProbe()
                    val operation = client.discover("atelier", result::receive)
                    assertTrue("The reply must be decoded on the callback thread", decoded.await(Fixtures.COLD_START_MILLIS, TimeUnit.MILLISECONDS))
                    assertEquals("Nothing is published while the decoded reply is held", emptyList<AnonymousDiscoveryOutcome>(), result.values.toList())
                    operation.cancel()
                    publish.countDown()
                    assertEquals("A cancel that returns before publication must win over the decoded reply",
                        AnonymousDiscoveryOutcome.Cancelled, result.await())
                    callbacks.drain()
                    assertEquals("Exactly one outcome once the callback has returned", listOf(AnonymousDiscoveryOutcome.Cancelled), result.values.toList())
                } finally { publish.countDown() }
            }
        }
    }
    @Test fun testCancellingOldOperationCannotCancelCurrentCall() {
        val hold = CountDownLatch(1)
        WireFixture(reply = { if (it.body.toString(Charsets.UTF_8).contains("alpha")) WireReply(hold = hold) else WireReply() }).use { wire -> wire.client().use { client ->
            try { val old = OutcomeProbe(); val operation = client.discover("alpha", old::receive); wire.awaitRequests(); operation.cancel(); assertEquals(AnonymousDiscoveryOutcome.Cancelled, old.await())
                hold.countDown(); val current = OutcomeProbe(); client.discover("bravo", current::receive); operation.cancel(); wire.awaitRequests(2)
                assertEquals(AnonymousDiscoveryOutcome.Result(AnonymousDiscoveryResult.NoMatch), current.await())
            } finally { hold.countDown() }
        } }
    }
}
