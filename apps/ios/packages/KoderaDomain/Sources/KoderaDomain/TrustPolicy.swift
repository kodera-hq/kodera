import Foundation

public enum DomainError: Error, Equatable, Sendable {
    case invalidOrigin, untrustedIssuer, invalidOrganisation, invalidSlug, mismatchedRealm
    case mismatchedWellKnown, unsupportedContract, unsupportedReadiness, selectionRequired
    case mismatchedOrganisation, untrustedProvenance, callbackMismatch, unsupportedSubject
    case identityMismatch, staleGeneration, invalidChannel
}
public enum UnavailabilityReason: Equatable, Sendable {
    case notConfigured, unsupportedContract, serviceUnavailable, identityRequired, forbidden
}
public enum ServiceReadiness: Equatable, Sendable {
    case unavailable(UnavailabilityReason), pending, ready, unknown
}
/// Protected anonymous metadata trust; no identity client, callback or membership assertion.
/// Its origins go through `IssuerAdmission.validateOrigin`, the validator sign-in uses: HTTPS, or the exact
/// loopback forms when a development build passes `.admitForDevelopment`.
public struct DiscoveryTrust: Equatable, Sendable {
    public let coreApiOrigin: String
    public let admittedIssuerOrigins: Set<String>
    public let loopback: LoopbackPolicy
    public init(coreApiOrigin: String, admittedIssuerOrigins: Set<String>, loopback: LoopbackPolicy = .refuse) {
        self.coreApiOrigin = coreApiOrigin
        self.admittedIssuerOrigins = admittedIssuerOrigins
        self.loopback = loopback
    }
}
public struct EnvironmentTrust: Equatable, Sendable {
    public let coreApiOrigin: String
    public let admittedIssuerOrigins: Set<String>
    public let nativeClientId: String
    public let redirectUri: String
    public let matrixRedirectUri: String
    public init(coreApiOrigin: String, admittedIssuerOrigins: Set<String>, nativeClientId: String,
                redirectUri: String, matrixRedirectUri: String) {
        self.coreApiOrigin = coreApiOrigin; self.admittedIssuerOrigins = admittedIssuerOrigins
        self.nativeClientId = nativeClientId; self.redirectUri = redirectUri; self.matrixRedirectUri = matrixRedirectUri
    }
}
public struct DiscoverySelection: Equatable, Sendable {
    public let organisationId: String
    public let organisationSlug: String
    public let realm: String
    public let issuer: String
    public let openidConfigurationUrl: String
    public init(organisationId: String, organisationSlug: String, realm: String, issuer: String,
                openidConfigurationUrl: String) {
        self.organisationId = organisationId; self.organisationSlug = organisationSlug; self.realm = realm
        self.issuer = issuer; self.openidConfigurationUrl = openidConfigurationUrl
    }
}
public struct CollaborationDescriptor: Equatable, Sendable {
    public let schemaVersion: Int?
    public let organisationId: String
    public let matrixServerName: String
    public let homeserverOrigin: String
    public let roomAccessOrigin: String
    public let readiness: ServiceReadiness?
    public init(schemaVersion: Int?, organisationId: String, matrixServerName: String,
                homeserverOrigin: String, roomAccessOrigin: String, readiness: ServiceReadiness?) {
        self.schemaVersion = schemaVersion; self.organisationId = organisationId
        self.matrixServerName = matrixServerName; self.homeserverOrigin = homeserverOrigin
        self.roomAccessOrigin = roomAccessOrigin; self.readiness = readiness
    }
}
/// Local adapter assertion only: this value does not verify a request, signature or membership.
public enum DescriptorProvenance: Equatable, Sendable {
    case unverified
    case authenticatedCore(origin: String, organisationId: String, issuer: String, subject: String)
}
public enum CallbackHop: Sendable { case core, matrix }
public struct ValidatedDiscovery: Equatable, Sendable {
    public let selection: DiscoverySelection
}
public struct ValidatedDescriptor: Equatable, Sendable {
    public let descriptor: CollaborationDescriptor
    public let coreIdentity: CoreIdentity
    public let readiness: ServiceReadiness
    public var canAttemptConnection: Bool { readiness == .ready }
}
/// Validates local contract values, never authentication, remote authority or reachability.
public enum TrustPolicy {
    /// Narrow raw-string profile: inspect before any Foundation URL normalization.
    public static func validateOrigin(_ value: String) throws {
        guard value.hasPrefix("https://"), isVisibleASCII(value) else { throw DomainError.invalidOrigin }
        var host = String(value.dropFirst(8))
        if host.hasSuffix("/") { host.removeLast() }
        guard validDNSName(host) else { throw DomainError.invalidOrigin }
    }

