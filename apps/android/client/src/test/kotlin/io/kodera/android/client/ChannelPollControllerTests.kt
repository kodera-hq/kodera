package io.kodera.android.client

import io.kodera.android.domain.*
import org.junit.Assert.*
import org.junit.Test

class ChannelPollControllerTests {
    private val scope = ChannelPollScope("11111111-1111-4111-8111-111111111111", "text-one")
    private val other = ChannelPollScope("22222222-2222-4222-8222-222222222222", "text-two")
    private fun start(controller: ChannelPollController, multiple: Boolean = false) =
        controller.beginLocalPreview("Choose a time", listOf("Morning", "Afternoon"), multiple)
    private fun refuses(reason: ChannelPollError, action: () -> Unit) {
        try { action(); fail("expected $reason") } catch (error: ChannelPollFailure) { assertEquals(reason, error.reason) }
    }
    @Test fun explicitPreviewOnlyExposesOneLocalVoterAndClosedResultsAreImmutable() {
        val controller = ChannelPollController(scope)
        assertEquals(ChannelPollPhase.UNPROVISIONED, controller.snapshot().phase)
        assertTrue(controller.snapshot().options.isEmpty()); assertNull(controller.previewSnapshot(null))
        val session = ChannelPollSession(controller, start(controller, true))
        session.toggleOption(0); session.toggleOption(1)
        assertEquals(1, session.snapshot()!!.totalVotes)
        session.closePoll()
        val closed = session.snapshot()!!
        refuses(ChannelPollError.CLOSED) { session.toggleOption(0) }
        refuses(ChannelPollError.CLOSED) { session.closePoll() }
        assertSame(closed, session.snapshot())
        session.leave(); assertTrue(controller.snapshot().options.isEmpty())
    }
    @Test fun everyMutationRefusesNilForeignOwnerAndOldScopeContextWithoutEffects() {
        val controller = ChannelPollController(scope)
        val old = start(controller)
        val foreign = start(ChannelPollController(scope))
        controller.switchScope(other)
        val current = start(controller)
        val before = controller.snapshot()
        for (bad in listOf(null, foreign, old)) {
            refuses(ChannelPollError.UNAUTHORISED_UPDATE) { controller.toggleOption(bad, 0) }
            refuses(ChannelPollError.UNAUTHORISED_UPDATE) { controller.closePoll(bad) }
            assertSame(before, controller.snapshot())
        }
        controller.toggleOption(current, 1)
        assertEquals(1, controller.snapshot().totalVotes)
    }
    @Test fun invalidPreviewAndOptionPreserveTheWorkingContextAndState() {
        val controller = ChannelPollController(scope)
        val context = start(controller)
        controller.toggleOption(context, 1)
        val before = controller.snapshot()
        for (options in listOf(emptyList(), listOf("A", "A"), (1..11).map { it.toString() })) {
            refuses(ChannelPollError.INVALID_POLL) { controller.beginLocalPreview("Question", options, false) }
            assertSame(before, controller.previewSnapshot(context))
        }
        refuses(ChannelPollError.INVALID_POLL) { controller.beginLocalPreview(" ", listOf("A", "B"), false) }
        refuses(ChannelPollError.INVALID_OPTION) { controller.toggleOption(context, Int.MAX_VALUE) }
        assertSame(before, controller.snapshot())
        controller.closePoll(context); assertTrue(controller.snapshot().isClosed)
    }
    @Test fun lifecycleResetClearsClosedPollAndFencesSameScopeAndAwayBackCallbacks() {
        for (action in listOf<(ChannelPollController) -> Unit>({ it.leave() }, { it.stop() }, {
            it.switchScope(other); it.switchScope(scope)
        }, { it.switchScope(scope) })) {
            val controller = ChannelPollController(scope)
            val context = start(controller)
            controller.toggleOption(context, 0); controller.closePoll(context)
            action(controller)
            assertTrue(controller.snapshot().options.isEmpty())
            assertEquals(0, controller.snapshot().totalVotes); assertFalse(controller.snapshot().isClosed)
            assertNull(controller.previewSnapshot(context))
            refuses(ChannelPollError.UNAUTHORISED_UPDATE) { controller.toggleOption(context, 0) }
            refuses(ChannelPollError.UNAUTHORISED_UPDATE) { controller.closePoll(context) }
        }
    }
    @Test fun replacementPreviewResetsAndObsoleteCardDisposalCannotClearIt() {
        val controller = ChannelPollController(scope)
        val old = ChannelPollSession(controller, start(controller))
        old.toggleOption(1); old.closePoll()
        val current = ChannelPollSession(controller, start(controller, true))
        old.leave()
        assertNull(old.snapshot()); assertNotNull(current.snapshot())
        assertFalse(current.snapshot()!!.isClosed); assertEquals(0, current.snapshot()!!.totalVotes)
        refuses(ChannelPollError.UNAUTHORISED_UPDATE) { old.closePoll() }
        current.toggleOption(0); assertEquals(1, current.snapshot()!!.totalVotes)
    }
    @Test fun stopCannotBeRevivedAndRepeatedTeardownStaysEmpty() {
        val controller = ChannelPollController(scope)
        start(controller); controller.stop(); controller.leave(); controller.stop()
        assertEquals(ChannelPollPhase.STOPPED, controller.snapshot().phase)
        refuses(ChannelPollError.STOPPED) { start(controller) }
        refuses(ChannelPollError.STOPPED) { controller.switchScope(other) }
        assertTrue(controller.snapshot().options.isEmpty())
    }
    @Test fun observerUpdatesInvalidatesImmediatelyAndUnsubscribeReleasesOldUi() {
        val controller = ChannelPollController(scope)
        val context = start(controller)
        val observed = mutableListOf<ChannelPollState?>()
        val subscription = controller.observe(context) { observed.add(it) }
        controller.toggleOption(context, 0); assertEquals(1, observed.last()!!.totalVotes)
        controller.closePoll(context); assertTrue(observed.last()!!.isClosed)
        controller.switchScope(other); assertNull(observed.last())
        subscription.close(); subscription.close()
        val size = observed.size
        start(controller); controller.leave()
        assertEquals(size, observed.size)
    }
    @Test fun observersAreBoundedAndFailedInitialCallbacksDoNotLeakCapacity() {
        val controller = ChannelPollController(scope)
        val context = start(controller)
        repeat(65) {
            try { controller.observe(context) { error("consumer failed") }; fail("expected callback failure") }
            catch (_: IllegalStateException) { }
        }
        val subscriptions = (1..64).map { controller.observe(context) {} }
        refuses(ChannelPollError.OBSERVER_LIMIT) { controller.observe(context) {} }
        subscriptions.forEach { it.close() }
        controller.observe(context) {}.close()
    }
}
