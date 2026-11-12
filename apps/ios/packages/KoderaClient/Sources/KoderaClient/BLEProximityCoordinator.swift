import Foundation
import KoderaDomain

/// A radio adapter must provide its own permission, availability, cancellation and delivery semantics.
public protocol BLEEmergencyTransport: Sendable {
    func broadcast(frame: Data, beacon: Data) async throws
}

public struct EmergencyMemberStatus: Equatable, Sendable {
    public let publicKey: Data
    public let messageID: EmergencyMessageID
    public let status: EmergencySafetyStatus
    public let text: String
    public let ttlHops: UInt8
    public var timestampMilliseconds: UInt64 { messageID.timestampMilliseconds }
}

/// Per-organisation, in-memory verified state. Construct only from trusted provisioning.
/// Signed v1 frames carry plaintext; no confidential transport or radio implementation is supplied here.
public actor BLEEmergencyCoordinator {
    private let salt: Data
    private let allowedRoster: Set<Data>
    private let verifier: any EmergencySignatureVerifier
    private let capacity: Int
    private var replay: EmergencyReplayGuard
    private var queue: [EmergencyFrame] = []
    private var members: [Data: EmergencyMemberStatus] = [:]
    private var inFlight: EmergencyMessageID?
    private var stopped = false

    public init(salt: Data, allowedRoster: Set<Data>, queueCapacity: Int = 128,
                replayCapacity: Int = 1024,
                verifier: any EmergencySignatureVerifier = SystemEmergencySignatureVerifier()) throws {
        guard salt.count == 32, (1...EmergencyBounds.rosterMembers).contains(allowedRoster.count),
              allowedRoster.allSatisfy({ $0.count == 32 }), (1...EmergencyBounds.queueCapacity).contains(queueCapacity),
              replayCapacity >= queueCapacity else { throw EmergencyError.invalidConfiguration }
        self.salt = salt; self.allowedRoster = allowedRoster; self.capacity = queueCapacity
        self.verifier = verifier; replay = try EmergencyReplayGuard(capacity: replayCapacity)
    }

    public func currentBeacon(unixSeconds: UInt64 = EmergencyBounds.currentUnixSeconds()) throws -> Data {
        guard !stopped else { throw EmergencyError.invalidConfiguration }
        return try ProximityBeacon.compute(salt: salt, unixSeconds: unixSeconds)
    }

    @discardableResult
    public func createLocalCheckIn(messageID: EmergencyMessageID, status: EmergencySafetyStatus,
                                   text: String, signer: any EmergencyIdentitySigner) throws -> EmergencyFrame {
        guard !stopped else { throw EmergencyError.invalidConfiguration }
        let frame = try EmergencyFrame.signed(messageID: messageID, ttlHops: 6,
                                               status: status, text: text, signer: signer)
        let verified = try frame.verified(allowedRoster: allowedRoster, verifier: verifier)
        try admit(verified, relay: frame, requireRelayAdmission: true)
        return frame
    }

    @discardableResult
    public func ingestPeerFrame(
        observedBeacon: Data,
        unixSeconds: UInt64 = EmergencyBounds.currentUnixSeconds(),
        rawFrame: Data
    ) throws -> EmergencyFrame {
        guard !stopped else { throw EmergencyError.invalidConfiguration }
        let previous = unixSeconds >= 300 ? unixSeconds - 300 : 0
        let next = unixSeconds <= UInt64.max - 300 ? unixSeconds + 300 : UInt64.max
        let candidates = try [previous, unixSeconds, next].map {
            try ProximityBeacon.compute(salt: salt, unixSeconds: $0)
        }
        guard observedBeacon.count == 8, candidates.contains(where: { constantEqual($0, observedBeacon) }) else {
            throw EmergencyError.wrongBeacon
        }
        let frame = try EmergencyFrame.decode(rawFrame)
        // A frame dated far ahead would outrank every real check-in from its sender until the clock caught up.
        let (now, overflow) = unixSeconds.multipliedReportingOverflow(by: 1000)
        guard !EmergencyBounds.isTooFarAhead(frameTimestampMilliseconds: frame.messageID.timestampMilliseconds,
                                             nowMilliseconds: overflow ? UInt64.max : now) else {
            throw EmergencyError.futureFrame
        }
        let verified = try frame.verified(allowedRoster: allowedRoster, verifier: verifier)
        try admit(verified, relay: frame.decrementHop(), requireRelayAdmission: false)
        return frame
    }

    private func admit(_ verified: VerifiedEmergencyFrame, relay: EmergencyFrame?, requireRelayAdmission: Bool) throws {
        let frame = verified.frame
        guard !queue.contains(where: { $0.messageID == frame.messageID }) else { throw EmergencyError.replay }
        if let current = members[frame.senderPublicKey], frame.messageID <= current.messageID {
            throw frame.messageID == current.messageID ? EmergencyError.replay : EmergencyError.staleStatus
        }
        // Local creation is transactional. Verified peer status survives a best-effort relay refusal.
        var nextReplay = replay
        guard nextReplay.acceptOnce(frame.messageID) else { throw EmergencyError.replay }
        var nextQueue = queue
        if let relay {
            var relayAdmitted = true
            if nextQueue.count == capacity {
                let candidates = nextQueue.indices.filter { nextQueue[$0].messageID != inFlight }
                if let worst = candidates.min(by: { preferred(nextQueue[$1], nextQueue[$0]) }),
                   preferred(relay, nextQueue[worst]) {
                    nextQueue.remove(at: worst)
                } else {
                    relayAdmitted = false
                }
            }
            if relayAdmitted {
                nextQueue.append(relay)
                nextQueue.sort(by: preferred)
            } else if requireRelayAdmission {
                throw EmergencyError.queueFull
            }
        }
        replay = nextReplay; queue = nextQueue
        members[frame.senderPublicKey] = EmergencyMemberStatus(publicKey: frame.senderPublicKey,
            messageID: frame.messageID, status: frame.status, text: frame.text, ttlHops: frame.ttlHops)
    }
    private func preferred(_ lhs: EmergencyFrame, _ rhs: EmergencyFrame) -> Bool {
        lhs.status.relayPriority == rhs.status.relayPriority
            ? lhs.messageID > rhs.messageID : lhs.status.relayPriority > rhs.status.relayPriority
    }
    private func constantEqual(_ lhs: Data, _ rhs: Data) -> Bool {
        guard lhs.count == rhs.count else { return false }
        return zip(lhs, rhs).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }

    public var pendingCount: Int { queue.count }
    public func memberStatuses() -> [EmergencyMemberStatus] {
        members.values.sorted { $0.publicKey.lexicographicallyPrecedes($1.publicKey) }
    }

    /// The selected frame stays pinned within queue capacity until completion. Failure or cancellation
    /// retains it for retry, unless stop() cleared the node. An in-flight adapter call may finish after
    /// stop; cancelling that physical operation belongs to the adapter. Success is not peer receipt.
    @discardableResult
    public func broadcastNext(
        using transport: any BLEEmergencyTransport,
        unixSeconds: UInt64 = EmergencyBounds.currentUnixSeconds()
    ) async throws -> Bool {
        try Task.checkCancellation()
        guard !stopped, inFlight == nil else { throw EmergencyError.invalidConfiguration }
        guard let frame = queue.first else { return false }
        let beacon = try currentBeacon(unixSeconds: unixSeconds)
        inFlight = frame.messageID
        defer { inFlight = nil }
        try await transport.broadcast(frame: frame.encode(), beacon: beacon)
        try Task.checkCancellation()
        guard !stopped else { return false }
        queue.removeAll { $0.messageID == frame.messageID }
        return true
    }
    public func stop() {
        stopped = true; queue.removeAll(); members.removeAll()
        replay.clear()
    }
}
