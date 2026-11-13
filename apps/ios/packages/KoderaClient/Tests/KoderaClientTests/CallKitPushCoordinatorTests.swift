import Foundation
import XCTest
import KoderaDomain
@testable import KoderaClient

private actor StubCallResolver: AuthenticatedCallStateResolver {
    private let callerLabel: String
    private let hasVideo: Bool
    private let shouldFail: Bool

    init(callerLabel: String = "Design Partners Audio", hasVideo: Bool = true, shouldFail: Bool = false) {
        self.callerLabel = callerLabel
        self.hasVideo = hasVideo
        self.shouldFail = shouldFail
    }

    func resolveEncryptedCall(wakeup: IncomingCallWakeup) async throws -> VerifiedCallDescriptor {
        if shouldFail {
            struct ResolutionError: Error {}
            throw ResolutionError()
        }
        return try VerifiedCallDescriptor(
            wakeupId: wakeup.wakeupId,
            organisationId: wakeup.organisationId,
            roomId: "!room-alpha:community.kodera.io",
            liveKitRoomName: "lk_room_alpha_01",
            callerLabel: callerLabel,
            hasVideo: hasVideo
        )
    }
}

private actor RecordingSystemCallProvider: SystemCallProviderControlling {
    enum Event: Equatable, Sendable {
        case incoming(UUID, String, Bool)
        case connecting(UUID)
        case connected(UUID)
        case ended(UUID, CallEndReason)
    }

    private(set) var events: [Event] = []
    private let rejectIncoming: Bool

    init(rejectIncoming: Bool = false) {
        self.rejectIncoming = rejectIncoming
    }

    func reportIncomingCall(uuid: UUID, callerLabel: String, hasVideo: Bool) async throws {
        if rejectIncoming {
            struct ProviderRejected: Error {}
            throw ProviderRejected()
        }
        events.append(.incoming(uuid, callerLabel, hasVideo))
    }

    func reportConnecting(uuid: UUID) async {
        events.append(.connecting(uuid))
    }

    func reportConnected(uuid: UUID) async {
        events.append(.connected(uuid))
    }

    func reportCallEnded(uuid: UUID, reason: CallEndReason) async {
        events.append(.ended(uuid, reason))
    }
}

@MainActor
final class CallKitPushCoordinatorTests: XCTestCase {
    private let orgA = "11111111-1111-4111-8111-111111111111"
    private let orgB = "22222222-2222-4222-8222-222222222222"
    private let wakeupA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private let wakeupB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

    func testRejectsCleartextPushPayloadsAndNeverPassesRelayStringsToCallKit() async throws {
        let provider = RecordingSystemCallProvider()
        let resolver = StubCallResolver(callerLabel: "Authenticated Session Room", hasVideo: false)
        let coordinator = try CallKitPushCoordinator(
            organisationId: orgA,
            admissionPolicy: .rejectCleartext,
            resolver: resolver,
            systemProvider: provider
        )

        let leakedRoomTitle: [String: Any] = [
            "wakeup_id": wakeupA,
            "organisation_id": orgA,
            "sync_hint": "sync_01",
            "room_title": "Confidential Strategy Room",
        ]
        let rejected = await coordinator.handleIncomingPushPayload(leakedRoomTitle)
        XCTAssertEqual(rejected, .failure(.cleartextPayloadForbidden(field: "room_title")))
        XCTAssertEqual(coordinator.state.phase, .failed(.untrustedPushPayload))
        let providerEventsAfterReject = await provider.events
        XCTAssertTrue(providerEventsAfterReject.isEmpty)

        // Under `.stripUntrustedRelayFields`, relay strings are stripped and ONLY authenticated session metadata reaches CallKit.
        let strippingCoordinator = try CallKitPushCoordinator(
            organisationId: orgA,
            admissionPolicy: .stripUntrustedRelayFields,
            resolver: resolver,
            systemProvider: provider
        )
        let untrustedRelayPayload: [String: Any] = [
            "wakeup_id": wakeupA,
            "organisation_id": orgA,
            "sync_hint": "sync_01",
            "sender_display_name": "Forged Push Caller",
            "message": "Plaintext body over APNs",
        ]
        let strippedOutcome = await strippingCoordinator.handleIncomingPushPayload(untrustedRelayPayload)
        let wakeup = try strippedOutcome.get()
        XCTAssertEqual(
            strippingCoordinator.lastStrippedPushFields,
            Set(["sender_display_name", "message"])
        )
        let events = await provider.events
        XCTAssertEqual(events, [.incoming(wakeup.callUUID, "Authenticated Session Room", false)])
    }

