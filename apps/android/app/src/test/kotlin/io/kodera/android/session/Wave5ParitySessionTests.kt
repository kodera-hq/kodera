package io.kodera.android.session

import io.kodera.android.R
import io.kodera.android.auth.ConnectionPolicy
import io.kodera.android.auth.url
import io.kodera.android.domain.CallAudioRoute
import io.kodera.android.domain.CallEndReason
import io.kodera.android.domain.CallRejectionReason
import io.kodera.android.domain.CallWakeupError
import io.kodera.android.domain.CallWakeupFailure
import io.kodera.android.domain.CommunityAudience
import io.kodera.android.domain.CommunityWorkspaceBlueprint
import io.kodera.android.domain.IncomingCallWakeup
import io.kodera.android.domain.MatrixRoomAlias
import io.kodera.android.domain.MatrixRoomId
import io.kodera.android.domain.MatrixServerName
import io.kodera.android.domain.MatrixUserId
import io.kodera.android.domain.PasskeyAssertion
import io.kodera.android.domain.PasskeyBackupPolicy
import io.kodera.android.domain.PasskeyDeviceBinding
import io.kodera.android.domain.PasskeyResidencyPosture
import io.kodera.android.domain.ProximityBatterySnapshot
import io.kodera.android.domain.ProximityBeaconKeyDerivation
import io.kodera.android.domain.ProximityBeaconV2
import io.kodera.android.domain.ProximityBeaconV2Error
import io.kodera.android.domain.ProximityBeaconV2Failure
import io.kodera.android.domain.ProximityBeaconV2Sender
import io.kodera.android.domain.ProximitySafetyStatus
import io.kodera.android.domain.ProximityTransportLane
import io.kodera.android.domain.PushRelayTransport
import io.kodera.android.domain.TelecomCallPhase
import io.kodera.android.domain.VerifiedCallDescriptor
import io.kodera.android.domain.VerifiedPasskeyRegistration
import io.kodera.android.ui.theme.resolveCielTheme
import io.kodera.tokens.KoderaTokens
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigInteger
import java.nio.ByteBuffer
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

class Wave5ParitySessionTests {
    private val orgA = "11111111-2222-4333-8444-555555555555"
    private val orgB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    private val wakeupUuidOne = "22222222-3333-4444-8555-666666666666"
    private val wakeupUuidTwo = "33333333-4444-4555-8666-777777777777"
    private val wakeupUuidThree = "44444444-5555-4666-8777-888888888888"
    private val roomHashHex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

    // ── 1. Cobalt × Kodera — verre ciel theme parity ───────────────────────

    @Test
    fun cielThemeResolvesLightAndDarkVariants() {
        val lightTheme = resolveCielTheme(darkTheme = false)
        assertEquals(KoderaTokens.Theme.Ciel, lightTheme)
        assertFalse(lightTheme.isDark)
        assertSame(KoderaTokens.ciel, lightTheme.palette)
        assertSame(KoderaTokens.MaterialSet.ciel, lightTheme.materials)

        val darkTheme = resolveCielTheme(darkTheme = true)
        assertEquals(KoderaTokens.Theme.CielNuit, darkTheme)
        assertTrue(darkTheme.isDark)
        assertSame(KoderaTokens.cielNuit, darkTheme.palette)
        assertSame(KoderaTokens.MaterialSet.cielNuit, darkTheme.materials)
    }

    // ── 2. Telecom / ConnectionService & payload-free push wakeup ──────────

    private class RecordingTelecomDriver : TelecomConnectionDriver {
        val events = mutableListOf<String>()

        override fun onIncomingCallRinging(wakeup: IncomingCallWakeup, descriptor: VerifiedCallDescriptor) {
            events += "ringing:${wakeup.connectionId}:video=${descriptor.hasVideo}"
        }

        override fun onCallAnswered(connectionId: String) {
            events += "answered:$connectionId"
        }

        override fun onCallConnected(connectionId: String) {
            events += "connected:$connectionId"
        }

        override fun onCallMutedChanged(connectionId: String, muted: Boolean) {
            events += "muted:$connectionId:$muted"
        }

        override fun onCallHoldChanged(connectionId: String, held: Boolean) {
            events += "held:$connectionId:$held"
        }

        override fun onAudioRouteChanged(connectionId: String, route: CallAudioRoute) {
            events += "route:$connectionId:${route.name}"
        }

        override fun onCallEnded(connectionId: String, reason: CallEndReason) {
            events += "ended:$connectionId:${reason.name}"
        }

