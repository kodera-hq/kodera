import Foundation

/// Whether a plain-HTTP loopback origin may be configured. Only a development build passes
/// `.admitForDevelopment`; the decision is compiled into the app, never read from configuration.
public enum LoopbackPolicy: Equatable, Sendable {
    case refuse, admitForDevelopment
}

/// An issuer that exactly equals one configured origin plus `/realms/{slug}`.
/// Only `IssuerAdmission.admit` creates one; holding it proves nothing about identity or membership.
public struct AdmittedIssuer: Equatable, Sendable {
    public let issuer: String
    public let origin: String
    public let realm: String
}

/// The trust check in front of every browser sign-in: the realm issuer must sit on an origin the
/// protected build configuration admits. Form text, deep links and responses cannot widen it.
public enum IssuerAdmission {
    /// HTTPS origins follow `TrustPolicy.validateOrigin`. With `.admitForDevelopment`, the exact forms
    /// `http://localhost:PORT` and `http://127.0.0.1:PORT` are also accepted, and nothing else over HTTP.
    public static func validateOrigin(_ value: String, loopback: LoopbackPolicy) throws {
        if value.hasPrefix("https://") {
            try TrustPolicy.validateOrigin(value)
            guard !value.hasSuffix("/") else { throw DomainError.invalidOrigin }
            return
        }
        guard loopback == .admitForDevelopment, isLoopbackDevelopmentOrigin(value) else {
            throw DomainError.invalidOrigin
        }
    }

    public static func admit(issuer: String, admittedOrigins: Set<String>, loopback: LoopbackPolicy)
        throws -> AdmittedIssuer {
        guard !admittedOrigins.isEmpty else { throw DomainError.untrustedIssuer }
        for origin in admittedOrigins { try validateOrigin(origin, loopback: loopback) }
        // Exact raw comparison: no URL normalisation, so encoded paths, ports, user info,
        // trailing segments and case variants never match.
        for origin in admittedOrigins.sorted() {
            let prefix = origin + "/realms/"
            guard issuer.hasPrefix(prefix) else { continue }
            let realm = String(issuer.dropFirst(prefix.count))
            guard TrustPolicy.canonicalSlug(realm) else { throw DomainError.untrustedIssuer }
            return AdmittedIssuer(issuer: issuer, origin: origin, realm: realm)
        }
        throw DomainError.untrustedIssuer
    }

    /// True when `url` has the same scheme, host and port as the admitted issuer's origin.
    /// Tokens and refresh tokens are only ever sent to such an endpoint.
    public static func sharesOrigin(_ url: String, with issuer: AdmittedIssuer) -> Bool {
        guard url.hasPrefix(issuer.origin + "/"), TrustPolicy.isVisibleASCII(url),
              !url.contains("\\"), !url.contains("@") else { return false }
        return true
    }

    static func isLoopbackDevelopmentOrigin(_ value: String) -> Bool {
        for host in ["http://localhost:", "http://127.0.0.1:"] where value.hasPrefix(host) {
            let port = Array(value.dropFirst(host.count).utf8)
            guard (1...5).contains(port.count), port.allSatisfy({ (48...57).contains($0) }),
                  port.first != 48, let number = Int(String(decoding: port, as: UTF8.self)),
                  (1...65_535).contains(number) else { return false }
            return true
        }
        return false
    }
}
