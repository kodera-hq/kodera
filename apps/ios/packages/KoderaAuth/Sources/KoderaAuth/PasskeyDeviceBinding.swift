import CryptoKit
import Foundation
import KoderaDomain
import Security
#if canImport(AuthenticationServices)
import AuthenticationServices
#endif

public enum PasskeyBindingError: Error, Equatable, Sendable {
    case invalidInput
    case scopeMismatch
    case epochMismatch
    case capacity
    case replay
    case authenticationFailed
}

/// Backup flag policy for WebAuthn Level 3 §6.5 assertion flags.
///
/// - `.universal` (default): admits single-device security keys (`0x05`), backup-eligible local
///   passkeys (`0x0D`), and multi-device synced passkeys (`0x1D`, including platform keychains and
///   self-hosted software vaults) while still requiring `UP|UV` and rejecting invalid `BS=1, BE=0`
///   (`0x15`), attested-data (`AT`), extension (`ED`), and reserved (`RFU`) bits.
/// - `.strictNonBackupable`: additionally requires `(flags & 0x18) == 0` (`0x05`).
public enum PasskeyBackupPolicy: Equatable, Sendable {
    case universal
    case strictNonBackupable
}

/// Authenticator backup/residency posture reported by signed WebAuthn Level 3 assertion flags.
public enum PasskeyResidencyPosture: Equatable, Sendable {
    case singleDeviceBound
    case backupEligibleLocal
    case multiDeviceSynced
}

/// Sensitive 256-bit WebAuthn challenge bound to a single organisation and expiry epoch.
public struct PasskeyChallenge: Equatable, Sendable, CustomDebugStringConvertible {
    public let organisationId: String
    private let nonce: Data
    public let expiresAt: UInt64

    public var debugDescription: String { "PasskeyChallenge([redacted])" }

    public var bytes: Data { nonce }

    public var base64URL: String {
        PasskeyBase64URL.encodeUnpadded(nonce)
    }

    fileprivate init(organisationId: String, nonce: Data, expiresAt: UInt64) {
        self.organisationId = organisationId
        self.nonce = nonce
        self.expiresAt = expiresAt
    }
}

/// Raw platform authenticator response. No client-side boolean establishes authentication.
public struct PasskeyAssertion: Equatable, Sendable, CustomDebugStringConvertible {
    public let credentialId: Data
    public let clientDataJSON: Data
    public let authenticatorData: Data
    public let signatureDER: Data

    public var debugDescription: String { "PasskeyAssertion([redacted])" }

    public init(
        credentialId: Data,
        clientDataJSON: Data,
        authenticatorData: Data,
        signatureDER: Data
    ) {
        self.credentialId = credentialId
        self.clientDataJSON = clientDataJSON
        self.authenticatorData = authenticatorData
        self.signatureDER = signatureDER
    }
}

/// ES256 WebAuthn assertion verifier aligned with `kodera-rs` `passkey_binding`.
/// Requires `UP+UV` (`0x05`) and enforces `PasskeyBackupPolicy` (`.universal` by default: `0x05`,
/// `0x0D`, `0x1D`, rejecting invalid `BS=1, BE=0` `0x15`, `AT`, `ED`, and RFU bits).
public struct PasskeyDeviceBinding: Sendable, CustomDebugStringConvertible {
    public static let maxChallenges = 64
    private static let flagUP: UInt8 = 0x01
    private static let flagUV: UInt8 = 0x04
    private static let flagBE: UInt8 = 0x08
    private static let flagBS: UInt8 = 0x10
    private static let flagAT: UInt8 = 0x40
    private static let flagED: UInt8 = 0x80
    private static let flagRFUMask: UInt8 = 0x22

    private struct ChallengeState: Sendable {
        let expiresAt: UInt64
        var used: Bool
    }

    public let organisationId: String
    public let rpId: String
    public let origin: String
    public let credentialId: Data
    public let backupPolicy: PasskeyBackupPolicy
    private let publicKey: P256.Signing.PublicKey
    public private(set) var lastCounter: UInt32 = 0
    public private(set) var latestNow: UInt64 = 0
    public private(set) var verifiedAssertionCount: Int = 0
    public private(set) var lastResidencyPosture: PasskeyResidencyPosture? = nil
    private var challenges: [Data: ChallengeState] = [:]

    public var debugDescription: String { "PasskeyDeviceBinding([redacted])" }

