import Foundation
import XCTest
import KoderaDomain
@testable import KoderaClient

private let callOrg = "22222222-2222-4222-8222-222222222222"
private let callId = "11111111-1111-4111-8111-111111111111"
private let callChannel = "33333333-3333-4333-8333-333333333333"
private func callWake(_ state: NativeRingPhase = .ringing, epoch: UInt64 = 1) throws -> NativeCallWake {
    try NativeCallWake(callId: callId, organisationId: callOrg, channelId: callChannel, epoch: epoch, state: state, expiresAt: 130)
}
private struct ImmediateCallResolver: NativeCallResolving {
    var fails = false
    func resolve(_ wake: NativeCallWake) async throws -> AuthenticatedNativeCall {
        if fails { throw KoderaMobileFfiError.authenticationFailed }
        return try AuthenticatedNativeCall(wake: wake, roomId: "!room:example.org", callerLabel: "Member")
    }
}
private actor HeldCallResolver: NativeCallResolving {
    private var entered = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var gate: CheckedContinuation<Void, Never>?
    func waitUntilEntered() async {
        if entered { return }; await withCheckedContinuation { waiters.append($0) }
    }
    func release() { gate?.resume(); gate = nil }
    func resolve(_ wake: NativeCallWake) async throws -> AuthenticatedNativeCall {
        await withCheckedContinuation { continuation in
            gate = continuation; entered = true; waiters.forEach { $0.resume() }; waiters.removeAll()
        }
        return try AuthenticatedNativeCall(wake: wake, roomId: "!room:example.org", callerLabel: "Member")
    }
}
@MainActor private final class CallMediaFixture: LiveKitWebRTCSession {
    var connections = 0; var disconnects = 0; var microphoneValues: [Bool] = []; var networks = 0
    func connect(_ call: AuthenticatedNativeCall) async throws { connections += 1 }
    func microphone(enabled: Bool) async throws { microphoneValues.append(enabled) }
    func audioSession(active: Bool) {}
    func networkPathChanged() async throws { networks += 1 }
    func disconnect() { disconnects += 1 }
}
@MainActor private final class CallPresenterFixture: NativeCallPresenting {
    var reasons: [NativeRingPhase] = []; var metadataCount = 0
    func metadata(_ call: AuthenticatedNativeCall) { metadataCount += 1 }
    func connected(callId: String) {}
    func ended(callId: String, reason: NativeRingPhase) { reasons.append(reason) }
}
private actor CallChatFixture: ChannelConversationTransport {
    nonisolated let ownUserId = "@member:example.org"
    private var events: [MatrixRawTimelineEvent] = []
    private var refuse = false
    func deny() { refuse = true }
    func setEvents(_ value: [MatrixRawTimelineEvent]) { events = value }
    func bootstrapRoom(organisationId: String, channelId: String) async throws(MatrixClientFailure) -> (roomId: String, initialBatch: MatrixSyncBatch) {
        ("!room:example.org", MatrixSyncBatch(nextBatch: "one", roomEvents: [:]))
    }
    func syncRoom(roomId: String, since: String?) async throws(MatrixClientFailure) -> MatrixSyncBatch {
        MatrixSyncBatch(nextBatch: "two", roomEvents: [roomId: events])
    }
    func sendMessage(roomId: String, transactionId: String, body: String, replyToEventId: String?, attachments: [AttachmentMetadataRef]) async throws(MatrixClientFailure) -> String {
        if refuse { throw .notFound }; return "$sent"
    }
    func editMessage(roomId: String, transactionId: String, targetEventId: String, newBody: String) async throws(MatrixClientFailure) -> String { "$edited" }
    func redactEvent(roomId: String, transactionId: String, targetEventId: String) async throws(MatrixClientFailure) -> String { "$redacted" }
    func sendReaction(roomId: String, transactionId: String, targetEventId: String, emojiKey: String) async throws(MatrixClientFailure) -> String { "$reaction" }
    func uploadAttachment(organisationId: String, channelId: String, payload: AttachmentUploadPayload) async throws(MatrixClientFailure) -> AttachmentMetadataRef { throw .notFound }
}
@MainActor private final class ImmediateReporterFixture: ImmediateVoIPReporting {
    var reports: [UUID] = []; var ended: [UUID] = []; var completions: [@MainActor (Bool) -> Void] = []
    func report(uuid: UUID, completion: @escaping @MainActor (Bool) -> Void) { reports.append(uuid); completions.append(completion) }
    func end(uuid: UUID, reason: NativeRingPhase) { ended.append(uuid) }
}

