package io.kodera.android.session

import android.content.Intent
import io.kodera.android.R
import io.kodera.android.auth.AppAuthBackend
import io.kodera.android.auth.AuthorizationPresenter
import io.kodera.android.auth.BrowserAuthorization
import io.kodera.android.auth.ConnectionPolicy
import io.kodera.android.auth.SessionStorage
import io.kodera.android.auth.url
import io.kodera.android.client.AttachmentUploadPayload
import io.kodera.android.client.AuthorizationBackend
import io.kodera.android.client.BootstrappedMatrixRoom
import io.kodera.android.client.ChannelConversationTransport
import io.kodera.android.client.FreshToken
import io.kodera.android.client.InMemoryTokenStore
import io.kodera.android.client.KoderaSignInService
import io.kodera.android.client.MatrixClientError
import io.kodera.android.client.MatrixClientException
import io.kodera.android.client.MatrixDeliveryStatus
import io.kodera.android.client.MatrixRawTimelineEvent
import io.kodera.android.client.MatrixRoomSyncDelta
import io.kodera.android.client.MatrixSyncBatch
import io.kodera.android.client.MeOutcome
import io.kodera.android.client.MemberOrganisation
import io.kodera.android.client.MemberProfile
import io.kodera.android.client.RustSessionVault
import io.kodera.android.client.SessionKeys
import io.kodera.android.client.SignInConfiguration
import io.kodera.android.client.StoredGrant
import io.kodera.android.client.WorkspaceCategory
import io.kodera.android.client.WorkspaceChannel
import io.kodera.android.client.WorkspaceChannelLifecycle
import io.kodera.android.client.WorkspaceFailure
import io.kodera.android.client.WorkspaceOutcome
import io.kodera.android.client.WorkspaceSetup
import io.kodera.android.client.WorkspaceSetupState
import io.kodera.android.client.WorkspaceSnapshot
import io.kodera.android.client.WorkspaceState
import io.kodera.android.domain.AdmittedIssuer
import io.kodera.android.domain.AttachmentMetadataRef
import io.kodera.android.domain.AttachmentMimeType
import io.kodera.android.domain.ChannelKind
import io.kodera.android.domain.ChannelRoomState
import io.kodera.android.domain.LoopbackPolicy
import io.kodera.android.entry.Deployment
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
import io.kodera.android.ui.theme.resolveActiveTheme
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
import java.nio.file.Files
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

class Wave5ParitySessionTests {
    private val orgA = "11111111-2222-4333-8444-555555555555"
    private val orgB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    private val wakeupUuidOne = "22222222-3333-4444-8555-666666666666"
    private val wakeupUuidTwo = "33333333-4444-4555-8666-777777777777"
    private val wakeupUuidThree = "44444444-5555-4666-8777-888888888888"
    private val roomHashHex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

    // ── 1. Cobalt × Kodera — verre ciel theme parity ───────────────────────

    @Test
    fun activeThemeResolvesDarkPrecisionAndLightGivre() {
        assertTrue(KoderaTokens.Theme.Dark.isDefault)
        assertFalse(KoderaTokens.Theme.Ciel.isDefault)

        val lightTheme = resolveActiveTheme(darkTheme = false)
        assertEquals(KoderaTokens.Theme.Light, lightTheme)
        assertFalse(lightTheme.isDark)
        assertSame(KoderaTokens.light, lightTheme.palette)

        val darkTheme = resolveActiveTheme(darkTheme = true)
        assertEquals(KoderaTokens.Theme.Dark, darkTheme)
        assertTrue(darkTheme.isDark)
        assertSame(KoderaTokens.dark, darkTheme.palette)
    }

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

    // ── 6. Interactive channel conversation scope & controller ──────────────

