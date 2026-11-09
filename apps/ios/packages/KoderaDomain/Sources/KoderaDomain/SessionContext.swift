import Foundation

public struct CoreIdentity: Equatable, Sendable {
    public let organisationId: String
    public let issuer: String
    public let subject: String
    public init(organisationId: String, issuer: String, subject: String) {
        self.organisationId = organisationId; self.issuer = issuer; self.subject = subject
    }
}
public struct MatrixIdentity: Equatable, Sendable {
    public let userId: String
    public let deviceId: String
    public let homeserverOrigin: String
    public init(userId: String, deviceId: String, homeserverOrigin: String) {
        self.userId = userId; self.deviceId = deviceId; self.homeserverOrigin = homeserverOrigin
    }
}
/// Identity correlation only. No access/refresh tokens or verified-login claim is stored here.
public struct AccountContext: Equatable, Sendable {
    public let coreIdentity: CoreIdentity
    public let matrixIdentity: MatrixIdentity
    public let generation: UInt64
    public static func bind(discovery: ValidatedDiscovery, descriptor: ValidatedDescriptor,
        coreIdentity: CoreIdentity, matrixIdentity: MatrixIdentity, generation: UInt64)
        throws -> AccountContext {
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789._=-/+".utf8)
        let subject = coreIdentity.subject
        guard (1...255).contains(subject.utf8.count), subject.utf8.allSatisfy({ allowed.contains($0) }) else {
            throw DomainError.unsupportedSubject
        }
        guard generation > 0 else { throw DomainError.staleGeneration }
        guard descriptor.coreIdentity == coreIdentity,
              descriptor.descriptor.organisationId == coreIdentity.organisationId,
              discovery.selection.organisationId == coreIdentity.organisationId,
              discovery.selection.issuer == coreIdentity.issuer else { throw DomainError.identityMismatch }
        guard matrixIdentity.userId == "@" + subject + ":" + descriptor.descriptor.matrixServerName,
              !matrixIdentity.deviceId.isEmpty,
              matrixIdentity.homeserverOrigin == descriptor.descriptor.homeserverOrigin else {
            throw DomainError.identityMismatch
        }
        return AccountContext(coreIdentity: coreIdentity, matrixIdentity: matrixIdentity, generation: generation)
    }
    public func accepts(coreIdentity: CoreIdentity, generation: UInt64) -> Bool {
        generation > 0 && self.generation == generation && self.coreIdentity == coreIdentity
    }
}
public struct SessionContext: Equatable, Sendable {
    public private(set) var generation: UInt64 = 1
    public private(set) var account: AccountContext?
    public init() {}
    public mutating func activate(_ account: AccountContext) throws {
        guard generation > 0, account.generation == generation else { throw DomainError.staleGeneration }
        if let current = self.account, current != account { throw DomainError.identityMismatch }
        self.account = account
    }
    public mutating func signOut() {
        account = nil
        // Zero is permanently fenced on exhaustion; never wrap back to a usable old generation.
        generation = generation == 0 || generation == UInt64.max ? 0 : generation + 1
    }
}
