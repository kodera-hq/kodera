package io.kodera.android.proximity

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import io.kodera.android.R
import io.kodera.android.ui.theme.CielBadgePill
import io.kodera.android.ui.theme.CielGlassCard
import io.kodera.android.ui.theme.LocalKoderaPalette
import io.kodera.android.ui.theme.NativeTypography
import io.kodera.tokens.KoderaTokens

internal object ProximityVoluntaryPresentation {
    fun durationLabelRes(duration: ProximitySessionDuration): Int = when (duration) {
        ProximitySessionDuration.MINUTES_15 -> R.string.proximity_voluntary_duration_15m
        ProximitySessionDuration.MINUTES_30 -> R.string.proximity_voluntary_duration_30m
        ProximitySessionDuration.HOUR_1 -> R.string.proximity_voluntary_duration_1h
        ProximitySessionDuration.HOURS_2 -> R.string.proximity_voluntary_duration_2h
    }

    fun distanceBandLabelRes(band: ProximityDistanceBand): Int = when (band) {
        ProximityDistanceBand.IMMEDIATE -> R.string.proximity_voluntary_band_immediate
        ProximityDistanceBand.NEAR -> R.string.proximity_voluntary_band_near
        ProximityDistanceBand.AMBIENT -> R.string.proximity_voluntary_band_ambient
    }
}