    @Test
    fun channelConversationAdmitsActiveTextAndAudioCompanionChatAndControllerSendsRetriesReactsAndClears() {
        val activeText = WorkspaceChannel(
            id = "22222222-2222-4222-8222-222222222222",
            kind = ChannelKind.TEXT,
            name = "general",
            templateKey = "general",
            topic = "Discussions",
            lifecycle = WorkspaceChannelLifecycle.ACTIVE,
            roomState = ChannelRoomState.READY,
            isConfidential = false,
        )
        val activeAudio = WorkspaceChannel(
            id = "33333333-3333-4333-8333-333333333333",
            kind = ChannelKind.AUDIO,
            name = "standup",
            templateKey = null,
            topic = "Audio room",
            lifecycle = WorkspaceChannelLifecycle.ACTIVE,
            roomState = ChannelRoomState.READY,
            isConfidential = false,
        )
        val archived = WorkspaceChannel(
            id = "44444444-4444-4444-8444-444444444444",
            kind = ChannelKind.TEXT,
            name = "legacy",
            templateKey = null,
            topic = "",
            lifecycle = WorkspaceChannelLifecycle.ARCHIVED,
            roomState = ChannelRoomState.READY,
            isConfidential = false,
        )

        val textScope = checkNotNull(ChannelConversationScope.fromChannel(orgA, activeText))
        val audioScope = checkNotNull(ChannelConversationScope.fromChannel(orgA, activeAudio))
        assertEquals(ChannelKind.TEXT, textScope.kind)
        assertEquals(ChannelKind.AUDIO, audioScope.kind)
        assertNull(ChannelConversationScope.fromChannel(orgA, archived))

        var failNextSend = false
        var eventSeq = 0
        val fakeTransport = object : ChannelConversationTransport {
            override val ownUserId: String = "@alice:atelier.matrix.kodera.io"

            override fun bootstrapRoom(organisationId: String, channelId: String): BootstrappedMatrixRoom {
                val roomId = "!general:atelier.matrix.kodera.io"
                return BootstrappedMatrixRoom(
                    roomId = roomId,
                    initialBatch = MatrixSyncBatch(
                        nextBatch = "s1",
                        plaintextAllowedRooms = setOf(roomId),
                        roomEvents = mapOf(
                            roomId to listOf(
                                MatrixRawTimelineEvent(
                                    type = "m.room.message",
                                    eventId = "\$welcome",
                                    sender = "@bob:atelier.matrix.kodera.io",
                                    originServerTs = 1_700_000_000_000L,
                                    msgtype = "m.text",
                                    body = "Bienvenue sur Kodera",
                                )
                            )
                        ),
                    ),
                )
            }

            override fun syncRoom(roomId: String, since: String?): MatrixSyncBatch =
                MatrixSyncBatch("s2", emptyMap(), plaintextAllowedRooms = setOf(roomId))

            override fun sendMessage(
                roomId: String,
                transactionId: String,
                body: String,
                replyToEventId: String?,
                attachments: List<AttachmentMetadataRef>,
            ): String {
                if (failNextSend) throw MatrixClientException(MatrixClientError.SERVICE_UNAVAILABLE)
                eventSeq += 1
                return "\$sent_$eventSeq"
            }

            override fun editMessage(roomId: String, transactionId: String, targetEventId: String, newBody: String): String {
                eventSeq += 1
                return "\$edit_$eventSeq"
            }

            override fun redactEvent(roomId: String, transactionId: String, targetEventId: String): String {
                eventSeq += 1
                return "\$redact_$eventSeq"
            }

            override fun sendReaction(roomId: String, transactionId: String, targetEventId: String, emojiKey: String): String {
                eventSeq += 1
                return "\$react_$eventSeq"
            }

            override fun uploadAttachment(
                organisationId: String,
                channelId: String,
                payload: AttachmentUploadPayload,
            ): AttachmentMetadataRef = AttachmentMetadataRef.create(
                id = "01935800-0000-7000-8000-000000000999",
                filename = payload.filename,
                contentType = payload.contentType,
                sizeBytes = payload.sizeBytes,
            )
        }

        val controller = ChannelConversationController(scope = textScope, transport = fakeTransport)
        controller.bootstrap()
        assertEquals(R.string.conversation_status_live, controller.syncStatusRes)
        assertEquals(1, controller.messages.size)
        assertEquals("Bienvenue sur Kodera", controller.messages[0].body)

        // Fail first send -> FAILED -> retry -> SENT with identical UI key.
        failNextSend = true
        controller.selectReplyTarget(controller.messages[0])
        controller.updateComposerText("Merci !")
        controller.sendComposerMessage()

        assertEquals(2, controller.messages.size)
        val stableUiKey = controller.messages[1].key
        val txnId = checkNotNull(controller.messages[1].transactionId)
        assertEquals(MatrixDeliveryStatus.FAILED, controller.messages[1].deliveryStatus)

        failNextSend = false
        controller.retryFailedMessage(txnId)
        assertEquals(stableUiKey, controller.messages[1].key)
        assertEquals(MatrixDeliveryStatus.SENT, controller.messages[1].deliveryStatus)
        assertEquals("Bienvenue sur Kodera", controller.messages[1].replyPreview?.bodyExcerpt)

        // Toggle emoji reaction on and off.
        controller.toggleReaction(controller.messages[0], "🎉")
        assertEquals("🎉", controller.messages[0].reactions.single().key)
        assertTrue(controller.messages[0].reactions.single().isSelectedByMe)

        controller.toggleReaction(controller.messages[0], "🎉")
        assertTrue(controller.messages[0].reactions.isEmpty())

        assertEquals(
            "#general — alice: Merci !",
            ChannelConversationController.shareableText(controller.messages[1], "general"),
        )
        assertFalse(controller.fence.isInvalidated)
        controller.clear()
        assertTrue(controller.fence.isInvalidated)
        assertTrue(controller.messages.isEmpty())
    }

