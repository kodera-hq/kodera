package io.kodera.android.domain

import java.util.Collections

enum class VoiceCallError { INVALID_SCOPE, INVALID_PARTICIPANT, INVALID_ROSTER, UNAUTHORISED_UPDATE, NOT_PREVIEWING, STOPPED }
class VoiceCallFailure(val reason: VoiceCallError) : Exception(reason.name)

/** Valid identifiers correlate local state; they establish no channel access or media authority. */
data class VoiceCallScope(val organisationId: String, val channelId: String) {
    init {
        if (!TrustPolicy.canonicalNonNilUUID(organisationId) || !TrustPolicy.boundedScopeChannelId(channelId)) {
            throw VoiceCallFailure(VoiceCallError.INVALID_SCOPE)
        }
    }
}

/** A local preview participant, never an assertion that a remote peer is connected or audible. */
data class VoiceCallParticipant(val scope: VoiceCallScope, val id: String, val displayName: String,
    val isMuted: Boolean = true, val isSpeaking: Boolean = false) {
    init {
        if (id.isEmpty() || id.length > 256 || !TrustPolicy.isVisibleASCII(id) ||
            !TrustPolicy.boundedScalarText(displayName, requireTrimmed = false) ||
            (isMuted && isSpeaking)) throw VoiceCallFailure(VoiceCallError.INVALID_PARTICIPANT)
    }
}

enum class VoiceCallPhase { UNPROVISIONED, LOCAL_PREVIEW_ONLY, STOPPED }

/** Immutable deterministic preferences. No phase in this implementation represents live media. */
class VoiceCallState private constructor(val scope: VoiceCallScope, val phase: VoiceCallPhase,
    val isMuted: Boolean, val isDeafened: Boolean, val participants: List<VoiceCallParticipant>) {
    val isMicrophoneCapturing: Boolean get() = false
    val isTransmitting: Boolean get() = false
    val isRemoteAudioPlaying: Boolean get() = false

    fun localPreview(values: List<VoiceCallParticipant>): VoiceCallState {
        if (phase == VoiceCallPhase.STOPPED) throw VoiceCallFailure(VoiceCallError.STOPPED)
        return VoiceCallState(scope, VoiceCallPhase.LOCAL_PREVIEW_ONLY, true, false, roster(scope, values))
    }
    fun replacingParticipants(values: List<VoiceCallParticipant>): VoiceCallState {
        requirePreview()
        return VoiceCallState(scope, phase, isMuted, isDeafened, roster(scope, values))
    }
    fun muted(value: Boolean): VoiceCallState {
        requirePreview()
        return VoiceCallState(scope, phase, value, if (value) isDeafened else false, participants)
    }
    fun deafened(value: Boolean): VoiceCallState {
        requirePreview()
        return VoiceCallState(scope, phase, if (value) true else isMuted, value, participants)
    }
    private fun requirePreview() {
        if (phase != VoiceCallPhase.LOCAL_PREVIEW_ONLY) throw VoiceCallFailure(VoiceCallError.NOT_PREVIEWING)
    }
    companion object {
        const val MAX_PARTICIPANTS = 64
        fun unprovisioned(scope: VoiceCallScope) = VoiceCallState(scope, VoiceCallPhase.UNPROVISIONED, true, false, emptyList())
        fun stopped(scope: VoiceCallScope) = VoiceCallState(scope, VoiceCallPhase.STOPPED, true, false, emptyList())
        private fun roster(scope: VoiceCallScope, values: List<VoiceCallParticipant>): List<VoiceCallParticipant> {
            val count = values.size
            if (count !in 1..MAX_PARTICIPANTS) throw VoiceCallFailure(VoiceCallError.INVALID_ROSTER)
            // Fixed indexed reads bound copying even if a caller's size or iterator changes.
            val owned = try { List(count) { values[it] } } catch (_: IndexOutOfBoundsException) {
                throw VoiceCallFailure(VoiceCallError.INVALID_ROSTER)
            } catch (_: ConcurrentModificationException) {
                throw VoiceCallFailure(VoiceCallError.INVALID_ROSTER)
            }
            if (owned.any { it.scope != scope } || owned.map { it.id }.toSet().size != count) {
                throw VoiceCallFailure(VoiceCallError.INVALID_ROSTER)
            }
            return Collections.unmodifiableList(owned.sortedBy { it.id })
        }
    }
}
