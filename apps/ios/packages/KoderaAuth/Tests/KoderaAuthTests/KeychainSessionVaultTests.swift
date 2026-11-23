import Foundation
import KoderaClient
import KoderaDomain
import Security
import XCTest
@testable import KoderaAuth

final class KeychainSessionVaultTests: XCTestCase {
    private static let orgA = "00000000-0000-4000-8000-000000000001"
    private static let orgB = "00000000-0000-4000-8000-000000000002"
    private static let deviceA = "01935800-0000-7000-8000-000000000042"
    private static let deviceB = "01935800-0000-7000-8000-000000000099"

    func testKeychainAttributesAreDeviceOnlyAndNeverSynchronised() {
        let defaultVault = KeychainSessionVault()
        guard let keyStore = defaultVault.keyStore as? KeychainTokenStore,
              let sealedStore = defaultVault.sealedStore as? KeychainTokenStore else {
            XCTFail("Expected KeychainTokenStore defaults")
            return
        }
        for store in [keyStore, sealedStore] {
            let attrs = store.addAttributes(Data("x".utf8))
            XCTAssertEqual(
                attrs[kSecAttrAccessible as String] as? String,
                kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String
            )
            XCTAssertEqual(attrs[kSecAttrSynchronizable as String] as? Bool, false)
            XCTAssertEqual(attrs[kSecUseDataProtectionKeychain as String] as? Bool, true)
        }
        XCTAssertNotEqual(keyStore.account, sealedStore.account)
    }

    func testSealOpenMatchesRustKdv1WireAndWipesCleanly() throws {
        let fixtureKey = try KoderaMobileFfiBridge.decodeHex(
            "0303030303030303030303030303030303030303030303030303030303030303"
        )
        let fixtureNonce = try KoderaMobileFfiBridge.decodeHex("040404040404040404040404")
        let fixturePlaintext = try KoderaMobileFfiBridge.decodeHex(
            "7b226d61747269785f646576696365223a224445563031222c2273796e635f6261746368223a227337325f31227d"
        )
        let expectedSealedHex = "4b4456310404040404040404040404043b057eacd9ec6e66c670e52818375c52ab5ecb2915f376c0044a74e84dedb63ec20d57b46369ca342e00df2d0fc950af88af858d2f28ff54f368dc958396"

        let keyStore = InMemoryTokenStore(fixtureKey)
        let sealedStore = InMemoryTokenStore()
        let vault = KeychainSessionVault(keyStore: keyStore, sealedStore: sealedStore)

        XCTAssertNil(try vault.open(organisationId: Self.orgA, deviceId: Self.deviceA))

        let sealed = try vault.seal(
            organisationId: Self.orgA,
            deviceId: Self.deviceA,
            plaintext: fixturePlaintext,
            deterministicNonce: fixtureNonce
        )
        XCTAssertEqual(KoderaMobileFfiBridge.encodeHex(sealed), expectedSealedHex)
        XCTAssertEqual(try vault.open(organisationId: Self.orgA, deviceId: Self.deviceA), fixturePlaintext)

        // Cross-org and cross-device AAD mismatches refuse opening.
        XCTAssertThrowsError(try vault.open(organisationId: Self.orgB, deviceId: Self.deviceA)) {
            XCTAssertEqual($0 as? KeychainSessionVaultError, .crypto(.authenticationFailed))
        }
        XCTAssertThrowsError(try vault.open(organisationId: Self.orgA, deviceId: Self.deviceB)) {
            XCTAssertEqual($0 as? KeychainSessionVaultError, .crypto(.authenticationFailed))
        }

        // Wipe removes both key and sealed payload.
        try vault.wipe()
        XCTAssertNil(try keyStore.load())
        XCTAssertNil(try sealedStore.load())
        XCTAssertNil(try vault.open(organisationId: Self.orgA, deviceId: Self.deviceA))
    }

    func testSerializedSealIfActiveAndRetireAndWipeNeverRecreateWipedVault() async throws {
        for _ in 0..<25 {
            let keyStore = InMemoryTokenStore()
            let sealedStore = InMemoryTokenStore()
            let vault = KeychainSessionVault(keyStore: keyStore, sealedStore: sealedStore)
            let fence = SessionFence()
            let payload = Data("{\"access_token\":\"mtx_race\"}".utf8)

            await withTaskGroup(of: Void.self) { group in
                for _ in 0..<16 {
                    group.addTask {
                        _ = try? vault.sealIfActive(
                            organisationId: Self.orgA,
                            deviceId: Self.deviceA,
                            plaintext: payload,
                            isActive: { !fence.isInvalidated }
                        )
                    }
                }
                group.addTask {
                    try? vault.retireAndWipe {
                        fence.invalidate()
                    }
                }
                for _ in 0..<16 {
                    group.addTask {
                        _ = try? vault.sealIfActive(
                            organisationId: Self.orgA,
                            deviceId: Self.deviceA,
                            plaintext: payload,
                            isActive: { !fence.isInvalidated }
                        )
                    }
                }
            }

            XCTAssertTrue(fence.isInvalidated)
            XCTAssertNil(try keyStore.load(), "Vault key must never remain after retireAndWipe")
            XCTAssertNil(try sealedStore.load(), "Sealed vault bytes must never be recreated after retireAndWipe")
            XCTAssertNil(try vault.open(organisationId: Self.orgA, deviceId: Self.deviceA))
        }

        // Also verify OIDC JWT `sub` extraction helper in AppAuthBackend.
        let header = Data("{\"alg\":\"RS256\"}".utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let claims = Data("{\"sub\":\"oidc-sub-uuid-9999\",\"iss\":\"https://auth.kodera.io/realms/atelier\"}".utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let syntheticIdToken = "\(header).\(claims).sig"
        XCTAssertEqual(AppAuthBackend.extractJwtSubject(syntheticIdToken), "oidc-sub-uuid-9999")
        XCTAssertNil(AppAuthBackend.extractJwtSubject("not-a-jwt"))
    }
}