    @Test
    fun channelConversationRefusesReactionsOnFailedOrUnsentOptimisticMessages() {
        val channel = WorkspaceChannel(
            id = "22222222-2222-4222-8222-222222222222",
            kind = ChannelKind.TEXT,
            name = "general",
            templateKey = "general",
            topic = "",
            lifecycle = WorkspaceChannelLifecycle.ACTIVE,
            roomState = ChannelRoomState.READY,
            isConfidential = false,
        )
        val scope = checkNotNull(ChannelConversationScope.fromChannel(orgA, channel))

        // Offline/null-transport controller produces a FAILED optimistic message with eventId == null.
        val offline = ChannelConversationController(scope = scope, transport = null)
        offline.updateComposerText("Brouillon hors ligne")
        offline.sendComposerMessage()

        assertEquals(1, offline.messages.size)
        assertEquals(MatrixDeliveryStatus.FAILED, offline.messages[0].deliveryStatus)
        assertNull(offline.messages[0].eventId)
        assertFalse(ChannelConversationController.canReact(offline.messages[0]))

        // Tapping react must NEVER transition FAILED -> SENT or fabricate a server eventId.
        offline.toggleReaction(offline.messages[0], "👍")
        assertEquals(MatrixDeliveryStatus.FAILED, offline.messages[0].deliveryStatus)
        assertNull(offline.messages[0].eventId)
        assertTrue(offline.messages[0].reactions.isEmpty())
    }

    @Test
    fun channelConversationStagesPickedDocumentOffMainThreadAndFencesTeardown() {
        val channel = WorkspaceChannel(
            id = "22222222-2222-4222-8222-222222222222",
            kind = ChannelKind.TEXT,
            name = "general",
            templateKey = "general",
            topic = "",
            lifecycle = WorkspaceChannelLifecycle.ACTIVE,
            roomState = ChannelRoomState.READY,
            isConfidential = false,
        )
        val scope = checkNotNull(ChannelConversationScope.fromChannel(orgA, channel))
        val mainQueue = LinkedBlockingQueue<Runnable>()
        val workers = Executors.newSingleThreadExecutor()
        val callerThread = Thread.currentThread()
        val readerThread = AtomicReference<Thread?>()

        try {
            val controller = ChannelConversationController(
                scope = scope,
                transport = null,
                mainExecutor = Executor { mainQueue.add(it) },
                workerExecutor = workers,
            )

            controller.stageAttachmentFromReader {
                readerThread.set(Thread.currentThread())
                AttachmentUploadPayload(
                    "rapport.pdf",
                    AttachmentMimeType.PDF,
                    "pdf-bytes".toByteArray(Charsets.UTF_8),
                )
            }
            val mainPublish = checkNotNull(mainQueue.poll(5, TimeUnit.SECONDS))
            assertTrue(readerThread.get() !== callerThread)
            assertTrue(controller.stagedAttachments.isEmpty())
            mainPublish.run()
            assertEquals(1, controller.stagedAttachments.size)
            assertEquals("rapport.pdf", controller.stagedAttachments[0].filename)

            // If cleared mid-read, the attachment must be discarded and never published.
            val readStarted = CountDownLatch(1)
            val unblockRead = CountDownLatch(1)
            controller.stageAttachmentFromReader {
                readStarted.countDown()
                unblockRead.await(5, TimeUnit.SECONDS)
                AttachmentUploadPayload(
                    "stale.txt",
                    AttachmentMimeType.OCTET_STREAM,
                    "stale".toByteArray(Charsets.UTF_8),
                )
            }
            assertTrue(readStarted.await(5, TimeUnit.SECONDS))
            controller.clear()
            unblockRead.countDown()
            val lateTask = mainQueue.poll(150, TimeUnit.MILLISECONDS)
            lateTask?.run()
            assertTrue(controller.stagedAttachments.isEmpty())
        } finally {
            workers.shutdownNow()
        }
    }