        override fun onCallRejected(connectionId: String?, reason: CallRejectionReason) {
            events += "rejected:${connectionId ?: "none"}:${reason.name}"
        }
    }

    @Test
    fun telecomCoordinatorAdmitsPayloadFreePushAndDrivesConnectionServiceLifecycle() {
        val driver = RecordingTelecomDriver()
        val coordinator = TelecomPushCoordinator(
            driver = driver,
            descriptorResolver = { wakeup ->
                VerifiedCallDescriptor.create(
                    wakeupId = wakeup.wakeupId,
                    organisationId = wakeup.organisationId,
                    roomId = "office-hours",
                    liveKitRoomName = wakeup.roomHash,
                    callerLabel = "Camille",
                    hasVideo = false,
                )
            },
        )
        coordinator.configureOrganisation(orgA)
        assertTrue(coordinator.isDriverProvisioned)
        assertEquals(R.string.telecom_phase_idle, telecomPhaseLabelRes(coordinator.phase))

        val opaqueUnifiedPush = """
            {
              "wakeup_id": "$wakeupUuidOne",
              "org_id": "$orgA",
              "room_hash": "$roomHashHex",
              "epoch_ms": 1762992000000,
              "transport": "unifiedpush"
            }
        """.trimIndent().toByteArray(Charsets.UTF_8)

        val wakeup = coordinator.admitPayloadFreePush(
            rawJsonBytes = opaqueUnifiedPush,
            nowEpochMs = 1_762_992_005_000L,
        )
        assertEquals(wakeupUuidOne, wakeup.connectionId)
        assertEquals(PushRelayTransport.UNIFIED_PUSH, coordinator.lastWakeupTransport)
        assertEquals(1, coordinator.admittedWakeupCount)
        assertTrue(coordinator.phase is TelecomCallPhase.Ringing)
        assertEquals(R.string.telecom_phase_ringing, telecomPhaseLabelRes(coordinator.phase))

        coordinator.answerCall()
        assertTrue(coordinator.phase is TelecomCallPhase.Connecting)
        coordinator.markConnected()
        assertTrue(coordinator.phase is TelecomCallPhase.Connected)

        coordinator.setMuted(true)
        assertTrue((coordinator.phase as TelecomCallPhase.Connected).isMuted)

        coordinator.setHeld(true)
        assertTrue(coordinator.phase is TelecomCallPhase.OnHold)
        assertEquals(R.string.telecom_phase_on_hold, telecomPhaseLabelRes(coordinator.phase))

        coordinator.setHeld(false)
        assertTrue(coordinator.phase is TelecomCallPhase.Connected)

        coordinator.toggleSpeakerRoute()
        assertEquals(CallAudioRoute.SPEAKER, (coordinator.phase as TelecomCallPhase.Connected).audioRoute)

        coordinator.endCall(CallEndReason.LOCAL_HANGUP)
        assertTrue(coordinator.phase is TelecomCallPhase.Ended)
        coordinator.resetIdleIfTerminal()
        assertEquals(TelecomCallPhase.Idle, coordinator.phase)

        assertEquals(
            listOf(
                "ringing:$wakeupUuidOne:video=false",
                "answered:$wakeupUuidOne",
                "connected:$wakeupUuidOne",
                "muted:$wakeupUuidOne:true",
                "held:$wakeupUuidOne:true",
                "held:$wakeupUuidOne:false",
                "route:$wakeupUuidOne:SPEAKER",
                "ended:$wakeupUuidOne:LOCAL_HANGUP",
            ),
            driver.events,
        )
    }

