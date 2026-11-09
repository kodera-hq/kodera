import Foundation
import KoderaClient
import KoderaDomain

/// The protected sign-in configuration: the platform's public client, the issuer origins this build
/// admits and whether a loopback development origin may be one of them.
public struct SignInConfiguration: Equatable, Sendable {
    /// RFC 8252 private-use scheme, the bundle identifier. Fixed by the app, never derived or configured.
    public static let redirectURI = "io.kodera.app:/oauth2redirect"
    /// Keycloak adds the client's default scopes (basic, acr, profile, email, web-origins) itself.
    public static let baseScopes = ["openid"]
    /// The native client's one optional scope, requested only when the build enables it.
    public static let offlineAccessScope = "offline_access"

    public let clientID: String
    public let admittedIssuerOrigins: Set<String>
    public let loopback: LoopbackPolicy
    /// From the `KODERA_OFFLINE_ACCESS` build setting, off unless set. On, the refresh token is an offline
    /// token (idle 14 days, max 90, rotated with reuse detection), so a member stays signed in across days
    /// without a browser round trip. Off, as the organisation realms are configured for now (I-2), the
    /// session lasts as long as the realm's SSO session. Either way a refused refresh returns to sign-in.
    public let offlineAccess: Bool

    /// What the authorization request asks for.
    public var scopes: [String] {
        offlineAccess ? Self.baseScopes + [Self.offlineAccessScope] : Self.baseScopes
    }

    public init(clientID: String, admittedIssuerOrigins: Set<String>, loopback: LoopbackPolicy,
                offlineAccess: Bool = false) throws(SignInFailure) {
        guard (1...128).contains(clientID.utf8.count),
              clientID.utf8.allSatisfy({ $0 > 32 && $0 < 127 }), !admittedIssuerOrigins.isEmpty else {
            throw .notConfigured
        }
        for origin in admittedIssuerOrigins {
            do { try IssuerAdmission.validateOrigin(origin, loopback: loopback) } catch { throw .notConfigured }
        }
        self.clientID = clientID
        self.admittedIssuerOrigins = admittedIssuerOrigins
        self.loopback = loopback
        self.offlineAccess = offlineAccess
    }

    func admit(_ issuer: String) throws(SignInFailure) -> AdmittedIssuer {
        do { return try IssuerAdmission.admit(issuer: issuer, admittedOrigins: admittedIssuerOrigins, loopback: loopback) }
        catch { throw .untrustedIssuer }
    }
}

/// A signed-in session as the interface sees it. It carries no token.
public struct Session: Equatable, Sendable {
    public let issuer: String
    public let realm: String
}

public enum SignInFailure: Error, Equatable, Sendable {
    case notConfigured
    /// The issuer is not on an origin this build admits; nothing was opened.
    case untrustedIssuer
    case cancelled
    case inProgress
    /// The identity provider could not be reached, or no window could present the browser.
    case identityUnavailable
    /// The provider refused the request, or answered outside the protocol.
    case refused
    /// The session could not be written to the Keychain; nothing is kept.
    case storage
    /// The sign-in did not complete, and the grant it was to replace ended but could not be deleted from
    /// the Keychain. The caller makes the next launch wipe it before anything is restored.
    case sessionNotWiped
}

/// What the app asks of sign-in. The AppAuth implementation sits behind it, so the interface and the
/// tests never touch AppAuth.
public protocol SignInService: AccessTokenProvider {
    func signIn(issuer: String) async throws(SignInFailure) -> Session
    /// The session left in the Keychain by a previous launch, if it is still admissible. No network.
    func restore() async -> Session?
    /// Launch: `restore()`, then one silent forced refresh. A refused refresh (revoked, member removed,
    /// expired) has purged everything and yields nil, back to sign-in; an unreachable provider keeps the session.
    /// Throws when the refusal's wipe could not delete the stored copy.
    func resume() async throws(SessionNotWiped) -> Session?
    func freshAccessToken() async throws(AccessTokenFailure) -> String
    /// `listener` is told once for each session the service ends, with which session and why, and never for
    /// a call that ended nothing. It must not block. The paths it covers, and the wipes it does not report,
    /// are listed on `KoderaSignInService.addSessionEndedListener(_:)`.
    func addSessionEndedListener(_ listener: @escaping @Sendable (SessionEnded) -> Void) async
}

/// Why the sign-in service ended a session. The names match Android's `SessionEndCause`.
public enum SessionEndCause: Equatable, Sendable {
    /// The member's sign-out (`signOut()`), or the sign-in that took over one still waiting for a refresh.
    /// The only cause that revoked the grant at the provider.
    case explicitSignOut
    /// The provider refused a refresh.
    case refreshRefused
    /// Core refused a freshly refreshed token: its second 401 (`endSessionLocally(servedBy:)`).
    case endedByServer
    /// A sign-in replaced a session held in memory or a readable stored copy, before its browser opened.
    case replaced
    /// `restore()` found a stored copy it cannot use: unreadable, or for an issuer this build no longer admits.
    case unusableStoredCopy
    /// Any other end: a rotated grant the Keychain could not keep.
    case other
}

/// One ended session, as the session-ended listeners hear of it.
public struct SessionEnded: Equatable, Sendable {
    /// The ended session's identity: the `session` its access tokens carried (`AccessToken.session`), the
    /// generation the service fences on. Each ended session in one process has its own.
    public let session: UInt64
    public let cause: SessionEndCause

    public init(session: UInt64, cause: SessionEndCause) {
        self.session = session
        self.cause = cause
    }
}

extension SignInService {
    public func freshAccessToken() async throws(AccessTokenFailure) -> String {
        try await accessToken(forceRefresh: false).value
    }
}