    /// Validates anonymous metadata against protected origins, never identity or membership.
    public static func validateDiscovery(_ value: DiscoverySelection, trust: DiscoveryTrust)
        throws -> ValidatedDiscovery {
        try IssuerAdmission.validateOrigin(trust.coreApiOrigin, loopback: trust.loopback)
        guard canonicalNonNilUUID(value.organisationId) else { throw DomainError.invalidOrganisation }
        guard canonicalSlug(value.organisationSlug) else { throw DomainError.invalidSlug }
        guard value.realm == value.organisationSlug else { throw DomainError.mismatchedRealm }
        for origin in trust.admittedIssuerOrigins { try IssuerAdmission.validateOrigin(origin, loopback: trust.loopback) }
        // The one issuer check sign-in runs too: exactly a configured origin plus `/realms/{slug}`, by raw
        // comparison, so encoded paths, ports, suffixes and controls never match. A discovered issuer outside
        // the configured origins, or a loopback one in a build that refuses loopback, stops here, before any
        // browser can open.
        let admitted = try IssuerAdmission.admit(issuer: value.issuer, admittedOrigins: trust.admittedIssuerOrigins,
                                                 loopback: trust.loopback)
        guard admitted.realm == value.realm else { throw DomainError.untrustedIssuer }
        guard value.openidConfigurationUrl == value.issuer + "/.well-known/openid-configuration" else {
            throw DomainError.mismatchedWellKnown
        }
        return ValidatedDiscovery(selection: value)
    }

    public static func validateDiscovery(_ value: DiscoverySelection, environment: EnvironmentTrust)
        throws -> ValidatedDiscovery {
        // Preserve the original full-profile origin/client guard and its error order.
        try validateOrigin(environment.coreApiOrigin)
        guard !environment.nativeClientId.isEmpty, isVisibleASCII(environment.nativeClientId) else {
            throw DomainError.unsupportedContract
        }
        return try validateDiscovery(value, trust: DiscoveryTrust(
            coreApiOrigin: environment.coreApiOrigin, admittedIssuerOrigins: environment.admittedIssuerOrigins
        ))
    }

    public static func selectDiscovery(_ values: [DiscoverySelection], selectedOrganisationId: String?,
                                      environment: EnvironmentTrust) throws -> ValidatedDiscovery? {
        let candidates = try values.map { try validateDiscovery($0, environment: environment) }
        if let selectedOrganisationId {
            let matches = candidates.filter { $0.selection.organisationId == selectedOrganisationId }
            guard matches.count == 1 else { throw DomainError.selectionRequired }
            return matches[0]
        }
        guard candidates.count <= 1 else { throw DomainError.selectionRequired }
        return candidates.first
    }

