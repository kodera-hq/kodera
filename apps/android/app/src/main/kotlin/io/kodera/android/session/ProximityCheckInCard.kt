package io.kodera.android.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import io.kodera.android.R
import io.kodera.android.client.ProximityCheckInLease
import io.kodera.android.client.ProximityCheckInSession
import io.kodera.android.domain.ProximityBeaconV2Error
import io.kodera.android.domain.ProximityBeaconV2Failure
import io.kodera.android.domain.ProximityError
import io.kodera.android.domain.ProximityFailure
import io.kodera.android.domain.ProximitySafetyStatus
import io.kodera.android.ui.theme.CielBadgePill
import io.kodera.android.ui.theme.CielGlassCard
import io.kodera.android.ui.theme.LocalKoderaPalette
import io.kodera.android.ui.theme.NativeTypography
import io.kodera.tokens.KoderaTokens

/**
 * The `#proximity` card: voluntary, pseudonymous check-in with explicit separation between
 * online Matrix channel relays and opt-in foreground BLE v2 radio discovery (`KP\x02`).
 * Never an emergency service, and always states so.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ProximityCheckInCard(
    session: ProximityCheckInSession?,
    organisationId: String?,
    v2Controller: ProximityV2CheckInController? = null,
) {
    val palette = LocalKoderaPalette.current
    val currentOrganisation by rememberUpdatedState(organisationId)
    val lease = remember(session, organisationId) {
        session?.takeIf { it.organisationId == organisationId }?.let(::ProximityCheckInLease)
    }
    val currentLease by rememberUpdatedState(lease)
    DisposableEffect(lease) { onDispose { lease?.close() } }
    var submitted by remember(lease) { mutableStateOf<ProximitySafetyStatus?>(null) }
    var failure by remember(lease) { mutableStateOf<ProximityError?>(null) }

    CielGlassCard {
        Column(
            modifier = Modifier.fillMaxWidth().padding(KoderaTokens.Space.s5),
            verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s4),
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
                    stringResource(R.string.proximity_title),
                    style = NativeTypography.heading,
                    modifier = Modifier.semantics { heading() },
                )
            }
            // The safety notice is always shown: this channel never reaches emergency services.
            Text(stringResource(R.string.proximity_notice), style = NativeTypography.caption, color = palette.ink2)
            Text(stringResource(R.string.proximity_scope), style = NativeTypography.body, color = palette.ink2)

            if (v2Controller != null && v2Controller.organisationId == organisationId && organisationId != null) {
                HorizontalDivider(color = palette.borderSoft)
                ProximityV2RadioSection(v2Controller)
                HorizontalDivider(color = palette.borderSoft)
            }

            if (lease == null || lease.organisationId != organisationId) {
                Text(stringResource(R.string.proximity_unprovisioned), style = NativeTypography.body, color = palette.ink2)
            } else {
                val shownAs = remember(lease) { try { lease.senderLabel.display } catch (_: ProximityFailure) { null } }
                shownAs?.let {
                    Text(stringResource(R.string.proximity_shown_as, it), style = NativeTypography.caption, color = palette.ink3)
                }
                if (failure != ProximityError.CRYPTO_UNAVAILABLE) for ((status, label) in listOf(
                    ProximitySafetyStatus.SAFE to R.string.proximity_safe,
                    ProximitySafetyStatus.NEED_ASSISTANCE to R.string.proximity_need_assistance,
                    ProximitySafetyStatus.MUSTER_POINT to R.string.proximity_muster_point,
                )) {
                    OutlinedButton(
                        onClick = {
                            try {
                                if (currentLease !== lease) throw ProximityFailure(ProximityError.UNAUTHORIZED)
                                lease.checkIn(currentOrganisation, status)
                                submitted = status
                                failure = null
                            } catch (error: ProximityFailure) {
                                failure = error.reason
                            }
                        },
                        modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12),
                    ) {
                        Text(stringResource(label), style = NativeTypography.emphasis, color = palette.accentInk)
                    }
                }
                val announcement = when {
                    failure == ProximityError.CRYPTO_UNAVAILABLE -> R.string.proximity_crypto_unavailable
                    failure != null -> R.string.proximity_failed
                    submitted != null -> R.string.proximity_queued
                    else -> null
                }
                announcement?.let {
                    Text(
                        stringResource(it),
                        style = NativeTypography.body,
                        color = palette.ink2,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ProximityV2RadioSection(controller: ProximityV2CheckInController) {
    val palette = LocalKoderaPalette.current
    val consentGranted = controller.hasForegroundConsent
    val consentStateText = stringResource(
        if (consentGranted) R.string.proximity_v2_consent_enabled else R.string.proximity_v2_consent_disabled
    )

    Column(verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s3)) {
        Text(
            stringResource(R.string.proximity_v2_lane_heading),
            style = NativeTypography.emphasis,
            modifier = Modifier.semantics { heading() },
        )
        Text(
            stringResource(R.string.proximity_v2_lane_separation),
            style = NativeTypography.caption,
            color = palette.ink2,
        )
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
            verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
        ) {
            CielBadgePill(
                label = stringResource(R.string.proximity_v2_online_lane_badge),
                containerColor = palette.t1Bg,
                contentColor = palette.t1Fg,
            )
            CielBadgePill(
                label = stringResource(R.string.proximity_v2_ble_lane_badge),
                containerColor = palette.t2Bg,
                contentColor = palette.t2Fg,
            )
            CielBadgePill(
                label = stringResource(
                    R.string.proximity_v2_duty_budget_badge,
                    controller.budget.activeDutyCyclePermille / 10,
                    controller.budget.minBatteryPercent,
                ),
                containerColor = palette.t5Bg,
                contentColor = palette.t5Fg,
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth()
                .semantics(mergeDescendants = true) { stateDescription = consentStateText },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(
                modifier = Modifier.weight(1f).padding(end = KoderaTokens.Space.s3),
                verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s1),
            ) {
                Text(stringResource(R.string.proximity_v2_consent_label), style = NativeTypography.body)
                Text(
                    stringResource(R.string.proximity_v2_consent_hint),
                    style = NativeTypography.caption,
                    color = palette.ink3,
                )
            }
            Switch(
                checked = consentGranted,
                onCheckedChange = { next ->
                    try {
                        controller.setForegroundConsent(next)
                    } catch (_: ProximityBeaconV2Failure) {
                    }
                },
            )
        }

        val postureRes = proximityPostureLabelRes(controller.localRadioPosture)
        Text(
            stringResource(postureRes),
            style = NativeTypography.caption,
            color = palette.ink2,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )

        controller.lastEmittedPseudonymHex?.let { pseudonym ->
            Text(
                stringResource(R.string.proximity_v2_rotating_pseudonym, pseudonym),
                style = NativeTypography.monoCaption,
                color = palette.accentInk,
            )
        }
        if (controller.verifiedPeerCount > 0 || controller.verifiedLocalBroadcastCount > 0) {
            Text(
                stringResource(
                    R.string.proximity_v2_radio_counters,
                    controller.verifiedLocalBroadcastCount,
                    controller.verifiedPeerCount,
                ),
                style = NativeTypography.caption,
                color = palette.ink3,
            )
        }
    }
}

internal fun proximityPostureLabelRes(posture: LocalBleRadioPosture): Int = when (posture) {
    LocalBleRadioPosture.Unprovisioned -> R.string.proximity_v2_posture_unprovisioned
    LocalBleRadioPosture.AwaitingForegroundConsent -> R.string.proximity_v2_posture_consent_required
    LocalBleRadioPosture.SuspendedInBackground -> R.string.proximity_v2_posture_suspended
    LocalBleRadioPosture.ReadyForLocalRadio -> R.string.proximity_v2_posture_ready
    is LocalBleRadioPosture.ScanningWindowActive -> R.string.proximity_v2_posture_scanning
    is LocalBleRadioPosture.Throttled -> when (posture.reason) {
        ProximityBeaconV2Error.BATTERY_BUDGET_EXCEEDED -> R.string.proximity_v2_posture_battery_guard
        else -> R.string.proximity_v2_posture_duty_throttled
    }
}
