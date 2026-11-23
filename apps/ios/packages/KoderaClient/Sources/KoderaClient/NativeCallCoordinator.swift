import Foundation
import KoderaDomain

enum NativeCallClock {
    static func timestamp(_ date: Date = Date()) -> UInt64 { UInt64(max(0, date.timeIntervalSince1970)) }
}

public struct AuthenticatedNativeCall: Equatable, Sendable {
    public let wake: NativeCallWake
    public let roomId: String
    public let callerLabel: String
    public init(wake: NativeCallWake, roomId: String, callerLabel: String) throws {
        guard !roomId.isEmpty, roomId.utf8.count <= 255, !callerLabel.isEmpty, callerLabel.utf8.count <= 255,
              !roomId.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              !callerLabel.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw KoderaMobileFfiError.invalidInput }
        self.wake = wake; self.roomId = roomId; self.callerLabel = callerLabel
    }
}
public protocol NativeCallResolving: Sendable {
    /// Must revalidate membership and confidential room authority; a 404 is terminal.
    func resolve(_ wake: NativeCallWake) async throws -> AuthenticatedNativeCall
}
@MainActor
public protocol LiveKitWebRTCSession: AnyObject {
    /// Connect with capture disabled; obtain scoped media credentials over authenticated transport.
    func connect(_ call: AuthenticatedNativeCall) async throws
    func microphone(enabled: Bool) async throws
    func audioSession(active: Bool)
    func networkPathChanged() async throws
    /// Synchronously cancels all owned operations and closes media; late completions cannot publish audio.
    func disconnect()
}
@MainActor
public protocol NativeCallPresenting: AnyObject {
    func metadata(_ call: AuthenticatedNativeCall)
    func connected(callId: String)
    func ended(callId: String, reason: NativeRingPhase)
}

/// Session owner for native call UI, authenticated media, and the existing encrypted channel timeline.
@MainActor
public final class NativeCallCoordinator {
    public private(set) var ring: NativeCallRing
    public private(set) var call: AuthenticatedNativeCall?
    private let localPartyId: String
    private let resolver: any NativeCallResolving
    private let media: any LiveKitWebRTCSession
    public let conversation: any ChannelConversationTransport
    private weak var presenter: (any NativeCallPresenting)?
    private let now: @Sendable () -> UInt64
    private var generation: UInt64 = 0
    private var activeId: String?
    private var answerRequested = false
    private var pendingAnswer: CheckedContinuation<Void, any Error>?
    private var audioActive = false
    private var muted = false
    private var stopped = false
    private var companionSince: String?
    private struct CompanionBackfill {
        let batch: MatrixSyncBatch
        let since: String?
    }
    private var companionBackfill: CompanionBackfill?
    private var companionCursorRevision: UInt64 = 0
    private var companionPollOwner: UInt64?

    public init(organisationId: String, localPartyId: String, resolver: any NativeCallResolving, media: any LiveKitWebRTCSession,
                conversation: any ChannelConversationTransport, now: @escaping @Sendable () -> UInt64 = { UInt64(max(0, Date().timeIntervalSince1970)) }) throws {
        guard !localPartyId.isEmpty, localPartyId.utf8.count <= 128 else { throw KoderaMobileFfiError.invalidInput }
        self.localPartyId = localPartyId
        ring = try NativeCallRing(organisationId: organisationId); self.resolver = resolver; self.media = media
        self.conversation = conversation; self.now = now
    }
    public func bind(_ presenter: any NativeCallPresenting) { self.presenter = presenter }

