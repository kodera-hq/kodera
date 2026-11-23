import CryptoKit
import Foundation
import SwiftUI
import XCTest
import KoderaAuth
import KoderaDomain
@testable import Kodera
@testable import KoderaClient

@MainActor
final class Wave5ParitySurfaceTests: XCTestCase {
    private let orgId = "11111111-1111-4111-8111-111111111111"

    func testConversationBackgroundPreservesDraftStagingAndFailedRetryUntilExplicitClosure() async throws {
        let channel = WorkspaceChannel(id: "22222222-2222-4222-8222-222222222222", kind: .text, name: "general", templateKey: nil, topic: "", lifecycle: .active, roomState: .ready, isConfidential: false)
        let scope = try XCTUnwrap(ChannelConversationScope(organisationId: orgId, channel: channel))
        var authority = OrganisationChannelsLoader.State()
        XCTAssertFalse(AppSessionModel.conversationAuthorityLost(scope: scope, state: authority))
        authority.workspace = .loading
        XCTAssertFalse(AppSessionModel.conversationAuthorityLost(scope: scope, state: authority))
        authority.workspace = .unavailable(.serviceUnavailable)
        XCTAssertFalse(AppSessionModel.conversationAuthorityLost(scope: scope, state: authority))
        authority.workspace = .unavailable(.notFound)
        XCTAssertTrue(AppSessionModel.conversationAuthorityLost(scope: scope, state: authority))
        authority.workspace = .unavailable(.forbidden)
        XCTAssertTrue(AppSessionModel.conversationAuthorityLost(scope: scope, state: authority))
        let transport = MockConversationTransport()
        let model = ChannelConversationModel(scope: scope, transport: transport)
        await model.bootstrap()
        await transport.setShouldFailNextSend(true)
        model.stageAttachment(try AttachmentUploadPayload(filename: "retry.ogg", contentType: .oggAudio, data: Data([1, 2])))
        model.composerText = "Retry with attachment"
        await model.sendComposerMessage()
        let failed = try XCTUnwrap(model.messages.last)
        XCTAssertEqual(failed.deliveryStatus, .failed)
        model.composerText = "Unsent draft"
        model.stageAttachment(try AttachmentUploadPayload(filename: "draft.webm", contentType: .webmAudio, data: Data([3, 4])))
        model.setForeground(false)
        XCTAssertEqual(model.composerText, "Unsent draft")
        XCTAssertEqual(model.stagedAttachments.map(\.filename), ["draft.webm"])
        XCTAssertFalse(model.fence.isInvalidated)
        XCTAssertFalse(model.canSend)
        model.setForeground(true)
        model.stopSyncLoop()
        XCTAssertEqual(model.composerText, "Unsent draft")
        XCTAssertEqual(model.stagedAttachments.count, 1)
        await transport.setShouldFailNextSend(false)
        await model.retryFailedMessage(transactionId: try XCTUnwrap(failed.transactionId))
        XCTAssertEqual(model.messages.last?.deliveryStatus, .sent)
        XCTAssertEqual(model.messages.last?.attachments.first?.contentType, .oggAudio)
        model.clear()
        XCTAssertTrue(model.fence.isInvalidated)
        XCTAssertEqual(model.composerText, "")
        XCTAssertTrue(model.stagedAttachments.isEmpty)
    }

    func testLiveConversationRevokesNativeCallsAtAuthorityAndSecurityBoundaries() async throws {
        let roomId = "!general:atelier.matrix.kodera.io"
        let channelId = "22222222-2222-4222-8222-222222222222"
        let callId = "33333333-3333-4333-8333-333333333333"
        for connected in [false, true] {
            for boundary in ["answer", "leave", "plaintext", "notFound", "forbidden", "backfill", "confidential", "unknown"] {
                let transport = MockConversationTransport(); let media = ConversationCallMedia()
                let coordinator = try NativeCallCoordinator(organisationId: orgId, localPartyId: "local",
                    resolver: ConversationCallResolver(roomId: roomId), media: media, conversation: transport, now: { 100 })
                let channel = WorkspaceChannel(id: channelId, kind: .audio, name: "audio", templateKey: nil, topic: "", lifecycle: .active, roomState: .ready, isConfidential: false)
                let model = ChannelConversationModel(scope: try XCTUnwrap(ChannelConversationScope(organisationId: orgId, channel: channel)), transport: transport,
                    onAuthenticatedSync: { coordinator.consumeAuthenticatedSync($1, roomId: $0) },
                    onTransportFailure: { coordinator.consumeTransportFailure($0) },
                    onSecurityBoundaryChanged: { coordinator.revoke() })
                let wake = try NativeCallWake(callId: callId, organisationId: orgId, channelId: channelId, epoch: 1, state: .ringing, expiresAt: 130)
                try await coordinator.receive(wake); await model.bootstrap()
                if connected { try await coordinator.answer(callId: callId); await coordinator.audioSession(active: true) }
                XCTAssertNotNil(coordinator.call)
                if boundary == "confidential" || boundary == "unknown" {
                    model.updateChannelSecurity(isConfidential: boundary == "confidential" ? true : nil)
                } else if boundary == "notFound" || boundary == "forbidden" {
                    await transport.failSync(boundary == "notFound" ? .notFound : .forbidden)
                    await model.refreshSync()
                } else if boundary == "backfill" {
                    await transport.configureLimitedSync(roomId: roomId, prevBatch: "previous", backfilled: [], postGap: [])
                    await transport.failBackfill(.forbidden); await model.refreshSync()
                } else {
                    var batch = MatrixSyncBatch(nextBatch: "boundary", roomEvents: [:])
                    if boundary == "answer" {
                        batch = MatrixSyncBatch(nextBatch: "answer", roomEvents: [roomId: [MatrixRawTimelineEvent(type: "m.call.answer", eventId: "$answer", sender: transport.ownUserId, originServerTs: 100, callId: callId, callPartyId: "other")]])
                        batch.plaintextAllowedRooms = [roomId]
                    } else if boundary == "leave" { batch.authorityLostRooms = [roomId] }
                    await transport.setSyncBatch(batch); await model.refreshSync()
                }
                XCTAssertNil(coordinator.call, boundary); XCTAssertEqual(media.disconnects, 1, boundary)
                XCTAssertFalse(media.microphoneEnabled, boundary)
                if boundary == "answer" { XCTAssertEqual(coordinator.ring.records[callId]?.phase, .answeredElsewhere) }
                else { XCTAssertTrue(coordinator.ring.records.isEmpty, boundary) }
                model.clear()
            }
        }
    }

