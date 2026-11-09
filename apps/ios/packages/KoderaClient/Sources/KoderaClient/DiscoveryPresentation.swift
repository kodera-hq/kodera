import Foundation

/// What organisation entry shows for a discovery state. The screen maps each case to its catalogue keys
/// and offers sign-in only for `.found`, whose issuer discovery has already admitted.
public enum DiscoveryPresentation: Equatable, Sendable {
    case ready
    case searching
    case cancelled
    /// Core answered with zero results. Not an error: nothing matched, or nothing is eligible yet.
    case noOrganisation
    /// One organisation: sign-in goes to its realm.
    case found(AnonymousOrganisationMetadata)
    /// Several organisations matched; the member picks one, which then becomes `.found`.
    case severalCandidates([AnonymousOrganisationMetadata])
    /// A quota answer (429 `rate-limited`). Nothing retries it; the member searches again later.
    case tryAgainLater
    /// No answer from Core: offline, timed out, or the connection could not be established.
    case networkError(TransportFailure)
    /// Core answered that it cannot serve discovery now (500, 503 or a status it does not document).
    case serviceUnavailable
    /// Core refused the request itself (one of `RequestRejection`).
    case requestRefused
    /// An answer the app cannot use, including an issuer outside the configured origins.
    case invalidResponse
    case invalidInput
    case notConfigured

    public init(_ state: AnonymousDiscoveryState) {
        switch state {
        case .editing: self = .ready
        case .loading: self = .searching
        case .cancelled: self = .cancelled
        case .noMatch: self = .noOrganisation
        case let .selected(organisation): self = .found(organisation)
        case let .choosing(organisations): self = .severalCandidates(organisations)
        case let .unavailable(failure):
            switch failure {
            case .rateLimited: self = .tryAgainLater
            case let .transport(reason): self = .networkError(reason)
            case .temporarilyUnavailable, .internalServiceError, .unsupportedService: self = .serviceUnavailable
            case .rejectedRequest: self = .requestRefused
            case .protocolViolation: self = .invalidResponse
            case .invalidInput: self = .invalidInput
            case .notConfigured: self = .notConfigured
            }
        }
    }

    /// The issuer a sign-in may start against: only a found organisation's.
    public var signInIssuer: String? {
        if case let .found(organisation) = self { organisation.issuer } else { nil }
    }
}
