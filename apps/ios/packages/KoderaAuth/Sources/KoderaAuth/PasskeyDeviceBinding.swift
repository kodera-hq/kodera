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

/// Strict ES256 WebAuthn assertion verifier aligned with `kodera-rs` `passkey_binding`.
/// Requires UP+UV (`0x05`) and refuses backup-eligible/backed-up flags (`BE`/`BS`), attested credential
/// data (`AT`), and extensions (`ED`) during assertion verification.
public struct PasskeyDeviceBinding: Sendable, CustomDebugStringConvertible {
    public static let maxChallenges = 64

    private struct ChallengeState: Sendable {
        let expiresAt: UInt64
        var used: Bool
    }

    public let organisationId: String
    public let rpId: String
    public let origin: String
    public let credentialId: Data
    private let publicKey: P256.Signing.PublicKey
    public private(set) var lastCounter: UInt32 = 0
    public private(set) var latestNow: UInt64 = 0
    public private(set) var verifiedAssertionCount: Int = 0
    private var challenges: [Data: ChallengeState] = [:]

    public var debugDescription: String { "PasskeyDeviceBinding([redacted])" }

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
        publicSEC1Key: Data
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

    public mutating func verifyAssertion(
        organisationId incomingOrganisationId: String,
        challenge: PasskeyChallenge,
        assertion: PasskeyAssertion,
        now: UInt64
    ) throws {
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
              assertion.authenticatorData.count == 37,
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
        guard Data(authBytes[0..<32]) == expectedRPHash,
              authBytes[32] == 0x05 else {
            throw PasskeyBindingError.authenticationFailed
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

private struct StrictWebAuthnClientData {
    let ceremony: String
    let challenge: String
    let origin: String
    let crossOrigin: Bool

    static func parse(_ data: Data) throws -> StrictWebAuthnClientData {
        guard data.count <= 4096, String(data: data, encoding: .utf8) != nil else {
            throw PasskeyBindingError.invalidInput
        }
        var parser = ObjectParser(bytes: Array(data))
        let fields = try parser.parseTopLevelObject()
        guard let ceremonyValue = fields["type"], case let .string(ceremony) = ceremonyValue,
              let challengeValue = fields["challenge"], case let .string(challenge) = challengeValue,
              let originValue = fields["origin"], case let .string(origin) = originValue else {
            throw PasskeyBindingError.invalidInput
        }
        let crossOrigin: Bool
        if let crossValue = fields["crossOrigin"] {
            guard case let .boolean(flag) = crossValue else {
                throw PasskeyBindingError.invalidInput
            }
            crossOrigin = flag
        } else {
            crossOrigin = false
        }
        for key in fields.keys where !["type", "challenge", "origin", "crossOrigin"].contains(key) {
            throw PasskeyBindingError.invalidInput
        }
        return StrictWebAuthnClientData(
            ceremony: ceremony,
            challenge: challenge,
            origin: origin,
            crossOrigin: crossOrigin
        )
    }

    private enum ScalarValue {
        case string(String)
        case boolean(Bool)
    }

    private struct ObjectParser {
        let bytes: [UInt8]
        var offset = 0

        mutating func parseTopLevelObject() throws -> [String: ScalarValue] {
            skipWhitespace()
            guard take(0x7B) else { throw PasskeyBindingError.invalidInput }
            skipWhitespace()
            var result: [String: ScalarValue] = [:]
            if take(0x7D) {
                skipWhitespace()
                guard offset == bytes.count else { throw PasskeyBindingError.invalidInput }
                return result
            }
            while true {
                skipWhitespace()
                let key = try parseString()
                guard result[key] == nil else { throw PasskeyBindingError.invalidInput }
                skipWhitespace()
                guard take(0x3A) else { throw PasskeyBindingError.invalidInput }
                skipWhitespace()
                let value = try parseScalar()
                result[key] = value
                skipWhitespace()
                if take(0x7D) {
                    skipWhitespace()
                    guard offset == bytes.count else { throw PasskeyBindingError.invalidInput }
                    return result
                }
                guard take(0x2C) else { throw PasskeyBindingError.invalidInput }
            }
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

        private mutating func parseScalar() throws -> ScalarValue {
            guard offset < bytes.count else { throw PasskeyBindingError.invalidInput }
            switch bytes[offset] {
            case 0x22:
                return .string(try parseString())
            case 0x74:
                try parseLiteral("true")
                return .boolean(true)
            case 0x66:
                try parseLiteral("false")
                return .boolean(false)
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
