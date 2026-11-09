import Foundation
import KoderaDomain

/// An in-process preparation lifetime, not a signed frame or radio authority.
public struct EmergencyCheckInContext: Sendable {
    fileprivate let owner: UUID
    fileprivate let generation: UUID
    fileprivate let organisationId: String
}

/// Local preparation only: not signed, queued, sent or acknowledged by a peer.
/// Owner preparation remains available directly; asynchronous view actions use a scoped context.
/// Value copies retain operation ownership and are not unique authentication authorities.
public struct EmergencyCheckInDraft: Equatable, Sendable {
    public private(set) var status: EmergencySafetyStatus?
    public private(set) var organisationId: String?
    private let owner = UUID()
    private var generation = UUID()
    public init() {}
    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.organisationId == rhs.organisationId && lhs.status == rhs.status
    }
    /// Replace the current display owner first; malformed or unavailable metadata stays empty.
    @discardableResult
    public mutating func configure(organisationId: String?) -> Bool {
        clear()
        guard let organisationId else { return true }
        guard TrustPolicy.canonicalNonNilUUID(organisationId) else { return false }
        self.organisationId = organisationId
        return true
    }
    public func preparationContext(forOrganisationId incoming: String?) -> EmergencyCheckInContext? {
        guard let organisationId, incoming == organisationId else { return nil }
        return EmergencyCheckInContext(owner: owner, generation: generation, organisationId: organisationId)
    }
    @discardableResult
    public mutating func prepare(_ status: EmergencySafetyStatus, context: EmergencyCheckInContext?) -> Bool {
        guard let context, context.owner == owner, context.generation == generation,
              context.organisationId == organisationId else { return false }
        return prepare(status)
    }
    @discardableResult
    public mutating func prepare(_ status: EmergencySafetyStatus) -> Bool {
        guard status != .messageOnly else { return false }
        self.status = status
        return true
    }
    public mutating func clear() { status = nil; organisationId = nil; generation = UUID() }
}