/**
 * Wave 9 voluntary `#proximity` check-in and nearby radar Jetpack Compose screen consuming
 * `CielGlassCard`, `CielBadgePill`, `LocalKoderaPalette`, `NativeTypography`, and `KoderaTokens`.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ProximityVoluntaryCheckInScreen(
    controller: VoluntaryProximitySessionController,
    onOpenEphemeralThread: ((DiscoveredProximityPeer) -> Unit)? = null,
    onStartDirectCall: ((DiscoveredProximityPeer) -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val palette = LocalKoderaPalette.current

    CielGlassCard(modifier = modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(KoderaTokens.Space.s5),
            verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s4),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
                ) {
                    Icon(
                        painterResource(R.drawable.around_me_antenna),
                        contentDescription = null,
                        modifier = Modifier.size(KoderaTokens.Space.s6),
                        tint = palette.ink,
                    )
                    Text(
                        text = stringResource(R.string.proximity_voluntary_title),
                        style = NativeTypography.heading,
                        modifier = Modifier.semantics { heading() },
                    )
                }
                CielBadgePill(
                    label = stringResource(
                        if (controller.isSessionActive) {
                            R.string.proximity_voluntary_active_badge
                        } else {
                            R.string.proximity_voluntary_inactive_badge
                        },
                    ),
                    containerColor = if (controller.isSessionActive) palette.okSoft else palette.muted,
                    contentColor = if (controller.isSessionActive) palette.okInk else palette.ink2,
                )
            }

            Text(
                text = stringResource(R.string.proximity_voluntary_pledge),
                style = NativeTypography.caption,
                color = palette.ink2,
            )

            if (controller.missingRuntimePermissions.isNotEmpty()) {
                Text(
                    text = stringResource(R.string.proximity_voluntary_permissions_missing),
                    style = NativeTypography.caption,
                    color = palette.warnInk,
                )
            }

            Column(verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2)) {
                Text(
                    text = stringResource(R.string.proximity_voluntary_duration_label),
                    style = NativeTypography.caption,
                    color = palette.ink3,
                )
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
                    verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
                ) {
                    for (preset in ProximitySessionDuration.entries) {
                        val selected = controller.selectedDuration == preset
                        OutlinedButton(
                            onClick = { controller.selectedDuration = preset },
                            enabled = !controller.isSessionActive,
                            colors = ButtonDefaults.outlinedButtonColors(
                                containerColor = if (selected) palette.action else palette.muted,
                                contentColor = if (selected) palette.onInverse else palette.accentInk,
                            ),
                        ) {
                            Text(
                                text = stringResource(ProximityVoluntaryPresentation.durationLabelRes(preset)),
                                style = NativeTypography.caption,
                            )
                        }
                    }
                }
            }

            OutlinedTextField(
                value = controller.statusNote,
                onValueChange = { next ->
                    if (next.length <= ProximityRadioConstants.MAX_STATUS_NOTE_LENGTH) {
                        controller.statusNote = next
                    }
                },
                enabled = !controller.isSessionActive,
                singleLine = true,
                label = { Text(stringResource(R.string.proximity_voluntary_note_label)) },
                placeholder = { Text(stringResource(R.string.proximity_voluntary_note_placeholder)) },
                modifier = Modifier.fillMaxWidth(),
            )

            when {
                controller.isSessionActive -> {
                    OutlinedButton(
                        onClick = { controller.leaveProximity() },
                        modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12),
                        colors = ButtonDefaults.outlinedButtonColors(
                            containerColor = palette.badSoft,
                            contentColor = palette.badInk,
                        ),
                    ) {
                        Text(
                            text = stringResource(R.string.proximity_voluntary_leave),
                            style = NativeTypography.emphasis,
                        )
                    }
                }
                !controller.hasForegroundConsent -> {
                    OutlinedButton(
                        onClick = { runCatching { controller.grantForegroundConsent() } },
                        enabled = controller.isForegroundActive && controller.organisationId != null,
                        modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12),
                    ) {
                        Text(
                            text = stringResource(R.string.proximity_voluntary_consent_grant),
                            style = NativeTypography.emphasis,
                            color = palette.accentInk,
                        )
                    }
                }
                else -> {
                    OutlinedButton(
                        onClick = { runCatching { controller.startVoluntarySession() } },
                        enabled = controller.isForegroundActive,
                        modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12),
                    ) {
                        Text(
                            text = stringResource(R.string.proximity_voluntary_start),
                            style = NativeTypography.emphasis,
                            color = palette.accentInk,
                        )
                    }
                }
            }

            HorizontalDivider(color = palette.borderSoft)

            Text(
                text = stringResource(R.string.proximity_voluntary_peers_heading),
                style = NativeTypography.emphasis,
                modifier = Modifier.semantics { heading() },
            )

            if (controller.peers.isEmpty()) {
                Text(
                    text = stringResource(R.string.proximity_voluntary_peers_empty),
                    style = NativeTypography.caption,
                    color = palette.ink3,
                )
            } else {
                for (peer in controller.peers) {
                    PeerRadarCard(
                        peer = peer,
                        onOpenEphemeralThread = onOpenEphemeralThread,
                        onStartDirectCall = onStartDirectCall,
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PeerRadarCard(
    peer: DiscoveredProximityPeer,
    onOpenEphemeralThread: ((DiscoveredProximityPeer) -> Unit)?,
    onStartDirectCall: ((DiscoveredProximityPeer) -> Unit)?,
) {
    val palette = LocalKoderaPalette.current

    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = KoderaTokens.Space.s2),
        verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
    ) {
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
            verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s1),
        ) {
            Text(text = peer.handle, style = NativeTypography.monoBody, color = palette.ink)
            CielBadgePill(
                label = stringResource(ProximityVoluntaryPresentation.distanceBandLabelRes(peer.distanceBand)),
                containerColor = palette.accentSoft,
                contentColor = palette.accentInk,
            )
            if (peer.viaMdnsLan) {
                CielBadgePill(
                    label = stringResource(R.string.proximity_voluntary_lan_badge),
                    containerColor = palette.t1Bg,
                    contentColor = palette.t1Fg,
                )
            }
        }

        if (peer.statusNote.isNotEmpty()) {
            Text(text = peer.statusNote, style = NativeTypography.body, color = palette.ink2)
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
        ) {
            OutlinedButton(
                onClick = { onOpenEphemeralThread?.invoke(peer) },
                modifier = Modifier.weight(1f).heightIn(min = KoderaTokens.Space.s10),
            ) {
                Text(
                    text = stringResource(R.string.proximity_voluntary_open_thread),
                    style = NativeTypography.caption,
                    color = palette.accentInk,
                )
            }
            OutlinedButton(
                onClick = { onStartDirectCall?.invoke(peer) },
                modifier = Modifier.weight(1f).heightIn(min = KoderaTokens.Space.s10),
            ) {
                Text(
                    text = stringResource(R.string.proximity_voluntary_start_call),
                    style = NativeTypography.caption,
                    color = palette.accentInk,
                )
            }
        }
    }
}
