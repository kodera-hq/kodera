package io.kodera.android.domain

import org.junit.Assert.*
import org.junit.Test

class VoiceCallStateTests {
    private val scope = VoiceCallScope("11111111-1111-4111-8111-111111111111", "audio-one")
    private fun participant(id: String = "member", scope: VoiceCallScope = this.scope) = VoiceCallParticipant(scope, id, id)
    private fun refuses(reason: VoiceCallError, action: () -> Unit) {
        try { action(); fail("expected $reason") } catch (error: VoiceCallFailure) { assertEquals(reason, error.reason) }
    }
    @Test fun scopeRejectsNoncanonicalOrganisationAndBlankOrUnsafeChannel() {
        for (organisation in listOf("", " 11111111-1111-4111-8111-111111111111", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")) {
            refuses(VoiceCallError.INVALID_SCOPE) { VoiceCallScope(organisation, "audio") }
        }
        for (channel in listOf("", " ", " audio", "audio\n", "a".repeat(257))) {
            refuses(VoiceCallError.INVALID_SCOPE) { VoiceCallScope(scope.organisationId, channel) }
        }
    }
    @Test fun unprovisionedAndStoppedStatesNeverClaimMediaOrParticipants() {
        for (state in listOf(VoiceCallState.unprovisioned(scope), VoiceCallState.stopped(scope))) {
            assertTrue(state.isMuted); assertFalse(state.isDeafened); assertTrue(state.participants.isEmpty())
            assertFalse(state.isMicrophoneCapturing); assertFalse(state.isTransmitting); assertFalse(state.isRemoteAudioPlaying)
            refuses(VoiceCallError.NOT_PREVIEWING) { state.muted(false) }
            refuses(VoiceCallError.NOT_PREVIEWING) { state.deafened(true) }
        }
        refuses(VoiceCallError.STOPPED) { VoiceCallState.stopped(scope).localPreview(listOf(participant())) }
    }
    @Test fun muteDeafenTransitionsAreDeterministicAndAlwaysPreserveInvariant() {
        val initial = VoiceCallState.unprovisioned(scope).localPreview(listOf(participant()))
        var states = listOf(initial)
        // Every sequence of eight mute/deafen actions, not only the happy-path toggle.
        repeat(8) {
            states = states.flatMap { state -> listOf(state.muted(true), state.muted(false), state.deafened(true), state.deafened(false)) }
            states.forEach { state ->
                assertTrue(!state.isDeafened || state.isMuted)
                assertFalse(state.isMicrophoneCapturing); assertFalse(state.isTransmitting); assertFalse(state.isRemoteAudioPlaying)
            }
        }
        val deafened = initial.muted(false).deafened(true)
        assertTrue(deafened.isMuted)
        assertFalse(deafened.muted(false).isDeafened)
        assertTrue(deafened.deafened(false).isMuted)
    }
    @Test fun rosterIsBoundedUniqueScopedSortedAndDefensivelyOwned() {
        val source = mutableListOf(participant("z"), participant("a"))
        val state = VoiceCallState.unprovisioned(scope).localPreview(source)
        source.clear()
        assertEquals(listOf("a", "z"), state.participants.map { it.id })
        try { (state.participants as MutableList).clear(); fail("mutable roster") } catch (_: UnsupportedOperationException) { }
        val full = (1..64).map { participant(it.toString()) }
        assertEquals(64, state.replacingParticipants(full).participants.size)
        refuses(VoiceCallError.INVALID_ROSTER) { state.replacingParticipants(emptyList()) }
        refuses(VoiceCallError.INVALID_ROSTER) { state.replacingParticipants(full + participant("65")) }
        refuses(VoiceCallError.INVALID_ROSTER) { state.replacingParticipants(listOf(participant(), participant())) }
        refuses(VoiceCallError.INVALID_ROSTER) { state.replacingParticipants(listOf(participant(scope = scope.copy(channelId = "other")))) }
        val huge = object : AbstractList<VoiceCallParticipant>() {
            override val size: Int = Int.MAX_VALUE
            override fun get(index: Int): VoiceCallParticipant = error("must bound before traversal")
        }
        refuses(VoiceCallError.INVALID_ROSTER) { state.replacingParticipants(huge) }
    }
    @Test fun participantIndicatorsAndInputBoundsAreValidated() {
        assertTrue(VoiceCallParticipant(scope, "speaker", "Speaker", false, true).isSpeaking)
        refuses(VoiceCallError.INVALID_PARTICIPANT) { VoiceCallParticipant(scope, "speaker", "Speaker", true, true) }
        for (id in listOf("", "bad id", "a".repeat(257))) {
            refuses(VoiceCallError.INVALID_PARTICIPANT) { VoiceCallParticipant(scope, id, "Member") }
        }
        for (name in listOf("", " ", "Member\n", "a".repeat(257))) {
            refuses(VoiceCallError.INVALID_PARTICIPANT) { VoiceCallParticipant(scope, "member", name) }
        }
    }
}
