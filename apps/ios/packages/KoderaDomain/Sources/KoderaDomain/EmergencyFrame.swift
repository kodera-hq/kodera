import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

// The `#proximity` frame v1 codec. The channel was first named `#urgence` and this frame
// "emergency frame v1"; this file keeps its first name because the reviewed-secrets ledger
// (`.gitleaksignore`) binds an entry to its path.
//
// FROZEN v1 WIRE FORMAT. The header bytes `4b 45 01` (ASCII "KE", version 1), the field layout and
// the signed label `kodera-emergency-v1:` are bytes that deployed peers sign and verify. They keep
// their historical value, old word included. Changing any of them is a new protocol version, never
// a rename. `packages/kodera-rs/vectors/proximity-frame-v1.txt` pins them and the tests read it.

public enum ProximityError: Error, Equatable, Sendable {
    case invalidIdentifier, malformedFrame, invalidTTL, payloadTooLarge
    case unauthorizedSender, invalidSignature, cryptoUnavailable, invalidConfiguration
    case wrongBeacon, replay, queueFull, staleStatus, futureFrame
    case invalidHandle
}

/// The proximity v1 bounds and clock rule, shared with `kodera-rs` through
/// `packages/kodera-rs/vectors/emergency-v1-rules.txt` (a path kept under its first name), which the tests read.
public enum ProximityBounds {
    public static let queueCapacity = 128
    public static let rosterMembers = 4096
    public static let replayEntries = 4096
    public static let maxFutureSkewMilliseconds: UInt64 = 300_000

    public static func currentUnixMilliseconds(now: Date = Date()) -> UInt64 {
        let ms = now.timeIntervalSince1970 * 1000.0
        guard ms.isFinite, ms > 0 else { return 0 }
        return ms >= Double(UInt64.max) ? UInt64.max : UInt64(ms)
    }

    public static func currentUnixSeconds(now: Date = Date()) -> UInt64 {
        let secs = now.timeIntervalSince1970
        guard secs.isFinite, secs > 0 else { return 0 }
        return secs >= Double(UInt64.max) ? UInt64.max : UInt64(secs)
    }

    /// True when the frame's UUIDv7 time is more than the skew bound ahead of the verifier's clock.
    /// A frame exactly at the bound is accepted; past frames are never refused by this rule.
    public static func isTooFarAhead(
        frameTimestampMilliseconds: UInt64,
        nowMilliseconds: UInt64 = currentUnixMilliseconds()
    ) -> Bool {
        let (limit, overflow) = nowMilliseconds.addingReportingOverflow(maxFutureSkewMilliseconds)
        return !overflow && frameTimestampMilliseconds > limit
    }
}

public enum ProximitySafetyStatus: UInt8, CaseIterable, Sendable {
    case messageOnly = 0, safe = 1, needAssistance = 2, musterPoint = 3

    public var relayPriority: Int {
        switch self {
        case .needAssistance: 3
        case .musterPoint: 2
        case .safe: 1
        case .messageOnly: 0
        }
    }
}

/// Canonical RFC 9562 UUIDv7 bytes, independent of platform UUID formatting.
public struct ProximityMessageID: Hashable, Comparable, Sendable {
    public let bytes: Data
    public init(bytes: Data) throws {
        guard bytes.count == 16 else { throw ProximityError.invalidIdentifier }
        let octets = Array(bytes)
        guard octets[6] >> 4 == 7, octets[8] >> 6 == 2 else {
            throw ProximityError.invalidIdentifier
        }
        self.bytes = Data(octets)
    }
    public init(timestampMilliseconds: UInt64, randomness: Data) throws {
        guard timestampMilliseconds <= 0xffff_ffff_ffff, randomness.count == 10 else {
            throw ProximityError.invalidIdentifier
        }
        let random = Array(randomness)
        var bytes = (0..<6).map { UInt8(truncatingIfNeeded: timestampMilliseconds >> ((5 - $0) * 8)) }
        bytes += [0x70 | (random[0] & 0x0f), random[1], 0x80 | (random[2] & 0x3f)]
        bytes += random[3...9]
        try self.init(bytes: Data(bytes))
    }
    public var timestampMilliseconds: UInt64 {
        bytes.prefix(6).reduce(0) { ($0 << 8) | UInt64($1) }
    }
    public static func < (lhs: Self, rhs: Self) -> Bool {
        lhs.bytes.lexicographicallyPrecedes(rhs.bytes)
    }
}

public protocol ProximityIdentitySigner: Sendable {
    var publicKey: Data { get }
    func sign(_ transcript: Data) throws -> Data
}
public protocol ProximitySignatureVerifier: Sendable {
    func verify(publicKey: Data, transcript: Data, signature: Data) throws
}

/// Uses the platform's Ed25519 implementation. Unsupported hosts refuse verification.
public struct SystemProximitySignatureVerifier: ProximitySignatureVerifier {
    public init() {}
    public func verify(publicKey: Data, transcript: Data, signature: Data) throws {
        guard publicKey.count == 32, signature.count == 64 else { throw ProximityError.invalidSignature }
        #if canImport(CryptoKit)
        guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey),
              key.isValidSignature(signature, for: transcript) else { throw ProximityError.invalidSignature }
        #else
        throw ProximityError.cryptoUnavailable
        #endif
    }
}