    func testConversationBootstrapFailureReachesOwnerAndClearFencesCallbacks() async throws {
        let channel = WorkspaceChannel(id: "22222222-2222-4222-8222-222222222222", kind: .audio, name: "audio", templateKey: nil, topic: "", lifecycle: .active, roomState: .ready, isConfidential: false)
        let transport = MockConversationTransport()
        var failures: [MatrixClientFailure] = []; var syncs = 0; var securityChanges = 0
        let model = ChannelConversationModel(scope: try XCTUnwrap(ChannelConversationScope(organisationId: orgId, channel: channel)), transport: transport,
            onAuthenticatedSync: { _, _ in syncs += 1 },
            onTransportFailure: { failures.append($0) },
            onSecurityBoundaryChanged: { securityChanges += 1 })
        await transport.failBootstrap(.notFound); await model.bootstrap()
        XCTAssertEqual(failures, [.notFound]); XCTAssertEqual(syncs, 0)
        await transport.failBootstrap(nil); await model.bootstrap(); XCTAssertEqual(syncs, 1)
        model.clear(); await model.refreshSync(); model.updateChannelSecurity(isConfidential: true)
        XCTAssertEqual(syncs, 1); XCTAssertEqual(securityChanges, 0)
    }

    func testConfidentialAndUnknownConversationMetadataDisableComposer() throws {
        for confidential: Bool? in [true, nil] {
            let channel = WorkspaceChannel(id: "22222222-2222-4222-8222-222222222222", kind: .text, name: "private", templateKey: nil, topic: "", lifecycle: .active, roomState: .ready, isConfidential: confidential)
            let model = ChannelConversationModel(scope: try XCTUnwrap(ChannelConversationScope(organisationId: orgId, channel: channel)))
            model.composerText = "Secret"
            XCTAssertFalse(model.canSend)
        }
    }

    func testCielThemeAndPaletteMappingResolvesLightAndDarkTokens() {
        XCTAssertEqual(KoderaTokens.Theme.defaultTheme, .dark)
        XCTAssertEqual(KoderaTokens.activeTheme(for: .light), .light)
        XCTAssertEqual(KoderaTokens.activeTheme(for: .dark), .dark)
        XCTAssertEqual(KoderaTokens.activePalette(for: .dark).page, KoderaTokens.dark.page)
        XCTAssertEqual(KoderaTokens.activePalette(for: .light).page, KoderaTokens.light.page)
        XCTAssertEqual(KoderaTokens.cielTheme(for: .light), .ciel)
        XCTAssertEqual(KoderaTokens.cielTheme(for: .dark), .cielNuit)
        XCTAssertFalse(KoderaTokens.cielTheme(for: .light).isDark)
        XCTAssertTrue(KoderaTokens.cielTheme(for: .dark).isDark)

        let lightPalette = KoderaTokens.cielPalette(for: .light)
        let darkPalette = KoderaTokens.cielPalette(for: .dark)
        XCTAssertEqual(lightPalette.page, KoderaTokens.ciel.page)
        XCTAssertEqual(darkPalette.page, KoderaTokens.cielNuit.page)
        XCTAssertNotEqual(lightPalette.page, darkPalette.page)
    }

    func testCommunityWorkspacePresentationCoversThreeCanonicalCategoriesAndInviteScopes() throws {
        let categories = CommunityWorkspaceBlueprint.categories
        XCTAssertEqual(categories.map(\.name), ["Community", "Core Kodera", "Design Partners"])
        XCTAssertEqual(categories.map(\.showsFederatedPartnerBadge), [false, false, true])

        XCTAssertEqual(
            CommunityCategoryPresentation.audienceKey(for: .publicOpen),
            "community.audience_public"
        )
        XCTAssertEqual(
            CommunityCategoryPresentation.audienceKey(for: .coreTeam),
            "community.audience_core"
        )
        XCTAssertEqual(
            CommunityCategoryPresentation.audienceKey(for: .federatedPartners),
            "community.audience_partners"
        )

        for topic in CommunityChannelTopic.allCases {
            let key = CommunityCategoryPresentation.topicKey(for: topic)
            XCTAssertTrue(key.hasPrefix("community.topic_"))
            let localized = NSLocalizedString(key, comment: "")
            XCTAssertFalse(localized.isEmpty)
            XCTAssertNotEqual(localized, key, "Missing localization in bundle for \(key)")
        }

        let scope = try XCTUnwrap(
            CommunityCategoryPresentation.makeInviteScope(
                organisationId: orgId,
                channelId: "partner-onboarding",
                channelName: "partner-onboarding"
            )
        )
        XCTAssertEqual(
            scope.invitation.matrixURIString,
            "matrix:r/partner-onboarding:community.kodera.io?action=join&via=community.kodera.io"
        )
        XCTAssertNil(
            CommunityCategoryPresentation.makeInviteScope(
                organisationId: nil,
                channelId: "partner-onboarding",
                channelName: "partner-onboarding"
            )
        )
    }

