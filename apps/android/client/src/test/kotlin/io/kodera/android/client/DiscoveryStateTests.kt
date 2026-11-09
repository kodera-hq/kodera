package io.kodera.android.client

import org.junit.Assert.*
import org.junit.Test

class DiscoveryStateTests {
    @Test fun testBeginPublishesLoadingForOpaqueCurrentTicket() {
        val state = DiscoveryState(); assertEquals(AnonymousDiscoveryState.Editing, state.value)
        state.begin(); assertEquals(AnonymousDiscoveryState.Loading, state.value)
    }
    @Test fun testNewerTicketFencesOlderAndDuplicateResult() {
        val state = DiscoveryState(); val old = state.begin(); val current = state.begin()
        state.receive(AnonymousDiscoveryOutcome.Result(AnonymousDiscoveryResult.NoMatch), old); assertEquals(AnonymousDiscoveryState.Loading, state.value)
        state.receive(AnonymousDiscoveryOutcome.Result(AnonymousDiscoveryResult.NoMatch), current); assertEquals(AnonymousDiscoveryState.NoMatch, state.value)
        state.receive(AnonymousDiscoveryOutcome.Failure(DiscoveryFailure.ProtocolViolation), current); assertEquals(AnonymousDiscoveryState.NoMatch, state.value)
    }
    @Test fun testLifecycleResetFencesAllPriorCallbacks() {
        val state = DiscoveryState(); val old = state.begin(); state.reset(); val current = state.begin()
        state.receive(AnonymousDiscoveryOutcome.Result(AnonymousDiscoveryResult.NoMatch), old); assertEquals(AnonymousDiscoveryState.Loading, state.value)
        state.receive(AnonymousDiscoveryOutcome.Cancelled, current); assertEquals(AnonymousDiscoveryState.Cancelled, state.value)
    }
    @Test fun testCancelAndResetNeverBecomeNoMatch() {
        val state = DiscoveryState(); val ticket = state.begin(); state.cancel()
        state.receive(AnonymousDiscoveryOutcome.Result(AnonymousDiscoveryResult.NoMatch), ticket); assertEquals(AnonymousDiscoveryState.Cancelled, state.value)
        state.reset(); assertEquals(AnonymousDiscoveryState.Editing, state.value)
    }
    @Test fun testMultipleChoicesRequireExplicitCurrentSelection() {
        val choices = (DiscoveryEnvelope.decode(Fixtures.data("many"), Fixtures.configuration()) as AnonymousDiscoveryResult.Multiple).choices
        val mutable = choices.toMutableList()
        val state = DiscoveryState(); val ticket = state.begin(); state.receive(AnonymousDiscoveryOutcome.Result(AnonymousDiscoveryResult.Multiple(mutable)), ticket)
        assertTrue(state.value is AnonymousDiscoveryState.Choosing)
        mutable.clear(); assertEquals(2, (state.value as AnonymousDiscoveryState.Choosing).choices.size)
        Fixtures.refused { state.select("ffffffff-ffff-4fff-8fff-ffffffffffff") }
        state.select(choices[1].organisationId); assertEquals(AnonymousDiscoveryState.Selected(choices[1]), state.value)
        Fixtures.refused { state.select(choices[0].organisationId) }
    }
    @Test fun testSingleAndZeroRemainAnonymousMetadata() {
        val state = DiscoveryState(); val metadata = Fixtures.selected(); state.receive(AnonymousDiscoveryOutcome.Result(AnonymousDiscoveryResult.Single(metadata)), state.begin())
        assertEquals(AnonymousDiscoveryState.Selected(metadata), state.value)
        state.receive(AnonymousDiscoveryOutcome.Result(AnonymousDiscoveryResult.NoMatch), state.begin()); assertEquals(AnonymousDiscoveryState.NoMatch, state.value)
    }
}
