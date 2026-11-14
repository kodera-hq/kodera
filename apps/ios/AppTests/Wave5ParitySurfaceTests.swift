import CryptoKit
import Foundation
import SwiftUI
import XCTest
import KoderaAuth
import KoderaClient
import KoderaDomain
@testable import Kodera

@MainActor
final class Wave5ParitySurfaceTests: XCTestCase {
    private let orgId = "11111111-1111-4111-8111-111111111111"

    func testCielThemeAndPaletteMappingResolvesLightAndDarkTokens() {
        XCTAssertEqual(KoderaTokens.Theme.defaultTheme, .ciel)
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
}
