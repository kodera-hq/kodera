import CryptoKit
import Foundation

public enum KoderaMobileFfiError: Error, Equatable, Sendable {
    case invalidPacket
    case invalidJSON
    case unknownOperation
    case invalidInput
    case authenticationFailed
    case replayDetected
    case staleEpoch
    case algorithmMismatch
    case organisationMismatch
    case capacityExceeded
    case cleartextForbidden(field: String)
    case unexpectedField(field: String)
    case featureDisabled

    public var statusCode: UInt32 {
        switch self {
        case .invalidPacket: 1
        case .invalidJSON: 2
        case .unknownOperation: 3
        case .invalidInput: 4
        case .authenticationFailed: 5
        case .replayDetected: 6
        case .staleEpoch: 7
        case .algorithmMismatch: 8
        case .organisationMismatch: 9
        case .capacityExceeded: 10
        case .cleartextForbidden: 11
        case .unexpectedField: 12
        case .featureDisabled: 13
        }
    }
}

/// Fixed-capacity `64 KiB` packet mirroring `kodera_rs::mobile_ffi::KoderaFfiPacket`.
public struct KoderaFfiPacket: Equatable, Sendable {
    public static let capacity = 65_536

    public var len: UInt32
    public var status: UInt32
    public var payload: Data

    public init(payload: Data = Data(), status: UInt32 = 0) throws {
        guard payload.count <= Self.capacity else {
            throw KoderaMobileFfiError.capacityExceeded
        }
        self.len = UInt32(payload.count)
        self.status = status
        self.payload = payload
    }
}

/// Injectable packet-dispatch seam matching `kodera_rs::mobile_ffi::PacketDispatcher` and
/// verified byte-for-byte against `packages/kodera-rs/vectors/mobile-ffi-v1.txt`.
public protocol PacketDispatcher: Sendable {
    func dispatch(_ request: KoderaFfiPacket) throws -> KoderaFfiPacket
}

public typealias KoderaMobileFfiTransport = PacketDispatcher

extension PacketDispatcher {
    public func invoke(_ request: KoderaFfiPacket) throws -> KoderaFfiPacket {
        try dispatch(request)
    }
}

/// RFC 9562 UUIDv7 identifier minting and validation matching `kodera_rs::UuidV7` byte-for-byte.
public struct UuidV7Identifier: Equatable, Hashable, Comparable, Sendable, CustomStringConvertible {
    public static let maximumTimestampMs: UInt64 = 0x0000_FFFF_FFFF_FFFF
    public let bytes: [UInt8]

    public static func < (lhs: UuidV7Identifier, rhs: UuidV7Identifier) -> Bool {
        lhs.bytes.lexicographicallyPrecedes(rhs.bytes)
    }

    public init(unixTimestampMs: UInt64, randomBytes: [UInt8]) throws {
        guard unixTimestampMs <= Self.maximumTimestampMs, randomBytes.count == 10 else {
            throw KoderaMobileFfiError.invalidInput
        }
        var out = [UInt8](repeating: 0, count: 16)
        out[0] = UInt8((unixTimestampMs >> 40) & 0xFF)
        out[1] = UInt8((unixTimestampMs >> 32) & 0xFF)
        out[2] = UInt8((unixTimestampMs >> 24) & 0xFF)
        out[3] = UInt8((unixTimestampMs >> 16) & 0xFF)
        out[4] = UInt8((unixTimestampMs >> 8) & 0xFF)
        out[5] = UInt8(unixTimestampMs & 0xFF)
        out[6] = 0x70 | (randomBytes[0] & 0x0F)
        out[7] = randomBytes[1]
        out[8] = 0x80 | (randomBytes[2] & 0x3F)
        for index in 0..<7 {
            out[9 + index] = randomBytes[3 + index]
        }
        self.bytes = out
    }

    public init(checkedBytes: [UInt8]) throws {
        guard checkedBytes.count == 16,
              (checkedBytes[6] >> 4) == 0x07,
              (checkedBytes[8] >> 6) == 0b10 else {
            throw KoderaMobileFfiError.invalidInput
        }
        self.bytes = checkedBytes
    }

    public init(parsing canonical: String) throws {
        guard canonical.utf8.count == 36 else {
            throw KoderaMobileFfiError.invalidInput
        }
        var compact: [UInt8] = []
        compact.reserveCapacity(32)
        for (idx, byte) in canonical.utf8.enumerated() {
            if [8, 13, 18, 23].contains(idx) {
                guard byte == 0x2D else { throw KoderaMobileFfiError.invalidInput }
            } else if (0x30...0x39).contains(byte) || (0x61...0x66).contains(byte) {
                compact.append(byte)
            } else {
                throw KoderaMobileFfiError.invalidInput
            }
        }
        var raw = [UInt8](repeating: 0, count: 16)
        for i in 0..<16 {
            raw[i] = (Self.hexNibble(compact[i * 2]) << 4) | Self.hexNibble(compact[i * 2 + 1])
        }
        try self.init(checkedBytes: raw)
    }

    public static func mint(nowMs: UInt64? = nil) throws -> UuidV7Identifier {
        let ts = nowMs ?? UInt64(Date().timeIntervalSince1970 * 1000.0)
        let key = SymmetricKey(size: .bits128)
        let rand = key.withUnsafeBytes { Array($0.prefix(10)) }
        return try UuidV7Identifier(unixTimestampMs: ts & Self.maximumTimestampMs, randomBytes: rand)
    }

    public var timestampMs: UInt64 {
        (UInt64(bytes[0]) << 40)
            | (UInt64(bytes[1]) << 32)
            | (UInt64(bytes[2]) << 24)
            | (UInt64(bytes[3]) << 16)
            | (UInt64(bytes[4]) << 8)
            | UInt64(bytes[5])
    }

    public var description: String {
        let table = Array("0123456789abcdef".utf8)
        var chars: [UInt8] = []
        chars.reserveCapacity(36)
        for (idx, b) in bytes.enumerated() {
            if idx == 4 || idx == 6 || idx == 8 || idx == 10 {
                chars.append(0x2D)
            }
            chars.append(table[Int(b >> 4)])
            chars.append(table[Int(b & 0x0F)])
        }
        return String(decoding: chars, as: UTF8.self)
    }