    @Test
    fun telecomCoordinatorRejectsCleartextPushAndEndsCallOnOrganisationSwitch() {
        val driver = RecordingTelecomDriver()
        val coordinator = TelecomPushCoordinator(driver = driver)
        coordinator.configureOrganisation(orgA)

        val leakyFcmPayload = """
            {
              "wakeup_id": "$wakeupUuidTwo",
              "org_id": "$orgA",
              "room_hash": "$roomHashHex",
              "epoch_ms": 1762992000000,
              "transport": "fcm",
              "caller_name": "Should Never Traverse Relay"
            }
        """.trimIndent().toByteArray(Charsets.UTF_8)

        val failure = assertThrows(CallWakeupFailure::class.java) {
            coordinator.admitPayloadFreePush(leakyFcmPayload, nowEpochMs = 1_762_992_001_000L)
        }
        assertEquals(CallWakeupError.CLEARTEXT_PAYLOAD_FORBIDDEN, failure.reason)
        assertEquals(1, coordinator.rejectedPushCount)
        assertTrue(coordinator.phase is TelecomCallPhase.Rejected)
        assertTrue(driver.events.contains("rejected:none:CLEARTEXT_PUSH_FORBIDDEN"))

        coordinator.resetIdleIfTerminal()

        val validFcmPayload = """
            {
              "wakeup_id": "$wakeupUuidThree",
              "organisation_id": "$orgA",
              "sync_hint": "$roomHashHex",
              "epoch_ms": 1762992010000,
              "transport": "fcm"
            }
        """.trimIndent().toByteArray(Charsets.UTF_8)

        coordinator.admitPayloadFreePush(validFcmPayload, nowEpochMs = 1_762_992_012_000L)
        assertTrue(coordinator.phase is TelecomCallPhase.WakeupPending)

        // Switching to another organisation immediately terminates the pending call.
        coordinator.configureOrganisation(orgB)
        assertEquals(orgB, coordinator.organisationId)
        assertTrue(driver.events.contains("ended:$wakeupUuidThree:ORGANISATION_CHANGED"))
    }

    // ── 3. #proximity v2 opt-in foreground BLE controller ──────────────────

    private class FakeBleRadio : LocalBleProximityRadio {
        var activeScanWindows = 0
        var stopCount = 0
        val emittedFrames = mutableListOf<Pair<ByteArray, ProximitySafetyStatus>>()

        override fun startForegroundScanWindow(durationSeconds: Long) {
            activeScanWindows += 1
        }

        override fun stopForegroundScanWindow() {
            stopCount += 1
        }

        override fun broadcastBeacon(beacon: ProximityBeaconV2, status: ProximitySafetyStatus) {
            emittedFrames += beacon.bytes() to status
        }
    }

    @Test
    fun proximityV2ControllerEnforcesForegroundConsentBatteryGuardAndLaneSeparation() {
        val radio = FakeBleRadio()
        val controller = ProximityV2CheckInController()
        val rootSeed = ByteArray(32) { (it + 7).toByte() }

        controller.configureOrganisation(orgA)
        controller.provisionFromRootMaterial(
            targetOrganisationId = orgA,
            rootMaterial = rootSeed,
            deviceContext = "pixel-9-local",
            radioAdapter = radio,
        )
        assertTrue(controller.isProvisionedForLocalRadio)
        assertEquals(LocalBleRadioPosture.AwaitingForegroundConsent, controller.localRadioPosture)
        assertEquals(
            R.string.proximity_v2_posture_consent_required,
            proximityPostureLabelRes(controller.localRadioPosture),
        )

        // Online Matrix lane check-in drafts never increment local BLE counters.
        val onlineDraft = controller.recordOnlineMatrixChannelDraft(ProximitySafetyStatus.SAFE)
        assertEquals(ProximityTransportLane.ONLINE_MATRIX_RELAY, onlineDraft.lane)
        assertEquals(1, controller.onlineMatrixDraftCount)
        assertEquals(0, controller.verifiedLocalBroadcastCount)
        assertEquals(0, controller.verifiedPeerCount)

        // Refuses BLE emission before explicit foreground consent is granted.
        controller.onForeground()
        val missingConsent = assertThrows(ProximityBeaconV2Failure::class.java) {
            controller.emitCheckInOverLocalRadio(ProximitySafetyStatus.SAFE, nowUnixSeconds = 1_700_000_100L)
        }
        assertEquals(ProximityBeaconV2Error.FOREGROUND_CONSENT_REQUIRED, missingConsent.reason)

        // Grant explicit foreground consent -> ReadyForLocalRadio.
        controller.setForegroundConsent(true)
        assertEquals(LocalBleRadioPosture.ReadyForLocalRadio, controller.localRadioPosture)

        controller.startScanWindow(nowUnixSeconds = 1_700_000_100L)
        assertTrue(controller.localRadioPosture is LocalBleRadioPosture.ScanningWindowActive)
        assertEquals(1, radio.activeScanWindows)

        val localBeacon = controller.emitCheckInOverLocalRadio(
            status = ProximitySafetyStatus.MUSTER_POINT,
            nowUnixSeconds = 1_700_000_105L,
        )
        assertEquals(ProximityBeaconV2.WIRE_BYTES, localBeacon.bytes().size)
        assertEquals(1, controller.verifiedLocalBroadcastCount)
        assertEquals(localBeacon.pseudonymHex, controller.lastEmittedPseudonymHex)

        // Ingest a distinct peer's valid beacon derived from the same organisation root material.
        ProximityBeaconKeyDerivation.deriveKeys(orgA, rootSeed, "peer-device-two").use { peerKeys ->
            ProximityBeaconV2Sender(orgA, peerKeys.discoveryKeyBytes(), peerKeys.deviceSeedBytes()).use { peerSender ->
                val peerFrame = peerSender.emitAt(1_700_000_110L).bytes()
                val observation = controller.ingestObservedPeerBeacon(peerFrame, nowUnixSeconds = 1_700_000_112L)
                assertEquals(ProximityTransportLane.LOCAL_BLE_RADIO_V2, observation.lane)
                assertEquals(1, controller.verifiedPeerCount)

                // Replaying the exact same peer frame in the same window is rejected.
                val replay = assertThrows(ProximityBeaconV2Failure::class.java) {
                    controller.ingestObservedPeerBeacon(peerFrame, nowUnixSeconds = 1_700_000_113L)
                }
                assertEquals(ProximityBeaconV2Error.REPLAY, replay.reason)
            }
        }

        // Backgrounding immediately stops the foreground BLE scan window.
        controller.onBackground()
        assertEquals(LocalBleRadioPosture.SuspendedInBackground, controller.localRadioPosture)
        assertTrue(radio.stopCount >= 1)

        val backgroundRefusal = assertThrows(ProximityBeaconV2Failure::class.java) {
            controller.emitCheckInOverLocalRadio(ProximitySafetyStatus.SAFE, nowUnixSeconds = 1_700_000_120L)
        }
        assertEquals(ProximityBeaconV2Error.FOREGROUND_CONSENT_REQUIRED, backgroundRefusal.reason)

        // Returning to foreground with battery saver enabled throttles radio activity.
        controller.onForeground()
        controller.updateBattery(ProximityBatterySnapshot(batteryLevelPercent = 85, isPowerSaveMode = true))
        assertEquals(
            R.string.proximity_v2_posture_battery_guard,
            proximityPostureLabelRes(controller.localRadioPosture),
        )
        controller.close()
    }

