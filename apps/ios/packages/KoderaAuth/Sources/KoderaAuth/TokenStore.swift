import Foundation
import Security

public enum TokenStoreFailure: Error, Equatable, Sendable {
    case keychain(OSStatus)
}

/// Where the serialised grant lives between launches.
public protocol TokenStore: Sendable {
    func load() throws(TokenStoreFailure) -> Data?
    func save(_ data: Data) throws(TokenStoreFailure)
    func wipe() throws(TokenStoreFailure)
}

/// Tests and previews only: nothing survives the process.
public final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    public init(_ data: Data? = nil) { self.data = data }
    public func load() throws(TokenStoreFailure) -> Data? { lock.withLock { data } }
    public func save(_ data: Data) throws(TokenStoreFailure) { lock.withLock { self.data = data } }
    public func wipe() throws(TokenStoreFailure) { lock.withLock { data = nil } }
}

/// One generic-password item, readable after the first unlock, bound to this device: it is never
/// synchronised to iCloud Keychain and never restored onto another device from a backup.
public struct KeychainTokenStore: TokenStore {
    public let service: String
    public let account: String

    public init(service: String = "io.kodera.app.session", account: String = "core") {
        self.service = service
        self.account = account
    }

    /// The item's identity. `kSecUseDataProtectionKeychain` makes macOS honour the same attributes as iOS.
    var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
         kSecUseDataProtectionKeychain as String: true]
    }

    /// What `save` writes over an existing item: the grant and its accessibility, nothing else.
    func updateAttributes(_ data: Data) -> [String: Any] {
        [kSecValueData as String: data,
         kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    }

    func addAttributes(_ data: Data) -> [String: Any] {
        query.merging(updateAttributes(data)) { $1 }
    }

    public func load() throws(TokenStoreFailure) -> Data? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw .keychain(status) }
        return result as? Data
    }

    /// Updates the item in place, and adds it only when there is none: a rotated grant never passes
    /// through a moment with no item, where a crash would lose the session.
    public func save(_ data: Data) throws(TokenStoreFailure) {
        let updated = SecItemUpdate(query as CFDictionary, updateAttributes(data) as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw .keychain(updated) }
        let added = SecItemAdd(addAttributes(data) as CFDictionary, nil)
        guard added == errSecSuccess else { throw .keychain(added) }
    }

    public func wipe() throws(TokenStoreFailure) {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw .keychain(status) }
    }
}