    private static func hexNibble(_ ascii: UInt8) -> UInt8 {
        if (0x30...0x39).contains(ascii) { return ascii - 0x30 }
        return ascii - 0x61 + 10
    }
}

/// Wire-identical `KDV1` AES-256-GCM session vault codec bound to `(organisationId, deviceId)` AAD.
public enum Kdv1SessionVaultCodec {
    public static let magic: [UInt8] = [0x4B, 0x44, 0x56, 0x31] // "KDV1"
    public static let nonceByteCount = 12
    public static let tagByteCount = 16
    public static let maxPlaintextByteCount = 262_144
    private static let aadDomain = Data("kodera-mobile-session-vault-kdv1\0".utf8)

    public static func aad(organisationId: String, deviceId: String) throws -> Data {
        guard TrustPolicy.canonicalNonNilUUID(organisationId),
              isValidVaultDeviceId(deviceId) else {
            throw KoderaMobileFfiError.invalidInput
        }
        let orgBytes = Data(organisationId.utf8)
        let devBytes = Data(deviceId.utf8)
        var out = Data()
        out.reserveCapacity(aadDomain.count + 8 + orgBytes.count + devBytes.count)
        out.append(aadDomain)
        out.append(bigEndianUInt32(UInt32(orgBytes.count)))
        out.append(orgBytes)
        out.append(bigEndianUInt32(UInt32(devBytes.count)))
        out.append(devBytes)
        return out
    }

    public static func seal(
        organisationId: String,
        deviceId: String,
        keyData: Data,
        nonceData: Data? = nil,
        plaintext: Data
    ) throws -> Data {
        guard !plaintext.isEmpty, plaintext.count <= maxPlaintextByteCount else {
            throw KoderaMobileFfiError.capacityExceeded
        }
        guard keyData.count == 32 else {
            throw KoderaMobileFfiError.invalidInput
        }
        let aadBytes = try aad(organisationId: organisationId, deviceId: deviceId)
        let nonce: AES.GCM.Nonce
        if let nonceData {
            guard nonceData.count == nonceByteCount else {
                throw KoderaMobileFfiError.invalidInput
            }
            nonce = try AES.GCM.Nonce(data: nonceData)
        } else {
            nonce = AES.GCM.Nonce()
        }
        let key = SymmetricKey(data: keyData)
        let sealedBox: AES.GCM.SealedBox
        do {
            sealedBox = try AES.GCM.seal(plaintext, using: key, nonce: nonce, authenticating: aadBytes)
        } catch {
            throw KoderaMobileFfiError.authenticationFailed
        }
        let nonceRaw = nonce.withUnsafeBytes { Data($0) }
        var out = Data()
        out.reserveCapacity(magic.count + nonceByteCount + sealedBox.ciphertext.count + tagByteCount)
        out.append(contentsOf: magic)
        out.append(nonceRaw)
        out.append(sealedBox.ciphertext)
        out.append(sealedBox.tag)
        return out
    }

    public static func open(
        organisationId: String,
        deviceId: String,
        keyData: Data,
        sealed: Data
    ) throws -> Data {
        let minLen = magic.count + nonceByteCount + 1 + tagByteCount
        let maxLen = magic.count + nonceByteCount + maxPlaintextByteCount + tagByteCount
        guard sealed.count <= maxLen else {
            throw KoderaMobileFfiError.capacityExceeded
        }
        guard sealed.count >= minLen, Array(sealed.prefix(magic.count)) == magic else {
            throw KoderaMobileFfiError.invalidInput
        }
        guard keyData.count == 32 else {
            throw KoderaMobileFfiError.invalidInput
        }
        let aadBytes = try aad(organisationId: organisationId, deviceId: deviceId)
        let headerEnd = magic.count + nonceByteCount
        let tagStart = sealed.count - tagByteCount
        let nonceSlice = sealed.subdata(in: magic.count..<headerEnd)
        let ciphertextSlice = sealed.subdata(in: headerEnd..<tagStart)
        let tagSlice = sealed.subdata(in: tagStart..<sealed.count)

        do {
            let nonce = try AES.GCM.Nonce(data: nonceSlice)
            let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertextSlice, tag: tagSlice)
            return try AES.GCM.open(box, using: SymmetricKey(data: keyData), authenticating: aadBytes)
        } catch {
            throw KoderaMobileFfiError.authenticationFailed
        }
    }

    public static func isValidVaultDeviceId(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard (1...128).contains(bytes.count) else { return false }
        return bytes.allSatisfy { byte in
            (byte >= 0x30 && byte <= 0x39)
                || (byte >= 0x41 && byte <= 0x5A)
                || (byte >= 0x61 && byte <= 0x7A)
                || byte == 0x2D || byte == 0x5F || byte == 0x2E || byte == 0x3A
        }
    }

    private static func bigEndianUInt32(_ value: UInt32) -> Data {
        var be = value.bigEndian
        return withUnsafeBytes(of: &be) { Data($0) }
    }
}

/// Cryptographic algorithm discriminator matching `kodera_rs::CryptoAlgorithm`.
public enum SessionEnvelopeCryptoAlgorithm: UInt8, Equatable, Sendable {
    case matrixOlmV1 = 1
    case openMlsDraft = 2
}

public struct SessionEnvelopeHeaderModel: Equatable, Sendable {
    public let organisationId: String
    public let roomId: UuidV7Identifier
    public let messageId: UuidV7Identifier
    public let epoch: UInt64
    public let algorithm: SessionEnvelopeCryptoAlgorithm

    public init(
        organisationId: String,
        roomId: UuidV7Identifier,
        messageId: UuidV7Identifier,
        epoch: UInt64,
        algorithm: SessionEnvelopeCryptoAlgorithm
    ) throws {
        guard TrustPolicy.canonicalNonNilUUID(organisationId) else {
            throw KoderaMobileFfiError.invalidInput
        }
        self.organisationId = organisationId
        self.roomId = roomId
        self.messageId = messageId
        self.epoch = epoch
        self.algorithm = algorithm
    }
}

/// Bounded room epoch/algorithm & FIFO message-ID replay tracker matching `kodera_rs::SessionEnvelopeTracker`.
public struct SessionEnvelopeTrackerModel: Sendable {
    public static let maxEntries = 4_096

    private struct RoomState: Sendable {
        var epoch: UInt64
        var algorithm: SessionEnvelopeCryptoAlgorithm
    }