    func testCallSessionPhasePresentationCoversAllDeterministicPhases() throws {
        let envelope = try PayloadFreePushEnvelope(
            wakeupId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            organisationId: orgId,
            syncHint: "sync_01"
        )
        let wakeup = IncomingCallWakeup(envelope: envelope)
        let descriptor = try VerifiedCallDescriptor(
            wakeupId: wakeup.wakeupId,
            organisationId: orgId,
            roomId: "!office:community.kodera.io",
            liveKitRoomName: "lk_office_01",
            callerLabel: "Office Hours",
            hasVideo: false
        )

        XCTAssertEqual(CallSessionPhasePresentation.phaseKey(for: .idle), "callkit.phase_idle")
        XCTAssertEqual(
            CallSessionPhasePresentation.phaseKey(for: .ringing(wakeup, descriptor)),
            "callkit.phase_ringing"
        )
        XCTAssertEqual(
            CallSessionPhasePresentation.phaseKey(for: .connecting(wakeup, descriptor)),
            "callkit.phase_connecting"
        )
        XCTAssertEqual(
            CallSessionPhasePresentation.phaseKey(
                for: .active(wakeup, descriptor, isMuted: false, isHeld: false, isVideoEnabled: false)
            ),
            "callkit.phase_active"
        )
        XCTAssertEqual(
            CallSessionPhasePresentation.phaseKey(
                for: .active(wakeup, descriptor, isMuted: true, isHeld: false, isVideoEnabled: false)
            ),
            "callkit.phase_muted"
        )
        XCTAssertEqual(
            CallSessionPhasePresentation.phaseKey(
                for: .active(wakeup, descriptor, isMuted: true, isHeld: true, isVideoEnabled: false)
            ),
            "callkit.phase_held"
        )
        XCTAssertEqual(
            CallSessionPhasePresentation.phaseKey(for: .ended(.localHangup)),
            "callkit.phase_ended"
        )
        XCTAssertEqual(
            CallSessionPhasePresentation.phaseKey(for: .failed(.untrustedPushPayload)),
            "callkit.phase_failed"
        )
    }

    func testProximityPresentationMaintainsOnlineMatrixAndLocalBLESeparation() throws {
        let controller = ProximityV2CheckInController()
        controller.configure(organisationId: orgId, provisioning: nil, onlineMatrixRoomId: nil)

        XCTAssertEqual(
            ProximitySurfacePresentation.onlineRelayStatusKey(for: controller.onlineMatrixRelayStatus),
            "proximity.online_disconnected"
        )
        XCTAssertEqual(
            ProximitySurfacePresentation.localRadioStatusKey(for: controller.localRadioStatus),
            "proximity.ble_status_awaiting_consent"
        )
        XCTAssertFalse(controller.hasVerifiedLocalRadioDelivery)

        try controller.grantForegroundConsent(forOrganisationId: orgId)
        XCTAssertEqual(
            ProximitySurfacePresentation.localRadioStatusKey(for: controller.localRadioStatus),
            "proximity.ble_status_unprovisioned"
        )

        controller.setForegroundActive(false)
        XCTAssertEqual(
            ProximitySurfacePresentation.localRadioStatusKey(for: controller.localRadioStatus),
            "proximity.ble_status_suspended_background"
        )

        controller.setOnlineMatrixRelayStatus(.connectedRoom(roomId: "!proximity:community.kodera.io"))
        XCTAssertEqual(
            ProximitySurfacePresentation.onlineRelayStatusKey(for: controller.onlineMatrixRelayStatus),
            "proximity.online_connected"
        )
        XCTAssertFalse(controller.hasVerifiedLocalRadioDelivery)
    }

    func testPasskeyDeviceBindingIntegratesInsideHostedAppTarget() throws {
        let key = P256.Signing.PrivateKey()
        var binding = try PasskeyDeviceBinding(
            organisationId: orgId,
            rpId: "accounts.kodera.io",
            origin: "https://accounts.kodera.io",
            credentialId: Data("ios-device-credential".utf8),
            publicSEC1Key: key.publicKey.x963Representation
        )
        let challenge = try binding.issueChallenge(organisationId: orgId, now: 1_000, lifetimeSeconds: 60)
        XCTAssertEqual(challenge.bytes.count, 32)
        XCTAssertEqual(binding.verifiedAssertionCount, 0)
    }

    func testChannelConversationScopeAdmitsActiveTextAndAudioCompanionChatAndModelSendsRetriesReactsAndClears() async throws {
        let textChannelId = "22222222-2222-4222-8222-222222222222"
        let audioChannelId = "33333333-3333-4333-8333-333333333333"
        let archivedChannelId = "44444444-4444-4444-8444-444444444444"

        let activeText = WorkspaceChannel(
            id: textChannelId,
            kind: .text,
            name: "general",
            templateKey: "general",
            topic: "Discussions d'équipe",
            lifecycle: .active,
            roomState: .ready,
            isConfidential: false
        )
        let activeAudio = WorkspaceChannel(
            id: audioChannelId,
            kind: .audio,
            name: "standup",
            templateKey: nil,
            topic: "Salon vocal",
            lifecycle: .active,
            roomState: .ready,
            isConfidential: false
        )
        let archivedText = WorkspaceChannel(
            id: archivedChannelId,
            kind: .text,
            name: "old",
            templateKey: nil,
            topic: "",
            lifecycle: .archived,
            roomState: .ready,
            isConfidential: false
        )

        let textScope = try XCTUnwrap(ChannelConversationScope(organisationId: orgId, channel: activeText))
        let audioScope = try XCTUnwrap(ChannelConversationScope(organisationId: orgId, channel: activeAudio))
        XCTAssertEqual(textScope.kind, .text)
        XCTAssertEqual(audioScope.kind, .audio)
        XCTAssertNil(ChannelConversationScope(organisationId: orgId, channel: archivedText))

        let transport = MockConversationTransport()
        let model = ChannelConversationModel(scope: textScope, transport: transport)
        await model.bootstrap()
        XCTAssertEqual(model.syncStateKey, "conversation.status_live")
        XCTAssertEqual(model.messages.count, 1)
        XCTAssertEqual(model.messages[0].body, "Bienvenue sur Kodera")

        // Fail first send, verify failed state, then retry to sent while keeping UI key intact.
        await transport.setShouldFailNextSend(true)
        model.selectReplyTarget(model.messages[0])
        model.composerText = "Merci !"
        await model.sendComposerMessage()

        XCTAssertEqual(model.messages.count, 2)
        let optimisticKey = model.messages[1].key
        let txnId = try XCTUnwrap(model.messages[1].transactionId)
        XCTAssertEqual(model.messages[1].deliveryStatus, .failed)

        await transport.setShouldFailNextSend(false)
        await model.retryFailedMessage(transactionId: txnId)
        XCTAssertEqual(model.messages[1].key, optimisticKey)
        XCTAssertEqual(model.messages[1].deliveryStatus, .sent)
        XCTAssertEqual(model.messages[1].replyPreview?.bodyExcerpt, "Bienvenue sur Kodera")

        // Toggle emoji reaction on and off.
        await model.toggleReaction(on: model.messages[0], emojiKey: "🎉")
        XCTAssertEqual(model.messages[0].reactions.first?.key, "🎉")
        XCTAssertEqual(model.messages[0].reactions.first?.count, 1)
        XCTAssertTrue(model.messages[0].reactions.first?.isSelectedByMe == true)

        await model.toggleReaction(on: model.messages[0], emojiKey: "🎉")
        XCTAssertTrue(model.messages[0].reactions.isEmpty)

        // Shareable text & session-fenced clear.
        XCTAssertEqual(
            ChannelConversationModel.shareableText(for: model.messages[1], channelName: "general"),
            "#general — alice: Merci !"
        )
        XCTAssertFalse(model.fence.isInvalidated)
        model.clear()
        XCTAssertTrue(model.fence.isInvalidated)
        XCTAssertTrue(model.messages.isEmpty)
    }