    private static func validateAssertionFlags(
        _ flags: UInt8,
        policy: PasskeyBackupPolicy
    ) throws -> PasskeyResidencyPosture {
        guard (flags & (flagUP | flagUV)) == (flagUP | flagUV) else {
            throw PasskeyBindingError.authenticationFailed
        }
        guard (flags & (flagRFUMask | flagAT)) == 0 else {
            throw PasskeyBindingError.authenticationFailed
        }
        let backupBits = flags & (flagBE | flagBS)
        guard backupBits != flagBS else {
            throw PasskeyBindingError.authenticationFailed
        }
        if policy == .strictNonBackupable && backupBits != 0 {
            throw PasskeyBindingError.authenticationFailed
        }
        switch backupBits {
        case 0:
            return .singleDeviceBound
        case flagBE:
            return .backupEligibleLocal
        default:
            return .multiDeviceSynced
        }
    }

    public static func isAdmittedOrigin(rpId: String, origin: String) -> Bool {
        guard origin.utf8.count <= 512 else { return false }
        if origin.hasPrefix("https://") {
            let host = String(origin.dropFirst("https://".count))
            guard TrustPolicy.validDNSName(host) else { return false }
            return host == rpId || host.hasSuffix("." + rpId)
        }
        if origin.hasPrefix("android:apk-key-hash:") {
            let hash = String(origin.dropFirst("android:apk-key-hash:".count))
            guard let decoded = PasskeyBase64URL.decodeUnpadded(hash),
                  decoded.count == 32,
                  PasskeyBase64URL.encodeUnpadded(decoded) == hash else {
                return false
            }
            return true
        }
        return false
    }

    public init(
        organisationId: String,
        rpId: String,
        origin: String,
        credentialId: Data,
        publicSEC1Key: Data,
        backupPolicy: PasskeyBackupPolicy = .universal
    ) throws {
        guard TrustPolicy.canonicalNonNilUUID(organisationId),
              TrustPolicy.validDNSName(rpId),
              Self.isAdmittedOrigin(rpId: rpId, origin: origin),
              (1...1024).contains(credentialId.count),
              publicSEC1Key.count == 33 || publicSEC1Key.count == 65 else {
            throw PasskeyBindingError.invalidInput
        }

        let parsedKey: P256.Signing.PublicKey
        do {
            if publicSEC1Key.count == 33 {
                parsedKey = try P256.Signing.PublicKey(compressedRepresentation: publicSEC1Key)
            } else {
                guard publicSEC1Key.first == 0x04 else {
                    throw PasskeyBindingError.invalidInput
                }
                parsedKey = try P256.Signing.PublicKey(x963Representation: publicSEC1Key)
            }
        } catch {
            throw PasskeyBindingError.invalidInput
        }

        self.organisationId = organisationId
        self.rpId = rpId
        self.origin = origin
        self.credentialId = credentialId
        self.backupPolicy = backupPolicy
        self.publicKey = parsedKey
    }

    public mutating func issueChallenge(
        organisationId incomingOrganisationId: String,
        now: UInt64,
        lifetimeSeconds: UInt64
    ) throws -> PasskeyChallenge {
        guard incomingOrganisationId == organisationId else {
            throw PasskeyBindingError.scopeMismatch
        }
        guard now >= latestNow else {
            throw PasskeyBindingError.epochMismatch
        }
        guard (1...300).contains(lifetimeSeconds) else {
            throw PasskeyBindingError.invalidInput
        }
        let (expiresAt, overflow) = now.addingReportingOverflow(lifetimeSeconds)
        guard !overflow else {
            throw PasskeyBindingError.invalidInput
        }

        let retained = challenges.values.filter { $0.expiresAt >= now }.count
        guard retained < Self.maxChallenges else {
            throw PasskeyBindingError.capacity
        }

        var randomBytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, randomBytes.count, &randomBytes)
        guard status == errSecSuccess else {
            throw PasskeyBindingError.authenticationFailed
        }
        let nonce = Data(randomBytes)
        guard challenges[nonce] == nil else {
            throw PasskeyBindingError.replay
        }