    private struct ReplayKey: Hashable, Sendable {
        let roomId: UuidV7Identifier
        let messageId: UuidV7Identifier
    }

    public let organisationId: String
    public let roomCapacity: Int
    public let replayCapacity: Int

    private var rooms: [UuidV7Identifier: RoomState] = [:]
    private var replay: Set<ReplayKey> = []
    private var replayOrder: [ReplayKey] = []

    public init(organisationId: String, roomCapacity: Int = 64, replayCapacity: Int = 256) throws {
        guard TrustPolicy.canonicalNonNilUUID(organisationId),
              (1...Self.maxEntries).contains(roomCapacity),
              (1...Self.maxEntries).contains(replayCapacity) else {
            throw KoderaMobileFfiError.invalidInput
        }
        self.organisationId = organisationId
        self.roomCapacity = roomCapacity
        self.replayCapacity = replayCapacity
    }

    public var roomCount: Int { rooms.count }
    public var replayCount: Int { replay.count }

    public mutating func verifyAndObserve(_ header: SessionEnvelopeHeaderModel) throws {
        guard header.organisationId == organisationId else {
            throw KoderaMobileFfiError.organisationMismatch
        }
        if let existing = rooms[header.roomId] {
            guard header.algorithm == existing.algorithm else {
                throw KoderaMobileFfiError.algorithmMismatch
            }
            guard header.epoch >= existing.epoch else {
                throw KoderaMobileFfiError.staleEpoch
            }
        } else if rooms.count == roomCapacity {
            throw KoderaMobileFfiError.capacityExceeded
        }
        let key = ReplayKey(roomId: header.roomId, messageId: header.messageId)
        guard !replay.contains(key) else {
            throw KoderaMobileFfiError.replayDetected
        }
        if replay.count == replayCapacity, !replayOrder.isEmpty {
            let oldest = replayOrder.removeFirst()
            replay.remove(oldest)
        }
        replay.insert(key)
        replayOrder.append(key)
        rooms[header.roomId] = RoomState(epoch: header.epoch, algorithm: header.algorithm)
    }

    public mutating func clear() {
        rooms.removeAll()
        replay.removeAll()
        replayOrder.removeAll()
    }
}

/// Deterministic UTS #51 single-grapheme emoji reaction validator matching `kodera_rs::mobile_ffi::validate_reaction_key`.
public enum ReactionKeyValidator {
    public static let maxUTF8Bytes = 32
    public static let quickPalette: [String] = ["👍", "❤️", "🎉", "🚀", "👀", "✅"]

    public static func isValid(_ key: String) -> Bool {
        guard !key.isEmpty, key.utf8.count <= maxUTF8Bytes else {
            return false
        }
        let scalars = key.unicodeScalars.map(\.value)
        guard !scalars.contains(where: isForbiddenScalar) else {
            return false
        }

        // 1. Keycap sequence: [0-9#*] U+FE0F? U+20E3
        if scalars[0] == 0x23 || scalars[0] == 0x2A || (0x30...0x39).contains(scalars[0]) {
            if scalars.count == 2 && scalars[1] == 0x20E3 { return true }
            if scalars.count == 3 && scalars[1] == 0xFE0F && scalars[2] == 0x20E3 { return true }
            return false
        }

        // 2. Regional indicator flag pair
        if isRegionalIndicator(scalars[0]) {
            return scalars.count == 2 && isRegionalIndicator(scalars[1])
        }

        // 3. Emoji pictographic base (+ optional VS16 / skin tone) (+ optional ZWJ continuations)
        var idx = 0
        while true {
            guard idx < scalars.count, isEmojiPictographicBase(scalars[idx]) else {
                return false
            }
            idx += 1
            if idx < scalars.count && scalars[idx] == 0xFE0F {
                idx += 1
            }
            if idx < scalars.count && isSkinToneModifier(scalars[idx]) {
                idx += 1
                if idx < scalars.count && scalars[idx] == 0xFE0F {
                    idx += 1
                }
            }
            if idx == scalars.count {
                return true
            }
            if scalars[idx] == 0x200D {
                idx += 1
                if idx >= scalars.count { return false }
            } else {
                return false
            }
        }
    }

    private static func isForbiddenScalar(_ cp: UInt32) -> Bool {
        if let scalar = UnicodeScalar(cp), scalar.properties.isWhitespace {
            return true
        }
        switch cp {
        case 0x0000...0x001F, 0x007F...0x009F, 0x00AD, 0x034F, 0x061C,
             0x200B...0x200C, 0x200E...0x200F, 0x202A...0x202E, 0x2060...0x206F,
             0xFEFF, 0xE0000...0xE007F:
            return true
        default:
            return false
        }
    }

    private static func isRegionalIndicator(_ cp: UInt32) -> Bool {
        (0x1F1E6...0x1F1FF).contains(cp)
    }

    private static func isSkinToneModifier(_ cp: UInt32) -> Bool {
        (0x1F3FB...0x1F3FF).contains(cp)
    }

    private static func isEmojiPictographicBase(_ cp: UInt32) -> Bool {
        if isRegionalIndicator(cp) || isSkinToneModifier(cp) { return false }
        switch cp {
        case 0x00A9, 0x00AE, 0x203C, 0x2049, 0x2122, 0x2139,
             0x2194...0x2199, 0x21A9...0x21AA, 0x231A...0x231B, 0x2328, 0x23CF,
             0x23E9...0x23F3, 0x23F8...0x23FA, 0x24C2, 0x25AA...0x25AB, 0x25B6,
             0x25C0, 0x25FB...0x25FE, 0x2600...0x27BF, 0x2934...0x2935,
             0x2B05...0x2B07, 0x2B1B...0x2B1C, 0x2B50, 0x2B55, 0x3030, 0x303D,
             0x3297, 0x3299, 0x1F000...0x1FAFF:
            return true
        default:
            return false
        }
    }
}

/// Core-scoped attachment MIME types and validated `io.kodera.attachments` reference model.
public enum AttachmentMimeType: String, CaseIterable, Equatable, Sendable {
    case jpeg = "image/jpeg"
    case png = "image/png"
    case webp = "image/webp"
    case gif = "image/gif"
    case oggAudio = "audio/ogg"
    case webmAudio = "audio/webm"
    case mp4Audio = "audio/mp4"
    case pdf = "application/pdf"
    case plainText = "text/plain"
    case octetStream = "application/octet-stream"