#if canImport(CryptoKit)
/// Device storage/provisioning is owned by the caller; this value does not persist a key.
public struct Ed25519ProximitySigner: ProximityIdentitySigner, CustomStringConvertible, CustomDebugStringConvertible {
    private let key: Curve25519.Signing.PrivateKey
    public init(rawPrivateKey: Data) throws {
        guard rawPrivateKey.count == 32 else { throw ProximityError.invalidConfiguration }
        key = try Curve25519.Signing.PrivateKey(rawRepresentation: rawPrivateKey)
    }
    public var description: String { "Ed25519ProximitySigner(<redacted>)" }
    public var debugDescription: String { description }
    public var publicKey: Data { key.publicKey.rawRepresentation }
    public func sign(_ transcript: Data) throws -> Data { try key.signature(for: transcript) }
}
#endif

public struct ProximityFrame: Equatable, Sendable {
    public static let fixedOverhead = 118
    public static let maximumTextBytes = 138
    public let messageID: ProximityMessageID
    public let senderPublicKey: Data
    public let ttlHops: UInt8
    public let status: ProximitySafetyStatus
    public let text: String
    public let signature: Data

    public init(messageID: ProximityMessageID, senderPublicKey: Data, ttlHops: UInt8,
                status: ProximitySafetyStatus, text: String, signature: Data) throws {
        guard (1...6).contains(ttlHops) else { throw ProximityError.invalidTTL }
        guard text.utf8.count <= Self.maximumTextBytes else { throw ProximityError.payloadTooLarge }
        guard senderPublicKey.count == 32, signature.count == 64 else { throw ProximityError.malformedFrame }
        self.messageID = messageID; self.senderPublicKey = Data(senderPublicKey)
        self.ttlHops = ttlHops; self.status = status; self.text = text; self.signature = Data(signature)
    }

    public static func signed(messageID: ProximityMessageID, ttlHops: UInt8,
                              status: ProximitySafetyStatus, text: String,
                              signer: any ProximityIdentitySigner) throws -> Self {
        guard (1...6).contains(ttlHops) else { throw ProximityError.invalidTTL }
        guard text.utf8.count <= maximumTextBytes else { throw ProximityError.payloadTooLarge }
        let key = signer.publicKey
        guard key.count == 32 else { throw ProximityError.malformedFrame }
        let transcript = transcript(messageID: messageID, senderPublicKey: key, status: status, text: text)
        return try Self(messageID: messageID, senderPublicKey: key, ttlHops: ttlHops,
                        status: status, text: text, signature: signer.sign(transcript))
    }

    public var signingTranscript: Data {
        Self.transcript(messageID: messageID, senderPublicKey: senderPublicKey, status: status, text: text)
    }
    private static func transcript(messageID: ProximityMessageID, senderPublicKey: Data,
                                   status: ProximitySafetyStatus, text: String) -> Data {
        // Frozen signed label: the historical word stays (see the note at the top of this file).
        Data("kodera-emergency-v1:".utf8) + messageID.bytes + senderPublicKey
            + Data([status.rawValue, UInt8(text.utf8.count)]) + Data(text.utf8)
    }
    public func encode() -> Data {
        Data([0x4b, 0x45, 1]) + messageID.bytes + senderPublicKey
            + Data([ttlHops, status.rawValue, UInt8(text.utf8.count)]) + Data(text.utf8) + signature
    }
    public static func decode(_ data: Data) throws -> Self {
        guard (fixedOverhead...256).contains(data.count) else { throw ProximityError.malformedFrame }
        let raw = Array(data)
        guard Array(raw[0..<3]) == [0x4b, 0x45, 1] else {
            throw ProximityError.malformedFrame
        }
        let count = Int(raw[53])
        guard count <= maximumTextBytes, raw.count == fixedOverhead + count,
              let status = ProximitySafetyStatus(rawValue: raw[52]),
              let text = String(bytes: raw[54..<(54 + count)], encoding: .utf8) else {
            throw ProximityError.malformedFrame
        }
        return try Self(messageID: ProximityMessageID(bytes: Data(raw[3..<19])),
                        senderPublicKey: Data(raw[19..<51]), ttlHops: raw[51], status: status,
                        text: text, signature: Data(raw[(54 + count)...]))
    }
    /// TTL is deliberately outside the signing transcript, matching the shared core.
    public func decrementHop() -> Self? {
        guard ttlHops > 1 else { return nil }
        return try? Self(messageID: messageID, senderPublicKey: senderPublicKey, ttlHops: ttlHops - 1,
                         status: status, text: text, signature: signature)
    }
    public func verified(allowedRoster: Set<Data>, verifier: any ProximitySignatureVerifier = SystemProximitySignatureVerifier()) throws -> VerifiedProximityFrame {
        guard allowedRoster.contains(senderPublicKey) else { throw ProximityError.unauthorizedSender }
        try verifier.verify(publicKey: senderPublicKey, transcript: signingTranscript, signature: signature)
        return VerifiedProximityFrame(frame: self)
    }
}

/// This wrapper can only be created after roster and signature verification.
public struct VerifiedProximityFrame: Sendable {
    public let frame: ProximityFrame
    fileprivate init(frame: ProximityFrame) { self.frame = frame }
}

/// Bounded replay memory. Once an old entry is evicted it is no longer a lifetime replay guarantee.
public struct ProximityReplayGuard: Sendable {
    private var seen: Set<ProximityMessageID> = []
    public let capacity: Int
    public init(capacity: Int = 1024) throws {
        guard (1...ProximityBounds.replayEntries).contains(capacity) else { throw ProximityError.invalidConfiguration }
        self.capacity = capacity
    }
    public mutating func acceptOnce(_ id: ProximityMessageID) -> Bool {
        guard !seen.contains(id) else { return false }
        if seen.count == capacity, let oldest = seen.min() { seen.remove(oldest) }
        seen.insert(id)
        return true
    }
    public var count: Int { seen.count }
    public mutating func clear() { seen.removeAll() }
}