    func testChannelConversationRefusesReactionOnFailedOrSendingOptimisticMessages() async throws {
        let channel = WorkspaceChannel(
            id: "22222222-2222-4222-8222-222222222222",
            kind: .text,
            name: "general",
            templateKey: "general",
            topic: "",
            lifecycle: .active,
            roomState: .ready,
            isConfidential: false
        )
        let scope = try XCTUnwrap(ChannelConversationScope(organisationId: orgId, channel: channel))

        // Offline/nil-transport model produces a `.failed` optimistic message with `eventId == nil`.
        let offlineModel = ChannelConversationModel(scope: scope, transport: nil)
        offlineModel.composerText = "Message hors ligne"
        await offlineModel.sendComposerMessage()

        XCTAssertEqual(offlineModel.messages.count, 1)
        XCTAssertEqual(offlineModel.messages[0].deliveryStatus, .failed)
        XCTAssertNil(offlineModel.messages[0].eventId)
        XCTAssertFalse(ChannelConversationModel.canReact(to: offlineModel.messages[0]))

        // Tapping react must NEVER transition `.failed -> .sent` or fabricate a fake server eventId.
        await offlineModel.toggleReaction(on: offlineModel.messages[0], emojiKey: "👍")
        XCTAssertEqual(offlineModel.messages[0].deliveryStatus, .failed)
        XCTAssertNil(offlineModel.messages[0].eventId)
        XCTAssertTrue(offlineModel.messages[0].reactions.isEmpty)

        // Same invariant when a live transport send fails, until retry succeeds.
        let transport = MockConversationTransport()
        let liveModel = ChannelConversationModel(scope: scope, transport: transport)
        await liveModel.bootstrap()
        await transport.setShouldFailNextSend(true)
        liveModel.composerText = "À réessayer"
        await liveModel.sendComposerMessage()

        XCTAssertEqual(liveModel.messages.last?.deliveryStatus, .failed)
        let failedMsg = try XCTUnwrap(liveModel.messages.last)
        XCTAssertFalse(ChannelConversationModel.canReact(to: failedMsg))
        await liveModel.toggleReaction(on: failedMsg, emojiKey: "🔥")
        XCTAssertEqual(liveModel.messages.last?.deliveryStatus, .failed)
        XCTAssertTrue(liveModel.messages.last?.reactions.isEmpty == true)

        let txnId = try XCTUnwrap(failedMsg.transactionId)
        await transport.setShouldFailNextSend(false)
        await liveModel.retryFailedMessage(transactionId: txnId)
        let deliveredMsg = try XCTUnwrap(liveModel.messages.last)
        XCTAssertEqual(deliveredMsg.deliveryStatus, .sent)
        XCTAssertTrue(ChannelConversationModel.canReact(to: deliveredMsg))
        await liveModel.toggleReaction(on: deliveredMsg, emojiKey: "🔥")
        XCTAssertEqual(liveModel.messages.last?.reactions.first?.key, "🔥")
    }

    func testChannelConversationLimitedSyncGapBackfillsResetsStaleEventsAndPreservesFailedOptimisticRow() async throws {
        let channel = WorkspaceChannel(
            id: "22222222-2222-4222-8222-222222222222",
            kind: .text,
            name: "general",
            templateKey: "general",
            topic: "",
            lifecycle: .active,
            roomState: .ready,
            isConfidential: false
        )
        let scope = try XCTUnwrap(ChannelConversationScope(organisationId: orgId, channel: channel))
        let transport = MockConversationTransport()
        let model = ChannelConversationModel(scope: scope, transport: transport)
        await model.bootstrap()
        XCTAssertEqual(model.messages.map(\.body), ["Bienvenue sur Kodera"])

        // Enqueue a failed optimistic row before the incremental gap sync.
        await transport.setShouldFailNextSend(true)
        model.composerText = "Brouillon local en attente"
        await model.sendComposerMessage()
        XCTAssertEqual(model.messages.count, 2)
        XCTAssertEqual(model.messages[1].deliveryStatus, .failed)

        // Next sync reports `limited: true` with `prevBatch = "gap_token"`.
        let roomId = "!general:atelier.matrix.kodera.io"
        await transport.configureLimitedSync(
            roomId: roomId,
            prevBatch: "gap_token",
            backfilled: [
                MatrixRawTimelineEvent(
                    type: "m.room.message",
                    eventId: "$backfilled_1",
                    sender: "@camille:atelier.matrix.kodera.io",
                    originServerTs: 1_700_000_010_000,
                    msgtype: "m.text",
                    body: "Message récupéré après coupure"
                )
            ],
            postGap: [
                MatrixRawTimelineEvent(
                    type: "m.room.message",
                    eventId: "$live_after_gap",
                    sender: "@bob:atelier.matrix.kodera.io",
                    originServerTs: 1_700_000_020_000,
                    msgtype: "m.text",
                    body: "Message récent après reprise"
                )
            ]
        )

        await model.refreshSync()
        // Pre-gap `$welcome` was reset; backfilled + post-gap + failed optimistic row remain intact!
        XCTAssertEqual(
            model.messages.map(\.body),
            [
                "Message récupéré après coupure",
                "Message récent après reprise",
                "Brouillon local en attente",
            ]
        )
        XCTAssertEqual(model.messages.last?.deliveryStatus, .failed)
    }