    public var isAudio: Bool { [.oggAudio, .webmAudio, .mp4Audio].contains(self) }
}

public struct AttachmentMetadataRef: Equatable, Hashable, Sendable {
    public static let maxFilenameLength = 255
    public static let maxSizeBytes = 26_214_400
    public static let maxRefsPerMessage = 10
    public static let matrixFieldName = "io.kodera.attachments"

    public let id: String
    public let filename: String
    public let contentType: AttachmentMimeType
    public let sizeBytes: Int

    public init(id: String, filename: String, contentType: AttachmentMimeType, sizeBytes: Int) throws {
        guard TrustPolicy.canonicalNonNilUUID(id) else {
            throw KoderaMobileFfiError.invalidInput
        }
        let cleaned = Self.cleanFilename(filename)
        guard !cleaned.isEmpty,
              cleaned.count <= Self.maxFilenameLength,
              (1...Self.maxSizeBytes).contains(sizeBytes) else {
            throw KoderaMobileFfiError.invalidInput
        }
        self.id = id
        self.filename = cleaned
        self.contentType = contentType
        self.sizeBytes = sizeBytes
    }

    public static func cleanFilename(_ raw: String) -> String {
        let filteredScalars = raw.unicodeScalars.filter { scalar in
            scalar.value >= 0x20 && scalar.value != 0x7F && scalar != "/" && scalar != "\\"
        }
        let trimmed = String(String.UnicodeScalarView(filteredScalars))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "attachment" }
        return String(trimmed.prefix(maxFilenameLength))
    }

    public static func fallbackBody(for refs: [AttachmentMetadataRef]) -> String {
        refs.map { "📎 \($0.filename)" }.joined(separator: "\n")
    }
}

/// Payload-free push wakeup admission matching `kodera_rs::mobile_ffi::admit_wakeup_envelope`
/// across APNs, UnifiedPush, and FCM envelopes.
public struct ZeroPayloadWakeupEnvelope: Equatable, Sendable {
    public static let maxEnvelopeBytes = 4_096
    public static let maxSyncHintBytes = 128
    public static let maxWakeupEpochMs: UInt64 = 4_102_444_800_000

    private static let admittedFields: Set<String> = [
        "wakeup_id", "organisation_id", "org_id", "sync_hint", "room_hash",
        "epoch_ms", "transport", "aps",
    ]

    private static let forbiddenCleartextMarkers: Set<String> = [
        "notification", "room_title", "roomtitle", "room_name", "roomname",
        "channel_name", "channelname", "sender", "sender_name", "sendername",
        "sender_display_name", "caller", "caller_name", "callername",
        "display_name", "displayname", "message", "body", "plaintext",
        "text", "content", "topic", "subject", "title", "subtitle",
        "alert", "avatar_url", "matrix_event", "sdp", "livekit_token",
        "access_token", "auth_token",
    ]

    public let wakeupId: String
    public let organisationId: String
    public let syncHint: String
    public let epochMs: UInt64?
    public let transport: String?

    public static func admit(jsonData: Data) throws -> ZeroPayloadWakeupEnvelope {
        let obj = try StrictFfiJson.parseObject(jsonData, byteLimit: maxEnvelopeBytes)

        for key in obj.keys.sorted() {
            let value = obj[key]!
            if isForbiddenCleartextKey(key) {
                throw KoderaMobileFfiError.cleartextForbidden(field: key)
            }
            if key == "aps" {
                guard let aps = value.objectValue else {
                    throw KoderaMobileFfiError.invalidInput
                }
                for apsKey in aps.keys.sorted() {
                    let qualified = "aps.\(apsKey)"
                    if isForbiddenCleartextKey(apsKey) {
                        throw KoderaMobileFfiError.cleartextForbidden(field: qualified)
                    }
                    guard apsKey == "content-available" else {
                        throw KoderaMobileFfiError.unexpectedField(field: qualified)
                    }
                    guard aps[apsKey]?.uint64Value == 1 else {
                        throw KoderaMobileFfiError.invalidInput
                    }
                }
                continue
            }
            if let leaked = findForbiddenNestedValue(value) {
                throw KoderaMobileFfiError.cleartextForbidden(field: "\(key).\(leaked)")
            }
            guard admittedFields.contains(key) else {
                throw KoderaMobileFfiError.unexpectedField(field: key)
            }
        }

        guard let wakeupId = obj["wakeup_id"]?.stringValue,
              TrustPolicy.canonicalNonNilUUID(wakeupId) else {
            throw KoderaMobileFfiError.invalidInput
        }

        let orgPrimary = try optionalCheckedString(obj, key: "org_id")
        let orgAlias = try optionalCheckedString(obj, key: "organisation_id")
        if let a = orgPrimary, let b = orgAlias, a != b {
            throw KoderaMobileFfiError.invalidInput
        }
        guard let orgId = orgPrimary ?? orgAlias,
              TrustPolicy.canonicalNonNilUUID(orgId) else {
            throw KoderaMobileFfiError.invalidInput
        }

        let hintPrimary = try optionalCheckedString(obj, key: "sync_hint")
        let hintAlias = try optionalCheckedString(obj, key: "room_hash")
        if let a = hintPrimary, let b = hintAlias, a != b {
            throw KoderaMobileFfiError.invalidInput
        }
        guard let syncHint = hintPrimary ?? hintAlias,
              isValidSyncHint(syncHint) else {
            throw KoderaMobileFfiError.invalidInput
        }

        let epochMs: UInt64?
        if let rawEpoch = obj["epoch_ms"] {
            if let num = rawEpoch.uint64Value,
               (1...maxWakeupEpochMs).contains(num) {
                epochMs = num
            } else if let str = rawEpoch.stringValue,
                      let parsed = parseCanonicalU64(str),
                      (1...maxWakeupEpochMs).contains(parsed) {
                epochMs = parsed
            } else {
                throw KoderaMobileFfiError.invalidInput
            }
        } else {
            epochMs = nil
        }

        let transport: String?
        if let rawTransport = obj["transport"] {
            guard let t = rawTransport.stringValue else {
                throw KoderaMobileFfiError.invalidInput
            }
            let lower = t.lowercased()
            guard ["apns", "unifiedpush", "fcm"].contains(lower) else {
                throw KoderaMobileFfiError.invalidInput
            }
            transport = lower
        } else {
            transport = nil
        }

        return ZeroPayloadWakeupEnvelope(
            wakeupId: wakeupId,
            organisationId: orgId,
            syncHint: syncHint,
            epochMs: epochMs,
            transport: transport
        )
    }