    // ── 4. 3-category community structure & universal Matrix invitations ───

    @Test
    fun channelInviteCoordinatorCopiesCanonicalLinksAndValidatesDirectInvites() {
        val dispatched = mutableListOf<Triple<String, String, String>>()
        val coordinator = ChannelInviteCoordinator { orgId, roomTarget, recipient ->
            dispatched += Triple(orgId, roomTarget, recipient.rawValue)
        }
        coordinator.configureOrganisation(orgA)

        val server = MatrixServerName.parse(CommunityWorkspaceBlueprint.CANONICAL_DOMAIN)
        val partnerScope = ChannelInviteScope.create(
            organisationId = orgA,
            channelId = "partner-onboarding",
            channelName = "partner-onboarding",
            serverName = server,
            canonicalAlias = MatrixRoomAlias.parse("#partner-onboarding:community.kodera.io"),
            roomId = MatrixRoomId.parse("!partnersRoom99:community.kodera.io"),
        )

        val firstContext = coordinator.openSheet(partnerScope)
        assertTrue(coordinator.isCurrentContext(firstContext))

        val copiedValues = mutableListOf<String>()
        val copiedUri = coordinator.copyInvitation(
            format = ChannelInviteShareFormat.MATRIX_URI,
            context = firstContext,
            copySink = { copiedValues += it },
        )
        assertEquals(
            "matrix:r/partner-onboarding:community.kodera.io?action=join&via=community.kodera.io",
            copiedUri,
        )
        assertEquals(ChannelInviteShareFormat.MATRIX_URI, coordinator.lastCopiedFormat)

        val copiedWeb = coordinator.copyInvitation(
            format = ChannelInviteShareFormat.MATRIX_TO_URL,
            context = firstContext,
            copySink = { copiedValues += it },
        )
        val expectedWeb = url(
            ConnectionPolicy.HTTPS,
            "matrix.to/#/%23partner-onboarding%3Acommunity.kodera.io?via=community.kodera.io",
        )
        assertEquals(expectedWeb, copiedWeb)
        assertEquals(2, copiedValues.size)

        // Invalid recipient is refused without invoking transport.
        val badRecipient = assertThrows(ChannelInviteFailure::class.java) {
            coordinator.sendDirectInvite("not-a-matrix-user", firstContext)
        }
        assertEquals(ChannelInviteError.INVALID_RECIPIENT, badRecipient.reason)
        assertTrue(dispatched.isEmpty())

        // Valid federated Matrix user dispatches cleanly over transport.
        val status = coordinator.sendDirectInvite("@camille:tchap.gouv.fr", firstContext)
        assertEquals(ChannelInviteStatus.Sent(MatrixUserId.parse("@camille:tchap.gouv.fr")), status)
        assertEquals(
            listOf(Triple(orgA, "!partnersRoom99:community.kodera.io", "@camille:tchap.gouv.fr")),
            dispatched,
        )

        // Opening a second sheet invalidates the earlier context fence.
        val secondScope = checkNotNull(
            CommunityCategoryPresentation.makeInviteScope(
                organisationId = orgA,
                channelId = "announcements",
                channelName = "announcements",
            )
        )
        val secondContext = coordinator.openSheet(secondScope)
        assertFalse(coordinator.isCurrentContext(firstContext))
        assertTrue(coordinator.isCurrentContext(secondContext))

        val staleError = assertThrows(ChannelInviteFailure::class.java) {
            coordinator.shareText(ChannelInviteShareFormat.CANONICAL_ALIAS, firstContext)
        }
        assertEquals(ChannelInviteError.STALE_CONTEXT, staleError.reason)

        // Unprovisioned coordinator reports Unprovisioned honestly when no live Matrix invite transport exists.
        val unprovisioned = ChannelInviteCoordinator()
        unprovisioned.configureOrganisation(orgA)
        val unprovContext = unprovisioned.openSheet(secondScope)
        val unprovStatus = unprovisioned.sendDirectInvite("@alex:matrix.org", unprovContext)
        assertEquals(ChannelInviteStatus.Unprovisioned(MatrixUserId.parse("@alex:matrix.org")), unprovStatus)

        // Presentation mapping covers all 3 canonical audiences.
        assertEquals(
            R.string.community_audience_partners,
            CommunityCategoryPresentation.audienceLabelRes(CommunityAudience.FEDERATED_PARTNERS),
        )
    }

