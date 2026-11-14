package io.kodera.android.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import io.kodera.android.R
import io.kodera.android.domain.PasskeyAssertion
import io.kodera.android.domain.PasskeyBackupPolicy
import io.kodera.android.domain.PasskeyChallenge
import io.kodera.android.domain.PasskeyDeviceBinding
import io.kodera.android.domain.PasskeyResidencyPosture
import io.kodera.android.domain.TrustPolicy
import io.kodera.android.domain.VerifiedPasskeyRegistration
import io.kodera.android.ui.theme.CielBadgePill
import io.kodera.android.ui.theme.CielGlassCard
import io.kodera.android.ui.theme.LocalKoderaPalette
import io.kodera.android.ui.theme.NativeTypography
import io.kodera.tokens.KoderaTokens

/**
 * Session-scoped coordinator tracking universal ES256 Passkey device-key binding
 * (`PasskeyBackupPolicy.UNIVERSAL` default, zero AAGUID lock-in).
 */
class PasskeySessionCoordinator {
    private var activeBinding: PasskeyDeviceBinding? = null

    var organisationId by mutableStateOf<String?>(null)
        private set

    var isBound by mutableStateOf(false)
        private set

    var rpId by mutableStateOf<String?>(null)
        private set

    var backupPolicy by mutableStateOf(PasskeyBackupPolicy.UNIVERSAL)
        private set

    var residencyPosture by mutableStateOf<PasskeyResidencyPosture?>(null)
        private set

    var verifiedAssertionCount by mutableIntStateOf(0)
        private set

    @Synchronized
    fun configureOrganisation(incomingOrganisationId: String?) {
        if (incomingOrganisationId != null && !TrustPolicy.canonicalNonNilUUID(incomingOrganisationId)) {
            return
        }
        if (organisationId == incomingOrganisationId) return
        clear()
        organisationId = incomingOrganisationId
    }

    @Synchronized
    fun bindDeviceKey(binding: PasskeyDeviceBinding) {
        organisationId = binding.organisationId
        activeBinding = binding
        isBound = true
        rpId = binding.rpId
        backupPolicy = binding.backupPolicy
        residencyPosture = binding.lastResidencyPosture
        verifiedAssertionCount = binding.verifiedAssertionCount
    }

    @Synchronized
    fun bindVerifiedRegistration(registration: VerifiedPasskeyRegistration) {
        bindDeviceKey(registration.binding)
        residencyPosture = registration.residencyPosture
    }

    @Synchronized
    fun issueChallenge(nowUnixSeconds: Long, lifetimeSeconds: Long = 60L): PasskeyChallenge? {
        val currentOrg = organisationId ?: return null
        val binding = activeBinding ?: return null
        return binding.issueChallenge(currentOrg, nowUnixSeconds, lifetimeSeconds)
    }

    @Synchronized
    fun verifyAssertion(
        challenge: PasskeyChallenge,
        assertion: PasskeyAssertion,
        nowUnixSeconds: Long,
    ): PasskeyResidencyPosture? {
        val currentOrg = organisationId ?: return null
        val binding = activeBinding ?: return null
        val posture = binding.verifyAssertion(currentOrg, challenge, assertion, nowUnixSeconds)
        residencyPosture = posture
        verifiedAssertionCount = binding.verifiedAssertionCount
        return posture
    }

    @Synchronized
    fun clear() {
        activeBinding = null
        isBound = false
        rpId = null
        backupPolicy = PasskeyBackupPolicy.UNIVERSAL
        residencyPosture = null
        verifiedAssertionCount = 0
    }
}

/**
 * Surfaces universal ES256 (`P-256`) WebAuthn / Android `CredentialManager` passkey binding posture:
 * Android Keystore biometrics / Google Password Manager, self-hosted Vaultwarden (`"Citadel"`),
 * and FIDO2 hardware security keys, with zero AAGUID lock-in.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PasskeyDeviceBindingCard(
    coordinator: PasskeySessionCoordinator? = null,
) {
    val palette = LocalKoderaPalette.current
    val bound = coordinator?.isBound == true
    val posture = coordinator?.residencyPosture
    val assertions = coordinator?.verifiedAssertionCount ?: 0

    CielGlassCard {
        Column(
            modifier = Modifier.fillMaxWidth().padding(KoderaTokens.Space.s5),
            verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s3),
        ) {
            Text(
                stringResource(R.string.passkey_title),
                style = NativeTypography.heading,
                modifier = Modifier.semantics { heading() },
            )
            Text(
                stringResource(R.string.passkey_universal_disclosure),
                style = NativeTypography.caption,
                color = palette.ink2,
            )

            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
                verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
            ) {
                CielBadgePill(
                    label = stringResource(R.string.passkey_badge_es256),
                    containerColor = palette.accentSoft,
                    contentColor = palette.accentInk,
                )
                CielBadgePill(
                    label = stringResource(R.string.passkey_badge_biometric),
                    containerColor = palette.t1Bg,
                    contentColor = palette.t1Fg,
                )
                CielBadgePill(
                    label = stringResource(R.string.passkey_badge_vaultwarden),
                    containerColor = palette.t2Bg,
                    contentColor = palette.t2Fg,
                )
                CielBadgePill(
                    label = stringResource(R.string.passkey_badge_fido2),
                    containerColor = palette.t5Bg,
                    contentColor = palette.t5Fg,
                )
            }

            if (bound) {
                val postureLabelRes = when (posture) {
                    PasskeyResidencyPosture.SINGLE_DEVICE_BOUND -> R.string.passkey_posture_hardware
                    PasskeyResidencyPosture.BACKUP_ELIGIBLE_LOCAL -> R.string.passkey_posture_backup_local
                    PasskeyResidencyPosture.MULTI_DEVICE_SYNCED -> R.string.passkey_posture_synced
                    null -> R.string.passkey_posture_bound
                }
                Text(
                    stringResource(postureLabelRes),
                    style = NativeTypography.body,
                    color = palette.okInk,
                )
                coordinator.rpId?.let { rp ->
                    Text(rp, style = NativeTypography.monoCaption, color = palette.accentInk)
                }
                Text(
                    stringResource(R.string.passkey_verified_count, assertions),
                    style = NativeTypography.caption,
                    color = palette.ink3,
                )
            } else {
                Text(
                    stringResource(R.string.passkey_status_unbound),
                    style = NativeTypography.body,
                    color = palette.ink2,
                )
            }
        }
    }
}