    private static func optionalCheckedString(_ obj: [String: FfiJsonValue], key: String) throws -> String? {
        guard let raw = obj[key] else { return nil }
        guard let str = raw.stringValue else { throw KoderaMobileFfiError.invalidInput }
        return str
    }

    private static func isForbiddenCleartextKey(_ key: String) -> Bool {
        let normalized = key.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "-", with: "_")
        return forbiddenCleartextMarkers.contains(normalized)
    }

    private static func findForbiddenNestedValue(_ value: FfiJsonValue) -> String? {
        switch value {
        case .object(let dict):
            for k in dict.keys.sorted() {
                if isForbiddenCleartextKey(k) { return k }
                if let child = findForbiddenNestedValue(dict[k]!) {
                    return "\(k).\(child)"
                }
            }
            return nil
        case .array(let array):
            for item in array {
                if let child = findForbiddenNestedValue(item) {
                    return child
                }
            }
            return nil
        default:
            return nil
        }
    }

    private static func isValidSyncHint(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard (1...maxSyncHintBytes).contains(bytes.count) else { return false }
        return bytes.allSatisfy { b in
            (b >= 0x30 && b <= 0x39)
                || (b >= 0x41 && b <= 0x5A)
                || (b >= 0x61 && b <= 0x7A)
                || b == 0x2D || b == 0x2E || b == 0x5F || b == 0x3A
        }
    }

    private static func parseCanonicalU64(_ raw: String) -> UInt64? {
        let bytes = Array(raw.utf8)
        guard (1...16).contains(bytes.count),
              (0x31...0x39).contains(bytes[0]),
              bytes.allSatisfy({ (0x30...0x39).contains($0) }) else {
            return nil
        }
        return UInt64(raw)
    }
}

/// Mobile packet bridge backed by an injectable `PacketDispatcher` seam (`CryptoKit` `KDV1`
/// session vault, `UuidV7Identifier`, `SessionEnvelopeTrackerModel`, `ReactionKeyValidator`, and
/// `ZeroPayloadWakeupEnvelope`) verified byte-for-byte against `packages/kodera-rs/vectors/mobile-ffi-v1.txt`.
/// Because `kodera-rs` enforces `#![forbid(unsafe_code)]` (where Rust 1.82+ forbids `#[no_mangle]`),
/// this bridge dispatches through `PacketDispatcher` without claiming an unmangled C symbol export.
public struct KoderaMobileFfiBridge: PacketDispatcher {
    private let customDispatcher: (any PacketDispatcher)?

    public init(dispatcher: (any PacketDispatcher)? = nil) {
        self.customDispatcher = dispatcher
    }

