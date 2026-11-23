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
            call = resolved; consumeAuthenticatedSync(room.initialBatch)
            guard owns(owner, wake.callId) else { return }
            presenter?.metadata(resolved)
            if answerRequested { try await connect(owner: owner, call: resolved) }
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
            pendingAnswer = continuation
            if let call {
                Task { @MainActor in
                    do { try await connect(owner: owner, call: call) }
                    catch { if owns(owner, callId) { finish(.revoked) } }
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
            consumeAuthenticatedSync(batch)
            return batch
        } catch { if owns(owner, call.wake.callId) { finish(.revoked) }; throw error }
    }
    public func consumeAuthenticatedSync(_ batch: MatrixSyncBatch) {
        guard let call else { return }
        if batch.authorityLostRooms.contains(call.roomId) { finish(.revoked); return }
        for event in batch.roomEvents[call.roomId] ?? [] {
            if event.type == "m.call.answer", event.sender == conversation.ownUserId,
               !event.isRedactedUnsigned, event.callId == call.wake.callId,
               let party = event.callPartyId, !party.isEmpty, party != localPartyId {
                finish(.answeredElsewhere); return
            }
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
        media.disconnect()
        if reason == .revoked { stopped = true; ring.revoke() }
        if let id {
            try? ring.transition(callId: id, to: reason)
            presenter?.ended(callId: id, reason: reason)
        }
    }
}