    func testAppSessionModelWiresProductionTransportRevokesPushAndPropagatesVaultWipeFailure() async throws {
        let suiteName = "io.kodera.tests.r2.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(true, forKey: FirstLaunch.markerKey)

        let oidcStore = InMemoryTokenStore()
        let vaultKeyStore = FaultyVaultTokenStore()
        let vaultSealedStore = InMemoryTokenStore()
        let vault = KeychainSessionVault(keyStore: vaultKeyStore, sealedStore: vaultSealedStore)

        let appConfig = AppConfiguration.read({ key in
            switch key {
            case "KoderaCoreOrigin": "https://api.kodera.test"
            case "KoderaIssuerOrigins": "https://auth.kodera.test"
            case "KoderaClientID": "synthetic-client"
            default: ""
            }
        }, loopback: .refuse, admitsDevelopmentIssuer: false)
        let signInConfig = try XCTUnwrap(appConfig.signIn)
        let oidcSubject = "oidc-sub-77777777-8888-4999-8000-aaaaaaaaaaaa"
        let backend = StubSignInBackend(oidcSubject: oidcSubject)
        let signInService = KoderaSignInService(configuration: signInConfig, store: oidcStore, backend: backend)

        let scenario = R2CoreProtocolScenario(organisationId: orgId, expectedOidcSubject: oidcSubject)
        R2CoreProtocol.install(scenario)
        defer { R2CoreProtocol.install(nil) }

        let channelsLoader = OrganisationChannelsLoader()
        let injectedWorkspace = WorkspaceSnapshot(
            organisationId: orgId, state: .initialised,
            setup: WorkspaceSetup(state: .ready, reason: nil), canInitialise: false,
            id: "99999999-9999-4999-8999-999999999999",
            categories: [WorkspaceCategory(
                id: "88888888-8888-4888-8888-888888888888", name: "General", templateKey: nil,
                channels: [WorkspaceChannel(
                    id: "22222222-2222-4222-8222-222222222222", kind: .text, name: "general",
                    templateKey: "general", topic: "General", lifecycle: .active,
                    roomState: .ready, isConfidential: false
                )]
            )], uncategorisedChannels: []
        )
        let model = AppSessionModel(
            configuration: appConfig,
            service: signInService,
            store: oidcStore,
            defaults: defaults,
            channels: channelsLoader,
            requesterFactory: { origin, policy, tokens in
                try CoreRequester(
                    coreApiOrigin: origin,
                    loopback: policy,
                    tokens: tokens,
                    protocolClass: R2CoreProtocol.self,
                    timeout: 5
                )
            },
            sessionVault: vault,
            matrixSsoAuthorizerFactory: { _ in
                { req throws(MatrixClientFailure) -> MatrixSsoTokenGrant in
                    try MatrixRoomClient.consumeSsoCallbackURI(
                        "\(req.callbackURI)&loginToken=sso_tok_r3_live",
                        expectedState: req.state
                    )
                }
            },
            matrixProtocolClass: R2CoreProtocol.self,
            fetchWorkspace: { _ in .loaded(injectedWorkspace) }
        )

        model.setForeground(true)
        await model.start()
        guard case .signedOut = model.phase else {
            XCTFail("Expected signedOut after fresh start")
            return
        }

        model.signIn(issuer: "https://auth.kodera.test/realms/atelier")
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if case .loaded = model.workspace { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        guard case let .loaded(snapshot) = model.workspace else {
            XCTFail("Expected workspace snapshot to load")
            return
        }

        let channel = try XCTUnwrap(snapshot.categories.first?.channels.first)

        // 1. Regression (Items 1 & 2): MemberProfile.id != oidcSubject; if Synapse returns `@<MemberProfile.id>:...`,
        // login MUST immediately call `/_matrix/client/v3/logout` and fail closed!
        scenario.returnMismatchedMemberPersonIdNextLogin = true
        model.openChannel(channel, organisationId: orgId)
        let mismatchedConv = try XCTUnwrap(model.activeConversation)
        await mismatchedConv.bootstrap()
        XCTAssertEqual(mismatchedConv.syncStateKey, "conversation.status_offline")
        XCTAssertEqual(scenario.workspaceFetchCount, 0)
        XCTAssertEqual(scenario.matrixLogoutTokens, ["Bearer aaa_bad"])
        model.closeChannel()

        // 2. Valid Synapse SSO `m.login.token` matching `@<oidcSubject>:atelier.kodera.test` succeeds,
        // seals credentials in `sessionVault`, and `openChannel -> closeChannel -> signOut` revokes Matrix session!
        model.openChannel(channel, organisationId: orgId)
        let activeConv = try XCTUnwrap(model.activeConversation)
        XCTAssertTrue(activeConv.hasLiveTransport)
        await activeConv.bootstrap()
        XCTAssertEqual(activeConv.syncStateKey, "conversation.status_live")
        XCTAssertEqual(scenario.workspaceFetchCount, 0)
        XCTAssertEqual(scenario.lastMatrixLoginType, "m.login.token")

        activeConv.stopSyncLoop()
        activeConv.composerText = "Failed retry payload"
        await activeConv.sendComposerMessage()
        let failedTransaction = try XCTUnwrap(activeConv.messages.last?.transactionId)
        XCTAssertEqual(activeConv.messages.last?.deliveryStatus, .failed)
        activeConv.composerText = "Draft preserved during retry"
        activeConv.stageAttachment(try AttachmentUploadPayload(filename: "draft.ogg", contentType: .oggAudio, data: Data([1])))
        var authority = OrganisationChannelsLoader.State()
        authority.member = model.member
        for workspace in [OrganisationChannelsLoader.Workspace.loading, .unavailable(.serviceUnavailable), .unavailable(.identityUnavailable), .unavailable(.transport(.offline))] {
            authority.workspace = workspace
            channelsLoader.onChange(authority)
            XCTAssertTrue(model.activeConversation === activeConv)
            XCTAssertEqual(activeConv.composerText, "Draft preserved during retry")
            XCTAssertEqual(activeConv.stagedAttachments.count, 1)
            XCTAssertFalse(activeConv.fence.isInvalidated)
        }
        authority.workspace = .unavailable(.notFound)
        channelsLoader.onChange(authority)
        XCTAssertNil(model.activeConversation)
        XCTAssertEqual(activeConv.composerText, "")
        XCTAssertTrue(activeConv.stagedAttachments.isEmpty)
        XCTAssertTrue(activeConv.messages.isEmpty)
        XCTAssertTrue(activeConv.fence.isInvalidated)
        await activeConv.retryFailedMessage(transactionId: failedTransaction)
        XCTAssertTrue(activeConv.messages.isEmpty)

        // Register payload-free push wakeup and verify strict 4-key JSON body (`platform: "ios"`, no `surface`).
        let pushDeviceId = "01935800-0000-7000-8000-000000000777"
        try await model.registerPushWakeup(
            deviceId: pushDeviceId,
            endpoint: "https://push.kodera.test/up/opaque123",
            p256dh: "B" + String(repeating: "A", count: 86),
            auth: String(repeating: "A", count: 22)
        )
        XCTAssertEqual(scenario.lastPutBodyKeys, ["auth", "endpoint", "p256dh", "platform"])

        // Inject vault wipe fault and sign out -> must revoke push, call `/_matrix/client/v3/logout` despite `closeChannel()`,
        // AND propagate `session.not_wiped`.
        vaultKeyStore.failWipes = true
        model.signOut()

        let signOutDeadline = Date().addingTimeInterval(5)
        while Date() < signOutDeadline {
            if scenario.deletedPushPaths.count == 1
                && scenario.matrixLogoutTokens.count == 2
                && model.noticeKey == "session.not_wiped" {
                break
            }
            try await Task.sleep(nanoseconds: 20_000_000)
        }

        if case .signedOut = model.phase {} else {
            XCTFail("Expected signedOut phase after signOut")
        }
        XCTAssertEqual(model.noticeKey, "session.not_wiped")
        XCTAssertEqual(scenario.deletedPushPaths, ["/api/v1/push/subscriptions/\(pushDeviceId)"])
        XCTAssertEqual(scenario.matrixLogoutTokens, [
            "Bearer aaa_bad",
            "Bearer aaa_ok",
        ])
        XCTAssertFalse(defaults.bool(forKey: FirstLaunch.markerKey))

        // 3. Regression (Item 5): Same-process `signIn()` while `sessionVault.wipe()` continues failing
        // MUST be refused immediately and remain in `.signedOut` with `noticeKey == "session.not_wiped"`!
        let authCountBeforeRefusal = await backend.authorizeCount
        model.signIn(issuer: "https://auth.kodera.test/realms/atelier")
        XCTAssertEqual(model.phase, .signedOut)
        XCTAssertEqual(model.noticeKey, "session.not_wiped")
        let authCountAfterRefusal = await backend.authorizeCount
        XCTAssertEqual(authCountAfterRefusal, authCountBeforeRefusal)

        // Once the vault wipe fault clears, same-process `signIn()` wipes cleanly and enters the new session.
        vaultKeyStore.failWipes = false
        model.signIn(issuer: "https://auth.kodera.test/realms/atelier")
        let reSignInDeadline = Date().addingTimeInterval(5)
        while Date() < reSignInDeadline {
            if case .signedIn = model.phase { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        if case .signedIn = model.phase {} else {
            XCTFail("Expected signedIn after vault wipe fault cleared")
        }
        XCTAssertNil(model.noticeKey)
    }
}

private final class FaultyVaultTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: Data?
    var failWipes: Bool {
        get { lock.withLock { _failWipes } }
        set { lock.withLock { _failWipes = newValue } }
    }
    private var _failWipes = false

    func load() throws(TokenStoreFailure) -> Data? { lock.withLock { storage } }
    func save(_ data: Data) throws(TokenStoreFailure) { lock.withLock { storage = data } }
    func wipe() throws(TokenStoreFailure) {
        let shouldFail = lock.withLock {
            if _failWipes { return true }
            storage = nil
            return false
        }
        if shouldFail { throw .keychain(-25_244) }
    }
}

private actor StubSignInBackend: AuthorizationBackend {
    let oidcSubject: String
    private(set) var authorizeCount = 0

    init(oidcSubject: String) {
        self.oidcSubject = oidcSubject
    }

    func authorize(issuer: AdmittedIssuer, configuration: SignInConfiguration) async throws(BackendFailure) -> StoredGrant {
        authorizeCount += 1
        return StoredGrant(issuer: issuer.issuer, archive: Data("grant-r2-\(authorizeCount)".utf8), subject: oidcSubject)
    }

    func freshAccessToken(grant: StoredGrant, forceRefresh: Bool) async throws(BackendFailure) -> FreshToken {
        FreshToken(accessToken: "oidc-r2-token", grant: StoredGrant(issuer: grant.issuer, archive: grant.archive, subject: oidcSubject))
    }

    func revoke(grant: StoredGrant, issuer: AdmittedIssuer, configuration: SignInConfiguration) async {}

    nonisolated func authenticatedSubject(for grant: StoredGrant) -> String? {
        grant.subject ?? oidcSubject
    }
}

private final class R2CoreProtocolScenario: @unchecked Sendable {
    let organisationId: String
    let expectedOidcSubject: String
    private let lock = NSLock()
    private var _lastPutBodyKeys: [String] = []
    private var _deletedPushPaths: [String] = []
    private var _lastMatrixLoginType: String?
    private var _matrixLogoutTokens: [String] = []
    private var _mismatchNextLogin = false
    private var _workspaceFetchCount = 0

    init(organisationId: String, expectedOidcSubject: String) {
        self.organisationId = organisationId
        self.expectedOidcSubject = expectedOidcSubject
    }

    var workspaceFetchCount: Int { lock.withLock { _workspaceFetchCount } }
    func recordWorkspaceFetch() { lock.withLock { _workspaceFetchCount += 1 } }

    var lastPutBodyKeys: [String] { lock.withLock { _lastPutBodyKeys } }
    var deletedPushPaths: [String] { lock.withLock { _deletedPushPaths } }
    var lastMatrixLoginType: String? { lock.withLock { _lastMatrixLoginType } }
    var matrixLogoutTokens: [String] { lock.withLock { _matrixLogoutTokens } }
    var returnMismatchedMemberPersonIdNextLogin: Bool {
        get { lock.withLock { _mismatchNextLogin } }
        set { lock.withLock { _mismatchNextLogin = newValue } }
    }

    func recordPutKeys(_ keys: [String]) {
        lock.withLock { _lastPutBodyKeys = keys.sorted() }
    }

    func recordDelete(_ path: String) {
        lock.withLock { _deletedPushPaths.append(path) }
    }

    func recordMatrixLogin(type: String?) {
        lock.withLock { _lastMatrixLoginType = type }
    }

    func consumeMismatchNextLogin() -> Bool {
        lock.withLock {
            let v = _mismatchNextLogin
            _mismatchNextLogin = false
            return v
        }
    }

    func recordMatrixLogout(authHeader: String?) {
        lock.withLock { _matrixLogoutTokens.append(authHeader ?? "") }
    }
}

private final class R2CoreProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private nonisolated(unsafe) static var scenario: R2CoreProtocolScenario?

    static func install(_ value: R2CoreProtocolScenario?) {
        lock.withLock { scenario = value }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let scenario = Self.lock.withLock({ Self.scenario }),
              let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        let method = request.httpMethod ?? "GET"
        let path = url.path
        let status: Int
        let responseBody: Data

        if method == "GET" && path == "/api/v1/me" {
            status = 200
            let payload = """
            {
              "id": "11111111-2222-4333-8444-555555555555",
              "email": "alice@kodera.test",
              "display_name": "Alice",
              "organisations": [
                {
                  "organisation": {
                    "id": "\(scenario.organisationId)",
                    "slug": "atelier",
                    "name": "Atelier",
                    "realm": "atelier"
                  },
                  "role": "org_owner",
                  "state": "active"
                }
              ]
            }
            """
            responseBody = Data(payload.utf8)
        } else if method == "GET" && path == "/api/v1/organisations/\(scenario.organisationId)/workspace" {
            scenario.recordWorkspaceFetch()
            status = 200
            let payload = """
            {
              "organisation_id": "\(scenario.organisationId)",
              "state": "initialised",
              "setup": { "state": "ready", "reason": null },
              "can_initialise": false,
              "id": "99999999-9999-4999-8999-999999999999",
              "categories": [
                {
                  "id": "88888888-8888-4888-8888-888888888888",
                  "name": "Général",
                  "template_key": null,
                  "channels": [
                    {
                      "id": "22222222-2222-4222-8222-222222222222",
                      "kind": "text",
                      "name": "general",
                      "template_key": "general",
                      "topic": "Discussions",
                      "lifecycle": "active",
                      "room_state": "ready",
                      "is_confidential": false
                    }
                  ]
                }
              ],
              "uncategorised_channels": []
            }
            """
            responseBody = Data(payload.utf8)
        } else if method == "PUT" && path.hasPrefix("/api/v1/push/subscriptions/") {
            let raw = Self.readBody(from: request)
            if let obj = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any] {
                scenario.recordPutKeys(Array(obj.keys))
            }
            status = 204
            responseBody = Data()
        } else if method == "DELETE" && path.hasPrefix("/api/v1/push/subscriptions/") {
            scenario.recordDelete(path)
            status = 204
            responseBody = Data()
        } else if method == "POST" && path == "/_matrix/client/v3/login" {
            let raw = Self.readBody(from: request)
            let obj = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any]
            scenario.recordMatrixLogin(type: obj?["type"] as? String)
            let deviceId = (obj?["device_id"] as? String) ?? "DEV1"
            status = 200
            if scenario.consumeMismatchNextLogin() {
                let badJson = """
                {"user_id":"@11111111-2222-4333-8444-555555555555:atelier.kodera.test","access_token":"aaa_bad","refresh_token":"rrr_bad","device_id":"\(deviceId)"}
                """
                responseBody = Data(badJson.utf8)
            } else {
                let okJson = """
                {"user_id":"@\(scenario.expectedOidcSubject):atelier.kodera.test","access_token":"aaa_ok","refresh_token":"rrr_ok","device_id":"\(deviceId)"}
                """
                responseBody = Data(okJson.utf8)
            }
        } else if method == "GET" && path.hasPrefix("/_matrix/client/v3/directory/room/") {
            status = 200
            responseBody = Data(#"{"room_id":"!general:atelier.kodera.test"}"#.utf8)
        } else if method == "POST" && path.hasPrefix("/_matrix/client/v3/rooms/") && path.hasSuffix("/join") {
            status = 200
            responseBody = Data(#"{"room_id":"!general:atelier.kodera.test"}"#.utf8)
        } else if method == "GET" && path == "/_matrix/client/v3/sync" {
            status = 200
            responseBody = Data(#"{"next_batch":"s_live_1","rooms":{"join":{"!general:atelier.kodera.test":{"state":{"events":[]},"timeline":{"events":[]}}}}}"#.utf8)
        } else if method == "POST" && path == "/_matrix/client/v3/logout" {
            scenario.recordMatrixLogout(authHeader: request.value(forHTTPHeaderField: "Authorization"))
            status = 200
            responseBody = Data("{}".utf8)
        } else {
            status = 404
            responseBody = Data("{}".utf8)
        }

        let response = HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !responseBody.isEmpty {
            client?.urlProtocol(self, didLoad: responseBody)
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readBody(from request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var out = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buf, maxLength: buf.count)
            if n <= 0 { break }
            out.append(buf, count: n)
        }
        return out
    }
}

private actor MockConversationTransport: ChannelConversationTransport {
    nonisolated let ownUserId = "@alice:atelier.matrix.kodera.io"
    private var shouldFailNextSend = false
    private var counter = 0
    private var backfillFailure: MatrixClientFailure?
    func failBackfill(_ failure: MatrixClientFailure) { backfillFailure = failure }
    private var bootstrapFailure: MatrixClientFailure?
    func failBootstrap(_ failure: MatrixClientFailure?) { bootstrapFailure = failure }
    private var syncFailure: MatrixClientFailure?
    func failSync(_ failure: MatrixClientFailure) { syncFailure = failure }
    func setSyncBatch(_ batch: MatrixSyncBatch) { pendingLimitedBatch = batch }
    private var pendingLimitedBatch: MatrixSyncBatch?
    private var pendingBackfill: [MatrixRawTimelineEvent] = []

    func setShouldFailNextSend(_ value: Bool) {
        shouldFailNextSend = value
    }

    func configureLimitedSync(
        roomId: String,
        prevBatch: String,
        backfilled: [MatrixRawTimelineEvent],
        postGap: [MatrixRawTimelineEvent]
    ) {
        pendingLimitedBatch = MatrixSyncBatch(
            nextBatch: "s_after_gap",
            roomDeltas: [
                roomId: MatrixRoomSyncDelta(events: postGap, limited: true, prevBatch: prevBatch)
            ]
        )
        pendingLimitedBatch?.plaintextAllowedRooms = [roomId]
        pendingBackfill = backfilled
    }

    func bootstrapRoom(
        organisationId: String,
        channelId: String
    ) async throws(MatrixClientFailure) -> (roomId: String, initialBatch: MatrixSyncBatch) {
        if let bootstrapFailure { throw bootstrapFailure }
        let roomId = "!general:atelier.matrix.kodera.io"
        var batch = MatrixSyncBatch(
            nextBatch: "s1",
            roomEvents: [
                roomId: [
                    MatrixRawTimelineEvent(
                        type: "m.room.message",
                        eventId: "$welcome",
                        sender: "@bob:atelier.matrix.kodera.io",
                        originServerTs: 1_700_000_000_000,
                        msgtype: "m.text",
                        body: "Bienvenue sur Kodera"
                    )
                ]
            ]
        )
        batch.plaintextAllowedRooms = [roomId]
        return (roomId, batch)
    }

    func syncRoom(roomId: String, since: String?) async throws(MatrixClientFailure) -> MatrixSyncBatch {
        if let syncFailure { throw syncFailure }
        if let batch = pendingLimitedBatch {
            pendingLimitedBatch = nil
            return batch
        }
        var batch = MatrixSyncBatch(nextBatch: "s2", roomEvents: [:])
        batch.plaintextAllowedRooms = [roomId]
        return batch
    }

    func backfillRoomMessages(
        roomId: String,
        fromToken: String,
        limit: Int
    ) async throws(MatrixClientFailure) -> [MatrixRawTimelineEvent] {
        if let backfillFailure { throw backfillFailure }
        let items = pendingBackfill
        pendingBackfill = []
        return items
    }

    func sendMessage(
        roomId: String,
        transactionId: String,
        body: String,
        replyToEventId: String?,
        attachments: [AttachmentMetadataRef]
    ) async throws(MatrixClientFailure) -> String {
        if shouldFailNextSend {
            throw .serviceUnavailable
        }
        counter += 1
        return "$sent_\(counter)"
    }

    func editMessage(
        roomId: String,
        transactionId: String,
        targetEventId: String,
        newBody: String
    ) async throws(MatrixClientFailure) -> String {
        counter += 1
        return "$edit_\(counter)"
    }

    func redactEvent(
        roomId: String,
        transactionId: String,
        targetEventId: String
    ) async throws(MatrixClientFailure) -> String {
        counter += 1
        return "$redact_\(counter)"
    }

    func sendReaction(
        roomId: String,
        transactionId: String,
        targetEventId: String,
        emojiKey: String
    ) async throws(MatrixClientFailure) -> String {
        counter += 1
        return "$react_\(counter)"
    }

    func uploadAttachment(
        organisationId: String,
        channelId: String,
        payload: AttachmentUploadPayload
    ) async throws(MatrixClientFailure) -> AttachmentMetadataRef {
        counter += 1
        return try! AttachmentMetadataRef(
            id: "01935800-0000-7000-8000-000000000999",
            filename: payload.filename,
            contentType: payload.contentType,
            sizeBytes: payload.data.count
        )
    }
}

private struct ConversationCallResolver: NativeCallResolving {
    let roomId: String
    func resolve(_ wake: NativeCallWake) async throws -> AuthenticatedNativeCall {
        try AuthenticatedNativeCall(wake: wake, roomId: roomId, callerLabel: "Member")
    }
}
@MainActor private final class ConversationCallMedia: LiveKitWebRTCSession {
    var disconnects = 0; var microphoneEnabled = false
    func connect(_ call: AuthenticatedNativeCall) async throws {}
    func microphone(enabled: Bool) async throws { microphoneEnabled = enabled }
    func audioSession(active: Bool) {}
    func networkPathChanged() async throws {}
    func disconnect() { disconnects += 1; microphoneEnabled = false }
}
