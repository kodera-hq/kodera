package io.kodera.android.client

import io.kodera.android.domain.*
import org.junit.Assert.*
import org.junit.Test

class VoiceCallControllerTests {
    private val scope = VoiceCallScope("11111111-1111-4111-8111-111111111111", "audio-one")
    private val other = VoiceCallScope("22222222-2222-4222-8222-222222222222", "audio-one")
    private fun participants(scope: VoiceCallScope = this.scope) = listOf(VoiceCallParticipant(scope, "member", "Member"))
    private fun refuses(reason: VoiceCallError, action: () -> Unit) {
        try { action(); fail("expected $reason") } catch (error: VoiceCallFailure) { assertEquals(reason, error.reason) }
    }
    private fun assertCleared(controller: VoiceCallController, phase: VoiceCallPhase = VoiceCallPhase.UNPROVISIONED) {
        val state = controller.snapshot()
        assertEquals(phase, state.phase); assertTrue(state.participants.isEmpty())
        assertTrue(state.isMuted); assertFalse(state.isDeafened)
        assertFalse(state.isMicrophoneCapturing); assertFalse(state.isTransmitting); assertFalse(state.isRemoteAudioPlaying)
    }
    @Test fun explicitLocalPreviewAllowsAudioPreferencesWithoutInventingMedia() {
        val controller = VoiceCallController(scope)
        assertCleared(controller)
        val context = controller.beginLocalPreview(participants())
        val session = VoiceCallDockSession(controller, context)
        assertEquals(VoiceCallPhase.LOCAL_PREVIEW_ONLY, session.snapshot()!!.phase)
        session.setMuted(false); assertFalse(session.snapshot()!!.isMuted)
        session.setDeafened(true); assertTrue(session.snapshot()!!.isMuted); assertTrue(session.snapshot()!!.isDeafened)
        session.setMuted(false); assertFalse(session.snapshot()!!.isDeafened)
        assertFalse(session.snapshot()!!.isTransmitting)
        assertFalse(session.snapshot()!!.isRemoteAudioPlaying)
    }
    @Test fun unauthenticatedForeignOwnerAndCrossScopeUpdatesAreTransactional() {
        val controller = VoiceCallController(scope)
        val context = controller.beginLocalPreview(participants())
        val before = controller.snapshot()
        val foreign = VoiceCallController(scope).beginLocalPreview(participants())
        for (bad in listOf(null, foreign)) {
            refuses(VoiceCallError.UNAUTHORISED_UPDATE) { controller.replaceParticipants(bad, participants()) }
            refuses(VoiceCallError.UNAUTHORISED_UPDATE) { controller.setMuted(bad, false) }
            refuses(VoiceCallError.UNAUTHORISED_UPDATE) { controller.setDeafened(bad, true) }
            assertSame(before, controller.snapshot())
        }
        refuses(VoiceCallError.INVALID_ROSTER) { controller.replaceParticipants(context, participants(other)) }
        assertSame(before, controller.snapshot())
    }
    @Test fun invalidPreviewOrRosterNeverReplacesContextOrState() {
        val controller = VoiceCallController(scope)
        val context = controller.beginLocalPreview(participants())
        val before = controller.snapshot()
        for (invalid in listOf(emptyList(), participants(other), participants() + participants())) {
            refuses(VoiceCallError.INVALID_ROSTER) { controller.beginLocalPreview(invalid) }
            assertSame(before, controller.previewSnapshot(context))
            refuses(VoiceCallError.INVALID_ROSTER) { controller.replaceParticipants(context, invalid) }
            assertSame(before, controller.snapshot())
        }
    }
    @Test fun leaveStopAndSwitchFenceDelayedCallbacksIncludingReturnToSameScope() {
        for (action in listOf<(VoiceCallController) -> Unit>({ it.leave() }, { it.stop() }, {
            it.switchScope(other); it.switchScope(scope)
        }, { it.switchScope(scope) })) {
            val controller = VoiceCallController(scope)
            val context = controller.beginLocalPreview(participants())
            controller.setDeafened(context, true)
            action(controller)
            assertCleared(controller, controller.snapshot().phase)
            assertNull(controller.previewSnapshot(context))
            refuses(VoiceCallError.UNAUTHORISED_UPDATE) { controller.replaceParticipants(context, participants()) }
            refuses(VoiceCallError.UNAUTHORISED_UPDATE) { controller.setMuted(context, false) }
            assertTrue(controller.snapshot().participants.isEmpty())
        }
    }
    @Test fun replacementPreviewInvalidatesOldHandleAndOldDisposalCannotClearNewPreview() {
        val controller = VoiceCallController(scope)
        val old = VoiceCallDockSession(controller, controller.beginLocalPreview(participants()))
        val current = VoiceCallDockSession(controller, controller.beginLocalPreview(participants()))
        old.leave()
        assertNull(old.snapshot()); assertNotNull(current.snapshot())
        refuses(VoiceCallError.UNAUTHORISED_UPDATE) { old.setDeafened(true) }
        current.leave(); assertCleared(controller)
    }
    @Test fun stopIsTerminalAndRepeatedClearsStayEmpty() {
        val controller = VoiceCallController(scope)
        controller.beginLocalPreview(participants()); controller.stop(); controller.leave(); controller.stop()
        assertCleared(controller, VoiceCallPhase.STOPPED)
        refuses(VoiceCallError.STOPPED) { controller.beginLocalPreview(participants()) }
        refuses(VoiceCallError.STOPPED) { controller.switchScope(other) }
        assertCleared(controller, VoiceCallPhase.STOPPED)
    }
    @Test fun observersClearUiImmediatelyAndClosedObserversCannotPublishAgain() {
        val controller = VoiceCallController(scope)
        val context = controller.beginLocalPreview(participants())
        val observed = mutableListOf<VoiceCallState?>()
        val subscription = controller.observe(context) { observed.add(it) }
        assertNotNull(observed.last())
        controller.setDeafened(context, true); assertTrue(observed.last()!!.isDeafened)
        controller.switchScope(other); assertNull(observed.last())
        subscription.close()
        val count = observed.size
        controller.switchScope(scope); controller.beginLocalPreview(participants())
        assertEquals(count, observed.size)
    }
    @Test fun rosterIndicatorsAreSortedAndSnapshotIsOwned() {
        val controller = VoiceCallController(scope)
        val context = controller.beginLocalPreview(participants())
        val source = mutableListOf(VoiceCallParticipant(scope, "z", "Muted"), VoiceCallParticipant(scope, "a", "Speaker", false, true))
        controller.replaceParticipants(context, source); source.clear()
        val state = controller.snapshot()
        assertEquals(listOf("a", "z"), state.participants.map { it.id })
        assertTrue(state.participants.first().isSpeaking); assertTrue(state.participants.last().isMuted)
    }
}