@MainActor final class NativeCallCoordinatorTests: XCTestCase {
    func testCancelDuringResolutionFencesLateMetadataAndMedia() async throws {
        let resolver = HeldCallResolver(); let media = CallMediaFixture(); let presenter = CallPresenterFixture()
        let coordinator = try NativeCallCoordinator(organisationId: callOrg, localPartyId: "local", resolver: resolver, media: media, conversation: CallChatFixture(), now: { 100 })
        coordinator.bind(presenter)
        let wake = try callWake()
        let receiving = Task { try await coordinator.receive(wake) }
        await resolver.waitUntilEntered()
        try await coordinator.receive(callWake(.answeredElsewhere, epoch: 2))
        await resolver.release(); try await receiving.value
        XCTAssertNil(coordinator.call); XCTAssertEqual(media.connections, 0); XCTAssertEqual(presenter.metadataCount, 0)
        XCTAssertEqual(presenter.reasons, [.answeredElsewhere]); XCTAssertEqual(coordinator.ring.records[callId]?.missed, false)
    }
    func testAudioHandoffChatAndAuthenticatedMatrixAnswerDeduplicate() async throws {
        let media = CallMediaFixture(); let chat = CallChatFixture(); let presenter = CallPresenterFixture()
        let coordinator = try NativeCallCoordinator(organisationId: callOrg, localPartyId: "local", resolver: ImmediateCallResolver(), media: media, conversation: chat, now: { 100 })
        coordinator.bind(presenter); try await coordinator.receive(callWake()); try await coordinator.answer(callId: callId)
        XCTAssertEqual(media.microphoneValues.last, false)
        await coordinator.audioSession(active: true); XCTAssertEqual(media.microphoneValues.last, true)
        try await coordinator.setMuted(true); XCTAssertEqual(media.microphoneValues.last, false)
        await coordinator.networkPathChanged(); XCTAssertEqual(media.networks, 1)
        let sent = try await coordinator.sendCompanionMessage("Companion message"); XCTAssertEqual(sent, "$sent")
        let sameDevice = MatrixRawTimelineEvent(type: "m.call.answer", eventId: "$one", sender: chat.ownUserId, originServerTs: 100000, callId: callId, callPartyId: "local")
        await chat.setEvents([sameDevice]); _ = try await coordinator.syncCompanionTimeline(since: nil)
        XCTAssertNotNil(coordinator.call)
        let otherDevice = MatrixRawTimelineEvent(type: "m.call.answer", eventId: "$two", sender: chat.ownUserId, originServerTs: 100001, callId: callId, callPartyId: "other")
        await chat.setEvents([otherDevice]); _ = try await coordinator.syncCompanionTimeline(since: "one")
        XCTAssertNil(coordinator.call); XCTAssertEqual(presenter.reasons, [.answeredElsewhere])
    }
    func testAuthorityLossWipesCallAndStopsAudio() async throws {
        let media = CallMediaFixture(); let chat = CallChatFixture()
        let coordinator = try NativeCallCoordinator(organisationId: callOrg, localPartyId: "local", resolver: ImmediateCallResolver(), media: media, conversation: chat, now: { 100 })
        try await coordinator.receive(callWake()); try await coordinator.answer(callId: callId); await chat.deny()
        do { _ = try await coordinator.sendCompanionMessage("Denied"); XCTFail("authority loss must fail") } catch {}
        XCTAssertNil(coordinator.call); XCTAssertTrue(coordinator.ring.records.isEmpty); XCTAssertEqual(media.disconnects, 1)
    }
    func testUnauthorisedResolutionStopsRingingAndClearsTransientState() async throws {
        let media = CallMediaFixture(); let presenter = CallPresenterFixture()
        let coordinator = try NativeCallCoordinator(organisationId: callOrg, localPartyId: "local", resolver: ImmediateCallResolver(fails: true), media: media, conversation: CallChatFixture(), now: { 100 })
        coordinator.bind(presenter)
        do { try await coordinator.receive(callWake()); XCTFail("unauthorized wake must fail") } catch {}
        XCTAssertNil(coordinator.call); XCTAssertTrue(coordinator.ring.records.isEmpty)
        XCTAssertEqual(media.connections, 0); XCTAssertEqual(presenter.reasons, [.revoked])
    }
    func testEveryInvalidDeliveryReportsSynchronouslyAndCompletesBeforeNetwork() throws {
        let coordinator = try NativeCallCoordinator(organisationId: callOrg, localPartyId: "local", resolver: ImmediateCallResolver(), media: CallMediaFixture(), conversation: CallChatFixture(), now: { 100 })
        let reporter = ImmediateReporterFixture(); let delivery = VoIPPushDelivery(reporter: reporter, coordinator: coordinator)
        var completions = 0
        delivery.receive(Data("{}".utf8), now: 100) { completions += 1 }
        XCTAssertEqual(reporter.reports.count, 1); XCTAssertEqual(completions, 0); XCTAssertNil(coordinator.call)
        reporter.completions[0](true)
        reporter.completions[0](true)
        XCTAssertEqual(completions, 1); XCTAssertEqual(reporter.ended, reporter.reports)
        delivery.receive(try JSONEncoder().encode(callWake()), now: 130) { completions += 1 }
        XCTAssertEqual(reporter.reports.count, 2)
        reporter.completions[1](true)
        XCTAssertEqual(completions, 2); XCTAssertEqual(reporter.ended, reporter.reports)
    }
}
