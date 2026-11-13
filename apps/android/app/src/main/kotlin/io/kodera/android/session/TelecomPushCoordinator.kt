package io.kodera.android.session

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.kodera.android.domain.CallAudioRoute
import io.kodera.android.domain.CallEndReason
import io.kodera.android.domain.CallPushAdmissionPolicy
import io.kodera.android.domain.CallRejectionReason
import io.kodera.android.domain.CallSessionState
import io.kodera.android.domain.CallWakeupError
import io.kodera.android.domain.CallWakeupFailure
import io.kodera.android.domain.IncomingCallWakeup
import io.kodera.android.domain.PayloadFreePushEnvelope
import io.kodera.android.domain.PushRelayTransport
import io.kodera.android.domain.TelecomCallPhase
import io.kodera.android.domain.VerifiedCallDescriptor

/**
 * Adapter boundary for Android `ConnectionService` / `TelecomManager` system call surfaces.
 * Kept abstract in `:app` so the manifest exports zero unreviewed services while allowing full
 * deterministic verification of system call state transitions.
 */
interface TelecomConnectionDriver {
    fun onIncomingCallRinging(wakeup: IncomingCallWakeup, descriptor: VerifiedCallDescriptor) {}
    fun onCallAnswered(connectionId: String) {}
    fun onCallConnected(connectionId: String) {}
    fun onCallMutedChanged(connectionId: String, muted: Boolean) {}
    fun onCallHoldChanged(connectionId: String, held: Boolean) {}
    fun onAudioRouteChanged(connectionId: String, route: CallAudioRoute) {}
    fun onCallEnded(connectionId: String, reason: CallEndReason) {}
    fun onCallRejected(connectionId: String?, reason: CallRejectionReason) {}
}

/** Resolves encrypted room and caller metadata strictly over an authenticated Core / MatrixRTC session. */
fun interface AuthenticatedCallDescriptorResolver {
    fun resolve(wakeup: IncomingCallWakeup): VerifiedCallDescriptor
}

/**
 * Coordinates payload-free UnifiedPush / FCM wakeup admission and Android `ConnectionService`
 * call controls (`mute`, `hold`, `audioRoute`, `answer`, `decline`, `end`) scoped to the active organisation.
 */
