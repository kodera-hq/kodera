import CryptoKit
import Foundation
import XCTest
@testable import KoderaAuth
#if canImport(AuthenticationServices)
import AuthenticationServices
#endif

final class PasskeyDeviceBindingTests: XCTestCase {
    private let org = "00000000-0000-4000-8000-000000000001"
    private let foreignOrg = "00000000-0000-4000-8000-000000000002"
    private let credentialID = Data("public-fixture-credential".utf8)

    private func makeSetup(
        origin: String = "https://accounts.example.test",
        compressed: Bool = false,
        backupPolicy: PasskeyBackupPolicy = .universal
    ) throws -> (PasskeyDeviceBinding, P256.Signing.PrivateKey) {
        let signer = P256.Signing.PrivateKey()
        let sec1 = compressed
            ? signer.publicKey.compressedRepresentation
            : signer.publicKey.x963Representation
        let binding = try PasskeyDeviceBinding(
            organisationId: org,
            rpId: "accounts.example.test",
            origin: origin,
            credentialId: credentialID,
            publicSEC1Key: sec1,
            backupPolicy: backupPolicy
        )
        return (binding, signer)
    }

    private func makeAssertion(
        signer: P256.Signing.PrivateKey,
        challenge: PasskeyChallenge,
        counter: UInt32,
        flags: UInt8,
        origin: String,
        rpId: String = "accounts.example.test",
        rawClientJSONOverride: Data? = nil
    ) throws -> PasskeyAssertion {
        let clientJSON: Data
        if let rawClientJSONOverride {
            clientJSON = rawClientJSONOverride
        } else {
            let text = """
            {"type":"webauthn.get","origin":"\(origin)","challenge":"\(challenge.base64URL)","crossOrigin":false}
            """
            clientJSON = Data(text.utf8)
        }

        var authData = Data(SHA256.hash(data: Data(rpId.utf8)))
        authData.append(flags)
        authData.append(contentsOf: [
            UInt8(truncatingIfNeeded: counter >> 24),
            UInt8(truncatingIfNeeded: counter >> 16),
            UInt8(truncatingIfNeeded: counter >> 8),
            UInt8(truncatingIfNeeded: counter),
        ])

        var signed = authData
        signed.append(contentsOf: SHA256.hash(data: clientJSON))
        let signature = try signer.signature(for: signed)
        return PasskeyAssertion(
            credentialId: credentialID,
            clientDataJSON: clientJSON,
            authenticatorData: authData,
            signatureDER: signature.derRepresentation
        )
    }