    func testFullDeterministicCallLifecycleAndReplayAndOrganisationSwitchProtection() async throws {
        let provider = RecordingSystemCallProvider()
        let resolver = StubCallResolver(callerLabel: "Office Hours Audio", hasVideo: true)
        let coordinator = try CallKitPushCoordinator(
            organisationId: orgA,
            admissionPolicy: .rejectCleartext,
            resolver: resolver,
            systemProvider: provider
        )

        let cleanPayload: [String: Any] = [
            "wakeup_id": wakeupA,
            "organisation_id": orgA,
            "sync_hint": "matrixrtc:sync_42",
            "aps": ["content-available": 1],
        ]
        let data = try JSONSerialization.data(withJSONObject: cleanPayload)
        let wakeup = try await coordinator.handleIncomingPushData(data).get()
        XCTAssertEqual(coordinator.state.activeCallUUID, wakeup.callUUID)
        XCTAssertTrue(coordinator.state.isVideoEnabled)

        try await coordinator.answerCall(uuid: wakeup.callUUID)
        if case .connecting = coordinator.state.phase {} else {
            XCTFail("Expected .connecting after answerCall")
        }

        try await coordinator.markMediaConnected(uuid: wakeup.callUUID)
        XCTAssertFalse(coordinator.state.isMuted)
        XCTAssertFalse(coordinator.state.isHeld)

        try coordinator.setMuted(true, uuid: wakeup.callUUID)
        XCTAssertTrue(coordinator.state.isMuted)
        try coordinator.setHeld(true, uuid: wakeup.callUUID)
        XCTAssertTrue(coordinator.state.isHeld)
        try coordinator.setHeld(false, uuid: wakeup.callUUID)
        try coordinator.setMuted(false, uuid: wakeup.callUUID)
        XCTAssertFalse(coordinator.state.isMuted)
        XCTAssertFalse(coordinator.state.isHeld)

        try await coordinator.endCall(uuid: wakeup.callUUID, reason: .localHangup)
        XCTAssertEqual(coordinator.state.phase, .ended(.localHangup))

        // Replaying the same wakeup_id is rejected deterministically.
        let replay = await coordinator.handleIncomingPushData(data)
        XCTAssertEqual(replay, .failure(.replayWakeup))
        XCTAssertEqual(coordinator.state.phase, .failed(.replayWakeup))

        // Start a second valid call, then switch organisations and verify CallKit is notified of termination.
        let secondPayload: [String: Any] = [
            "wakeup_id": wakeupB,
            "organisation_id": orgA,
            "sync_hint": "matrixrtc:sync_43",
        ]
        let secondWakeup = try await coordinator.handleIncomingPushPayload(secondPayload).get()
        try await coordinator.switchOrganisation(orgB)
        XCTAssertEqual(coordinator.state.organisationId, orgB)
        XCTAssertNil(coordinator.state.activeCallUUID)

        let events = await provider.events
        XCTAssertEqual(events, [
            .incoming(wakeup.callUUID, "Office Hours Audio", true),
            .connecting(wakeup.callUUID),
            .connected(wakeup.callUUID),
            .ended(wakeup.callUUID, .localHangup),
            .incoming(secondWakeup.callUUID, "Office Hours Audio", true),
            .ended(secondWakeup.callUUID, .organisationChanged),
        ])
    }
}