    public func dispatch(_ request: KoderaFfiPacket) throws -> KoderaFfiPacket {
        guard Int(request.len) == request.payload.count,
              !request.payload.isEmpty,
              request.payload.count <= KoderaFfiPacket.capacity else {
            throw KoderaMobileFfiError.invalidPacket
        }

        if let customDispatcher {
            return try customDispatcher.dispatch(request)
        }

        let dict = try StrictFfiJson.parseObject(request.payload, byteLimit: KoderaFfiPacket.capacity)
        guard let op = dict["op"]?.stringValue else {
            throw KoderaMobileFfiError.invalidJSON
        }

        switch op {
        case "uuid_v7_mint":
            try Self.ensureAllowedKeys(dict, allowed: ["op", "unix_ts_ms", "rand_hex"])
            let unixTsMs: UInt64
            if let rawTs = dict["unix_ts_ms"] {
                guard let ts = rawTs.uint64Value, ts <= UuidV7Identifier.maximumTimestampMs else {
                    throw KoderaMobileFfiError.invalidInput
                }
                unixTsMs = ts
            } else {
                unixTsMs = UInt64(Date().timeIntervalSince1970 * 1000.0) & UuidV7Identifier.maximumTimestampMs
            }
            let minted: UuidV7Identifier
            if let rawRand = dict["rand_hex"] {
                guard let randHex = rawRand.stringValue else {
                    throw KoderaMobileFfiError.invalidInput
                }
                let rand = try Self.decodeHex(randHex)
                guard rand.count == 10 else { throw KoderaMobileFfiError.invalidInput }
                minted = try UuidV7Identifier(unixTimestampMs: unixTsMs, randomBytes: Array(rand))
            } else {
                let key = SymmetricKey(size: .bits128)
                let rand = key.withUnsafeBytes { Array($0.prefix(10)) }
                minted = try UuidV7Identifier(unixTimestampMs: unixTsMs, randomBytes: rand)
            }
            let out = "{\"ok\":true,\"uuid\":\"\(minted.description)\",\"timestamp_ms\":\(unixTsMs)}"
            return try KoderaFfiPacket(payload: Data(out.utf8), status: 0)

        case "session_vault_seal":
            try Self.ensureAllowedKeys(dict, allowed: [
                "op", "org_id", "device_id", "key_hex", "nonce_hex", "plaintext_hex",
            ])
            guard let orgId = dict["org_id"]?.stringValue,
                  let deviceId = dict["device_id"]?.stringValue,
                  let keyHex = dict["key_hex"]?.stringValue,
                  let plainHex = dict["plaintext_hex"]?.stringValue else {
                throw KoderaMobileFfiError.invalidInput
            }
            let nonceData: Data?
            if let rawNonce = dict["nonce_hex"] {
                guard let nonceHex = rawNonce.stringValue else {
                    throw KoderaMobileFfiError.invalidInput
                }
                nonceData = try Self.decodeHex(nonceHex)
            } else {
                nonceData = nil
            }
            let sealed = try Kdv1SessionVaultCodec.seal(
                organisationId: orgId,
                deviceId: deviceId,
                keyData: try Self.decodeHex(keyHex),
                nonceData: nonceData,
                plaintext: try Self.decodeHex(plainHex)
            )
            let out = "{\"ok\":true,\"sealed_hex\":\"\(Self.encodeHex(sealed))\"}"
            return try KoderaFfiPacket(payload: Data(out.utf8), status: 0)

        case "session_vault_open":
            try Self.ensureAllowedKeys(dict, allowed: [
                "op", "org_id", "device_id", "key_hex", "sealed_hex",
            ])
            guard let orgId = dict["org_id"]?.stringValue,
                  let deviceId = dict["device_id"]?.stringValue,
                  let keyHex = dict["key_hex"]?.stringValue,
                  let sealedHex = dict["sealed_hex"]?.stringValue else {
                throw KoderaMobileFfiError.invalidInput
            }
            let plain = try Kdv1SessionVaultCodec.open(
                organisationId: orgId,
                deviceId: deviceId,
                keyData: try Self.decodeHex(keyHex),
                sealed: try Self.decodeHex(sealedHex)
            )
            let out = "{\"ok\":true,\"plaintext_hex\":\"\(Self.encodeHex(plain))\"}"
            return try KoderaFfiPacket(payload: Data(out.utf8), status: 0)

        case "session_envelope_verify_and_observe":
            try Self.ensureAllowedKeys(dict, allowed: [
                "op", "org_id", "room_capacity", "replay_capacity", "history", "envelope",
            ])
            guard let orgId = dict["org_id"]?.stringValue else {
                throw KoderaMobileFfiError.invalidInput
            }
            let roomCap: Int
            if let rawRoomCap = dict["room_capacity"] {
                guard let v = rawRoomCap.uint64Value, let i = Int(exactly: v) else {
                    throw KoderaMobileFfiError.invalidInput
                }
                roomCap = i
            } else {
                roomCap = 64
            }
            let replayCap: Int
            if let rawReplayCap = dict["replay_capacity"] {
                guard let v = rawReplayCap.uint64Value, let i = Int(exactly: v) else {
                    throw KoderaMobileFfiError.invalidInput
                }
                replayCap = i
            } else {
                replayCap = 256
            }
            var tracker = try SessionEnvelopeTrackerModel(
                organisationId: orgId,
                roomCapacity: roomCap,
                replayCapacity: replayCap
            )
            if let rawHistory = dict["history"] {
                guard let items = rawHistory.arrayValue else {
                    throw KoderaMobileFfiError.invalidInput
                }
                guard items.count <= 512 else {
                    throw KoderaMobileFfiError.capacityExceeded
                }
                for item in items {
                    guard let entryObj = item.objectValue else {
                        throw KoderaMobileFfiError.invalidInput
                    }
                    try tracker.verifyAndObserve(try Self.parseEnvelopeHeader(entryObj))
                }
            }
            guard let candidateObj = dict["envelope"]?.objectValue else {
                throw KoderaMobileFfiError.invalidInput
            }
            try tracker.verifyAndObserve(try Self.parseEnvelopeHeader(candidateObj))
            let out = "{\"ok\":true,\"room_count\":\(tracker.roomCount),\"replay_count\":\(tracker.replayCount)}"
            return try KoderaFfiPacket(payload: Data(out.utf8), status: 0)

        case "mls_device_create":
            try Self.ensureAllowedKeys(dict, allowed: [
                "op", "org_id", "membership_id", "public_identity_hex", "wrapping_key_hex",
            ])
            throw KoderaMobileFfiError.featureDisabled

        case "mls_device_restore":
            try Self.ensureAllowedKeys(dict, allowed: [
                "op", "org_id", "membership_id", "expected_device_key_hex",
                "expected_generation", "wrapping_key_hex", "sealed_hex",
            ])
            throw KoderaMobileFfiError.featureDisabled

        case "attachment_mime_validate":
            try Self.ensureAllowedKeys(dict, allowed: ["op", "content_type"])
            guard let mime = dict["content_type"]?.stringValue else { throw KoderaMobileFfiError.invalidInput }
            let valid = AttachmentMimeType(rawValue: mime) != nil ? "true" : "false"
            return try KoderaFfiPacket(payload: Data("{\"ok\":true,\"valid\":\(valid)}".utf8), status: 0)

        case "reaction_validate":
            try Self.ensureAllowedKeys(dict, allowed: ["op", "key"])
            guard let key = dict["key"]?.stringValue else {
                throw KoderaMobileFfiError.invalidInput
            }
            let valid = ReactionKeyValidator.isValid(key) ? "true" : "false"
            let out = "{\"ok\":true,\"valid\":\(valid)}"
            return try KoderaFfiPacket(payload: Data(out.utf8), status: 0)

        case "call_wake_admit":
            try Self.ensureAllowedKeys(dict, allowed: ["op", "payload_hex", "now"])
            guard let hex = dict["payload_hex"]?.stringValue, let now = dict["now"]?.uint64Value else { throw KoderaMobileFfiError.invalidInput }
            let data = try Self.decodeHex(hex)
            let obj = try StrictFfiJson.parseObject(data, byteLimit: 4096)
            try Self.ensureAllowedKeys(obj, allowed: ["call_id", "organisation_id", "channel_id", "epoch", "state", "expires_at"])
            guard let callId = obj["call_id"]?.stringValue, let org = obj["organisation_id"]?.stringValue,
                  let channel = obj["channel_id"]?.stringValue, let epoch = obj["epoch"]?.uint64Value,
                  let state = obj["state"]?.stringValue.flatMap(NativeRingPhase.init(rawValue:)),
                  let expiry = obj["expires_at"]?.uint64Value else { throw KoderaMobileFfiError.invalidInput }
            let wake = try NativeCallWake(callId: callId, organisationId: org, channelId: channel, epoch: epoch, state: state, expiresAt: expiry)
            try wake.validate(now: now)
            let out = "{\"ok\":true,\"call_id\":\"\(callId)\",\"organisation_id\":\"\(org)\",\"channel_id\":\"\(channel)\",\"epoch\":\(epoch),\"state\":\"\(state.rawValue)\",\"expires_at\":\(expiry)}"
            return try KoderaFfiPacket(payload: Data(out.utf8), status: 0)

        case "wakeup_envelope_admit":
            try Self.ensureAllowedKeys(dict, allowed: ["op", "payload_hex"])
            guard let payloadHex = dict["payload_hex"]?.stringValue else {
                throw KoderaMobileFfiError.invalidInput
            }
            let payloadData = try Self.decodeHex(payloadHex)
            let admitted = try ZeroPayloadWakeupEnvelope.admit(jsonData: payloadData)
            let out = "{\"ok\":true,\"wakeup_id\":\"\(admitted.wakeupId)\",\"organisation_id\":\"\(admitted.organisationId)\",\"sync_hint\":\"\(admitted.syncHint)\"}"
            return try KoderaFfiPacket(payload: Data(out.utf8), status: 0)

        default:
            throw KoderaMobileFfiError.unknownOperation
        }
    }