    func testSignedRPOriginChallengeAndStrictJSONMutationsDoNotConsumeGoodResponse() throws {
        var (binding, signer) = try makeSetup()
        let challenge = try binding.issueChallenge(organisationId: org, now: 100, lifetimeSeconds: 30)

        // 0: Wrong RP hash
        let wrongRP = try makeAssertion(
            signer: signer,
            challenge: challenge,
            counter: 1,
            flags: 0x05,
            origin: "https://accounts.example.test",
            rpId: "foreign.example.test"
        )
        XCTAssertThrowsError(try binding.verifyAssertion(organisationId: org, challenge: challenge, assertion: wrongRP, now: 101)) {
            XCTAssertEqual($0 as? PasskeyBindingError, .authenticationFailed)
        }

        // 1: crossOrigin = true
        let crossOriginJSON = Data("""
        {"type":"webauthn.get","origin":"https://accounts.example.test","challenge":"\(challenge.base64URL)","crossOrigin":true}
        """.utf8)
        let crossOriginAssertion = try makeAssertion(
            signer: signer,
            challenge: challenge,
            counter: 1,
            flags: 0x05,
            origin: "https://accounts.example.test",
            rawClientJSONOverride: crossOriginJSON
        )
        XCTAssertThrowsError(try binding.verifyAssertion(organisationId: org, challenge: challenge, assertion: crossOriginAssertion, now: 101)) {
            XCTAssertEqual($0 as? PasskeyBindingError, .scopeMismatch)
        }

        // 2: crossOrigin = null
        let nullCrossJSON = Data("""
        {"type":"webauthn.get","origin":"https://accounts.example.test","challenge":"\(challenge.base64URL)","crossOrigin":null}
        """.utf8)
        let nullCrossAssertion = try makeAssertion(
            signer: signer,
            challenge: challenge,
            counter: 1,
            flags: 0x05,
            origin: "https://accounts.example.test",
            rawClientJSONOverride: nullCrossJSON
        )
        XCTAssertThrowsError(try binding.verifyAssertion(organisationId: org, challenge: challenge, assertion: nullCrossAssertion, now: 101)) {
            XCTAssertEqual($0 as? PasskeyBindingError, .invalidInput)
        }

        // 3: Deeply nested JSON (> depth 4) rejected
        let extraFieldJSON = Data("""
        {"type":"webauthn.get","origin":"https://accounts.example.test","challenge":"\(challenge.base64URL)","crossOrigin":false,"deep":{"l1":{"l2":{"l3":{"l4":true}}}}}
        """.utf8)
        let extraFieldAssertion = try makeAssertion(
            signer: signer,
            challenge: challenge,
            counter: 1,
            flags: 0x05,
            origin: "https://accounts.example.test",
            rawClientJSONOverride: extraFieldJSON
        )
        XCTAssertThrowsError(try binding.verifyAssertion(organisationId: org, challenge: challenge, assertion: extraFieldAssertion, now: 101)) {
            XCTAssertEqual($0 as? PasskeyBindingError, .invalidInput)
        }

        // 4: Forged challenge nonce
        let forgedChallenge = PasskeyBase64URL.encodeUnpadded(Data(repeating: 9, count: 32))
        let forgedJSON = Data("""
        {"type":"webauthn.get","origin":"https://accounts.example.test","challenge":"\(forgedChallenge)","crossOrigin":false}
        """.utf8)
        let forgedAssertion = try makeAssertion(
            signer: signer,
            challenge: challenge,
            counter: 1,
            flags: 0x05,
            origin: "https://accounts.example.test",
            rawClientJSONOverride: forgedJSON
        )
        XCTAssertThrowsError(try binding.verifyAssertion(organisationId: org, challenge: challenge, assertion: forgedAssertion, now: 101)) {
            XCTAssertEqual($0 as? PasskeyBindingError, .scopeMismatch)
        }

        // 5: Escaped duplicate key `\u0074ype`
        let duplicateKeyJSON = Data(
            "{\"type\":\"webauthn.get\",\"origin\":\"https://accounts.example.test\",\"challenge\":\"\(challenge.base64URL)\",\"crossOrigin\":false,\"\\u0074ype\":\"webauthn.get\"}".utf8
        )
        let duplicateAssertion = try makeAssertion(
            signer: signer,
            challenge: challenge,
            counter: 1,
            flags: 0x05,
            origin: "https://accounts.example.test",
            rawClientJSONOverride: duplicateKeyJSON
        )
        XCTAssertThrowsError(try binding.verifyAssertion(organisationId: org, challenge: challenge, assertion: duplicateAssertion, now: 101)) {
            XCTAssertEqual($0 as? PasskeyBindingError, .invalidInput)
        }

        // The original issued challenge remains unconsumed and verifies cleanly.
        let good = try makeAssertion(
            signer: signer,
            challenge: challenge,
            counter: 1,
            flags: 0x05,
            origin: "https://accounts.example.test"
        )
        try binding.verifyAssertion(organisationId: org, challenge: challenge, assertion: good, now: 101)
        XCTAssertEqual(binding.verifiedAssertionCount, 1)
    }

    func testRealES256VerificationConsumesOnlyAuthenticatedChallengesAndCounters() throws {
        var (binding, signer) = try makeSetup(compressed: true)
        let challenge = try binding.issueChallenge(organisationId: org, now: 100, lifetimeSeconds: 30)
        let validResponse = try makeAssertion(
            signer: signer,
            challenge: challenge,
            counter: 1,
            flags: 0x05,
            origin: "https://accounts.example.test"
        )

        var tamperedSig = Array(validResponse.signatureDER)
        tamperedSig[tamperedSig.count - 1] ^= 0x01
        let corrupted = PasskeyAssertion(
            credentialId: validResponse.credentialId,
            clientDataJSON: validResponse.clientDataJSON,
            authenticatorData: validResponse.authenticatorData,
            signatureDER: Data(tamperedSig)
        )
        XCTAssertThrowsError(try binding.verifyAssertion(organisationId: org, challenge: challenge, assertion: corrupted, now: 101)) {
            XCTAssertEqual($0 as? PasskeyBindingError, .authenticationFailed)
        }

        try binding.verifyAssertion(organisationId: org, challenge: challenge, assertion: validResponse, now: 101)
        XCTAssertThrowsError(try binding.verifyAssertion(organisationId: org, challenge: challenge, assertion: validResponse, now: 101)) {
            XCTAssertEqual($0 as? PasskeyBindingError, .replay)
        }

        let secondChallenge = try binding.issueChallenge(organisationId: org, now: 102, lifetimeSeconds: 30)
        let staleCounter = try makeAssertion(
            signer: signer,
            challenge: secondChallenge,
            counter: 1,
            flags: 0x05,
            origin: "https://accounts.example.test"
        )
        XCTAssertThrowsError(try binding.verifyAssertion(organisationId: org, challenge: secondChallenge, assertion: staleCounter, now: 103)) {
            XCTAssertEqual($0 as? PasskeyBindingError, .replay)
        }

        let incremented = try makeAssertion(
            signer: signer,
            challenge: secondChallenge,
            counter: 2,
            flags: 0x05,
            origin: "https://accounts.example.test"
        )
        try binding.verifyAssertion(organisationId: org, challenge: secondChallenge, assertion: incremented, now: 103)
        XCTAssertEqual(binding.lastCounter, 2)
    }

