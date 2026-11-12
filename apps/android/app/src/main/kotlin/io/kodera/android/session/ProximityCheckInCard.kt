package io.kodera.android.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import io.kodera.android.R
import io.kodera.android.client.ProximityCheckInSession
import io.kodera.android.client.ProximityCheckInLease
import io.kodera.android.domain.ProximityFailure
import io.kodera.android.domain.ProximityError
import io.kodera.android.domain.ProximitySafetyStatus
import io.kodera.android.ui.theme.LocalKoderaPalette
import io.kodera.android.ui.theme.NativeTypography
import io.kodera.tokens.KoderaTokens

/**
 * The `#proximity` card: an everyday presence check-in, voluntary and pseudonymous. It is not an emergency
 * service and says so. Provisioning is explicit: an ordinary Core session is not proximity mesh membership.
 */
@Composable
internal fun ProximityCheckInCard(session: ProximityCheckInSession?, organisationId: String?) {
    val palette = LocalKoderaPalette.current
    val currentOrganisation by rememberUpdatedState(organisationId)
    val lease = remember(session, organisationId) {
        session?.takeIf { it.organisationId == organisationId }?.let(::ProximityCheckInLease)
    }
    val currentLease by rememberUpdatedState(lease)
    DisposableEffect(lease) { onDispose { lease?.close() } }
    var submitted by remember(lease) { mutableStateOf<ProximitySafetyStatus?>(null) }
    var failure by remember(lease) { mutableStateOf<ProximityError?>(null) }
    Surface(color = palette.surface, shape = RoundedCornerShape(KoderaTokens.Radius.lg)) {
        Column(modifier = Modifier.fillMaxWidth().padding(KoderaTokens.Space.s5),
            verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s4)) {
            Row(verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2)) {
                Icon(painterResource(R.drawable.around_me_antenna), contentDescription = null,
                    modifier = Modifier.size(KoderaTokens.Space.s6), tint = palette.ink)
                Text(stringResource(R.string.proximity_title), style = NativeTypography.heading,
                    modifier = Modifier.semantics { heading() })
            }
            // The safety notice is always shown: this channel never reaches emergency services.
            Text(stringResource(R.string.proximity_notice), style = NativeTypography.caption, color = palette.ink2)
            Text(stringResource(R.string.proximity_scope), style = NativeTypography.body, color = palette.ink2)
            if (lease == null || lease.organisationId != organisationId) {
                Text(stringResource(R.string.proximity_unprovisioned), style = NativeTypography.body, color = palette.ink2)
            } else {
                // The label others see for this device: a pseudonym, never a name. Computed once per lease.
                val shownAs = remember(lease) { try { lease.senderLabel.display } catch (_: ProximityFailure) { null } }
                shownAs?.let {
                    Text(stringResource(R.string.proximity_shown_as, it), style = NativeTypography.caption, color = palette.ink3)
                }
                if (failure != ProximityError.CRYPTO_UNAVAILABLE) for ((status, label) in listOf(
                    ProximitySafetyStatus.SAFE to R.string.proximity_safe,
                    ProximitySafetyStatus.NEED_ASSISTANCE to R.string.proximity_need_assistance,
                    ProximitySafetyStatus.MUSTER_POINT to R.string.proximity_muster_point,
                )) {
                    OutlinedButton(onClick = {
                        try {
                            if (currentLease !== lease) throw ProximityFailure(ProximityError.UNAUTHORIZED)
                            lease.checkIn(currentOrganisation, status); submitted = status; failure = null
                        }
                        catch (error: ProximityFailure) { failure = error.reason }
                    }, modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)) {
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
                    Text(stringResource(it), style = NativeTypography.body, color = palette.ink2,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                }
            }
        }
    }
}
