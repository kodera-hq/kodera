import Foundation
import Security
import XCTest
@testable import KoderaAuth

final class TokenStoreTests: XCTestCase {
    func testInMemoryRoundTripAndWipe() throws {
        let store = InMemoryTokenStore()
        XCTAssertNil(try store.load())
        try store.save(Data("one".utf8))
        try store.save(Data("two".utf8))
        XCTAssertEqual(try store.load(), Data("two".utf8))
        try store.wipe()
        XCTAssertNil(try store.load())
        try store.wipe()
    }

    /// The real Keychain needs an entitled host (the app); the attributes it is given are checked here.
    func testKeychainItemIsDeviceBoundAndNeverSynchronised() throws {
        let store = KeychainTokenStore()
        let attributes = store.addAttributes(Data("grant".utf8))
        XCTAssertEqual(attributes[kSecAttrAccessible as String] as? String,
                       kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertEqual(attributes[kSecAttrSynchronizable as String] as? Bool, false)
        XCTAssertEqual(attributes[kSecClass as String] as? String, kSecClassGenericPassword as String)
        XCTAssertEqual(attributes[kSecValueData as String] as? Data, Data("grant".utf8))
        XCTAssertEqual(attributes[kSecUseDataProtectionKeychain as String] as? Bool, true)
        // Lookups and deletions are scoped to the same non-synchronised item.
        XCTAssertEqual(store.query[kSecAttrSynchronizable as String] as? Bool, false)
        XCTAssertEqual(store.query[kSecAttrService as String] as? String, "io.kodera.app.session")
        XCTAssertNil(store.query[kSecValueData as String])
        // An update in place rewrites the grant and keeps it device-bound; it never touches the identity.
        let update = store.updateAttributes(Data("rotated".utf8))
        XCTAssertEqual(update[kSecValueData as String] as? Data, Data("rotated".utf8))
        XCTAssertEqual(update[kSecAttrAccessible as String] as? String,
                       kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertEqual(Set(update.keys), [kSecValueData as String, kSecAttrAccessible as String])
    }
}
