import Foundation
import KoderaDomain

/// An opaque, serialised grant (AppAuth's `OIDAuthState`) and the issuer it belongs to.
public struct StoredGrant: Equatable, Sendable {
    public let issuer: String
    public let archive: Data
    public init(issuer: String, archive: Data) {
        self.issuer = issuer
        self.archive = archive
    }
}

public struct FreshToken: Sendable {
    public let accessToken: String
    public let grant: StoredGrant
    public init(accessToken: String, grant: StoredGrant) {
        self.accessToken = accessToken
        self.grant = grant
    }
}

public enum BackendFailure: Error, Equatable, Sendable {
    case cancelled
    /// An OAuth error from the provider: the grant is no longer usable.
    case refused
    /// Network or presentation trouble: nothing about the grant is known.
    case unavailable
    case protocolViolation
}

/// The browser, token and revocation calls. `AppAuthBackend` is the production implementation;
/// tests substitute a fake so no browser or network is needed.
public protocol AuthorizationBackend: Sendable {
    func authorize(issuer: AdmittedIssuer, configuration: SignInConfiguration) async throws(BackendFailure)
        -> StoredGrant
    func freshAccessToken(grant: StoredGrant, forceRefresh: Bool) async throws(BackendFailure) -> FreshToken
    /// Best effort: revoke the refresh token at the issuer's RFC 7009 endpoint, if it publishes one.
    /// Called by the explicit sign-out only.
    func revoke(grant: StoredGrant, issuer: AdmittedIssuer, configuration: SignInConfiguration) async
}
