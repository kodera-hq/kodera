import Foundation
import XCTest
import KoderaDomain
@testable import KoderaClient

private let callOrg = "22222222-2222-4222-8222-222222222222"
private let callId = "11111111-1111-4111-8111-111111111111"
private let callChannel = "33333333-3333-4333-8333-333333333333"
private let selectedChannel = "44444444-4444-4444-8444-444444444444"
private let selectedRoom = "!selected:example.org"
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
    private let fails: Bool
    init(fails: Bool = false) { self.fails = fails }
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
        if fails { throw KoderaMobileFfiError.authenticationFailed }
        return try AuthenticatedNativeCall(wake: wake, roomId: "!room:example.org", callerLabel: "Member")
    }
}
@MainActor private final class CallMediaGate {
    private var entered = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var operation: CheckedContinuation<Void, any Error>?
    func wait() async throws {
        try await withCheckedThrowingContinuation { continuation in
            operation = continuation; entered = true
            waiters.forEach { $0.resume() }; waiters.removeAll()
        }
    }
    func waitUntilEntered() async {
        if entered { return }; await withCheckedContinuation { waiters.append($0) }
    }
    func release(failing: Bool = false) {
        let operation = operation; self.operation = nil
        if failing { operation?.resume(throwing: KoderaMobileFfiError.authenticationFailed) } else { operation?.resume() }
    }
}
@MainActor private final class CallMediaFixture: LiveKitWebRTCSession {
    var connections = 0; var disconnects = 0; var microphoneValues: [Bool] = []; var networks = 0
    var microphoneEnabled = false
    var connectGate: CallMediaGate?; var microphoneGate: CallMediaGate?
    func connect(_ call: AuthenticatedNativeCall) async throws { connections += 1; try await connectGate?.wait() }
    func microphone(enabled: Bool) async throws { microphoneEnabled = enabled; microphoneValues.append(enabled); try await microphoneGate?.wait() }
    func audioSession(active: Bool) {}
    func networkPathChanged() async throws { networks += 1 }
    func disconnect() { disconnects += 1; microphoneEnabled = false }
}
@MainActor private final class CallPresenterFixture: NativeCallPresenting {
    var reasons: [NativeRingPhase] = []; var metadataCount = 0
    var lifecycle: [String] = []
    var onEnded: (() -> Void)?
    func metadata(_ call: AuthenticatedNativeCall) { metadataCount += 1; lifecycle.append("ring:\(call.wake.callId)") }
    func connected(callId: String) {}
    func ended(callId: String, reason: NativeRingPhase) { reasons.append(reason); lifecycle.append("end:\(callId):\(reason.rawValue)"); onEnded?() }
}
private final class CallClockFixture: @unchecked Sendable {
    private let lock = NSLock()
    private var value: UInt64 = 100
    func read() -> UInt64 { lock.lock(); defer { self.lock.unlock() }; return value }
    func set(_ value: UInt64) { lock.lock(); defer { self.lock.unlock() }; self.value = value }
}
private actor CallChatFixture: ChannelConversationTransport {
    nonisolated let ownUserId = "@member:example.org"
    private var events: [MatrixRawTimelineEvent] = []
    private var refuse = false
    private var lostRooms: Set<String> = []
    private var syncFailure: MatrixClientFailure?
    private var limitedRooms: Set<String> = []
    private var recoveryBatch: MatrixSyncBatch?
    private var plaintextBlocked = false
    private var syncRequests: [String] = []
    private var holdSync = false
    private var syncGate: CheckedContinuation<Void, Never>?
    private var syncWaiters: [CheckedContinuation<Void, Never>] = []
    func requests() -> [String] { syncRequests }
    func blockPlaintext() { plaintextBlocked = true }
    func holdNextSync() { holdSync = true }
    func waitUntilSyncEntered() async {
        if syncGate != nil { return }
        await withCheckedContinuation { syncWaiters.append($0) }
    }
    func releaseSync() { syncGate?.resume(); syncGate = nil }
    func loseAuthority(_ rooms: Set<String>) { lostRooms = rooms }
    func failSync(_ failure: MatrixClientFailure?) { syncFailure = failure }
    func limitTimeline(_ rooms: Set<String>) { limitedRooms = rooms }
    func recoverWith(_ batch: MatrixSyncBatch) { recoveryBatch = batch }
    func deny() { refuse = true }
    func setEvents(_ value: [MatrixRawTimelineEvent]) { events = value }
    func bootstrapRoom(organisationId: String, channelId: String) async throws(MatrixClientFailure) -> (roomId: String, initialBatch: MatrixSyncBatch) {
        if channelId == selectedChannel {
            var batch = MatrixSyncBatch(nextBatch: "selected", roomEvents: [:])
            batch.plaintextAllowedRooms = [selectedRoom]
            return (selectedRoom, batch)
        }
        var batch = MatrixSyncBatch(nextBatch: "one", roomEvents: [:])
        batch.plaintextAllowedRooms = ["!room:example.org"]
        return ("!room:example.org", batch)
    }
    func syncRoom(roomId: String, since: String?) async throws(MatrixClientFailure) -> MatrixSyncBatch {
        syncRequests.append("\(roomId)|\(since ?? "nil")")
        if roomId == selectedRoom {
            var batch = MatrixSyncBatch(nextBatch: "selected", roomEvents: [:])
            batch.plaintextAllowedRooms = [selectedRoom]; return batch
        }
        if holdSync {
            holdSync = false
            await withCheckedContinuation { continuation in
                syncGate = continuation
                syncWaiters.forEach { $0.resume() }; syncWaiters.removeAll()
            }
        }
        if let syncFailure { throw syncFailure }
        if since == nil, let recoveryBatch { return recoveryBatch }
        var deltas = Dictionary(uniqueKeysWithValues: limitedRooms.map { ($0, MatrixRoomSyncDelta(events: [], limited: true)) })
        deltas[roomId] = MatrixRoomSyncDelta(events: events, limited: limitedRooms.contains(roomId))
        var batch = MatrixSyncBatch(nextBatch: "two", roomDeltas: deltas)
        batch.authorityLostRooms = lostRooms; batch.plaintextAllowedRooms = plaintextBlocked ? [] : [roomId]; return batch
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
    func testCompanionPollRetriesTransientFailuresWithoutRetiringCallOrAdvancingCursor() async throws {
        for connected in [false, true] {
            for failure in [MatrixClientFailure.serviceUnavailable, .transport(.offline), .transport(.timeout), .rateLimited] {
                let media = CallMediaFixture(); let chat = CallChatFixture(); let presenter = CallPresenterFixture()
                let coordinator = try NativeCallCoordinator(organisationId: callOrg, localPartyId: "local",
                    resolver: ImmediateCallResolver(), media: media, conversation: chat, now: { 100 })
                coordinator.bind(presenter); try await coordinator.receive(callWake())
                if connected { try await coordinator.answer(callId: callId); await coordinator.audioSession(active: true) }
                await chat.failSync(failure)
                await coordinator.pollCompanionTimeline(); await coordinator.pollCompanionTimeline()
                XCTAssertEqual(coordinator.call?.wake.callId, callId)
                XCTAssertEqual(coordinator.ring.records[callId]?.phase, connected ? .connected : .ringing)
                XCTAssertEqual(media.disconnects, 0); XCTAssertEqual(media.microphoneEnabled, connected)
                XCTAssertTrue(presenter.reasons.isEmpty)
                await chat.failSync(nil); await coordinator.pollCompanionTimeline()
                await chat.setEvents([MatrixRawTimelineEvent(type: "m.call.answer", eventId: "$answer",
                    sender: chat.ownUserId, originServerTs: 100, callId: callId, callPartyId: "other")])
                await coordinator.pollCompanionTimeline()
                let requests = await chat.requests()
                XCTAssertEqual(requests, ["!room:example.org|one", "!room:example.org|one", "!room:example.org|one", "!room:example.org|two"])
                XCTAssertNil(coordinator.call); XCTAssertEqual(media.disconnects, 1)
                XCTAssertEqual(presenter.reasons, [.answeredElsewhere])
            }
        }
    }

    func testCompanionPollAuthorityFailuresImmediatelyRetireRingingAndConnectedCalls() async throws {
        for connected in [false, true] {
            for failure in [MatrixClientFailure.unauthorized, .forbidden, .notFound, .plaintextForbidden,
                            .protocolViolation, .signedOut, .signedOutNotWiped, .identityUnavailable] {
                let media = CallMediaFixture(); let chat = CallChatFixture(); let presenter = CallPresenterFixture()
                let coordinator = try NativeCallCoordinator(organisationId: callOrg, localPartyId: "local",
                    resolver: ImmediateCallResolver(), media: media, conversation: chat, now: { 100 })
                coordinator.bind(presenter); try await coordinator.receive(callWake())
                if connected { try await coordinator.answer(callId: callId); await coordinator.audioSession(active: true) }
                await chat.failSync(failure); await coordinator.pollCompanionTimeline(); await coordinator.pollCompanionTimeline()
                XCTAssertNil(coordinator.call); XCTAssertTrue(coordinator.ring.records.isEmpty)
                XCTAssertEqual(media.disconnects, 1); XCTAssertFalse(media.microphoneEnabled)
                XCTAssertEqual(presenter.reasons, [.revoked])
                let requests = await chat.requests(); XCTAssertEqual(requests, ["!room:example.org|one"])
            }
        }
    }

    func testLimitedCallTimelineResetsCursorAndRecoversOmittedAnswerOrAuthority() async throws {
        for recovery in ["answer", "authority", "continue"] {
            let media = CallMediaFixture(); let chat = CallChatFixture(); let presenter = CallPresenterFixture()
            let coordinator = try NativeCallCoordinator(organisationId: callOrg, localPartyId: "local",
                resolver: ImmediateCallResolver(), media: media, conversation: chat, now: { 100 })
            coordinator.bind(presenter); try await coordinator.receive(callWake()); try await coordinator.answer(callId: callId)
            await chat.limitTimeline([selectedRoom]); await coordinator.pollCompanionTimeline()
            await chat.limitTimeline(["!room:example.org"]); await coordinator.pollCompanionTimeline()
            XCTAssertNotNil(coordinator.call); XCTAssertEqual(media.disconnects, 0)
            // Recovery can also fail transiently; the reset cursor must survive that failure.
            await chat.failSync(.serviceUnavailable); await coordinator.pollCompanionTimeline(); await chat.failSync(nil)
            let events = recovery == "answer" ? [MatrixRawTimelineEvent(type: "m.call.answer", eventId: "$omitted",
                sender: chat.ownUserId, originServerTs: 100, callId: callId, callPartyId: "other")] : []
            var recovered = MatrixSyncBatch(nextBatch: "recovered", roomEvents: ["!room:example.org": events])
            recovered.plaintextAllowedRooms = ["!room:example.org"]
            if recovery == "authority" { recovered.authorityLostRooms = ["!room:example.org"] }
            await chat.recoverWith(recovered); await coordinator.pollCompanionTimeline()
            let requests = await chat.requests()
            XCTAssertEqual(requests, ["!room:example.org|one", "!room:example.org|two", "!room:example.org|nil", "!room:example.org|nil"])
            if recovery == "continue" {
                XCTAssertNotNil(coordinator.call); XCTAssertTrue(presenter.reasons.isEmpty)
                await chat.limitTimeline([]); await coordinator.pollCompanionTimeline()
                let resumed = await chat.requests(); XCTAssertEqual(resumed.last, "!room:example.org|recovered")
                coordinator.end(callId: callId)
            } else {
                XCTAssertNil(coordinator.call); XCTAssertEqual(media.disconnects, 1)
                XCTAssertEqual(presenter.reasons, [recovery == "answer" ? .answeredElsewhere : .revoked])
            }
        }
    }

    func testReplacingExpiredRingEndsPreviousCallBeforePresentingNextCall() async throws {
        for timestamp: UInt64 in [130, 160] {
            let clock = CallClockFixture(); let media = CallMediaFixture(); let presenter = CallPresenterFixture()
            let coordinator = try NativeCallCoordinator(organisationId: callOrg, localPartyId: "local",
                resolver: ImmediateCallResolver(), media: media, conversation: CallChatFixture(), now: { clock.read() })
            coordinator.bind(presenter); try await coordinator.receive(callWake())
            let nextId = "55555555-5555-4555-8555-555555555555"
            presenter.onEnded = {
                XCTAssertNil(coordinator.call)
                XCTAssertEqual(presenter.metadataCount, 1)
            }
            clock.set(timestamp)
            try await coordinator.receive(NativeCallWake(callId: nextId, organisationId: callOrg,
                channelId: callChannel, epoch: 1, state: .ringing, expiresAt: timestamp + 30))
            presenter.onEnded = nil
            XCTAssertEqual(presenter.lifecycle, ["ring:\(callId)", "end:\(callId):expired", "ring:\(nextId)"])
            XCTAssertEqual(media.disconnects, 1); XCTAssertEqual(coordinator.call?.wake.callId, nextId)
            coordinator.end(callId: callId); coordinator.tick()
            XCTAssertEqual(presenter.reasons, [.expired]); XCTAssertEqual(coordinator.ring.records[nextId]?.phase, .ringing)
            try await coordinator.answer(callId: nextId)
            XCTAssertEqual(coordinator.ring.records[nextId]?.phase, .connected)
            coordinator.end(callId: nextId); XCTAssertEqual(presenter.reasons, [.expired, .ended])
        }
    }

    func testCallRoomIsPolledWhileAnotherChannelInTheSameOrganisationIsSelected() async throws {
        for connected in [false, true] {
            for boundary in ["answer", "leave", "confidential", "notFound", "forbidden"] {
                let media = CallMediaFixture(); let chat = CallChatFixture(); let presenter = CallPresenterFixture()
                let coordinator = try NativeCallCoordinator(organisationId: callOrg, localPartyId: "local",
                    resolver: ImmediateCallResolver(), media: media, conversation: chat, now: { 100 })
                coordinator.bind(presenter)
                let selected = try await chat.bootstrapRoom(organisationId: callOrg, channelId: selectedChannel)
                coordinator.consumeAuthenticatedSync(selected.initialBatch, roomId: selected.roomId)
                try await coordinator.receive(callWake())
                if connected { try await coordinator.answer(callId: callId); await coordinator.audioSession(active: true) }
                await coordinator.pollCompanionTimeline()
                XCTAssertNotNil(coordinator.call)
                switch boundary {
                case "answer":
                    await chat.setEvents([MatrixRawTimelineEvent(type: "m.call.answer", eventId: "$answer",
                        sender: chat.ownUserId, originServerTs: 100, callId: callId, callPartyId: "other")])
                case "leave": await chat.loseAuthority(["!room:example.org"])
                case "confidential": await chat.blockPlaintext()
                case "notFound": await chat.failSync(.notFound)
                default: await chat.failSync(.forbidden)
                }
                let selectedBatch = try await chat.syncRoom(roomId: selected.roomId, since: selected.initialBatch.nextBatch)
                coordinator.consumeAuthenticatedSync(selectedBatch, roomId: selected.roomId)
                XCTAssertNotNil(coordinator.call, "The selected room cannot observe the call room boundary")
                await coordinator.pollCompanionTimeline()
                XCTAssertNil(coordinator.call, boundary); XCTAssertEqual(media.disconnects, 1, boundary)
                XCTAssertFalse(media.microphoneEnabled)
                XCTAssertEqual(presenter.reasons, [boundary == "answer" ? .answeredElsewhere : .revoked])
                await coordinator.pollCompanionTimeline()
                let requests = await chat.requests()
                XCTAssertEqual(requests, ["!room:example.org|one", "\(selectedRoom)|selected", "!room:example.org|two"])
            }
        }
    }

    func testCompanionPollCoalescesAndLateFailureCannotRetireTheNextCall() async throws {
        let media = CallMediaFixture(); let chat = CallChatFixture()
        let coordinator = try NativeCallCoordinator(organisationId: callOrg, localPartyId: "local",
            resolver: ImmediateCallResolver(), media: media, conversation: chat, now: { 100 })
        try await coordinator.receive(callWake()); await chat.holdNextSync()
        let polling = Task { await coordinator.pollCompanionTimeline() }
        await chat.waitUntilSyncEntered()
        await coordinator.pollCompanionTimeline()
        let entered = await chat.requests(); XCTAssertEqual(entered.count, 1)
        coordinator.end(callId: callId)
        let nextId = "55555555-5555-4555-8555-555555555555"
        try await coordinator.receive(NativeCallWake(callId: nextId, organisationId: callOrg,
            channelId: callChannel, epoch: 1, state: .ringing, expiresAt: 130))
        await chat.failSync(.forbidden); await chat.releaseSync(); await polling.value
        XCTAssertEqual(coordinator.call?.wake.callId, nextId)
        XCTAssertEqual(media.disconnects, 1)
        coordinator.end(callId: nextId)
    }

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
    func testSyncMembershipLossRevokesOnlyTheCallsRoom() async throws {
        let media = CallMediaFixture(); let chat = CallChatFixture()
        let coordinator = try NativeCallCoordinator(organisationId: callOrg, localPartyId: "local", resolver: ImmediateCallResolver(), media: media, conversation: chat, now: { 100 })
        try await coordinator.receive(callWake()); try await coordinator.answer(callId: callId)
        await chat.loseAuthority(["!unrelated:example.org"])
        _ = try await coordinator.syncCompanionTimeline(since: "one"); XCTAssertNotNil(coordinator.call)
        await chat.loseAuthority(["!room:example.org"])
        _ = try await coordinator.syncCompanionTimeline(since: "two")
        XCTAssertNil(coordinator.call); XCTAssertTrue(coordinator.ring.records.isEmpty); XCTAssertEqual(media.disconnects, 1)
    }
    func testSyncNotFoundAndForbiddenRevokeMedia() async throws {
        for failure in [MatrixClientFailure.notFound, .forbidden] {
            let media = CallMediaFixture(); let chat = CallChatFixture()
            let coordinator = try NativeCallCoordinator(organisationId: callOrg, localPartyId: "local", resolver: ImmediateCallResolver(), media: media, conversation: chat, now: { 100 })
            try await coordinator.receive(callWake()); try await coordinator.answer(callId: callId)
            await chat.failSync(failure)
            do { _ = try await coordinator.syncCompanionTimeline(since: "one"); XCTFail("Authority failure must propagate") } catch {}
            XCTAssertNil(coordinator.call); XCTAssertTrue(coordinator.ring.records.isEmpty); XCTAssertEqual(media.disconnects, 1)
        }
    }
    func testLiveSyncPlaintextExclusionRevokesRingingAndConnectedCalls() async throws {
        for connected in [false, true] {
            let media = CallMediaFixture(); let presenter = CallPresenterFixture()
            let coordinator = try NativeCallCoordinator(organisationId: callOrg, localPartyId: "local", resolver: ImmediateCallResolver(), media: media, conversation: CallChatFixture(), now: { 100 })
            coordinator.bind(presenter); try await coordinator.receive(callWake())
            if connected { try await coordinator.answer(callId: callId); await coordinator.audioSession(active: true) }
            coordinator.consumeAuthenticatedSync(MatrixSyncBatch(nextBatch: "other", roomEvents: ["!other:example.org": []]), roomId: "!other:example.org")
            XCTAssertNotNil(coordinator.call)
            // A security boundary can exclude plaintext without dropping Matrix membership or emitting timeline events.
            coordinator.consumeAuthenticatedSync(MatrixSyncBatch(nextBatch: "blocked", roomEvents: [:]), roomId: "!room:example.org")
            XCTAssertNil(coordinator.call); XCTAssertTrue(coordinator.ring.records.isEmpty)
            XCTAssertEqual(media.disconnects, 1); XCTAssertEqual(presenter.reasons, [.revoked])
        }
    }
    func testLiveTransportAuthorityFailuresRevokeButTransientFailuresPreserveCall() async throws {
        for failure in [MatrixClientFailure.notFound, .forbidden, .unauthorized, .plaintextForbidden, .protocolViolation, .identityUnavailable] {
            let media = CallMediaFixture()
            let coordinator = try NativeCallCoordinator(organisationId: callOrg, localPartyId: "local", resolver: ImmediateCallResolver(), media: media, conversation: CallChatFixture(), now: { 100 })
            try await coordinator.receive(callWake()); try await coordinator.answer(callId: callId)
            coordinator.consumeTransportFailure(.serviceUnavailable); XCTAssertNotNil(coordinator.call)
            coordinator.consumeTransportFailure(failure)
            XCTAssertNil(coordinator.call); XCTAssertTrue(coordinator.ring.records.isEmpty); XCTAssertEqual(media.disconnects, 1)
        }
    }
    func testAnswerWaitsForResolutionAndMediaConnection() async throws {
        let resolver = HeldCallResolver(); let media = CallMediaFixture(); let gate = CallMediaGate()
        media.connectGate = gate
        let coordinator = try NativeCallCoordinator(organisationId: callOrg, localPartyId: "local", resolver: resolver, media: media, conversation: CallChatFixture(), now: { 100 })
        let receiving = Task { try await coordinator.receive(callWake()) }
        await resolver.waitUntilEntered()
        var started = false; var completed = false
        let answering = Task { started = true; try await coordinator.answer(callId: callId); completed = true }
        while !started { await Task.yield() }
        XCTAssertFalse(completed); await resolver.release(); await gate.waitUntilEntered()
        XCTAssertFalse(completed); gate.release()
        try await receiving.value; try await answering.value
        XCTAssertTrue(completed); XCTAssertEqual(coordinator.ring.records[callId]?.phase, .connected)
    }
    func testPendingAnswerFailsImmediatelyWhenRevokedDuringResolution() async throws {
        let resolver = HeldCallResolver(); let media = CallMediaFixture()
        let coordinator = try NativeCallCoordinator(organisationId: callOrg, localPartyId: "local", resolver: resolver, media: media, conversation: CallChatFixture(), now: { 100 })
        let receiving = Task { try await coordinator.receive(callWake()) }
        await resolver.waitUntilEntered()
        var started = false
        let answering = Task { started = true; try await coordinator.answer(callId: callId) }
        while !started { await Task.yield() }
        coordinator.revoke()
        do { try await answering.value; XCTFail("Retired answer must fail") } catch {}
        await resolver.release(); try await receiving.value
        XCTAssertEqual(media.connections, 0)
    }
    func testPendingAnswerFailsOnResolutionAuthorizationFailure() async throws {
        let resolver = HeldCallResolver(fails: true); let media = CallMediaFixture()
        let coordinator = try NativeCallCoordinator(organisationId: callOrg, localPartyId: "local", resolver: resolver, media: media, conversation: CallChatFixture(), now: { 100 })
        let receiving = Task { try await coordinator.receive(callWake()) }
        await resolver.waitUntilEntered()
        var started = false
        let answering = Task { started = true; try await coordinator.answer(callId: callId) }
        while !started { await Task.yield() }
        await resolver.release()
        do { try await receiving.value; XCTFail("Resolution must fail") } catch {}
        do { try await answering.value; XCTFail("Answer must fail") } catch {}
        XCTAssertNil(coordinator.call); XCTAssertEqual(media.connections, 0)
    }
    func testPendingAnswerFailsOnConnectionFailure() async throws {
        let resolver = HeldCallResolver(); let media = CallMediaFixture(); let gate = CallMediaGate()
        media.connectGate = gate
        let coordinator = try NativeCallCoordinator(organisationId: callOrg, localPartyId: "local", resolver: resolver, media: media, conversation: CallChatFixture(), now: { 100 })
        let receiving = Task { try await coordinator.receive(callWake()) }
        await resolver.waitUntilEntered()
        var started = false
        let answering = Task { started = true; try await coordinator.answer(callId: callId) }
        while !started { await Task.yield() }
        await resolver.release(); await gate.waitUntilEntered(); gate.release(failing: true)
        do { try await receiving.value; XCTFail("Connection must fail") } catch {}
        do { try await answering.value; XCTFail("Answer must fail") } catch {}
        XCTAssertNil(coordinator.call); XCTAssertTrue(coordinator.ring.records.isEmpty)
    }
    func testObsoleteMuteFailurePreservesSubsequentCall() async throws {
        let media = CallMediaFixture()
        let coordinator = try NativeCallCoordinator(organisationId: callOrg, localPartyId: "local", resolver: ImmediateCallResolver(), media: media, conversation: CallChatFixture(), now: { 100 })
        try await coordinator.receive(callWake()); try await coordinator.answer(callId: callId)
        let gate = CallMediaGate(); media.microphoneGate = gate
        let muting = Task { try await coordinator.setMuted(true) }
        await gate.waitUntilEntered(); coordinator.end(callId: callId); media.microphoneGate = nil
        let nextId = "44444444-4444-4444-8444-444444444444"
        let next = try NativeCallWake(callId: nextId, organisationId: callOrg, channelId: callChannel, epoch: 1, state: .ringing, expiresAt: 130)
        try await coordinator.receive(next); try await coordinator.answer(callId: nextId)
        gate.release(failing: true)
        do { try await muting.value; XCTFail("Old mute must fail") } catch {}
        XCTAssertEqual(coordinator.call?.wake.callId, nextId); XCTAssertEqual(coordinator.ring.records[nextId]?.phase, .connected)
        XCTAssertEqual(media.disconnects, 1)
    }
    func testRejectedSyntheticReportsStillDeliverCancellations() async throws {
        for state in [NativeRingPhase.answeredElsewhere, .ended] {
            let media = CallMediaFixture()
            let coordinator = try NativeCallCoordinator(organisationId: callOrg, localPartyId: "local", resolver: ImmediateCallResolver(), media: media, conversation: CallChatFixture(), now: { 100 })
            try await coordinator.receive(callWake()); try await coordinator.answer(callId: callId)
            let presenter = CallPresenterFixture(); coordinator.bind(presenter)
            let cancelled = XCTestExpectation(description: "Cancellation reaches the active call")
            presenter.onEnded = { cancelled.fulfill() }
            let reporter = ImmediateReporterFixture(); let delivery = VoIPPushDelivery(reporter: reporter, coordinator: coordinator)
            var completions = 0
            delivery.receive(try JSONEncoder().encode(callWake(state, epoch: 2)), now: 100) { completions += 1 }
            reporter.completions[0](false); reporter.completions[0](false)
            let result = await XCTWaiter.fulfillment(of: [cancelled], timeout: 2)
            XCTAssertEqual(result, .completed)
            XCTAssertEqual(completions, 1); XCTAssertNil(coordinator.call); XCTAssertEqual(media.disconnects, 1)
            XCTAssertEqual(coordinator.ring.records[callId]?.phase, state)
        }
    }
    func testPreEpochClockClampsWithoutTrapping() {
        XCTAssertEqual(NativeCallClock.timestamp(Date(timeIntervalSince1970: -1)), 0)
        XCTAssertEqual(NativeCallClock.timestamp(Date(timeIntervalSince1970: 123.9)), 123)
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