    /// Called only after the native adapter has synchronously reported the PushKit delivery.
    public func receive(_ wake: NativeCallWake) async throws {
        guard !stopped else { throw KoderaMobileFfiError.authenticationFailed }
        try ring.observe(wake, now: now())
        // observe can expire (or evict) the previous ring while admitting this wake.
        if let id = activeId, ring.records[id] == nil || ring.records[id]?.phase == .expired { finish(.expired) }
        if wake.state != .ringing {
            if activeId == wake.callId { finish(wake.state) }
            return
        }
        generation &+= 1; let owner = generation
        activeId = wake.callId; answerRequested = false
        do {
            let resolved = try await resolver.resolve(wake)
            guard owns(owner, wake.callId) else { return }
            guard resolved.wake == wake else { throw KoderaMobileFfiError.organisationMismatch }
            try wake.validate(now: now())
            let room = try await conversation.bootstrapRoom(organisationId: wake.organisationId, channelId: wake.channelId)
            guard owns(owner, wake.callId) else { return }
            guard room.roomId == resolved.roomId else { throw KoderaMobileFfiError.organisationMismatch }
            try wake.validate(now: now())
            call = resolved; companionSince = room.initialBatch.roomDeltas[room.roomId]?.limited == true ? nil : room.initialBatch.nextBatch
            consumeAuthenticatedSync(room.initialBatch, roomId: room.roomId)
            do { try await self.recoverLimitedTimeline(room.initialBatch, call: resolved, since: nil, owner: owner) }
            catch { if self.owns(owner, wake.callId), let failure = error as? MatrixClientFailure { self.consumeTransportFailure(failure) } }
            guard owns(owner, wake.callId) else { return }
            presenter?.metadata(resolved)
            if answerRequested, self.ring.records[wake.callId]?.phase == .ringing { try await connect(owner: owner, call: resolved) }
        } catch {
            if owns(owner, wake.callId) { finish(.revoked) }
            throw error
        }
    }
    public func answer(callId: String) async throws {
        guard !stopped, activeId == callId, ring.records[callId]?.phase == .ringing, !answerRequested else { throw KoderaMobileFfiError.invalidInput }
        answerRequested = true
        let owner = generation
        try await withCheckedThrowingContinuation { continuation in
            self.pendingAnswer = continuation
            if let call = self.call {
                Task { @MainActor in
                    do { try await self.connect(owner: owner, call: call) }
                    catch { if self.owns(owner, callId) { self.finish(.revoked) } }
                }
            }
        }
    }
    private func connect(owner: UInt64, call: AuthenticatedNativeCall) async throws {
        do {
            guard owns(owner, call.wake.callId) else { throw KoderaMobileFfiError.authenticationFailed }
            try call.wake.validate(now: now())
            try ring.transition(callId: call.wake.callId, to: .connecting)
            try await media.connect(call)
            guard owns(owner, call.wake.callId) else { throw KoderaMobileFfiError.authenticationFailed }
            try ring.transition(callId: call.wake.callId, to: .connected)
            try await media.microphone(enabled: audioActive && !muted)
            guard owns(owner, call.wake.callId) else { throw KoderaMobileFfiError.authenticationFailed }
            presenter?.connected(callId: call.wake.callId)
            let answer = pendingAnswer; pendingAnswer = nil; answer?.resume()
        } catch {
            if owns(owner, call.wake.callId) { finish(.revoked) }
            throw error
        }
    }
    public func setMuted(_ value: Bool) async throws {
        muted = value
        guard let id = activeId, ring.records[id]?.phase == .connected else { return }
        let owner = generation
        do {
            try await media.microphone(enabled: audioActive && !value)
            guard owns(owner, id) else { throw KoderaMobileFfiError.authenticationFailed }
        } catch { if owns(owner, id) { finish(.revoked) }; throw error }
    }
    public func audioSession(active: Bool) async {
        guard !stopped else { return }
        audioActive = active; media.audioSession(active: active)
        try? await setMuted(muted)
    }
    public func networkPathChanged() async {
        guard let id = activeId, ring.records[id]?.phase == .connected else { return }
        let owner = generation
        do { try await media.networkPathChanged() } catch { if owns(owner, id) { finish(.revoked) } }
    }
    public func sendCompanionMessage(_ body: String) async throws -> String {
        guard let call, ring.records[call.wake.callId]?.phase == .connected else { throw KoderaMobileFfiError.authenticationFailed }
        let owner = generation
        do {
            let result = try await conversation.sendMessage(roomId: call.roomId, transactionId: UUID().uuidString.lowercased(), body: body, replyToEventId: nil, attachments: [])
            guard owns(owner, call.wake.callId) else { throw KoderaMobileFfiError.authenticationFailed }
            return result
        } catch { if owns(owner, call.wake.callId) { finish(.revoked) }; throw error }
    }
    /// Uses the same authenticated room transport as the in-call channel timeline.
    public func syncCompanionTimeline(since: String?) async throws -> MatrixSyncBatch {
        guard let call else { throw KoderaMobileFfiError.authenticationFailed }
        let owner = generation
        do {
            let batch = try await conversation.syncRoom(roomId: call.roomId, since: since)
            guard owns(owner, call.wake.callId) else { throw KoderaMobileFfiError.authenticationFailed }
            consumeAuthenticatedSync(batch, roomId: call.roomId)
            try await self.recoverLimitedTimeline(batch, call: call, since: since, owner: owner)
            return batch
        } catch {
            if owns(owner, call.wake.callId), let failure = error as? MatrixClientFailure { consumeTransportFailure(failure) }
            throw error
        }
    }
    /// Runtime timer entry point. Always monitors the call's room, independently of the selected UI.
    public func pollCompanionTimeline() async {
        guard let call, companionPollOwner == nil else { return }
        let owner = generation
        companionPollOwner = owner
        let cursorRevision = self.companionCursorRevision
        defer { if companionPollOwner == owner { companionPollOwner = nil } }
        do {
            if let gap = self.companionBackfill {
                try await self.recoverLimitedTimeline(gap.batch, call: call, since: gap.since, owner: owner)
                guard self.owns(owner, call.wake.callId) else { return }
            }
            let batch = try await syncCompanionTimeline(since: companionSince)
            if owns(owner, call.wake.callId), self.companionCursorRevision == cursorRevision {
                // Re-read the room without an incremental cursor after an omitted timeline segment.
                companionSince = batch.roomDeltas[call.roomId]?.limited == true ? nil : batch.nextBatch
            }
        } catch {
            // Failed sync clears Matrix room knowledge; recover it with a full sync for this owner.
            if self.owns(owner, call.wake.callId) {
                self.companionSince = nil
                if let failure = error as? MatrixClientFailure { self.consumeTransportFailure(failure) }
            }
        }
    }
    public func consumeAuthenticatedSync(_ batch: MatrixSyncBatch, roomId: String? = nil) {
        guard let id = activeId, let currentRoomId = call?.roomId ?? roomId else { return }
        if batch.authorityLostRooms.contains(currentRoomId) ||
            ((roomId == nil || roomId == currentRoomId) && !batch.plaintextAllowedRooms.contains(currentRoomId)) {
            finish(.revoked); return
        }
        // Retain the UI's exact gap until the companion can recover it outside the state consumer.
        if let delta = batch.roomDeltas[currentRoomId], delta.limited {
            if delta.prevBatch != nil, self.companionBackfill == nil {
                self.companionBackfill = CompanionBackfill(batch: batch, since: self.companionSince)
            }
            self.companionSince = nil
            self.companionCursorRevision &+= 1
        }
        self.consumeCallEvents(batch.roomEvents[currentRoomId] ?? [], callId: id)
    }
    private func consumeCallEvents(_ events: [MatrixRawTimelineEvent], callId id: String) {
        for event in events {
            if event.type == "m.call.answer", event.sender == conversation.ownUserId,
               !event.isRedactedUnsigned, event.callId == id,
               let party = event.callPartyId, !party.isEmpty, party != localPartyId {
                finish(.answeredElsewhere); return
            }
        }
    }
    /// At most 200 older events, stopping at the prior sync cursor or a non-advancing page.
    private func recoverLimitedTimeline(_ batch: MatrixSyncBatch, call: AuthenticatedNativeCall, since: String?, owner: UInt64) async throws {
        guard self.owns(owner, call.wake.callId), let delta = batch.roomDeltas[call.roomId], delta.limited,
              var from = delta.prevBatch else { return }
        var visited: Set<String> = []
        for _ in 0..<4 {
            guard from != since, visited.insert(from).inserted, self.owns(owner, call.wake.callId) else { break }
            let page = try await self.conversation.backfillRoomPage(roomId: call.roomId, fromToken: from, toToken: since, limit: 50)
            guard self.owns(owner, call.wake.callId) else { return }
            self.consumeCallEvents(page.events, callId: call.wake.callId)
            guard let end = page.endToken, !end.isEmpty else { break }
            from = end
        }
        if self.owns(owner, call.wake.callId), self.companionBackfill?.batch.nextBatch == batch.nextBatch {
            self.companionBackfill = nil
        }
    }
    /// Forwarded by the session's live conversation consumer, including bootstrap failures.
    public func consumeTransportFailure(_ failure: MatrixClientFailure) {
        switch failure {
        case .notFound, .forbidden, .unauthorized, .plaintextForbidden, .protocolViolation,
             .signedOut, .signedOutNotWiped, .identityUnavailable: revoke()
        default:
            self.companionSince = nil
            self.companionCursorRevision &+= 1
        }
    }
    /// Only authenticated, scope-correlated Matrix m.call.answer / call membership events enter here.
    public func answeredElsewhere(callId: String, organisationId: String, channelId: String) {
        guard let r = ring.records[callId], r.wake.organisationId == organisationId, r.wake.channelId == channelId, activeId == callId else { return }
        finish(.answeredElsewhere)
    }
    public func end(callId: String, declined: Bool = false) {
        guard activeId == callId else { return }; finish(declined ? .declined : .ended)
    }
    public func tick() {
        let id = activeId; ring.tick(now: now())
        if let id, ring.records[id] == nil || ring.records[id]?.phase == .expired { finish(.expired) }
    }
    public func revoke() {
        stopped = true; finish(.revoked); ring.revoke()
    }
    private func owns(_ owner: UInt64, _ id: String) -> Bool { !stopped && generation == owner && activeId == id }
    private func finish(_ reason: NativeRingPhase) {
        generation &+= 1
        let answer = pendingAnswer; pendingAnswer = nil
        answer?.resume(throwing: KoderaMobileFfiError.authenticationFailed)
        let id = activeId; activeId = nil; call = nil; answerRequested = false; muted = false; audioActive = false
        companionSince = nil; companionPollOwner = nil; self.companionBackfill = nil
        media.disconnect()
        if reason == .revoked { stopped = true; ring.revoke() }
        if let id {
            try? ring.transition(callId: id, to: reason)
            presenter?.ended(callId: id, reason: reason)
        }
    }
}