    // ── 5. Universal ES256 Passkey session coordinator (zero AAGUID lock-in) ─

    @Test
    fun passkeySessionCoordinatorSupportsVaultwardenBiometricAndHardwareAssertions() {
        val coordinator = PasskeySessionCoordinator()
        coordinator.configureOrganisation(orgA)
        assertFalse(coordinator.isBound)

        val rpId = "kodera.test"
        val webOrigin = url(ConnectionPolicy.HTTPS, "accounts.kodera.test")

        val kpg = KeyPairGenerator.getInstance("EC")
        kpg.initialize(ECGenParameterSpec("secp256r1"))
        val pair = kpg.generateKeyPair()
        val ecPub = pair.public as ECPublicKey
        val uncompressedSec1 = encodeUncompressedSec1(ecPub)
        val keyHandle = byteArrayOf(0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48)

        val binding = PasskeyDeviceBinding.create(
            organisationId = orgA,
            rpId = rpId,
            origin = webOrigin,
            keyHandleId = keyHandle,
            publicSec1Key = uncompressedSec1,
            backupPolicy = PasskeyBackupPolicy.UNIVERSAL,
            aaguidCanonical = VerifiedPasskeyRegistration.ZERO_AAGUID,
        )
        coordinator.bindDeviceKey(binding)
        assertTrue(coordinator.isBound)
        assertEquals(rpId, coordinator.rpId)
        assertEquals(0, coordinator.verifiedAssertionCount)

        // 1) Vaultwarden "Citadel" / synced passkey flags 0x1D (UP|UV|BE|BS) -> MULTI_DEVICE_SYNCED
        val firstChallenge = checkNotNull(coordinator.issueChallenge(nowUnixSeconds = 1_760_000_000L))
        val syncedAssertion = signWebAuthnAssertion(
            rpId = rpId,
            origin = webOrigin,
            challengeB64 = firstChallenge.base64Url,
            keyHandle = keyHandle,
            flags = 0x1D,
            signCount = 1,
            signer = { payload ->
                Signature.getInstance("SHA256withECDSA").run {
                    initSign(pair.private)
                    update(payload)
                    canonicalizeLowSDer(sign())
                }
            },
        )
        val firstPosture = coordinator.verifyAssertion(firstChallenge, syncedAssertion, nowUnixSeconds = 1_760_000_005L)
        assertEquals(PasskeyResidencyPosture.MULTI_DEVICE_SYNCED, firstPosture)
        assertEquals(PasskeyResidencyPosture.MULTI_DEVICE_SYNCED, coordinator.residencyPosture)
        assertEquals(1, coordinator.verifiedAssertionCount)

        // 2) Hardware security key flags 0x05 (UP|UV) -> SINGLE_DEVICE_BOUND
        val secondChallenge = checkNotNull(coordinator.issueChallenge(nowUnixSeconds = 1_760_000_010L))
        val hardwareAssertion = signWebAuthnAssertion(
            rpId = rpId,
            origin = webOrigin,
            challengeB64 = secondChallenge.base64Url,
            keyHandle = keyHandle,
            flags = 0x05,
            signCount = 2,
            signer = { payload ->
                Signature.getInstance("SHA256withECDSA").run {
                    initSign(pair.private)
                    update(payload)
                    canonicalizeLowSDer(sign())
                }
            },
        )
        val secondPosture = coordinator.verifyAssertion(secondChallenge, hardwareAssertion, nowUnixSeconds = 1_760_000_012L)
        assertEquals(PasskeyResidencyPosture.SINGLE_DEVICE_BOUND, secondPosture)
        assertEquals(2, coordinator.verifiedAssertionCount)

        // Switching organisation clears the bound device key state.
        coordinator.configureOrganisation(orgB)
        assertFalse(coordinator.isBound)
        assertNull(coordinator.rpId)
        assertEquals(0, coordinator.verifiedAssertionCount)
    }