    func testUniversalPolicyAdmitsSingleDeviceBackupEligibleAndSyncedPasskeysAndRefusesInvalidFlags() throws {
        var (binding, signer) = try makeSetup()
        XCTAssertEqual(binding.backupPolicy, .universal)
        XCTAssertNil(binding.lastResidencyPosture)

        let challenge = try binding.issueChallenge(organisationId: org, now: 100, lifetimeSeconds: 30)
        for disallowedFlags: UInt8 in [0x00, 0x01, 0x04, 0x09, 0x15, 0x19, 0x25, 0x45, 0x85] {
            let badFlags = try makeAssertion(
                signer: signer,
                challenge: challenge,
                counter: 1,
                flags: disallowedFlags,
                origin: "https://accounts.example.test"
            )
            XCTAssertThrowsError(
                try binding.verifyAssertion(organisationId: org, challenge: challenge, assertion: badFlags, now: 101)
            ) {
                XCTAssertEqual($0 as? PasskeyBindingError, .authenticationFailed)
            }
        }

        let admitted: [(UInt8, PasskeyResidencyPosture)] = [
            (0x05, .singleDeviceBound),
            (0x0D, .backupEligibleLocal),
            (0x1D, .multiDeviceSynced),
        ]
        for (index, entry) in admitted.enumerated() {
            let now = UInt64(102 + index * 2)
            let stepChallenge = try binding.issueChallenge(organisationId: org, now: now, lifetimeSeconds: 30)
            let assertion = try makeAssertion(
                signer: signer,
                challenge: stepChallenge,
                counter: UInt32(index + 1),
                flags: entry.0,
                origin: "https://accounts.example.test"
            )
            let posture = try binding.verifyAssertion(
                organisationId: org,
                challenge: stepChallenge,
                assertion: assertion,
                now: now + 1
            )
            XCTAssertEqual(posture, entry.1)
            XCTAssertEqual(binding.lastResidencyPosture, entry.1)
        }
    }

    func testScopeOriginUVStrictNonBackupableExpiryClockAndRedactionInvariants() throws {
        var (binding, signer) = try makeSetup(backupPolicy: .strictNonBackupable)
        let challenge = try binding.issueChallenge(organisationId: org, now: 100, lifetimeSeconds: 30)

        for disallowedFlags: UInt8 in [0x00, 0x01, 0x04, 0x0D, 0x15, 0x1D, 0x45, 0x85] {
            let badFlags = try makeAssertion(
                signer: signer,
                challenge: challenge,
                counter: 1,
                flags: disallowedFlags,
                origin: "https://accounts.example.test"
            )
            XCTAssertThrowsError(
                try binding.verifyAssertion(organisationId: org, challenge: challenge, assertion: badFlags, now: 101)
            ) {
                XCTAssertEqual($0 as? PasskeyBindingError, .authenticationFailed)
            }
        }

        let wrongOrigin = try makeAssertion(
            signer: signer,
            challenge: challenge,
            counter: 1,
            flags: 0x05,
            origin: "https://foreign.example.test"
        )
        XCTAssertThrowsError(
            try binding.verifyAssertion(organisationId: org, challenge: challenge, assertion: wrongOrigin, now: 101)
        ) {
            XCTAssertEqual($0 as? PasskeyBindingError, .scopeMismatch)
        }

        let good = try makeAssertion(
            signer: signer,
            challenge: challenge,
            counter: 1,
            flags: 0x05,
            origin: "https://accounts.example.test"
        )
        XCTAssertThrowsError(
            try binding.verifyAssertion(organisationId: foreignOrg, challenge: challenge, assertion: good, now: 101)
        ) {
            XCTAssertEqual($0 as? PasskeyBindingError, .scopeMismatch)
        }
        XCTAssertThrowsError(
            try binding.verifyAssertion(organisationId: org, challenge: challenge, assertion: good, now: 131)
        ) {
            XCTAssertEqual($0 as? PasskeyBindingError, .authenticationFailed)
        }
        XCTAssertThrowsError(
            try binding.verifyAssertion(organisationId: org, challenge: challenge, assertion: good, now: 101)
        ) {
            XCTAssertEqual($0 as? PasskeyBindingError, .epochMismatch)
        }

        let formatted = "\(String(reflecting: binding)) \(String(reflecting: challenge)) \(String(reflecting: good))"
        XCTAssertTrue(formatted.contains("[redacted]"))
        XCTAssertFalse(formatted.contains(challenge.base64URL))

        #if canImport(AuthenticationServices)
        let request = try PasskeyPlatformAssertionBridge.makeAssertionRequest(
            rpId: "accounts.example.test",
            challenge: challenge,
            allowedCredentialIDs: [credentialID]
        )
        XCTAssertEqual(request.relyingPartyIdentifier, "accounts.example.test")
        XCTAssertEqual(request.challenge, challenge.bytes)
        XCTAssertEqual(request.userVerificationPreference, .required)
        XCTAssertEqual(request.allowedCredentials.count, 1)
        #endif
    }