        challenges = challenges.filter { $0.value.expiresAt >= now }
        challenges[nonce] = ChallengeState(expiresAt: expiresAt, used: false)
        latestNow = now
        return PasskeyChallenge(organisationId: organisationId, nonce: nonce, expiresAt: expiresAt)
    }

    @discardableResult
    public mutating func verifyAssertion(
        organisationId incomingOrganisationId: String,
        challenge: PasskeyChallenge,
        assertion: PasskeyAssertion,
        now: UInt64
    ) throws -> PasskeyResidencyPosture {
        guard incomingOrganisationId == organisationId,
              challenge.organisationId == organisationId else {
            throw PasskeyBindingError.scopeMismatch
        }
        guard now >= latestNow else {
            throw PasskeyBindingError.epochMismatch
        }
        guard let state = challenges[challenge.bytes] else {
            throw PasskeyBindingError.authenticationFailed
        }
        if state.used {
            throw PasskeyBindingError.replay
        }
        latestNow = now
        if now > state.expiresAt || state.expiresAt != challenge.expiresAt {
            throw PasskeyBindingError.authenticationFailed
        }

        guard assertion.credentialId == credentialId,
              !assertion.clientDataJSON.isEmpty,
              assertion.clientDataJSON.count <= 4096,
              (37...2048).contains(assertion.authenticatorData.count),
              (8...80).contains(assertion.signatureDER.count) else {
            throw PasskeyBindingError.invalidInput
        }

        let clientData = try StrictWebAuthnClientData.parse(assertion.clientDataJSON)
        guard let decodedChallenge = PasskeyBase64URL.decodeUnpadded(clientData.challenge) else {
            throw PasskeyBindingError.authenticationFailed
        }
        guard clientData.ceremony == "webauthn.get",
              clientData.origin == origin,
              !clientData.crossOrigin,
              decodedChallenge == challenge.bytes,
              PasskeyBase64URL.encodeUnpadded(decodedChallenge) == clientData.challenge else {
            throw PasskeyBindingError.scopeMismatch
        }

        let authBytes = Array(assertion.authenticatorData)
        let expectedRPHash = Data(SHA256.hash(data: Data(rpId.utf8)))
        guard Data(authBytes[0..<32]) == expectedRPHash else {
            throw PasskeyBindingError.authenticationFailed
        }
        let flags = authBytes[32]
        let posture = try Self.validateAssertionFlags(flags, policy: backupPolicy)
        let extensionSlice = Array(authBytes[37..<authBytes.count])
        if (flags & Self.flagED) != 0 {
            try StrictCBORExtensionMap.validate(extensionSlice)
        } else if !extensionSlice.isEmpty {
            throw PasskeyBindingError.invalidInput
        }

        let counter = (UInt32(authBytes[33]) << 24)
            | (UInt32(authBytes[34]) << 16)
            | (UInt32(authBytes[35]) << 8)
            | UInt32(authBytes[36])
        if (counter > 0 || lastCounter > 0) && counter <= lastCounter {
            throw PasskeyBindingError.replay
        }

        let signature: P256.Signing.ECDSASignature
        do {
            signature = try P256.Signing.ECDSASignature(derRepresentation: assertion.signatureDER)
        } catch {
            throw PasskeyBindingError.authenticationFailed
        }

        var signedPayload = assertion.authenticatorData
        signedPayload.append(contentsOf: SHA256.hash(data: assertion.clientDataJSON))
        guard publicKey.isValidSignature(signature, for: signedPayload) else {
            throw PasskeyBindingError.authenticationFailed
        }

        challenges[challenge.bytes]?.used = true
        lastCounter = counter
        verifiedAssertionCount += 1
        lastResidencyPosture = posture
        return posture
    }
}

#if canImport(AuthenticationServices)
/// Bridges Apple's `ASAuthorizationPlatformPublicKeyCredential` APIs to `PasskeyDeviceBinding` models.
public enum PasskeyPlatformAssertionBridge {
    public static func makeAssertionRequest(
        rpId: String,
        challenge: PasskeyChallenge,
        allowedCredentialIDs: [Data]
    ) throws -> ASAuthorizationPlatformPublicKeyCredentialAssertionRequest {
        guard TrustPolicy.validDNSName(rpId),
              !allowedCredentialIDs.isEmpty,
              allowedCredentialIDs.allSatisfy({ (1...1024).contains($0.count) }) else {
            throw PasskeyBindingError.invalidInput
        }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let request = provider.createCredentialAssertionRequest(challenge: challenge.bytes)
        request.userVerificationPreference = .required
        request.allowedCredentials = allowedCredentialIDs.map {
            ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
        }
        return request
    }