    private fun encodeUncompressedSec1(pub: ECPublicKey): ByteArray {
        val x = fixed32(pub.w.affineX)
        val y = fixed32(pub.w.affineY)
        return byteArrayOf(0x04) + x + y
    }

    private fun fixed32(value: BigInteger): ByteArray {
        val raw = value.toByteArray()
        return when {
            raw.size == 32 -> raw
            raw.size == 33 && raw[0] == 0.toByte() -> raw.copyOfRange(1, 33)
            raw.size < 32 -> ByteArray(32 - raw.size) + raw
            else -> error("Unexpected P-256 coordinate length")
        }
    }

    private fun signWebAuthnAssertion(
        rpId: String,
        origin: String,
        challengeB64: String,
        keyHandle: ByteArray,
        flags: Int,
        signCount: Int,
        signer: (ByteArray) -> ByteArray,
    ): PasskeyAssertion {
        val clientDataBytes =
            """{"type":"webauthn.get","challenge":"$challengeB64","origin":"$origin","crossOrigin":false}"""
                .toByteArray(Charsets.UTF_8)
        val rpHash = MessageDigest.getInstance("SHA-256").digest(rpId.toByteArray(Charsets.UTF_8))
        val authData = ByteBuffer.allocate(37)
            .put(rpHash)
            .put(flags.toByte())
            .putInt(signCount)
            .array()
        val clientHash = MessageDigest.getInstance("SHA-256").digest(clientDataBytes)
        val signatureDer = signer(authData + clientHash)
        return PasskeyAssertion(
            keyHandleId = keyHandle,
            clientDataJson = clientDataBytes,
            authenticatorData = authData,
            signatureDer = signatureDer,
        )
    }

    private fun canonicalizeLowSDer(der: ByteArray): ByteArray {
        val order = BigInteger("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16)
        val halfOrder = order.shiftRight(1)
        var offset = 2
        check(der[offset] == 0x02.toByte())
        val rLen = der[offset + 1].toInt() and 0xFF
        val rBytes = der.copyOfRange(offset + 2, offset + 2 + rLen)
        offset += 2 + rLen
        check(der[offset] == 0x02.toByte())
        val sLen = der[offset + 1].toInt() and 0xFF
        val sBytes = der.copyOfRange(offset + 2, offset + 2 + sLen)

        val r = BigInteger(1, rBytes)
        var s = BigInteger(1, sBytes)
        if (s > halfOrder) {
            s = order.subtract(s)
        }
        val rEnc = r.toByteArray()
        val sEnc = s.toByteArray()
        val total = 2 + rEnc.size + 2 + sEnc.size
        return ByteBuffer.allocate(2 + total)
            .put(0x30.toByte())
            .put(total.toByte())
            .put(0x02.toByte())
            .put(rEnc.size.toByte())
            .put(rEnc)
            .put(0x02.toByte())
            .put(sEnc.size.toByte())
            .put(sEnc)
            .array()
    }
}