class TelecomPushCoordinator(
    private val driver: TelecomConnectionDriver? = null,
    private val descriptorResolver: AuthenticatedCallDescriptorResolver? = null,
) {
    private val stateMachine = CallSessionState()
    private var stopped = false

    var organisationId by mutableStateOf<String?>(null)
        private set

    var phase by mutableStateOf<TelecomCallPhase>(TelecomCallPhase.Idle)
        private set

    var lastWakeupTransport by mutableStateOf<PushRelayTransport?>(null)
        private set

    var admittedWakeupCount by mutableIntStateOf(0)
        private set

    var rejectedPushCount by mutableIntStateOf(0)
        private set

    val isDriverProvisioned: Boolean get() = driver != null

    @Synchronized
    fun configureOrganisation(incomingOrganisationId: String?) {
        if (stopped) return
        val priorConnectionId = stateMachine.activeConnectionId
        stateMachine.configureOrganisation(incomingOrganisationId)
        organisationId = stateMachine.organisationId
        phase = stateMachine.phase
        if (incomingOrganisationId == null) {
            lastWakeupTransport = null
        }
        if (priorConnectionId != null && phase is TelecomCallPhase.Ended) {
            driver?.onCallEnded(priorConnectionId, CallEndReason.ORGANISATION_CHANGED)
        }
    }

    @Synchronized
    fun admitPayloadFreePush(
        rawJsonBytes: ByteArray,
        policy: CallPushAdmissionPolicy = CallPushAdmissionPolicy.REJECT_CLEARTEXT,
        nowEpochMs: Long? = null,
        resolverOverride: AuthenticatedCallDescriptorResolver? = descriptorResolver,
    ): IncomingCallWakeup {
        ensureActive()
        val parsed = try {
            PayloadFreePushEnvelope.admit(rawJsonBytes, policy)
        } catch (failure: CallWakeupFailure) {
            rejectedPushCount += 1
            val rejection = if (failure.reason == CallWakeupError.CLEARTEXT_PAYLOAD_FORBIDDEN) {
                CallRejectionReason.CLEARTEXT_PUSH_FORBIDDEN
            } else {
                CallRejectionReason.UNTRUSTED_PUSH_PAYLOAD
            }
            stateMachine.recordRejection(rejection)
            phase = stateMachine.phase
            driver?.onCallRejected(null, rejection)
            throw failure
        }

        val wakeup = IncomingCallWakeup(parsed.envelope)
        try {
            stateMachine.admitWakeup(wakeup, nowEpochMs = nowEpochMs)
        } catch (failure: CallWakeupFailure) {
            rejectedPushCount += 1
            phase = stateMachine.phase
            val rejection = (phase as? TelecomCallPhase.Rejected)?.reason ?: CallRejectionReason.UNTRUSTED_PUSH_PAYLOAD
            driver?.onCallRejected(wakeup.connectionId, rejection)
            throw failure
        }

        admittedWakeupCount += 1
        lastWakeupTransport = parsed.envelope.transport
        phase = stateMachine.phase

        if (resolverOverride != null) {
            val descriptor = try {
                resolverOverride.resolve(wakeup)
            } catch (error: Throwable) {
                stateMachine.rejectIncoming(CallRejectionReason.CALL_RESOLUTION_FAILED)
                phase = stateMachine.phase
                driver?.onCallRejected(wakeup.connectionId, CallRejectionReason.CALL_RESOLUTION_FAILED)
                if (error is CallWakeupFailure) throw error
                throw CallWakeupFailure(CallWakeupError.INVALID_CALL_DESCRIPTOR)
            }
            attachVerifiedDescriptor(descriptor)
        }
        return wakeup
    }

    @Synchronized
    fun attachVerifiedDescriptor(descriptor: VerifiedCallDescriptor) {
        ensureActive()
        stateMachine.attachVerifiedDescriptor(descriptor)
        phase = stateMachine.phase
        val ringing = phase as? TelecomCallPhase.Ringing ?: return
        driver?.onIncomingCallRinging(ringing.wakeup, ringing.descriptor)
    }

    @Synchronized
    fun answerCall() {
        ensureActive()
        stateMachine.acceptAnswer()
        phase = stateMachine.phase
        stateMachine.activeConnectionId?.let { driver?.onCallAnswered(it) }
    }

    @Synchronized
    fun declineCall() {
        ensureActive()
        val connectionId = stateMachine.activeConnectionId
        stateMachine.rejectIncoming(CallRejectionReason.USER_DECLINED)
        phase = stateMachine.phase
        driver?.onCallRejected(connectionId, CallRejectionReason.USER_DECLINED)
    }

    @Synchronized
    fun markConnected() {
        ensureActive()
        stateMachine.markConnected()
        phase = stateMachine.phase
        stateMachine.activeConnectionId?.let { driver?.onCallConnected(it) }
    }

    @Synchronized
    fun setMuted(muted: Boolean) {
        ensureActive()
        stateMachine.setMuted(muted)
        phase = stateMachine.phase
        stateMachine.activeConnectionId?.let { driver?.onCallMutedChanged(it, muted) }
    }

    @Synchronized
    fun setHeld(held: Boolean) {
        ensureActive()
        stateMachine.setHeld(held)
        phase = stateMachine.phase
        stateMachine.activeConnectionId?.let { driver?.onCallHoldChanged(it, held) }
    }

    @Synchronized
    fun setAudioRoute(route: CallAudioRoute) {
        ensureActive()
        stateMachine.setAudioRoute(route)
        phase = stateMachine.phase
        stateMachine.activeConnectionId?.let { driver?.onAudioRouteChanged(it, route) }
    }

    @Synchronized
    fun toggleSpeakerRoute() {
        val next = if (stateMachine.audioRoute == CallAudioRoute.SPEAKER) {
            CallAudioRoute.EARPIECE
        } else {
            CallAudioRoute.SPEAKER
        }
        setAudioRoute(next)
    }

    @Synchronized
    fun endCall(reason: CallEndReason = CallEndReason.LOCAL_HANGUP) {
        ensureActive()
        val connectionId = stateMachine.activeConnectionId
        stateMachine.endCall(reason)
        phase = stateMachine.phase
        if (connectionId != null) {
            driver?.onCallEnded(connectionId, reason)
        }
    }

    @Synchronized
    fun resetIdleIfTerminal() {
        if (stopped) return
        when (phase) {
            is TelecomCallPhase.Ended, is TelecomCallPhase.Rejected -> {
                stateMachine.resetToIdle()
                phase = stateMachine.phase
            }
            else -> Unit
        }
    }

    @Synchronized
    fun stop() {
        if (stopped) return
        val connectionId = stateMachine.activeConnectionId
        stateMachine.configureOrganisation(null)
        organisationId = null
        phase = stateMachine.phase
        lastWakeupTransport = null
        stopped = true
        if (connectionId != null) {
            driver?.onCallEnded(connectionId, CallEndReason.ORGANISATION_CHANGED)
        }
    }

    private fun ensureActive() {
        if (stopped) throw CallWakeupFailure(CallWakeupError.STOPPED)
    }
}