    public static func extractAssertion(
        from credential: ASAuthorizationPlatformPublicKeyCredentialAssertion
    ) throws -> PasskeyAssertion {
        guard let rawAuthenticatorData = credential.rawAuthenticatorData,
              let signature = credential.signature else {
            throw PasskeyBindingError.invalidInput
        }
        return PasskeyAssertion(
            credentialId: credential.credentialID,
            clientDataJSON: credential.rawClientDataJSON,
            authenticatorData: rawAuthenticatorData,
            signatureDER: signature
        )
    }
}
#endif

enum PasskeyBase64URL {
    static func encodeUnpadded(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decodeUnpadded(_ raw: String) -> Data? {
        guard !raw.isEmpty, !raw.contains("="), !raw.contains("+"), !raw.contains("/") else {
            return nil
        }
        let validAlphabet = raw.utf8.allSatisfy { byte in
            (byte >= 0x30 && byte <= 0x39)
                || (byte >= 0x41 && byte <= 0x5A)
                || (byte >= 0x61 && byte <= 0x7A)
                || byte == 0x2D || byte == 0x5F
        }
        guard validAlphabet else { return nil }
        let remainder = raw.utf8.count % 4
        guard remainder != 1 else { return nil }
        let paddingCount = remainder == 0 ? 0 : (4 - remainder)
        let standard = raw
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
            + String(repeating: "=", count: paddingCount)
        return Data(base64Encoded: standard)
    }
}

private enum StrictCBORExtensionMap {
    private static let maxExtensionBytes = 2048
    private static let maxCBORDepth = 4

    static func validate(_ bytes: [UInt8]) throws {
        guard !bytes.isEmpty, bytes.count <= maxExtensionBytes else {
            throw PasskeyBindingError.authenticationFailed
        }
        var offset = 0
        guard (bytes[0] >> 5) == 5 else {
            throw PasskeyBindingError.authenticationFailed
        }
        let mapLen = try readDefiniteLength(bytes, offset: &offset)
        guard (1...32).contains(mapLen) else {
            throw PasskeyBindingError.authenticationFailed
        }
        for _ in 0..<mapLen {
            try skipItem(bytes, offset: &offset, depth: 1)
            try skipItem(bytes, offset: &offset, depth: 1)
        }
        guard offset == bytes.count else {
            throw PasskeyBindingError.authenticationFailed
        }
    }

    private static func readDefiniteLength(_ bytes: [UInt8], offset: inout Int) throws -> Int {
        guard offset < bytes.count else { throw PasskeyBindingError.authenticationFailed }
        let initial = bytes[offset]
        offset += 1
        let info = Int(initial & 0x1F)
        switch info {
        case 0...23:
            return info
        case 24:
            guard offset < bytes.count else { throw PasskeyBindingError.authenticationFailed }
            let v = Int(bytes[offset])
            offset += 1
            guard v >= 24 else { throw PasskeyBindingError.authenticationFailed }
            return v
        case 25:
            guard bytes.count - offset >= 2 else { throw PasskeyBindingError.authenticationFailed }
            let v = (Int(bytes[offset]) << 8) | Int(bytes[offset + 1])
            offset += 2
            guard v >= 256 else { throw PasskeyBindingError.authenticationFailed }
            return v
        default:
            throw PasskeyBindingError.authenticationFailed
        }
    }

    private static func skipItem(_ bytes: [UInt8], offset: inout Int, depth: Int) throws {
        guard depth <= maxCBORDepth, offset < bytes.count else {
            throw PasskeyBindingError.authenticationFailed
        }
        let initial = bytes[offset]
        let major = initial >> 5
        let info = initial & 0x1F
        switch major {
        case 0, 1:
            offset += 1
            let extra: Int
            switch info {
            case 0...23: extra = 0
            case 24: extra = 1
            case 25: extra = 2
            case 26: extra = 4
            case 27: extra = 8
            default: throw PasskeyBindingError.authenticationFailed
            }
            guard bytes.count - offset >= extra else { throw PasskeyBindingError.authenticationFailed }
            offset += extra
        case 2:
            let len = try readDefiniteLength(bytes, offset: &offset)
            guard bytes.count - offset >= len else { throw PasskeyBindingError.authenticationFailed }
            offset += len
        case 3:
            let len = try readDefiniteLength(bytes, offset: &offset)
            guard bytes.count - offset >= len,
                  String(bytes: bytes[offset..<(offset + len)], encoding: .utf8) != nil else {
                throw PasskeyBindingError.authenticationFailed
            }
            offset += len
        case 4:
            guard depth < maxCBORDepth else { throw PasskeyBindingError.authenticationFailed }
            let len = try readDefiniteLength(bytes, offset: &offset)
            guard len <= 32 else { throw PasskeyBindingError.authenticationFailed }
            for _ in 0..<len {
                try skipItem(bytes, offset: &offset, depth: depth + 1)
            }
        case 5:
            guard depth < maxCBORDepth else { throw PasskeyBindingError.authenticationFailed }
            let len = try readDefiniteLength(bytes, offset: &offset)
            guard len <= 32 else { throw PasskeyBindingError.authenticationFailed }
            for _ in 0..<len {
                try skipItem(bytes, offset: &offset, depth: depth + 1)
                try skipItem(bytes, offset: &offset, depth: depth + 1)
            }
        case 7:
            guard (20...22).contains(info) else { throw PasskeyBindingError.authenticationFailed }
            offset += 1
        default:
            throw PasskeyBindingError.authenticationFailed
        }
    }
}

private struct StrictWebAuthnClientData {
    private static let maxJSONDepth = 4