    @Test
    fun channelConversationLimitedSyncGapBackfillsAndPreservesFailedOptimisticRow() {
        val channel = WorkspaceChannel(
            id = "22222222-2222-4222-8222-222222222222",
            kind = ChannelKind.TEXT,
            name = "general",
            templateKey = "general",
            topic = "",
            lifecycle = WorkspaceChannelLifecycle.ACTIVE,
            roomState = ChannelRoomState.READY,
            isConfidential = false,
        )
        val scope = checkNotNull(ChannelConversationScope.fromChannel(orgA, channel))
        val roomId = "!general:atelier.matrix.kodera.io"
        var returnLimitedGap = false

        val transport = object : ChannelConversationTransport {
            override val ownUserId: String = "@alice:atelier.matrix.kodera.io"

            override fun bootstrapRoom(organisationId: String, channelId: String): BootstrappedMatrixRoom =
                BootstrappedMatrixRoom(
                    roomId = roomId,
                    initialBatch = MatrixSyncBatch(
                        nextBatch = "s1",
                        plaintextAllowedRooms = setOf(roomId),
                        roomEvents = mapOf(
                            roomId to listOf(
                                MatrixRawTimelineEvent(
                                    type = "m.room.message",
                                    eventId = "\$pre_gap",
                                    sender = "@bob:atelier.matrix.kodera.io",
                                    originServerTs = 1_700_000_000_000L,
                                    msgtype = "m.text",
                                    body = "Avant coupure",
                                )
                            )
                        ),
                    ),
                )

            override fun syncRoom(roomId: String, since: String?): MatrixSyncBatch =
                if (returnLimitedGap) {
                    MatrixSyncBatch.fromDeltas(
                        nextBatch = "s_gap",
                        deltas = mapOf(
                            roomId to MatrixRoomSyncDelta(
                                events = listOf(
                                    MatrixRawTimelineEvent(
                                        type = "m.room.message",
                                        eventId = "\$post_gap",
                                        sender = "@bob:atelier.matrix.kodera.io",
                                        originServerTs = 1_700_000_020_000L,
                                        msgtype = "m.text",
                                        body = "Après reprise",
                                    )
                                ),
                                limited = true,
                                prevBatch = "tok_gap",
                            )
                        ),
                    ).copy(plaintextAllowedRooms = setOf(roomId))
                } else {
                    MatrixSyncBatch("s2", emptyMap(), plaintextAllowedRooms = setOf(roomId))
                }

            override fun backfillRoomMessages(roomId: String, fromToken: String, limit: Int): List<MatrixRawTimelineEvent> =
                listOf(
                    MatrixRawTimelineEvent(
                        type = "m.room.message",
                        eventId = "\$backfilled",
                        sender = "@camille:atelier.matrix.kodera.io",
                        originServerTs = 1_700_000_010_000L,
                        msgtype = "m.text",
                        body = "Récupéré via messages",
                    )
                )

            override fun sendMessage(
                roomId: String,
                transactionId: String,
                body: String,
                replyToEventId: String?,
                attachments: List<AttachmentMetadataRef>,
            ): String = throw MatrixClientException(MatrixClientError.SERVICE_UNAVAILABLE)

            override fun editMessage(roomId: String, transactionId: String, targetEventId: String, newBody: String): String = "\$e"
            override fun redactEvent(roomId: String, transactionId: String, targetEventId: String): String = "\$r"
            override fun sendReaction(roomId: String, transactionId: String, targetEventId: String, emojiKey: String): String = "\$k"
            override fun uploadAttachment(
                organisationId: String,
                channelId: String,
                payload: AttachmentUploadPayload,
            ): AttachmentMetadataRef = error("unused")
        }

        val controller = ChannelConversationController(scope = scope, transport = transport)
        controller.bootstrap()
        assertEquals(listOf("Avant coupure"), controller.messages.map { it.body })

        controller.updateComposerText("Brouillon local échoué")
        controller.sendComposerMessage()
        assertEquals(2, controller.messages.size)
        assertEquals(MatrixDeliveryStatus.FAILED, controller.messages[1].deliveryStatus)

        returnLimitedGap = true
        controller.refreshSync()
        assertEquals(
            listOf("Récupéré via messages", "Après reprise", "Brouillon local échoué"),
            controller.messages.map { it.body },
        )
        assertEquals(MatrixDeliveryStatus.FAILED, controller.messages.last().deliveryStatus)
    }