    public static func validateDescriptor(_ value: CollaborationDescriptor, discovery: ValidatedDiscovery,
        coreIdentity: CoreIdentity, environment: EnvironmentTrust, provenance: DescriptorProvenance)
        throws -> ValidatedDescriptor {
        _ = try validateDiscovery(discovery.selection, environment: environment)
        guard value.schemaVersion == 1 else { throw DomainError.unsupportedContract }
        guard coreIdentity.organisationId == discovery.selection.organisationId,
              value.organisationId == coreIdentity.organisationId,
              coreIdentity.issuer == discovery.selection.issuer else { throw DomainError.mismatchedOrganisation }
        guard !coreIdentity.subject.isEmpty, isVisibleASCII(coreIdentity.subject) else {
            throw DomainError.unsupportedSubject
        }
        guard case let .authenticatedCore(origin, organisationId, issuer, subject) = provenance,
              origin == environment.coreApiOrigin, organisationId == coreIdentity.organisationId,
              issuer == coreIdentity.issuer, subject == coreIdentity.subject else {
            throw DomainError.untrustedProvenance
        }
        try validateOrigin(value.homeserverOrigin)
        try validateOrigin(value.roomAccessOrigin)
        guard validDNSName(value.matrixServerName) else { throw DomainError.invalidOrigin }
        guard let readiness = value.readiness, readiness != .unknown else {
            throw DomainError.unsupportedReadiness
        }
        return ValidatedDescriptor(descriptor: value, coreIdentity: coreIdentity, readiness: readiness)
    }

    /// Compares registered callback profiles only; response queries/PKCE/state need a trusted adapter.
    public static func validateCallback(_ value: String, hop: CallbackHop, environment: EnvironmentTrust)
        throws {
        let expected: String
        switch hop {
        case .core: expected = environment.redirectUri
        case .matrix: expected = environment.matrixRedirectUri
        }
        guard value == expected, environment.redirectUri != environment.matrixRedirectUri,
              isVisibleASCII(value), !value.contains("%"), !value.contains("\\"),
              let components = URLComponents(string: value), let scheme = components.scheme,
              !scheme.isEmpty, scheme == scheme.lowercased(), scheme != "http",
              scheme != "file", scheme != "javascript", scheme != "data",
              components.user == nil, components.password == nil, components.port == nil,
              components.query == nil, components.fragment == nil,
              components.path.hasPrefix("/"), !components.path.isEmpty else {
            throw DomainError.callbackMismatch
        }
        if scheme == "https" {
            guard let host = components.host, validDNSName(host) else { throw DomainError.callbackMismatch }
        }
    }

    static func isVisibleASCII(_ value: String) -> Bool {
        value.utf8.allSatisfy { $0 > 32 && $0 < 127 }
    }

    /// Entity and session correlation identifiers cannot use the nil UUID namespace.
    public static func canonicalNonNilUUID(_ value: String) -> Bool {
        canonicalUUID(value) && value != "00000000-0000-0000-0000-000000000000"
    }

    public static func canonicalUUID(_ value: String) -> Bool {
        guard value.utf8.count == 36 else { return false }
        for (index, byte) in value.utf8.enumerated() {
            if [8, 13, 18, 23].contains(index) {
                if byte != 45 { return false }
            } else if !(48...57).contains(byte) && !(97...102).contains(byte) { return false }
        }
        return true
    }

    public static func canonicalSlug(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard (5...20).contains(bytes.count), let first = bytes.first,
              (97...122).contains(first) || (48...57).contains(first),
              let last = bytes.last, (97...122).contains(last) || (48...57).contains(last) else { return false }
        return bytes.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
    }

    public static func validDNSName(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard !bytes.isEmpty, bytes.count <= 253,
              bytes.contains(where: { (97...122).contains($0) }) else { return false }
        let labels = value.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2 else { return false }
        // Legacy IPv4 components may mix decimal/octal digits and explicit hexadecimal.
        // Reject their numeric-host shape without parsing or normalizing it into an address.
        let numericHost = labels.allSatisfy { label in
            if label.hasPrefix("0x") {
                let digits = label.dropFirst(2).utf8
                return !digits.isEmpty && digits.allSatisfy {
                    (48...57).contains($0) || (97...102).contains($0)
                }
            }
            return !label.isEmpty && label.utf8.allSatisfy { (48...57).contains($0) }
        }
        guard !numericHost else { return false }
        return labels.allSatisfy { label in
            let bytes = Array(label.utf8)
            guard (1...63).contains(bytes.count), let first = bytes.first, let last = bytes.last,
                  first != 45, last != 45 else { return false }
            return bytes.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
        }
    }
}