    let ceremony: String
    let challenge: String
    let origin: String
    let crossOrigin: Bool

    static func parse(_ data: Data) throws -> StrictWebAuthnClientData {
        guard !data.isEmpty, data.count <= 4096, String(data: data, encoding: .utf8) != nil else {
            throw PasskeyBindingError.invalidInput
        }
        var parser = ObjectParser(bytes: Array(data))
        return try parser.parseTopLevelObject()
    }

    private struct ObjectParser {
        let bytes: [UInt8]
        var offset = 0

        mutating func parseTopLevelObject() throws -> StrictWebAuthnClientData {
            skipWhitespace()
            guard take(0x7B) else { throw PasskeyBindingError.invalidInput }
            skipWhitespace()
            var seenKeys = Set<String>()
            var ceremony: String? = nil
            var challenge: String? = nil
            var origin: String? = nil
            var crossOrigin = false

            if !take(0x7D) {
                while true {
                    guard seenKeys.count < 64 else { throw PasskeyBindingError.invalidInput }
                    skipWhitespace()
                    let key = try parseString()
                    guard seenKeys.insert(key).inserted else { throw PasskeyBindingError.invalidInput }
                    skipWhitespace()
                    guard take(0x3A) else { throw PasskeyBindingError.invalidInput }
                    skipWhitespace()
                    switch key {
                    case "type":
                        ceremony = try parseString()
                    case "challenge":
                        challenge = try parseString()
                    case "origin":
                        origin = try parseString()
                    case "crossOrigin":
                        crossOrigin = try parseBoolean()
                    default:
                        try skipValue(depth: 1)
                    }
                    skipWhitespace()
                    if take(0x7D) {
                        break
                    }
                    guard take(0x2C) else { throw PasskeyBindingError.invalidInput }
                }
            }
            skipWhitespace()
            guard offset == bytes.count,
                  let unwrappedCeremony = ceremony,
                  let unwrappedChallenge = challenge,
                  let unwrappedOrigin = origin else {
                throw PasskeyBindingError.invalidInput
            }
            return StrictWebAuthnClientData(
                ceremony: unwrappedCeremony,
                challenge: unwrappedChallenge,
                origin: unwrappedOrigin,
                crossOrigin: crossOrigin
            )
        }

        private mutating func skipWhitespace() {
            while offset < bytes.count && [0x09, 0x0A, 0x0D, 0x20].contains(bytes[offset]) {
                offset += 1
            }
        }

        private mutating func take(_ expected: UInt8) -> Bool {
            guard offset < bytes.count, bytes[offset] == expected else { return false }
            offset += 1
            return true
        }

        private mutating func parseBoolean() throws -> Bool {
            guard offset < bytes.count else { throw PasskeyBindingError.invalidInput }
            switch bytes[offset] {
            case 0x74:
                try parseLiteral("true")
                return true
            case 0x66:
                try parseLiteral("false")
                return false
            default:
                throw PasskeyBindingError.invalidInput
            }
        }

