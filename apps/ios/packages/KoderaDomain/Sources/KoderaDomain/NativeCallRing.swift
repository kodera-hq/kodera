import Foundation

public enum NativeRingPhase: String, Codable, Sendable {
    case ringing, connecting, connected, answeredElsewhere = "answered_elsewhere", declined, ended, expired, revoked
    public var terminal: Bool { self != .ringing && self != .connecting && self != .connected }
}

/// Wire binding for kodera_rs::mobile_calls::CallWake. All times are Unix seconds.
public struct NativeCallWake: Equatable, Codable, Sendable {
    public let callId: String
    public let organisationId: String
    public let channelId: String
    public let epoch: UInt64
    public let state: NativeRingPhase
    public let expiresAt: UInt64
    enum CodingKeys: String, CodingKey {
        case callId = "call_id", organisationId = "organisation_id", channelId = "channel_id"
        case epoch, state, expiresAt = "expires_at"
    }
    public init(callId: String, organisationId: String, channelId: String, epoch: UInt64, state: NativeRingPhase, expiresAt: UInt64) throws {
        guard [callId, organisationId, channelId].allSatisfy(TrustPolicy.canonicalNonNilUUID),
              epoch > 0, epoch <= 9_007_199_254_740_991,
              [.ringing, .answeredElsewhere, .ended].contains(state) else { throw KoderaMobileFfiError.invalidInput }
        self.callId = callId; self.organisationId = organisationId; self.channelId = channelId
        self.epoch = epoch; self.state = state; self.expiresAt = expiresAt
    }
    public func validate(now: UInt64) throws {
        guard now > 0, now <= 9_007_199_254_740_931 else { throw KoderaMobileFfiError.invalidInput }
        guard expiresAt > now, expiresAt - now <= 60 else { throw KoderaMobileFfiError.staleEpoch }
    }
    /// Uses the existing bounded packet seam; production can inject the safe Rust dispatcher.
    public static func admit(_ data: Data, now: UInt64, dispatcher: any PacketDispatcher = KoderaMobileFfiBridge()) throws -> Self {
        guard data.count <= 4096 else { throw KoderaMobileFfiError.capacityExceeded }
        let hex = data.map { String(format: "%02x", $0) }.joined()
        let request = Data("{\"op\":\"call_wake_admit\",\"payload_hex\":\"\(hex)\",\"now\":\(now)}".utf8)
        let response = try dispatcher.dispatch(try KoderaFfiPacket(payload: request))
        guard response.status == 0 else { throw KoderaMobileFfiError.invalidInput }
        let value = try JSONDecoder().decode(Self.self, from: response.payload)
        let wake = try Self(callId: value.callId, organisationId: value.organisationId, channelId: value.channelId,
                            epoch: value.epoch, state: value.state, expiresAt: value.expiresAt)
        try wake.validate(now: now); return wake
    }
}
public struct NativeRingRecord: Equatable, Sendable {
    public let wake: NativeCallWake
    public var phase: NativeRingPhase
    public var missed: Bool
    fileprivate let retainUntil: UInt64
}
/// Value binding of the shared reducer; serialize on the session owner actor.
public struct NativeCallRing: Sendable {
    public let organisationId: String
    public private(set) var records: [String: NativeRingRecord] = [:]
    private var clock: UInt64 = 0
    public init(organisationId: String) throws {
        guard TrustPolicy.canonicalNonNilUUID(organisationId) else { throw KoderaMobileFfiError.invalidInput }
        self.organisationId = organisationId
    }
    public mutating func observe(_ wake: NativeCallWake, now: UInt64) throws {
        try wake.validate(now: now)
        guard now >= clock else { throw KoderaMobileFfiError.staleEpoch }
        guard wake.organisationId == organisationId else { throw KoderaMobileFfiError.organisationMismatch }
        tick(now: now)
        if let old = records[wake.callId] {
            guard old.wake.channelId == wake.channelId else { throw KoderaMobileFfiError.organisationMismatch }
            guard (!old.phase.terminal || (old.phase == .expired && wake.state == .answeredElsewhere)), wake.epoch > old.wake.epoch, wake.state != .ringing else { throw KoderaMobileFfiError.replayDetected }
        } else {
            guard records.count < 128, wake.state != .ringing || !records.values.contains(where: { !$0.phase.terminal }) else {
                throw KoderaMobileFfiError.capacityExceeded
            }
        }
        records[wake.callId] = NativeRingRecord(wake: wake, phase: wake.state, missed: false, retainUntil: now + 60)
    }
    public mutating func transition(callId: String, to next: NativeRingPhase) throws {
        guard var r = records[callId], !r.phase.terminal,
              (r.phase == .ringing && next == .connecting) || (r.phase == .connecting && next == .connected)
                || [.answeredElsewhere, .declined, .ended, .revoked].contains(next) else { throw KoderaMobileFfiError.replayDetected }
        r.phase = next; r.missed = false; records[callId] = r
    }
    public mutating func tick(now: UInt64) {
        clock = max(clock, now)
        for (id, var r) in records {
            if [.ringing, .connecting].contains(r.phase), r.wake.expiresAt <= clock {
                r.missed = r.phase == .ringing; r.phase = .expired; records[id] = r
            }
        }
        records = records.filter { !$0.value.phase.terminal || $0.value.retainUntil > clock }
    }
    public mutating func revoke() { records.removeAll() }
}
