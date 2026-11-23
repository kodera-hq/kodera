import CryptoKit
import Foundation
import KoderaDomain

public enum KeychainSessionVaultError: Error, Equatable, Sendable {
    case keychain(OSStatus)
    case crypto(KoderaMobileFfiError)
    case missingVaultKey
}

/// Device-bound `KDV1` AES-256-GCM session vault persisted in Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`,
/// `kSecAttrSynchronizable = false`) and cryptographically bound to `(organisationId, deviceId)` AAD.
/// All `seal`, `sealIfActive`, `open`, and `wipe` operations serialize through a shared per-vault lock so
/// late Matrix authentication or refresh completions cannot recreate a wiped vault after sign-out begins.
public struct KeychainSessionVault: Sendable {
    private final class VaultGate: @unchecked Sendable {
        private let lock = NSLock()
        func withLock<T>(
            _ body: () throws(KeychainSessionVaultError) -> T
        ) throws(KeychainSessionVaultError) -> T {
            lock.lock()
            defer { lock.unlock() }
            return try body()
        }
    }

    public static let defaultService = "io.kodera.app.session.vault"
    public static let keyAccount = "kdv1-key"
    public static let sealedAccount = "kdv1-sealed"

    public let keyStore: any TokenStore
    public let sealedStore: any TokenStore
    private let gate = VaultGate()

    public init(
        keyStore: any TokenStore = KeychainTokenStore(service: Self.defaultService, account: Self.keyAccount),
        sealedStore: any TokenStore = KeychainTokenStore(service: Self.defaultService, account: Self.sealedAccount)
    ) {
        self.keyStore = keyStore
        self.sealedStore = sealedStore
    }

    /// Seals `plaintext` under a 256-bit Keychain-persisted key with `(organisationId, deviceId)` AAD.
    @discardableResult
    public func seal(
        organisationId: String,
        deviceId: String,
        plaintext: Data,
        deterministicNonce: Data? = nil
    ) throws(KeychainSessionVaultError) -> Data {
        try gate.withLock { () throws(KeychainSessionVaultError) -> Data in
            try sealLocked(
                organisationId: organisationId,
                deviceId: deviceId,
                plaintext: plaintext,
                deterministicNonce: deterministicNonce
            )
        }
    }

    /// Re-checks `isActive()` inside the vault's serializing lock immediately before persisting ciphertext,
    /// preventing any late Matrix login or token refresh from recreating a vault wiped by `signOut`.
    @discardableResult
    public func sealIfActive(
        organisationId: String,
        deviceId: String,
        plaintext: Data,
        deterministicNonce: Data? = nil,
        isActive: () -> Bool
    ) throws(KeychainSessionVaultError) -> Data? {
        try gate.withLock { () throws(KeychainSessionVaultError) -> Data? in
            guard isActive() else { return nil }
            return try sealLocked(
                organisationId: organisationId,
                deviceId: deviceId,
                plaintext: plaintext,
                deterministicNonce: deterministicNonce
            )
        }
    }

    private func sealLocked(
        organisationId: String,
        deviceId: String,
        plaintext: Data,
        deterministicNonce: Data?
    ) throws(KeychainSessionVaultError) -> Data {
        let keyData = try loadOrMintKeyLocked()
        let sealed: Data
        do {
            sealed = try Kdv1SessionVaultCodec.seal(
                organisationId: organisationId,
                deviceId: deviceId,
                keyData: keyData,
                nonceData: deterministicNonce,
                plaintext: plaintext
            )
        } catch let error as KoderaMobileFfiError {
            throw .crypto(error)
        } catch {
            throw .crypto(.authenticationFailed)
        }
        do throws(TokenStoreFailure) {
            try sealedStore.save(sealed)
        } catch {
            switch error {
            case let .keychain(status): throw .keychain(status)
            }
        }
        return sealed
    }

    /// Opens the persisted `KDV1` vault payload if present, verifying `(organisationId, deviceId)` AAD.
    public func open(
        organisationId: String,
        deviceId: String
    ) throws(KeychainSessionVaultError) -> Data? {
        try gate.withLock { () throws(KeychainSessionVaultError) -> Data? in
            let sealed: Data?
            do throws(TokenStoreFailure) {
                sealed = try sealedStore.load()
            } catch {
                switch error {
                case let .keychain(status): throw .keychain(status)
                }
            }
            guard let sealed else { return nil }

            let keyData: Data?
            do throws(TokenStoreFailure) {
                keyData = try keyStore.load()
            } catch {
                switch error {
                case let .keychain(status): throw .keychain(status)
                }
            }
            guard let keyData, keyData.count == 32 else {
                throw .missingVaultKey
            }

            do {
                return try Kdv1SessionVaultCodec.open(
                    organisationId: organisationId,
                    deviceId: deviceId,
                    keyData: keyData,
                    sealed: sealed
                )
            } catch let error as KoderaMobileFfiError {
                throw .crypto(error)
            } catch {
                throw .crypto(.authenticationFailed)
            }
        }
    }

    /// Wipes both the `KDV1` ciphertext item and the wrapping key item on sign-out or session termination.
    public func wipe() throws(KeychainSessionVaultError) {
        try gate.withLock { () throws(KeychainSessionVaultError) -> Void in
            try wipeLocked()
        }
    }

    /// Atomically runs `beforeWipe` (such as session fence invalidation) and wipes the vault under the same lock.
    public func retireAndWipe(_ beforeWipe: () -> Void = {}) throws(KeychainSessionVaultError) {
        try gate.withLock { () throws(KeychainSessionVaultError) -> Void in
            beforeWipe()
            try wipeLocked()
        }
    }

    private func wipeLocked() throws(KeychainSessionVaultError) {
        var firstFailure: OSStatus?
        do throws(TokenStoreFailure) {
            try sealedStore.wipe()
        } catch {
            switch error {
            case let .keychain(status): firstFailure = status
            }
        }
        do throws(TokenStoreFailure) {
            try keyStore.wipe()
        } catch {
            switch error {
            case let .keychain(status):
                if firstFailure == nil { firstFailure = status }
            }
        }
        if let firstFailure {
            throw .keychain(firstFailure)
        }
    }

    private func loadOrMintKeyLocked() throws(KeychainSessionVaultError) -> Data {
        let existing: Data?
        do throws(TokenStoreFailure) {
            existing = try keyStore.load()
        } catch {
            switch error {
            case let .keychain(status): throw .keychain(status)
            }
        }
        if let existing, existing.count == 32 {
            return existing
        }
        let freshKey = SymmetricKey(size: .bits256)
        let rawKey = freshKey.withUnsafeBytes { Data($0) }
        do throws(TokenStoreFailure) {
            try keyStore.save(rawKey)
        } catch {
            switch error {
            case let .keychain(status): throw .keychain(status)
            }
        }
        return rawKey
    }
}