        private mutating func parseNumber() throws {
            _ = take(0x2D)
            guard offset < bytes.count else { throw PasskeyBindingError.invalidInput }
            if bytes[offset] == 0x30 {
                offset += 1
            } else if (0x31...0x39).contains(bytes[offset]) {
                offset += 1
                while offset < bytes.count && (0x30...0x39).contains(bytes[offset]) {
                    offset += 1
                }
            } else {
                throw PasskeyBindingError.invalidInput
            }
            if take(0x2E) {
                guard offset < bytes.count && (0x30...0x39).contains(bytes[offset]) else {
                    throw PasskeyBindingError.invalidInput
                }
                while offset < bytes.count && (0x30...0x39).contains(bytes[offset]) {
                    offset += 1
                }
            }
            if offset < bytes.count && (bytes[offset] == 0x65 || bytes[offset] == 0x45) {
                offset += 1
                if offset < bytes.count && (bytes[offset] == 0x2B || bytes[offset] == 0x2D) {
                    offset += 1
                }
                guard offset < bytes.count && (0x30...0x39).contains(bytes[offset]) else {
                    throw PasskeyBindingError.invalidInput
                }
                while offset < bytes.count && (0x30...0x39).contains(bytes[offset]) {
                    offset += 1
                }
            }
        }

        private mutating func skipValue(depth: Int) throws {
            guard depth <= StrictWebAuthnClientData.maxJSONDepth, offset < bytes.count else {
                throw PasskeyBindingError.invalidInput
            }
            switch bytes[offset] {
            case 0x22:
                _ = try parseString()
            case 0x74:
                try parseLiteral("true")
            case 0x66:
                try parseLiteral("false")
            case 0x6E:
                try parseLiteral("null")
            case 0x2D, 0x30...0x39:
                try parseNumber()
            case 0x5B:
                guard depth < StrictWebAuthnClientData.maxJSONDepth else {
                    throw PasskeyBindingError.invalidInput
                }
                offset += 1
                skipWhitespace()
                if take(0x5D) { return }
                var count = 0
                while true {
                    count += 1
                    guard count <= 64 else { throw PasskeyBindingError.invalidInput }
                    skipWhitespace()
                    try skipValue(depth: depth + 1)
                    skipWhitespace()
                    if take(0x5D) { return }
                    guard take(0x2C) else { throw PasskeyBindingError.invalidInput }
                }
            case 0x7B:
                guard depth < StrictWebAuthnClientData.maxJSONDepth else {
                    throw PasskeyBindingError.invalidInput
                }
                offset += 1
                skipWhitespace()
                if take(0x7D) { return }
                var nestedKeys = Set<String>()
                while true {
                    guard nestedKeys.count < 64 else { throw PasskeyBindingError.invalidInput }
                    skipWhitespace()
                    let k = try parseString()
                    guard nestedKeys.insert(k).inserted else { throw PasskeyBindingError.invalidInput }
                    skipWhitespace()
                    guard take(0x3A) else { throw PasskeyBindingError.invalidInput }
                    skipWhitespace()
                    try skipValue(depth: depth + 1)
                    skipWhitespace()
                    if take(0x7D) { return }
                    guard take(0x2C) else { throw PasskeyBindingError.invalidInput }
                }
            default:
                throw PasskeyBindingError.invalidInput
            }
        }

        private mutating func parseLiteral(_ literal: String) throws {
            let expected = Array(literal.utf8)
            guard bytes.count - offset >= expected.count,
                  Array(bytes[offset..<(offset + expected.count)]) == expected else {
                throw PasskeyBindingError.invalidInput
            }
            offset += expected.count
        }

        private mutating func parseString() throws -> String {
            let start = offset
            guard take(0x22) else { throw PasskeyBindingError.invalidInput }
            while offset < bytes.count {
                let byte = bytes[offset]
                offset += 1
                if byte == 0x22 {
                    do {
                        return try JSONDecoder().decode(String.self, from: Data(bytes[start..<offset]))
                    } catch {
                        throw PasskeyBindingError.invalidInput
                    }
                }
                guard byte >= 0x20 else { throw PasskeyBindingError.invalidInput }
                if byte == 0x5C {
                    guard offset < bytes.count else { throw PasskeyBindingError.invalidInput }
                    let escaped = bytes[offset]
                    offset += 1
                    if escaped == 0x75 {
                        guard bytes.count - offset >= 4,
                              bytes[offset..<(offset + 4)].allSatisfy({
                                  (0x30...0x39).contains($0)
                                      || (0x41...0x46).contains($0)
                                      || (0x61...0x66).contains($0)
                              }) else {
                            throw PasskeyBindingError.invalidInput
                        }
                        offset += 4
                    } else if ![0x22, 0x2F, 0x5C, 0x62, 0x66, 0x6E, 0x72, 0x74].contains(escaped) {
                        throw PasskeyBindingError.invalidInput
                    }
                }
            }
            throw PasskeyBindingError.invalidInput
        }
    }
}