    private static func parseEnvelopeHeader(_ obj: [String: FfiJsonValue]) throws -> SessionEnvelopeHeaderModel {
        try ensureAllowedKeys(obj, allowed: ["org_id", "room_id", "message_id", "epoch", "algorithm"])
        guard let orgId = obj["org_id"]?.stringValue,
              let roomIdStr = obj["room_id"]?.stringValue,
              let msgIdStr = obj["message_id"]?.stringValue,
              let epoch = obj["epoch"]?.uint64Value,
              let algVal = obj["algorithm"]?.uint64Value,
              let algByte = UInt8(exactly: algVal),
              let alg = SessionEnvelopeCryptoAlgorithm(rawValue: algByte) else {
            throw KoderaMobileFfiError.invalidInput
        }
        return try SessionEnvelopeHeaderModel(
            organisationId: orgId,
            roomId: try UuidV7Identifier(parsing: roomIdStr),
            messageId: try UuidV7Identifier(parsing: msgIdStr),
            epoch: epoch,
            algorithm: alg
        )
    }

    private static func ensureAllowedKeys(_ obj: [String: FfiJsonValue], allowed: Set<String>) throws {
        for key in obj.keys.sorted() {
            if !allowed.contains(key) {
                throw KoderaMobileFfiError.unexpectedField(field: key)
            }
        }
    }

    public static func encodeHex(_ data: Data) -> String {
        let table = Array("0123456789abcdef".utf8)
        var out: [UInt8] = []
        out.reserveCapacity(data.count * 2)
        for byte in data {
            out.append(table[Int(byte >> 4)])
            out.append(table[Int(byte & 0x0F)])
        }
        return String(decoding: out, as: UTF8.self)
    }

    public static func decodeHex(_ hex: String) throws -> Data {
        let bytes = Array(hex.utf8)
        guard bytes.count % 2 == 0 else { throw KoderaMobileFfiError.invalidInput }
        var out = Data(capacity: bytes.count / 2)
        for idx in stride(from: 0, to: bytes.count, by: 2) {
            guard let hi = nibble(bytes[idx]), let lo = nibble(bytes[idx + 1]) else {
                throw KoderaMobileFfiError.invalidInput
            }
            out.append((hi << 4) | lo)
        }
        return out
    }

    private static func nibble(_ b: UInt8) -> UInt8? {
        if (0x30...0x39).contains(b) { return b - 0x30 }
        if (0x61...0x66).contains(b) { return b - 0x61 + 10 }
        return nil
    }
}

private enum FfiJsonValue: Equatable, Sendable {
    case object([String: FfiJsonValue])
    case array([FfiJsonValue])
    case string(String)
    case uint(UInt64)
    case nonUintNumber
    case bool(Bool)
    case null

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    var uint64Value: UInt64? {
        if case .uint(let v) = self { return v }
        return nil
    }

    var objectValue: [String: FfiJsonValue]? {
        if case .object(let m) = self { return m }
        return nil
    }

    var arrayValue: [FfiJsonValue]? {
        if case .array(let a) = self { return a }
        return nil
    }
}

/// Strict RFC 8259 JSON parser matching `kodera_rs::mobile_ffi::StrictFfiJson`, rejecting duplicate
/// keys at every object depth (including `\uXXXX` escapes), trailing tokens, and malformed UTF-8.
private struct StrictFfiJson {
    static let maxDepth = 16

    private let bytes: [UInt8]
    private var pos: Int = 0

    private init(bytes: [UInt8]) {
        self.bytes = bytes
    }

    static func parseObject(_ raw: Data, byteLimit: Int) throws -> [String: FfiJsonValue] {
        guard !raw.isEmpty,
              raw.count <= byteLimit,
              String(data: raw, encoding: .utf8) != nil else {
            throw KoderaMobileFfiError.invalidJSON
        }
        var parser = StrictFfiJson(bytes: Array(raw))
        parser.skipWhitespace()
        let obj = try parser.readObject(depth: 1)
        parser.skipWhitespace()
        guard parser.pos == parser.bytes.count else {
            throw KoderaMobileFfiError.invalidJSON
        }
        return obj
    }

    private mutating func skipWhitespace() {
        while pos < bytes.count {
            let b = bytes[pos]
            if b == 0x20 || b == 0x09 || b == 0x0D || b == 0x0A {
                pos += 1
            } else {
                break
            }
        }
    }

    private mutating func takeByte(_ expected: UInt8) -> Bool {
        if pos < bytes.count && bytes[pos] == expected {
            pos += 1
            return true
        }
        return false
    }

    private mutating func expectByte(_ expected: UInt8) throws {
        guard takeByte(expected) else {
            throw KoderaMobileFfiError.invalidJSON
        }
    }

    private mutating func expectLiteral(_ literal: [UInt8]) throws {
        guard pos + literal.count <= bytes.count else {
            throw KoderaMobileFfiError.invalidJSON
        }
        for i in 0..<literal.count where bytes[pos + i] != literal[i] {
            throw KoderaMobileFfiError.invalidJSON
        }
        pos += literal.count
    }

    private mutating func readValue(depth: Int) throws -> FfiJsonValue {
        guard depth <= Self.maxDepth else {
            throw KoderaMobileFfiError.invalidJSON
        }
        skipWhitespace()
        guard pos < bytes.count else {
            throw KoderaMobileFfiError.invalidJSON
        }
        switch bytes[pos] {
        case 0x7B:
            return .object(try readObject(depth: depth))
        case 0x5B:
            return .array(try readArray(depth: depth))
        case 0x22:
            return .string(try readString())
        case 0x74:
            try expectLiteral([0x74, 0x72, 0x75, 0x65]) // "true"
            return .bool(true)
        case 0x66:
            try expectLiteral([0x66, 0x61, 0x6C, 0x73, 0x65]) // "false"
            return .bool(false)
        case 0x6E:
            try expectLiteral([0x6E, 0x75, 0x6C, 0x6C]) // "null"
            return .null
        case 0x2D, 0x30...0x39:
            return try readNumber()
        default:
            throw KoderaMobileFfiError.invalidJSON
        }
    }

