import Foundation
import KoderaDomain

/// A radio adapter must provide its own permission, availability, cancellation and delivery semantics.
public protocol BLEProximityTransport: Sendable {
    func broadcast(frame: Data, beacon: Data) async throws
}

public struct ProximityMemberStatus: Equatable, Sendable {
    public let publicKey: Data
    public let messageID: ProximityMessageID
    public let status: ProximitySafetyStatus
    public let text: String
    public let ttlHops: UInt8
    public var timestampMilliseconds: UInt64 { messageID.timestampMilliseconds }
}

/// Per-organisation, in-memory verified state. Construct only from trusted provisioning.
/// Signed v1 frames carry plaintext; no confidential transport or radio implementation is supplied here.
public actor BLEProximityCoordinator {
    private let salt: Data
    private let allowedRoster: Set<Data>
    private let verifier: any ProximitySignatureVerifier
    private let capacity: Int
    private var replay: ProximityReplayGuard
    private var queue: [ProximityFrame] = []
    private var members: [Data: ProximityMemberStatus] = [:]
    /// Pseudonyms members picked, by provisioned key. Display metadata only: never consulted to admit,
    /// refuse or deduplicate anything.
    private var dedicatedHandles: [Data: ProximityHandle] = [:]
    private var inFlight: ProximityMessageID?
    private var stopped = false

    public init(salt: Data, allowedRoster: Set<Data>, queueCapacity: Int = 128,
                replayCapacity: Int = 1024,
                verifier: any ProximitySignatureVerifier = SystemProximitySignatureVerifier()) throws {
        guard salt.count == 32, (1...ProximityBounds.rosterMembers).contains(allowedRoster.count),
              allowedRoster.allSatisfy({ $0.count == 32 }), (1...ProximityBounds.queueCapacity).contains(queueCapacity),
              replayCapacity >= queueCapacity else { throw ProximityError.invalidConfiguration }
        self.salt = salt; self.allowedRoster = allowedRoster; self.capacity = queueCapacity
        self.verifier = verifier; replay = try ProximityReplayGuard(capacity: replayCapacity)
    }

    public func currentBeacon(unixSeconds: UInt64 = ProximityBounds.currentUnixSeconds()) throws -> Data {
        guard !stopped else { throw ProximityError.invalidConfiguration }
        return try ProximityBeacon.compute(salt: salt, unixSeconds: unixSeconds)
    }

    @discardableResult
    public func createLocalCheckIn(messageID: ProximityMessageID, status: ProximitySafetyStatus,
                                   text: String, signer: any ProximityIdentitySigner) throws -> ProximityFrame {
        guard !stopped else { throw ProximityError.invalidConfiguration }
        let frame = try ProximityFrame.signed(messageID: messageID, ttlHops: 6,
                                               status: status, text: text, signer: signer)
        let verified = try frame.verified(allowedRoster: allowedRoster, verifier: verifier)
        try admit(verified, relay: frame, requireRelayAdmission: true)
        return frame
    }

    @discardableResult
    public func ingestPeerFrame(
        observedBeacon: Data,
        unixSeconds: UInt64 = ProximityBounds.currentUnixSeconds(),
        rawFrame: Data
    ) throws -> ProximityFrame {
        guard !stopped else { throw ProximityError.invalidConfiguration }
        let previous = unixSeconds >= 300 ? unixSeconds - 300 : 0
        let next = unixSeconds <= UInt64.max - 300 ? unixSeconds + 300 : UInt64.max
        let candidates = try [previous, unixSeconds, next].map {
            try ProximityBeacon.compute(salt: salt, unixSeconds: $0)
        }
        guard observedBeacon.count == 8, candidates.contains(where: { constantEqual($0, observedBeacon) }) else {
            throw ProximityError.wrongBeacon
        }
        let frame = try ProximityFrame.decode(rawFrame)
        // A frame dated far ahead would outrank every real check-in from its sender until the clock caught up.
        let (now, overflow) = unixSeconds.multipliedReportingOverflow(by: 1000)
        guard !ProximityBounds.isTooFarAhead(frameTimestampMilliseconds: frame.messageID.timestampMilliseconds,
                                             nowMilliseconds: overflow ? UInt64.max : now) else {
            throw ProximityError.futureFrame
        }
        let verified = try frame.verified(allowedRoster: allowedRoster, verifier: verifier)
        try admit(verified, relay: frame.decrementHop(), requireRelayAdmission: false)
        return frame
    }

    private func admit(_ verified: VerifiedProximityFrame, relay: ProximityFrame?, requireRelayAdmission: Bool) throws {
        let frame = verified.frame
        guard !queue.contains(where: { $0.messageID == frame.messageID }) else { throw ProximityError.replay }
        if let current = members[frame.senderPublicKey], frame.messageID <= current.messageID {
            throw frame.messageID == current.messageID ? ProximityError.replay : ProximityError.staleStatus
        }
        // Local creation is transactional. Verified peer status survives a best-effort relay refusal.
        var nextReplay = replay
        guard nextReplay.acceptOnce(frame.messageID) else { throw ProximityError.replay }
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
                throw ProximityError.queueFull
            }
        }
        replay = nextReplay; queue = nextQueue
        members[frame.senderPublicKey] = ProximityMemberStatus(publicKey: frame.senderPublicKey,
            messageID: frame.messageID, status: frame.status, text: frame.text, ttlHops: frame.ttlHops)
    }
    private func preferred(_ lhs: ProximityFrame, _ rhs: ProximityFrame) -> Bool {
        lhs.status.relayPriority == rhs.status.relayPriority
            ? lhs.messageID > rhs.messageID : lhs.status.relayPriority > rhs.status.relayPriority
    }
    private func constantEqual(_ lhs: Data, _ rhs: Data) -> Bool {
        guard lhs.count == rhs.count else { return false }
        return zip(lhs, rhs).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }

    public var pendingCount: Int { queue.count }
    public func memberStatuses() -> [ProximityMemberStatus] {
        members.values.sorted { $0.publicKey.lexicographicallyPrecedes($1.publicKey) }
    }
    /// Records the pseudonym a provisioned member picked. Trusted provisioning only: the key must be
    /// in the roster and the handle inside the shared grammar. It changes what is displayed for that
    /// key and nothing else.
    public func provisionDedicatedHandle(_ raw: String, for publicKey: Data) throws {
        guard !stopped else { throw ProximityError.invalidConfiguration }
        guard allowedRoster.contains(publicKey) else { throw ProximityError.unauthorizedSender }
        dedicatedHandles[publicKey] = try ProximityHandle(dedicated: raw)
    }

    /// One display label per member that has checked in, in `memberStatuses()` order. A handle is the
    /// member's dedicated pseudonym when one was provisioned, else derived from the sender key under
    /// this organisation's beacon salt, so no name is needed and none is revealed.
    ///
    /// Equal handles are told apart with a fingerprint of the signing key, keyed with this organisation's
    /// beacon salt so it links nothing across organisations, and equality is judged over
    /// EVERY provisioned key, not over the members seen so far: a member whose handle equals that of
    /// someone who has not checked in yet already carries its fingerprint, so it cannot pass for the
    /// absent member and no label changes when that member appears. Labels are for display only:
    /// identity and admission stay with the key, the roster and the signature.
    public func memberLabels() throws -> [ProximityRosterLabel] {
        guard !stopped else { throw ProximityError.invalidConfiguration }
        let provisioned = try allowedRoster.map { key in
            (senderPublicKey: key,
             handle: try dedicatedHandles[key] ?? ProximityHandle.generated(organisationSalt: salt, senderPublicKey: key))
        }
        return try ProximityHandle.labels(provisioned: provisioned, observed: memberStatuses().map(\.publicKey),
                                          organisationSalt: salt)
    }

    /// The selected frame stays pinned within queue capacity until completion. Failure or cancellation
    /// retains it for retry, unless stop() cleared the node. An in-flight adapter call may finish after
    /// stop; cancelling that physical operation belongs to the adapter. Success is not peer receipt.
    @discardableResult
    public func broadcastNext(
        using transport: any BLEProximityTransport,
        unixSeconds: UInt64 = ProximityBounds.currentUnixSeconds()
    ) async throws -> Bool {
        try Task.checkCancellation()
        guard !stopped, inFlight == nil else { throw ProximityError.invalidConfiguration }
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
        stopped = true; queue.removeAll(); members.removeAll(); dedicatedHandles.removeAll()
        replay.clear()
    }
}
