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
import io.kodera.android.client.EmergencyCheckInSession
import io.kodera.android.client.EmergencyCheckInLease
import io.kodera.android.domain.EmergencyFailure
import io.kodera.android.domain.EmergencyError
import io.kodera.android.domain.EmergencySafetyStatus
import io.kodera.android.ui.theme.LocalKoderaPalette
import io.kodera.android.ui.theme.NativeTypography
import io.kodera.tokens.KoderaTokens

/** Provisioning is explicit: an ordinary Core session is not emergency mesh membership. */
@Composable
internal fun EmergencyCheckInCard(session: EmergencyCheckInSession?, organisationId: String?) {
    val palette = LocalKoderaPalette.current
    val currentOrganisation by rememberUpdatedState(organisationId)
    val lease = remember(session, organisationId) {
        session?.takeIf { it.organisationId == organisationId }?.let(::EmergencyCheckInLease)
    }
    val currentLease by rememberUpdatedState(lease)
    DisposableEffect(lease) { onDispose { lease?.close() } }
    var submitted by remember(lease) { mutableStateOf<EmergencySafetyStatus?>(null) }
    var failure by remember(lease) { mutableStateOf<EmergencyError?>(null) }
    Surface(color = palette.surface, shape = RoundedCornerShape(KoderaTokens.Radius.lg)) {
        Column(modifier = Modifier.fillMaxWidth().padding(KoderaTokens.Space.s5),
            verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s4)) {
            Row(verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2)) {
                Icon(painterResource(R.drawable.around_me_antenna), contentDescription = null,
                    modifier = Modifier.size(KoderaTokens.Space.s6), tint = palette.ink)
                Text(stringResource(R.string.emergency_title), style = NativeTypography.heading,
                    modifier = Modifier.semantics { heading() })
            }
            Text(stringResource(R.string.emergency_scope), style = NativeTypography.body, color = palette.ink2)
            if (lease == null || lease.organisationId != organisationId) {
                Text(stringResource(R.string.emergency_unprovisioned), style = NativeTypography.body, color = palette.ink2)
            } else {
                if (failure != EmergencyError.CRYPTO_UNAVAILABLE) for ((status, label) in listOf(
                    EmergencySafetyStatus.SAFE to R.string.emergency_safe,
                    EmergencySafetyStatus.NEED_ASSISTANCE to R.string.emergency_need_assistance,
                    EmergencySafetyStatus.MUSTER_POINT to R.string.emergency_muster_point,
                )) {
                    OutlinedButton(onClick = {
                        try {
                            if (currentLease !== lease) throw EmergencyFailure(EmergencyError.UNAUTHORIZED)
                            lease.checkIn(currentOrganisation, status); submitted = status; failure = null
                        }
                        catch (error: EmergencyFailure) { failure = error.reason }
                    }, modifier = Modifier.fillMaxWidth().heightIn(min = KoderaTokens.Space.s12)) {
                        Text(stringResource(label), style = NativeTypography.emphasis, color = palette.accentInk)
                    }
                }
                val announcement = when {
                    failure == EmergencyError.CRYPTO_UNAVAILABLE -> R.string.emergency_crypto_unavailable
                    failure != null -> R.string.emergency_failed
                    submitted != null -> R.string.emergency_queued
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