    private mutating func readObject(depth: Int) throws -> [String: FfiJsonValue] {
        guard depth <= Self.maxDepth else {
            throw KoderaMobileFfiError.invalidJSON
        }
        try expectByte(0x7B)
        skipWhitespace()
        var map: [String: FfiJsonValue] = [:]
        if takeByte(0x7D) {
            return map
        }
        while true {
            skipWhitespace()
            let key = try readString()
            guard map[key] == nil else {
                throw KoderaMobileFfiError.invalidJSON
            }
            skipWhitespace()
            try expectByte(0x3A)
            let value = try readValue(depth: depth + 1)
            map[key] = value
            skipWhitespace()
            if takeByte(0x7D) {
                return map
            }
            try expectByte(0x2C)
        }
    }

    private mutating func readArray(depth: Int) throws -> [FfiJsonValue] {
        guard depth <= Self.maxDepth else {
            throw KoderaMobileFfiError.invalidJSON
        }
        try expectByte(0x5B)
        skipWhitespace()
        var items: [FfiJsonValue] = []
        if takeByte(0x5D) {
            return items
        }
        while true {
            items.append(try readValue(depth: depth + 1))
            skipWhitespace()
            if takeByte(0x5D) {
                return items
            }
            try expectByte(0x2C)
        }
    }

    private mutating func readNumber() throws -> FfiJsonValue {
        let start = pos
        let negative = takeByte(0x2D)
        let intStart = pos
        if takeByte(0x30) {
            if pos < bytes.count && (0x30...0x39).contains(bytes[pos]) {
                throw KoderaMobileFfiError.invalidJSON
            }
        } else {
            while pos < bytes.count && (0x30...0x39).contains(bytes[pos]) {
                pos += 1
            }
            if pos == intStart {
                throw KoderaMobileFfiError.invalidJSON
            }
        }
        var fractionalOrExp = false
        if takeByte(0x2E) {
            fractionalOrExp = true
            let fracStart = pos
            while pos < bytes.count && (0x30...0x39).contains(bytes[pos]) {
                pos += 1
            }
            if pos == fracStart {
                throw KoderaMobileFfiError.invalidJSON
            }
        }
        if pos < bytes.count && (bytes[pos] == 0x65 || bytes[pos] == 0x45) {
            fractionalOrExp = true
            pos += 1
            if pos < bytes.count && (bytes[pos] == 0x2B || bytes[pos] == 0x2D) {
                pos += 1
            }
            let expStart = pos
            while pos < bytes.count && (0x30...0x39).contains(bytes[pos]) {
                pos += 1
            }
            if pos == expStart {
                throw KoderaMobileFfiError.invalidJSON
            }
        }
        if negative || fractionalOrExp {
            return .nonUintNumber
        }
        let text = String(decoding: bytes[start..<pos], as: UTF8.self)
        if let v = UInt64(text) {
            return .uint(v)
        }
        return .nonUintNumber
    }

    private mutating func readString() throws -> String {
        try expectByte(0x22)
        var utf8Out: [UInt8] = []
        while pos < bytes.count {
            let b = bytes[pos]
            if b == 0x22 {
                pos += 1
                guard let decoded = String(bytes: utf8Out, encoding: .utf8) else {
                    throw KoderaMobileFfiError.invalidJSON
                }
                return decoded
            }
            if b < 0x20 {
                throw KoderaMobileFfiError.invalidJSON
            }
            if b == 0x5C {
                pos += 1
                guard pos < bytes.count else {
                    throw KoderaMobileFfiError.invalidJSON
                }
                let esc = bytes[pos]
                pos += 1
                switch esc {
                case 0x22: utf8Out.append(0x22)
                case 0x5C: utf8Out.append(0x5C)
                case 0x2F: utf8Out.append(0x2F)
                case 0x62: utf8Out.append(0x08)
                case 0x66: utf8Out.append(0x0C)
                case 0x6E: utf8Out.append(0x0A)
                case 0x72: utf8Out.append(0x0D)
                case 0x74: utf8Out.append(0x09)
                case 0x75:
                    let code = try readHexU16()
                    let scalarValue: UInt32
                    if (0xD800...0xDBFF).contains(code) {
                        guard pos + 2 <= bytes.count,
                              bytes[pos] == 0x5C,
                              bytes[pos + 1] == 0x75 else {
                            throw KoderaMobileFfiError.invalidJSON
                        }
                        pos += 2
                        let low = try readHexU16()
                        guard (0xDC00...0xDFFF).contains(low) else {
                            throw KoderaMobileFfiError.invalidJSON
                        }
                        scalarValue = 0x10000 + (((UInt32(code) - 0xD800) << 10) | (UInt32(low) - 0xDC00))
                    } else if (0xDC00...0xDFFF).contains(code) {
                        throw KoderaMobileFfiError.invalidJSON
                    } else {
                        scalarValue = UInt32(code)
                    }
                    guard let scalar = UnicodeScalar(scalarValue) else {
                        throw KoderaMobileFfiError.invalidJSON
                    }
                    utf8Out.append(contentsOf: String(scalar).utf8)
                default:
                    throw KoderaMobileFfiError.invalidJSON
                }
            } else {
                utf8Out.append(b)
                pos += 1
            }
        }
        throw KoderaMobileFfiError.invalidJSON
    }

    private mutating func readHexU16() throws -> UInt16 {
        guard pos + 4 <= bytes.count else {
            throw KoderaMobileFfiError.invalidJSON
        }
        var acc: UInt16 = 0
        for i in 0..<4 {
            let b = bytes[pos + i]
            let digit: UInt16
            if (0x30...0x39).contains(b) {
                digit = UInt16(b - 0x30)
            } else if (0x61...0x66).contains(b) {
                digit = UInt16(b - 0x61 + 10)
            } else if (0x41...0x46).contains(b) {
                digit = UInt16(b - 0x41 + 10)
            } else {
                throw KoderaMobileFfiError.invalidJSON
            }
            acc = (acc << 4) | digit
        }
        pos += 4
        return acc
    }
}
