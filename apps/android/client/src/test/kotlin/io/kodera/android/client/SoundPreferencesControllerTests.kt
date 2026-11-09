package io.kodera.android.client

import io.kodera.android.domain.*
import org.junit.Assert.*
import org.junit.Test

class SoundPreferencesControllerTests {
    private val scope = SoundPreferencesScope("11111111-1111-4111-8111-111111111111")
    private val other = SoundPreferencesScope("22222222-2222-4222-8222-222222222222")
    private fun refuses(reason: SoundPreferencesError, action: () -> Unit) {
        try { action(); fail("expected $reason") } catch (error: SoundPreferencesFailure) { assertEquals(reason, error.reason) }
    }
    private fun assertDefaults(controller: SoundPreferencesController) {
        val state = controller.snapshot()
        assertEquals(SoundPackId.GIVRE, state.activePack); assertEquals(80, state.volumePercent)
        assertFalse(state.isMuted); assertFalse(state.isManuallyMuted); assertFalse(state.isCallDuckingActive)
        assertEquals(0, state.activeDuckingDecibels); assertEquals(80, state.effectiveGainPercent)
        assertFalse(state.isAudioHardwareActive)
    }
    private fun allMutations(controller: SoundPreferencesController, context: SoundPreferencesContext?) = listOf<() -> Unit>(
        { controller.selectPack(context, SoundPackId.SILENT) }, { controller.setVolumePercent(context, 0) },
        { controller.setMuted(context, true) }, { controller.setCallDucking(context, true) },
    )
    @Test fun defaultIsUnprovisionedAndOnlyExplicitPreviewAllowsPreferenceMutations() {
        val controller = SoundPreferencesController(scope)
        assertDefaults(controller); assertEquals(SoundPreferencesPhase.UNPROVISIONED, controller.snapshot().phase)
        assertNull(controller.previewSnapshot(null))
        val session = SoundPreferencesSession(controller, controller.beginLocalPreview())
        session.selectPack(SoundPackId.ARCADE_8BIT); session.setCallDucking(true)
        assertEquals(40, session.snapshot()!!.effectiveGainPercent)
        session.setVolumePercent(0); assertTrue(session.snapshot()!!.isMuted)
        session.selectPack(SoundPackId.ATELIER); assertEquals(80, session.snapshot()!!.volumePercent)
        session.setMuted(true); assertEquals(0, session.snapshot()!!.effectiveGainPercent)
        assertFalse(session.snapshot()!!.isAudioHardwareActive)
    }
    @Test fun nilForeignOwnerAndForeignOrganisationContextsCannotMutateState() {
        val controller = SoundPreferencesController(scope)
        controller.beginLocalPreview()
        val before = controller.snapshot()
        val sameOrgForeign = SoundPreferencesController(scope).beginLocalPreview()
        val otherOrgForeign = SoundPreferencesController(other).beginLocalPreview()
        for (bad in listOf(null, sameOrgForeign, otherOrgForeign)) for (action in allMutations(controller, bad)) {
            refuses(SoundPreferencesError.UNAUTHORISED_UPDATE, action)
            assertSame(before, controller.snapshot())
        }
    }
    @Test fun invalidVolumeIsTransactionalAndRetainsTheWorkingContext() {
        val controller = SoundPreferencesController(scope)
        val context = controller.beginLocalPreview()
        controller.selectPack(context, SoundPackId.GLITCH_404)
        val before = controller.snapshot()
        for (value in listOf(Int.MIN_VALUE, -1, 101, Int.MAX_VALUE)) {
            refuses(SoundPreferencesError.INVALID_VOLUME) { controller.setVolumePercent(context, value) }
            assertSame(before, controller.previewSnapshot(context))
        }
        controller.setVolumePercent(context, 45)
        assertEquals(45, controller.snapshot().volumePercent)
    }
    @Test fun leaveStopSameScopeAndAwayBackFenceAllOldMutationsAndResetDefaults() {
        for (action in listOf<(SoundPreferencesController) -> Unit>({ it.leave() }, { it.stop() }, {
            it.switchScope(other); it.switchScope(scope)
        }, { it.switchScope(scope) })) {
            val controller = SoundPreferencesController(scope)
            val context = controller.beginLocalPreview()
            controller.selectPack(context, SoundPackId.SILENT); controller.setCallDucking(context, true)
            action(controller)
            assertDefaults(controller); assertNull(controller.previewSnapshot(context))
            for (mutation in allMutations(controller, context)) {
                refuses(SoundPreferencesError.UNAUTHORISED_UPDATE, mutation)
                assertDefaults(controller)
            }
        }
    }
    @Test fun obsoleteUiDisposalCannotClearReplacementPreviewOrFollowItsLifetime() {
        val controller = SoundPreferencesController(scope)
        val old = SoundPreferencesSession(controller, controller.beginLocalPreview())
        old.selectPack(SoundPackId.CRISTAL)
        val current = SoundPreferencesSession(controller, controller.beginLocalPreview())
        assertDefaults(controller)
        old.leave(); assertNull(old.snapshot()); assertNotNull(current.snapshot())
        refuses(SoundPreferencesError.UNAUTHORISED_UPDATE) { old.setMuted(true) }
        current.selectPack(SoundPackId.ATELIER); current.leave()
        assertNull(current.snapshot()); assertDefaults(controller)
    }
    @Test fun terminalStopCannotBeRevivedByLeaveSwitchOrPreview() {
        val controller = SoundPreferencesController(scope)
        controller.beginLocalPreview(); controller.stop(); controller.leave(); controller.stop()
        assertDefaults(controller); assertEquals(SoundPreferencesPhase.STOPPED, controller.snapshot().phase)
        refuses(SoundPreferencesError.STOPPED) { controller.beginLocalPreview() }
        refuses(SoundPreferencesError.STOPPED) { controller.switchScope(other) }
        assertDefaults(controller)
    }
    @Test fun observersReceiveInvalidationImmediatelyAndDisposedCallbacksDoNotReturn() {
        val controller = SoundPreferencesController(scope)
        val context = controller.beginLocalPreview()
        val observed = mutableListOf<SoundPreferencesState?>()
        val subscription = controller.observe(context) { observed.add(it) }
        assertNotNull(observed.last())
        controller.setCallDucking(context, true); assertEquals(40, observed.last()!!.effectiveGainPercent)
        controller.switchScope(other); assertNull(observed.last())
        val count = observed.size
        for (action in allMutations(controller, context)) refuses(SoundPreferencesError.UNAUTHORISED_UPDATE, action)
        assertEquals(count, observed.size)
        subscription.close(); subscription.close()
        controller.switchScope(scope); controller.beginLocalPreview()
        assertEquals(count, observed.size)
    }
    @Test fun observerBoundAndInitialCallbackFailureReleaseCapacity() {
        val controller = SoundPreferencesController(scope)
        val context = controller.beginLocalPreview()
        repeat(65) {
            try { controller.observe(context) { error("consumer failed") }; fail("expected callback failure") }
            catch (_: IllegalStateException) { }
        }
        val subscriptions = (1..64).map { controller.observe(context) {} }
        refuses(SoundPreferencesError.OBSERVER_LIMIT) { controller.observe(context) {} }
        subscriptions.forEach { it.close() }
        controller.observe(context) {}.close()
    }
}