    func testAndroidCredentialManagerPackageNameBrowserTokenBindingAndCBORExtensionAssertionsSucceed() throws {
        let credPropsCBOR = Data([
            0xA1, 0x69,
            0x63, 0x72, 0x65, 0x64, 0x50, 0x72, 0x6F, 0x70, 0x73,
            0xA1, 0x62, 0x72, 0x6B, 0xF5,
        ])

        // 1. Android CredentialManager payload with `androidPackageName` + `ED=0x80` CBOR extension map.
        let apkFacet = "android:apk-key-hash:\(PasskeyBase64URL.encodeUnpadded(Data(repeating: 7, count: 32)))"
        var (androidBinding, androidSigner) = try makeSetup(origin: apkFacet)
        let c1 = try androidBinding.issueChallenge(organisationId: org, now: 200, lifetimeSeconds: 30)
        let androidJSON = Data("""
        {"type":"webauthn.get","challenge":"\(c1.base64URL)","origin":"\(apkFacet)","androidPackageName":"io.kodera.android"}
        """.utf8)
        var androidAuthData = Data(SHA256.hash(data: Data("accounts.example.test".utf8)))
        androidAuthData.append(0x9D) // UP | UV | BE | BS | ED
        androidAuthData.append(contentsOf: [0, 0, 0, 1])
        androidAuthData.append(credPropsCBOR)
        var androidSigned = androidAuthData
        androidSigned.append(contentsOf: SHA256.hash(data: androidJSON))
        let androidSig = try androidSigner.signature(for: androidSigned)
        let androidAssertion = PasskeyAssertion(
            credentialId: credentialID,
            clientDataJSON: androidJSON,
            authenticatorData: androidAuthData,
            signatureDER: androidSig.derRepresentation
        )
        let androidPosture = try androidBinding.verifyAssertion(
            organisationId: org,
            challenge: c1,
            assertion: androidAssertion,
            now: 201
        )
        XCTAssertEqual(androidPosture, .multiDeviceSynced)

        // 2. Browser payload with `tokenBinding` object, `topOrigin`, and `ED=0x80` CBOR map.
        var (webBinding, webSigner) = try makeSetup()
        let c2 = try webBinding.issueChallenge(organisationId: org, now: 300, lifetimeSeconds: 30)
        let browserJSON = Data("""
        {"type":"webauthn.get","challenge":"\(c2.base64URL)","origin":"https://accounts.example.test","crossOrigin":false,"topOrigin":"https://accounts.example.test","tokenBinding":{"status":"present","id":"AQIDBAUGBwgJCgsMDQ4PEA"}}
        """.utf8)
        var webAuthData = Data(SHA256.hash(data: Data("accounts.example.test".utf8)))
        webAuthData.append(0x85) // UP | UV | ED
        webAuthData.append(contentsOf: [0, 0, 0, 1])
        webAuthData.append(credPropsCBOR)
        var webSigned = webAuthData
        webSigned.append(contentsOf: SHA256.hash(data: browserJSON))
        let webSig = try webSigner.signature(for: webSigned)
        let browserAssertion = PasskeyAssertion(
            credentialId: credentialID,
            clientDataJSON: browserJSON,
            authenticatorData: webAuthData,
            signatureDER: webSig.derRepresentation
        )
        let webPosture = try webBinding.verifyAssertion(
            organisationId: org,
            challenge: c2,
            assertion: browserAssertion,
            now: 301
        )
        XCTAssertEqual(webPosture, .singleDeviceBound)
    }
}
