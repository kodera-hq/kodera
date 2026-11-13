package io.kodera.android.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import io.kodera.android.R
import io.kodera.android.client.VoiceCallDockSession
import io.kodera.android.domain.CallAudioRoute
import io.kodera.android.domain.CallEndReason
import io.kodera.android.domain.CallWakeupFailure
import io.kodera.android.domain.PushRelayTransport
import io.kodera.android.domain.TelecomCallPhase
import io.kodera.android.domain.VoiceCallFailure
import io.kodera.android.ui.theme.CielBadgePill
import io.kodera.android.ui.theme.CielGlassCard
import io.kodera.android.ui.theme.LocalKoderaPalette
import io.kodera.android.ui.theme.NativeTypography
import io.kodera.tokens.KoderaTokens

/**
 * Surfaces Android `ConnectionService` / payload-free UnifiedPush & FCM wakeup controls alongside
 * scoped local channel audio preview preferences.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun VoiceCallDockCard(
    session: VoiceCallDockSession?,
    telecomCoordinator: TelecomPushCoordinator? = null,
) {
    val palette = LocalKoderaPalette.current
    var state by remember(session) { mutableStateOf(session?.snapshot()) }
    DisposableEffect(session) {
        val subscription = session?.observe { state = it }
        onDispose { subscription?.close(); session?.leave() }
    }
    val muted = state?.isMuted ?: true
    val deafened = state?.isDeafened ?: false
    val muteState = stringResource(if (muted) R.string.voice_muted else R.string.voice_unmuted)
    val deafenState = stringResource(if (deafened) R.string.voice_deafened else R.string.voice_not_deafened)
    val muteHint = stringResource(R.string.voice_mute_hint)
    val deafenHint = stringResource(R.string.voice_deafen_hint)

    CielGlassCard {
        Column(
            modifier = Modifier.fillMaxWidth().padding(KoderaTokens.Space.s5),
            verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s4),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    stringResource(R.string.voice_title),
                    style = NativeTypography.heading,
                    modifier = Modifier.semantics { heading() },
                )
                CielBadgePill(
                    label = stringResource(R.string.telecom_push_badge),
                    containerColor = palette.accentSoft,
                    contentColor = palette.accentInk,
                )
            }

            if (telecomCoordinator != null) {
                TelecomConnectionSection(telecomCoordinator)
                HorizontalDivider(color = palette.borderSoft)
            }

            Text(stringResource(R.string.voice_unprovisioned), style = NativeTypography.body, color = palette.ink2)
            Text(
                stringResource(if (state == null) R.string.voice_unavailable else R.string.voice_preview_only),
                style = NativeTypography.caption,
                color = palette.ink2,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
            OutlinedButton(
                enabled = state != null,
                onClick = {
                    try {
                        session?.setMuted(!muted)
                    } catch (_: VoiceCallFailure) {
                        state = session?.snapshot()
                    }
                },
                modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)
                    .semantics { stateDescription = muteState; contentDescription = muteHint },
            ) {
                Text(
                    stringResource(if (muted) R.string.voice_unmute else R.string.voice_mute),
                    style = NativeTypography.emphasis,
                    color = palette.accentInk,
                )
            }
            OutlinedButton(
                enabled = state != null,
                onClick = {
                    try {
                        session?.setDeafened(!deafened)
                    } catch (_: VoiceCallFailure) {
                        state = session?.snapshot()
                    }
                },
                modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)
                    .semantics { stateDescription = deafenState; contentDescription = deafenHint },
            ) {
                Text(
                    stringResource(if (deafened) R.string.voice_undeafen else R.string.voice_deafen),
                    style = NativeTypography.emphasis,
                    color = palette.accentInk,
                )
            }
            state?.let { preview ->
                Text(
                    stringResource(R.string.voice_preview_roster),
                    style = NativeTypography.emphasis,
                    modifier = Modifier.semantics { heading() },
                )
                for (participant in preview.participants) {
                    Column(
                        modifier = Modifier.semantics(mergeDescendants = true) {},
                        verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
                    ) {
                        Text(participant.displayName, style = NativeTypography.body)
                        Text(
                            stringResource(
                                when {
                                    participant.isSpeaking -> R.string.voice_participant_speaking
                                    participant.isMuted -> R.string.voice_participant_muted
                                    else -> R.string.voice_participant_unmuted
                                }
                            ),
                            style = NativeTypography.caption,
                            color = palette.ink2,
                        )
                    }
                }
                OutlinedButton(
                    onClick = { session?.leave() },
                    modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12),
                ) {
                    Text(
                        stringResource(R.string.voice_leave_preview),
                        style = NativeTypography.emphasis,
                        color = palette.accentInk,
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TelecomConnectionSection(coordinator: TelecomPushCoordinator) {
    val palette = LocalKoderaPalette.current
    val currentPhase = coordinator.phase
    Column(verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s3)) {
        Text(
            stringResource(R.string.telecom_section_title),
            style = NativeTypography.emphasis,
            modifier = Modifier.semantics { heading() },
        )
        Text(
            stringResource(R.string.telecom_payload_free_notice),
            style = NativeTypography.caption,
            color = palette.ink2,
        )
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
            verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
        ) {
            CielBadgePill(
                label = stringResource(telecomPhaseLabelRes(currentPhase)),
                containerColor = palette.t1Bg,
                contentColor = palette.t1Fg,
            )
            val relayLabel = when (coordinator.lastWakeupTransport) {
                PushRelayTransport.UNIFIED_PUSH -> R.string.telecom_relay_unifiedpush
                PushRelayTransport.FCM -> R.string.telecom_relay_fcm
                null -> R.string.telecom_relay_standby
            }
            CielBadgePill(
                label = stringResource(relayLabel),
                containerColor = palette.t5Bg,
                contentColor = palette.t5Fg,
            )
        }

        when (currentPhase) {
            is TelecomCallPhase.Ringing -> {
                Text(
                    currentPhase.descriptor.callerLabel,
                    style = NativeTypography.body,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s3),
                ) {
                    OutlinedButton(
                        onClick = { runCatching { coordinator.answerCall() } },
                        modifier = Modifier.weight(1f).heightIn(min = KoderaTokens.Space.s12),
                    ) {
                        Text(stringResource(R.string.telecom_action_answer), style = NativeTypography.emphasis, color = palette.okInk)
                    }
                    OutlinedButton(
                        onClick = { runCatching { coordinator.declineCall() } },
                        modifier = Modifier.weight(1f).heightIn(min = KoderaTokens.Space.s12),
                    ) {
                        Text(stringResource(R.string.telecom_action_decline), style = NativeTypography.emphasis, color = palette.ink)
                    }
                }
            }
            is TelecomCallPhase.Connected, is TelecomCallPhase.OnHold -> {
                val (descriptor, callMuted, route) = if (currentPhase is TelecomCallPhase.Connected) {
                    Triple(currentPhase.descriptor, currentPhase.isMuted, currentPhase.audioRoute)
                } else {
                    val held = currentPhase as TelecomCallPhase.OnHold
                    Triple(held.descriptor, held.isMuted, held.audioRoute)
                }
                val callHeld = currentPhase is TelecomCallPhase.OnHold
                Text(descriptor.callerLabel, style = NativeTypography.body)
                OutlinedButton(
                    onClick = { try { coordinator.setMuted(!callMuted) } catch (_: CallWakeupFailure) {} },
                    modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12),
                ) {
                    Text(
                        stringResource(if (callMuted) R.string.telecom_action_unmute else R.string.telecom_action_mute),
                        style = NativeTypography.emphasis,
                        color = palette.accentInk,
                    )
                }
                OutlinedButton(
                    onClick = { try { coordinator.setHeld(!callHeld) } catch (_: CallWakeupFailure) {} },
                    modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12),
                ) {
                    Text(
                        stringResource(if (callHeld) R.string.telecom_action_resume else R.string.telecom_action_hold),
                        style = NativeTypography.emphasis,
                        color = palette.accentInk,
                    )
                }
                OutlinedButton(
                    onClick = { try { coordinator.toggleSpeakerRoute() } catch (_: CallWakeupFailure) {} },
                    modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12),
                ) {
                    Text(
                        stringResource(
                            if (route == CallAudioRoute.SPEAKER) R.string.telecom_route_earpiece
                            else R.string.telecom_route_speaker
                        ),
                        style = NativeTypography.emphasis,
                        color = palette.accentInk,
                    )
                }
                OutlinedButton(
                    onClick = { try { coordinator.endCall(CallEndReason.LOCAL_HANGUP) } catch (_: CallWakeupFailure) {} },
                    modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12),
                ) {
                    Text(stringResource(R.string.telecom_action_end), style = NativeTypography.emphasis, color = palette.ink)
                }
            }
            else -> {
                Text(
                    stringResource(
                        if (coordinator.isDriverProvisioned) R.string.telecom_driver_ready
                        else R.string.telecom_driver_unprovisioned
                    ),
                    style = NativeTypography.caption,
                    color = palette.ink3,
                )
            }
        }
    }
}

internal fun telecomPhaseLabelRes(phase: TelecomCallPhase): Int = when (phase) {
    TelecomCallPhase.Idle -> R.string.telecom_phase_idle
    is TelecomCallPhase.WakeupPending -> R.string.telecom_phase_wakeup_pending
    is TelecomCallPhase.Ringing -> R.string.telecom_phase_ringing
    is TelecomCallPhase.Connecting -> R.string.telecom_phase_connecting
    is TelecomCallPhase.Connected -> R.string.telecom_phase_connected
    is TelecomCallPhase.OnHold -> R.string.telecom_phase_on_hold
    is TelecomCallPhase.Ended -> R.string.telecom_phase_ended
    is TelecomCallPhase.Rejected -> R.string.telecom_phase_rejected
}
