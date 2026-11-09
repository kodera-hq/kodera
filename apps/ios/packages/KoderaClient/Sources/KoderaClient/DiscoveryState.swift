import Foundation

public struct DiscoveryTicket: Equatable, Sendable {
    let queryID: UUID
    let lifecycleID: UUID
}
public enum AnonymousDiscoveryState: Equatable, Sendable {
    case editing, loading, noMatch, cancelled
    case choosing([AnonymousOrganisationMetadata])
    case selected(AnonymousOrganisationMetadata)
    case unavailable(DiscoveryFailure)
}
/// Anonymous metadata state. Network-task cancellation belongs to its task owner.
public struct DiscoveryState: Sendable {
    public private(set) var value: AnonymousDiscoveryState = .editing
    private var lifecycleID = UUID()
    private var current: DiscoveryTicket?
    public init() {}
    public mutating func begin() -> DiscoveryTicket {
        let ticket = DiscoveryTicket(queryID: UUID(), lifecycleID: lifecycleID)
        current = ticket
        value = .loading
        return ticket
    }
    public mutating func receive(_ outcome: AnonymousDiscoveryOutcome, for ticket: DiscoveryTicket) {
        guard current == ticket, ticket.lifecycleID == lifecycleID else { return }
        current = nil
        switch outcome {
        case .result(.noMatch): value = .noMatch
        case let .result(.single(metadata)): value = .selected(metadata)
        case let .result(.multiple(metadata)): value = .choosing(metadata)
        case let .failure(failure): value = .unavailable(failure)
        case .cancelled: value = .cancelled
        }
    }
    public mutating func cancel() {
        current = nil
        value = .cancelled
    }
    public mutating func reset() {
        lifecycleID = UUID()
        current = nil
        value = .editing
    }
    public mutating func select(organisationId: String) throws {
        guard case let .choosing(metadata) = value else { throw DiscoveryFailure.protocolViolation }
        let matches = metadata.filter { $0.organisationId == organisationId }
        guard matches.count == 1, let selected = matches.first else { throw DiscoveryFailure.protocolViolation }
        value = .selected(selected)
    }
}