    @Test
    fun sessionControllerWiresProductionTransportRevokesPushAndPropagatesVaultWipeFailure() {
        val tempDir = Files.createTempDirectory("kodera-r2-session").toFile()
        val workers = Executors.newCachedThreadPool()
        val mainQueue = LinkedBlockingQueue<Runnable>()
        val testThread = Thread.currentThread()

        fun drainUntil(label: String, predicate: () -> Boolean) {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (!predicate()) {
                check(System.nanoTime() < deadline) { "Timed out waiting for $label" }
                mainQueue.poll(20, TimeUnit.MILLISECONDS)?.run()
            }
        }

        val failKeyDestroy = AtomicBoolean(false)
        val faultyKeys = object : SessionKeys {
            private var secret: SecretKey? = null
            override fun existing(): SecretKey? = secret
            override fun getOrCreate(): SecretKey = secret ?: KeyGenerator.getInstance("AES").run {
                init(256)
                generateKey().also { secret = it }
            }
            override fun destroy() {
                if (failKeyDestroy.get()) error("Simulated Keystore deleteEntry failure")
                secret = null
            }
        }

        val issuerUrl = url(ConnectionPolicy.HTTPS, "auth.kodera.test/realms/atelier")
        val client = "test-client"
        val admittedOrigins = setOf(url(ConnectionPolicy.HTTPS, "auth.kodera.test"))
        val signInConfig = SignInConfiguration(client, admittedOrigins, LoopbackPolicy.REFUSE)
        val oidcSub = "oidc-sub-77777777-8888-4999-8000-aaaaaaaaaaaa"

        // Verify JWT `sub` extraction helper on AppAuthBackend as well.
        val jwtHeader = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString("""{"alg":"RS256"}""".toByteArray(Charsets.UTF_8))
        val jwtClaims = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString("""{"sub":"$oidcSub"}""".toByteArray(Charsets.UTF_8))
        assertEquals(oidcSub, AppAuthBackend.extractJwtSubject("$jwtHeader.$jwtClaims.sig"))

        val fakeBackend = object : AuthorizationBackend, BrowserAuthorization {
            override fun authorize(issuer: AdmittedIssuer, configuration: SignInConfiguration): StoredGrant =
                StoredGrant(issuer.issuer, "grant-r2", oidcSub)
            override fun freshAccessToken(grant: StoredGrant, forceRefresh: Boolean): FreshToken =
                FreshToken("oidc-access-r2", StoredGrant(grant.issuer, grant.state, oidcSub))
            override fun revoke(grant: StoredGrant, issuer: AdmittedIssuer, configuration: SignInConfiguration) {}
            override fun authenticatedSubject(grant: StoredGrant): String? = grant.subject ?: oidcSub
            override fun attach(presenter: AuthorizationPresenter) {}
            override fun detach(presenter: AuthorizationPresenter) {}
            override fun onAuthorizationResult(data: Intent?): Boolean = false
            override fun cancelAuthorization(): Boolean = false
        }
        val tokenStore = InMemoryTokenStore()
        val signInService = KoderaSignInService(signInConfig, tokenStore, fakeBackend)
        val sessionDir = SessionStorage.sessionDirectory(tempDir)
        val vault = RustSessionVault(SessionStorage.rustVaultFile(tempDir), faultyKeys)

        val channel = WorkspaceChannel(
            id = "22222222-2222-4222-8222-222222222222",
            kind = ChannelKind.TEXT,
            name = "general",
            templateKey = "general",
            topic = "General",
            lifecycle = WorkspaceChannelLifecycle.ACTIVE,
            roomState = ChannelRoomState.READY,
            isConfidential = false,
        )
        val snapshot = WorkspaceSnapshot(
            orgA,
            WorkspaceState.INITIALISED,
            WorkspaceSetup(WorkspaceSetupState.READY, null),
            false,
            "99999999-9999-4999-8999-999999999999",
            listOf(WorkspaceCategory("88888888-8888-4888-8888-888888888888", "Général", null, listOf(channel))),
            emptyList(),
        )
        val memberProfile = MemberProfile(
            "11111111-2222-4333-8444-555555555555",
            "alice@kodera.test",
            "Alice",
            listOf(
                MemberOrganisation(
                    orgA,
                    "atelier",
                    "Atelier",
                    "atelier",
                    "org_owner",
                    "active",
                )
            ),
        )

        val registeredDevices = mutableListOf<String>()
        val revokedDevices = mutableListOf<String>()
        val matrixLogoutHeaders = java.util.concurrent.CopyOnWriteArrayList<String>()
        val syncHits = java.util.concurrent.atomic.AtomicInteger(0)
        val returnMismatchedPersonIdNextLogin = AtomicBoolean(true)
        val lastLoginPayload = java.util.concurrent.atomic.AtomicReference("")
        val holdLoginEntered = java.util.concurrent.atomic.AtomicReference<java.util.concurrent.CountDownLatch?>(null)
        val holdLoginRelease = java.util.concurrent.atomic.AtomicReference<java.util.concurrent.CountDownLatch?>(null)
        val holdSyncEntered = java.util.concurrent.atomic.AtomicReference<java.util.concurrent.CountDownLatch?>(null)
        val holdSyncRelease = java.util.concurrent.atomic.AtomicReference<java.util.concurrent.CountDownLatch?>(null)
        val holdNextSso = AtomicBoolean(false)
        val ssoBrowserOpened = java.util.concurrent.atomic.AtomicReference<java.util.concurrent.CountDownLatch?>(null)
        val ssoCallbackReturned = java.util.concurrent.atomic.AtomicReference<java.util.concurrent.CountDownLatch?>(null)
        val ssoAuthorizerCalls = java.util.concurrent.atomic.AtomicInteger(0)

        val matrixStub = io.kodera.android.client.MatrixHttpStub { req ->
            val path = java.net.URI(req.url).path
            when {
                path == "/.well-known/matrix/client" -> io.kodera.android.client.MatrixHttpReply(404)
                path == "/_matrix/client/v3/login" -> {
                    holdLoginEntered.get()?.countDown()
                    holdLoginRelease.get()?.await(2, TimeUnit.SECONDS)
                    lastLoginPayload.set(req.bodyUtf8 ?: "")
                    val json = if (returnMismatchedPersonIdNextLogin.getAndSet(false)) {
                        """{"user_id":"@${memberProfile.id}:atelier.kodera.test","access_token":"aaa_bad","refresh_token":"rrr_bad","device_id":"DEV01"}"""
                    } else {
                        """{"user_id":"@$oidcSub:atelier.kodera.test","access_token":"aaa_ok","refresh_token":"rrr_ok","device_id":"DEV01"}"""
                    }
                    io.kodera.android.client.MatrixHttpReply(200, json.toByteArray(Charsets.UTF_8))
                }
                path.startsWith("/_matrix/client/v3/directory/room/") ->
                    io.kodera.android.client.MatrixHttpReply(
                        200,
                        """{"room_id":"!general:atelier.kodera.test"}""".toByteArray(Charsets.UTF_8),
                    )
                path.startsWith("/_matrix/client/v3/rooms/") && path.endsWith("/join") ->
                    io.kodera.android.client.MatrixHttpReply(200, """{"room_id":"!general:atelier.kodera.test"}""".toByteArray(Charsets.UTF_8))
                path == "/_matrix/client/v3/sync" -> {
                    syncHits.incrementAndGet()
                    holdSyncEntered.get()?.countDown()
                    holdSyncRelease.get()?.await(2, TimeUnit.SECONDS)
                    io.kodera.android.client.MatrixHttpReply(
                        200,
                        """{"next_batch":"s_live_${syncHits.get()}","rooms":{"join":{"!general:atelier.kodera.test":{"state":{"events":[]},"timeline":{"events":[]}}}}}""".toByteArray(Charsets.UTF_8),
                    )
                }
                path == "/_matrix/client/v3/logout" -> {
                    matrixLogoutHeaders += (req.authorizationHeader ?: "")
                    io.kodera.android.client.MatrixHttpReply(200)
                }
                else -> io.kodera.android.client.MatrixHttpReply(404)
            }
        }

        val coreOrigin = url(ConnectionPolicy.HTTPS, "api.kodera.test")
        val deployment = Deployment(null, signInConfig, coreOrigin, null)

        try {
            val controller = SessionController(
                deployment = deployment,
                backend = fakeBackend,
                service = signInService,
                main = Executor { mainQueue.add(it) },
                onMainThread = { Thread.currentThread() === testThread },
                workers = workers,
                fetchMember = { MeOutcome.Member(memberProfile) },
                fetchWorkspace = { _, _ -> WorkspaceOutcome.Loaded(snapshot) },
                rustSessionVault = vault,
                sessionStateDir = sessionDir,
                registerPush = { _, deviceId, _, _, _ -> registeredDevices += deviceId },
                revokePush = { _, deviceId -> revokedDevices += deviceId },
                matrixSsoAuthorizer = { ssoReq ->
                    ssoAuthorizerCalls.incrementAndGet()
                    if (holdNextSso.getAndSet(false)) {
                        ssoBrowserOpened.get()?.countDown()
                        check(ssoCallbackReturned.get()?.await(2, TimeUnit.SECONDS) == true) {
                            "Timed out awaiting SSO Custom Tab callback"
                        }
                    }
                    io.kodera.android.client.MatrixRoomClient.consumeSsoCallbackUri(
                        "${ssoReq.callbackUri}&loginToken=sso_tok_android_live",
                        ssoReq.state,
                    )
                },
                matrixHttpStub = matrixStub,
            )
            assertFalse(controller.isForeground.value)
            controller.onForeground()
            assertTrue(controller.isForeground.value)
            controller.start()
            drainUntil("initial signed out") { controller.phase == SessionPhase.SignedOut }

            controller.signIn(issuerUrl)
            drainUntil("workspace loaded") { controller.workspace is WorkspaceViewState.Loaded }

            // 1. Regression (Items 1 & 2): MemberProfile.id != oidcSub; mismatched `@<MemberProfile.id>:...`
            // MUST immediately execute `/_matrix/client/v3/logout` and refuse!
            controller.openChannel(channel, orgA)
            val mismatchedConv = checkNotNull(controller.activeConversation)
            mismatchedConv.bootstrap()
            drainUntil("mismatched user_id refused") {
                mismatchedConv.syncStatusRes == R.string.conversation_status_offline &&
                    matrixLogoutHeaders.size == 1
            }
            assertEquals(listOf("Bearer aaa_bad"), matrixLogoutHeaders.toList())
            controller.closeChannel()

            // 2a. Real Android SSO lifecycle (Ordering A): Custom Tab opens -> `onBackground()` invalidates
            // `syncCycleFence` while `MatrixSsoAuthorizer` awaits callback -> callback returns & `/login` succeeds ->
            // `onForeground()` resumes catch-up `/sync` under a fresh `syncCycleFence`!
            val openedA = java.util.concurrent.CountDownLatch(1)
            val callbackA = java.util.concurrent.CountDownLatch(1)
            ssoBrowserOpened.set(openedA)
            ssoCallbackReturned.set(callbackA)
            holdNextSso.set(true)

            controller.openChannel(channel, orgA)
            val ssoConvA = checkNotNull(controller.activeConversation)
            assertTrue(ssoConvA.hasLiveTransport)
            ssoConvA.bootstrap()
            assertTrue("Expected SSO Custom Tab to open", openedA.await(2, TimeUnit.SECONDS))

            // Activity pauses/backgrounds while Custom Tab is in front:
            controller.onBackground()
            assertFalse(controller.isForeground.value)
            assertFalse(ssoConvA.isForeground.value)

            // Custom Tab delivers single-use loginToken (ActivityResult arrives in STARTED before onResume):
            callbackA.countDown()
            drainUntil("bootstrap completed post-SSO while still pre-resume") {
                ssoConvA.isBootstrapped && ssoConvA.syncStatusRes == R.string.conversation_status_live
            }
            val syncHitsAfterBootA = syncHits.get()
            assertTrue(syncHitsAfterBootA >= 1)
            assertTrue(lastLoginPayload.get().contains(""""type":"m.login.token""""))

            // Activity resumes (`onResume -> onForeground`): workspace reloads AND catch-up `/sync` runs with fresh fence!
            controller.onForeground()
            assertTrue(controller.isForeground.value)
            assertTrue(ssoConvA.isForeground.value)
            drainUntil("workspace reloaded & catch-up sync resumed after SSO A") {
                controller.workspace is WorkspaceViewState.Loaded && syncHits.get() > syncHitsAfterBootA
            }
            assertEquals(2, ssoAuthorizerCalls.get())
            controller.closeChannel()

            // 2b. Real Android SSO lifecycle (Ordering B): Custom Tab opens -> `onBackground()` -> callback unblocks ->
            // `onForeground()` runs BEFORE `POST /_matrix/client/v3/login` completes -> coalesces without duplicate SSO
            // and immediately runs catch-up `/sync` once `/login` + bootstrap complete!
            vault.wipe()
            val openedB = java.util.concurrent.CountDownLatch(1)
            val callbackB = java.util.concurrent.CountDownLatch(1)
            val loginEnteredB = java.util.concurrent.CountDownLatch(1)
            val loginReleaseB = java.util.concurrent.CountDownLatch(1)
            ssoBrowserOpened.set(openedB)
            ssoCallbackReturned.set(callbackB)
            holdLoginEntered.set(loginEnteredB)
            holdLoginRelease.set(loginReleaseB)
            holdNextSso.set(true)

            controller.openChannel(channel, orgA)
            val openConv = checkNotNull(controller.activeConversation)
            openConv.bootstrap()
            assertTrue("Expected second SSO Custom Tab to open", openedB.await(2, TimeUnit.SECONDS))
            controller.onBackground()
            callbackB.countDown()
            assertTrue("Expected POST /login to enter flight", loginEnteredB.await(2, TimeUnit.SECONDS))

            // Activity resumes BEFORE `/login` HTTP completes; simulated LaunchedEffect re-invocation must coalesce!
            controller.onForeground()
            openConv.bootstrap()
            val syncHitsBeforeReleaseB = syncHits.get()
            loginReleaseB.countDown()
            holdLoginEntered.set(null)
            holdLoginRelease.set(null)

            drainUntil("bootstrap B live & catch-up sync completed") {
                controller.workspace is WorkspaceViewState.Loaded &&
                    openConv.isBootstrapped && !openConv.isSyncing &&
                    openConv.syncStatusRes == R.string.conversation_status_live &&
                    syncHits.get() >= syncHitsBeforeReleaseB + 2 &&
                    !openConv.isSyncing
            }
            assertEquals("Must not trigger duplicate SSO on resume", 3, ssoAuthorizerCalls.get())

            // 3. Regression (Item 8): `onBackground()` flips `isForeground` to false, cancels in-flight `/sync`,
            // and halts `/sync` polling until `onForeground()` resumes!
            val syncEntered = java.util.concurrent.CountDownLatch(1)
            val syncRelease = java.util.concurrent.CountDownLatch(1)
            holdSyncEntered.set(syncEntered)
            holdSyncRelease.set(syncRelease)
            openConv.refreshSync()
            assertTrue("Expected in-flight /sync to start", syncEntered.await(2, TimeUnit.SECONDS))

            controller.onBackground()
            assertFalse(controller.isForeground.value)
            assertFalse(openConv.isForeground.value)
            assertFalse(openConv.isSyncing)
            syncRelease.countDown()
            holdSyncEntered.set(null)
            holdSyncRelease.set(null)

            val hitsWhileBackgrounded = syncHits.get()
            openConv.refreshSync()
            assertEquals("Backgrounded conversation must not poll /sync", hitsWhileBackgrounded, syncHits.get())

            controller.onForeground()
            assertTrue(controller.isForeground.value)
            assertTrue(openConv.isForeground.value)
            drainUntil("workspace reloaded on foreground") { controller.workspace is WorkspaceViewState.Loaded }
            openConv.refreshSync()
            drainUntil("foreground /sync resumed") {
                syncHits.get() > hitsWhileBackgrounded && !openConv.isSyncing
            }

            // 4. Regression (Item 6): Navigate Back (`closeChannel()`) BEFORE `signOut()` ->
            // `signOut()` MUST still execute `POST /_matrix/client/v3/logout` before wiping `RustSessionVault`!
            controller.closeChannel()
            assertTrue(openConv.isCleared)
            assertNull(controller.activeConversation)

            val pushDeviceId = "01935800-0000-7000-8000-000000000777"
            val regDone = AtomicBoolean(false)
            controller.registerPushWakeup(
                deviceId = pushDeviceId,
                endpoint = url(ConnectionPolicy.HTTPS, "push.kodera.test/up/opaque"),
                p256dh = "B" + "A".repeat(86),
                auth = "A".repeat(22),
            ) { ok ->
                assertTrue(ok)
                regDone.set(true)
            }
            drainUntil("push registered") { regDone.get() }
            assertEquals(listOf(pushDeviceId), registeredDevices)

            failKeyDestroy.set(true)
            controller.signOut()
            drainUntil("signOut not wiped notice") {
                controller.notice == R.string.session_not_wiped && matrixLogoutHeaders.size == 2
            }
            assertEquals(SessionPhase.SignedOut, controller.phase)
            assertEquals(listOf(pushDeviceId), revokedDevices)
            assertEquals(
                listOf("Bearer aaa_bad", "Bearer aaa_ok"),
                matrixLogoutHeaders.toList(),
            )
            assertTrue(SessionStorage.unwipedMarkerFile(sessionDir).exists())
            controller.close()

            // Next launch while key destroy STILL fails must refuse restoration and surface session_not_wiped.
            KoderaSignInService(signInConfig, tokenStore, fakeBackend).signIn(issuerUrl)
            val relaunchedService = KoderaSignInService(signInConfig, tokenStore, fakeBackend)
            val secondController = SessionController(
                deployment = deployment,
                backend = fakeBackend,
                service = relaunchedService,
                main = Executor { mainQueue.add(it) },
                onMainThread = { Thread.currentThread() === testThread },
                workers = workers,
                fetchMember = { MeOutcome.Member(memberProfile) },
                fetchWorkspace = { _, _ -> WorkspaceOutcome.Loaded(snapshot) },
                rustSessionVault = vault,
                sessionStateDir = sessionDir,
            )
            secondController.start()
            drainUntil("relaunch refused with not wiped") {
                secondController.phase == SessionPhase.SignedOut && secondController.notice == R.string.session_not_wiped
            }
            assertTrue(SessionStorage.unwipedMarkerFile(sessionDir).exists())

            // Once the keystore fault clears, retry start() wipes cleanly and settles on SignedOut without reopening.
            failKeyDestroy.set(false)
            secondController.start()
            drainUntil("relaunch retry wiped cleanly") {
                secondController.phase == SessionPhase.SignedOut && secondController.notice == null
            }
            assertFalse(SessionStorage.unwipedMarkerFile(sessionDir).exists())
            assertNull(tokenStore.load())
            secondController.close()
        } finally {
            workers.shutdownNow()
            tempDir.deleteRecursively()
        }
    }

    @Test
    fun workspaceNotFoundClearsConversationWhileServiceUnavailablePreservesDraft() {
        val workers = Executors.newSingleThreadExecutor()
        val mainQueue = LinkedBlockingQueue<Runnable>()
        val testThread = Thread.currentThread()
        fun drainUntil(label: String, predicate: () -> Boolean) {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (!predicate()) {
                check(System.nanoTime() < deadline) { "Timed out waiting for $label" }
                mainQueue.poll(20, TimeUnit.MILLISECONDS)?.run()
            }
        }
        val client = "test-client"
        val configuration = SignInConfiguration(
            client, setOf(url(ConnectionPolicy.HTTPS, "auth.kodera.test")), LoopbackPolicy.REFUSE,
        )
        val backend = object : AuthorizationBackend {
            override fun authorize(issuer: AdmittedIssuer, configuration: SignInConfiguration) =
                StoredGrant(issuer.issuer, "workspace-grant", "member-subject")
            override fun freshAccessToken(grant: StoredGrant, forceRefresh: Boolean) =
                FreshToken("workspace-token", grant)
            override fun revoke(grant: StoredGrant, issuer: AdmittedIssuer, configuration: SignInConfiguration) {}
        }
        val channel = WorkspaceChannel(
            id = "22222222-2222-4222-8222-222222222222", kind = ChannelKind.TEXT,
            name = "general", templateKey = "general", topic = "General",
            lifecycle = WorkspaceChannelLifecycle.ACTIVE, roomState = ChannelRoomState.READY,
            isConfidential = false,
        )
        val snapshot = WorkspaceSnapshot(
            orgA, WorkspaceState.INITIALISED, WorkspaceSetup(WorkspaceSetupState.READY, null),
            false, "99999999-9999-4999-8999-999999999999", emptyList(), listOf(channel),
        )
        val answer = AtomicReference<WorkspaceOutcome>(WorkspaceOutcome.Loaded(snapshot))
        val profile = MemberProfile(orgA, "member@kodera.test", "Member", listOf(
            MemberOrganisation(orgA, "atelier", "Atelier", "atelier", "org_owner", "active"),
        ))
        val controller = SessionController(
            deployment = Deployment(null, configuration, url(ConnectionPolicy.HTTPS, "api.kodera.test"), null),
            backend = null,
            service = KoderaSignInService(configuration, InMemoryTokenStore(), backend),
            main = Executor { mainQueue.add(it) },
            onMainThread = { Thread.currentThread() === testThread }, workers = workers,
            fetchMember = { MeOutcome.Member(profile) }, fetchWorkspace = { _, _ -> answer.get() },
            conversationTransportFactory = { _, _, _, _, _, _ -> null },
        )
        try {
            controller.onForeground()
            controller.start()
            drainUntil("signed out") { controller.phase == SessionPhase.SignedOut }
            controller.signIn(url(ConnectionPolicy.HTTPS, "auth.kodera.test/realms/atelier"))
            drainUntil("workspace loaded") { controller.workspace is WorkspaceViewState.Loaded }
            controller.openChannel(channel, orgA)
            val conversation = checkNotNull(controller.activeConversation)
            conversation.updateComposerText("Unsent draft")

            answer.set(WorkspaceOutcome.Unavailable(WorkspaceFailure.ServiceUnavailable))
            controller.retryWorkspace()
            drainUntil("temporary failure") { controller.workspace is WorkspaceViewState.Unavailable }
            assertSame(conversation, controller.activeConversation)
            assertFalse(conversation.isCleared)
            assertEquals("Unsent draft", conversation.composerText)

            answer.set(WorkspaceOutcome.Unavailable(WorkspaceFailure.NotFound))
            controller.retryWorkspace()
            drainUntil("authority lost") { controller.activeConversation == null }
            assertTrue(conversation.isCleared)
            assertEquals("", conversation.composerText)
        } finally {
            controller.close()
            workers.shutdownNow()
        }
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
