import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

public enum EmergencyError: Error, Equatable, Sendable {
    case invalidIdentifier, malformedFrame, invalidTTL, payloadTooLarge
    case unauthorizedSender, invalidSignature, cryptoUnavailable, invalidConfiguration
    case wrongBeacon, replay, queueFull, staleStatus, futureFrame
}

/// The emergency v1 bounds and clock rule, shared with `kodera-rs` through
/// `packages/kodera-rs/vectors/emergency-v1-rules.txt`, which the tests read.
public enum EmergencyBounds {
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

public enum EmergencySafetyStatus: UInt8, CaseIterable, Sendable {
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
public struct EmergencyMessageID: Hashable, Comparable, Sendable {
    public let bytes: Data
    public init(bytes: Data) throws {
        guard bytes.count == 16 else { throw EmergencyError.invalidIdentifier }
        let octets = Array(bytes)
        guard octets[6] >> 4 == 7, octets[8] >> 6 == 2 else {
            throw EmergencyError.invalidIdentifier
        }
        self.bytes = Data(octets)
    }
    public init(timestampMilliseconds: UInt64, randomness: Data) throws {
        guard timestampMilliseconds <= 0xffff_ffff_ffff, randomness.count == 10 else {
            throw EmergencyError.invalidIdentifier
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

public protocol EmergencyIdentitySigner: Sendable {
    var publicKey: Data { get }
    func sign(_ transcript: Data) throws -> Data
}
public protocol EmergencySignatureVerifier: Sendable {
    func verify(publicKey: Data, transcript: Data, signature: Data) throws
}

/// Uses the platform's Ed25519 implementation. Unsupported hosts refuse verification.
public struct SystemEmergencySignatureVerifier: EmergencySignatureVerifier {
    public init() {}
    public func verify(publicKey: Data, transcript: Data, signature: Data) throws {
        guard publicKey.count == 32, signature.count == 64 else { throw EmergencyError.invalidSignature }
        #if canImport(CryptoKit)
        guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey),
              key.isValidSignature(signature, for: transcript) else { throw EmergencyError.invalidSignature }
        #else
        throw EmergencyError.cryptoUnavailable
        #endif
    }
}

#if canImport(CryptoKit)
/// Device storage/provisioning is owned by the caller; this value does not persist a key.
public struct Ed25519EmergencySigner: EmergencyIdentitySigner, CustomStringConvertible, CustomDebugStringConvertible {
    private let key: Curve25519.Signing.PrivateKey
    public init(rawPrivateKey: Data) throws {
        guard rawPrivateKey.count == 32 else { throw EmergencyError.invalidConfiguration }
        key = try Curve25519.Signing.PrivateKey(rawRepresentation: rawPrivateKey)
    }
    public var description: String { "Ed25519EmergencySigner(<redacted>)" }
    public var debugDescription: String { description }
    public var publicKey: Data { key.publicKey.rawRepresentation }
    public func sign(_ transcript: Data) throws -> Data { try key.signature(for: transcript) }
}
#endif

public struct EmergencyFrame: Equatable, Sendable {
    public static let fixedOverhead = 118
    public static let maximumTextBytes = 138
    public let messageID: EmergencyMessageID
    public let senderPublicKey: Data
    public let ttlHops: UInt8
    public let status: EmergencySafetyStatus
    public let text: String
    public let signature: Data

    public init(messageID: EmergencyMessageID, senderPublicKey: Data, ttlHops: UInt8,
                status: EmergencySafetyStatus, text: String, signature: Data) throws {
        guard (1...6).contains(ttlHops) else { throw EmergencyError.invalidTTL }
        guard text.utf8.count <= Self.maximumTextBytes else { throw EmergencyError.payloadTooLarge }
        guard senderPublicKey.count == 32, signature.count == 64 else { throw EmergencyError.malformedFrame }
        self.messageID = messageID; self.senderPublicKey = Data(senderPublicKey)
        self.ttlHops = ttlHops; self.status = status; self.text = text; self.signature = Data(signature)
    }

    public static func signed(messageID: EmergencyMessageID, ttlHops: UInt8,
                              status: EmergencySafetyStatus, text: String,
                              signer: any EmergencyIdentitySigner) throws -> Self {
        guard (1...6).contains(ttlHops) else { throw EmergencyError.invalidTTL }
        guard text.utf8.count <= maximumTextBytes else { throw EmergencyError.payloadTooLarge }
        let key = signer.publicKey
        guard key.count == 32 else { throw EmergencyError.malformedFrame }
        let transcript = transcript(messageID: messageID, senderPublicKey: key, status: status, text: text)
        return try Self(messageID: messageID, senderPublicKey: key, ttlHops: ttlHops,
                        status: status, text: text, signature: signer.sign(transcript))
    }

    public var signingTranscript: Data {
        Self.transcript(messageID: messageID, senderPublicKey: senderPublicKey, status: status, text: text)
    }
    private static func transcript(messageID: EmergencyMessageID, senderPublicKey: Data,
                                   status: EmergencySafetyStatus, text: String) -> Data {
        Data("kodera-emergency-v1:".utf8) + messageID.bytes + senderPublicKey
            + Data([status.rawValue, UInt8(text.utf8.count)]) + Data(text.utf8)
    }
    public func encode() -> Data {
        Data([0x4b, 0x45, 1]) + messageID.bytes + senderPublicKey
            + Data([ttlHops, status.rawValue, UInt8(text.utf8.count)]) + Data(text.utf8) + signature
    }
    public static func decode(_ data: Data) throws -> Self {
        guard (fixedOverhead...256).contains(data.count) else { throw EmergencyError.malformedFrame }
        let raw = Array(data)
        guard Array(raw[0..<3]) == [0x4b, 0x45, 1] else {
            throw EmergencyError.malformedFrame
        }
        let count = Int(raw[53])
        guard count <= maximumTextBytes, raw.count == fixedOverhead + count,
              let status = EmergencySafetyStatus(rawValue: raw[52]),
              let text = String(bytes: raw[54..<(54 + count)], encoding: .utf8) else {
            throw EmergencyError.malformedFrame
        }
        return try Self(messageID: EmergencyMessageID(bytes: Data(raw[3..<19])),
                        senderPublicKey: Data(raw[19..<51]), ttlHops: raw[51], status: status,
                        text: text, signature: Data(raw[(54 + count)...]))
    }
    /// TTL is deliberately outside the signing transcript, matching the shared core.
    public func decrementHop() -> Self? {
        guard ttlHops > 1 else { return nil }
        return try? Self(messageID: messageID, senderPublicKey: senderPublicKey, ttlHops: ttlHops - 1,
                         status: status, text: text, signature: signature)
    }
    public func verified(allowedRoster: Set<Data>, verifier: any EmergencySignatureVerifier = SystemEmergencySignatureVerifier()) throws -> VerifiedEmergencyFrame {
        guard allowedRoster.contains(senderPublicKey) else { throw EmergencyError.unauthorizedSender }
        try verifier.verify(publicKey: senderPublicKey, transcript: signingTranscript, signature: signature)
        return VerifiedEmergencyFrame(frame: self)
    }
}

/// This wrapper can only be created after roster and signature verification.
public struct VerifiedEmergencyFrame: Sendable {
    public let frame: EmergencyFrame
    fileprivate init(frame: EmergencyFrame) { self.frame = frame }
}

/// Bounded replay memory. Once an old entry is evicted it is no longer a lifetime replay guarantee.
public struct EmergencyReplayGuard: Sendable {
    private var seen: Set<EmergencyMessageID> = []
    public let capacity: Int
    public init(capacity: Int = 1024) throws {
        guard (1...EmergencyBounds.replayEntries).contains(capacity) else { throw EmergencyError.invalidConfiguration }
        self.capacity = capacity
    }
    public mutating func acceptOnce(_ id: EmergencyMessageID) -> Bool {
        guard !seen.contains(id) else { return false }
        if seen.count == capacity, let oldest = seen.min() { seen.remove(oldest) }
        seen.insert(id)
        return true
    }
    public var count: Int { seen.count }
    public mutating func clear() { seen.removeAll() }
}
