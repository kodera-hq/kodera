import Foundation

public enum DocsWorkspaceError: Error, Equatable, Sendable {
    case invalidScope, invalidPad, invalidURL, invalidPads, unavailable, stopped, staleContext
}

/// Context for local metadata only; it grants no collaborative document access.
public struct DocsWorkspaceScope: Equatable, Sendable {
    public let organisationId: String
    public let channelId: String
    public init(organisationId: String, channelId: String) throws {
        guard TrustPolicy.canonicalNonNilUUID(organisationId), Self.boundedText(channelId) else {
            throw DocsWorkspaceError.invalidScope
        }
        self.organisationId = organisationId
        self.channelId = channelId
    }
    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.organisationId == rhs.organisationId && lhs.channelId.utf8.elementsEqual(rhs.channelId.utf8)
    }
    static func boundedText(_ value: String) -> Bool {
        (1...255).contains(value.utf8.count)
            && value == value.trimmingCharacters(in: .whitespacesAndNewlines)
            && !value.unicodeScalars.contains {
                CharacterSet.controlCharacters.contains($0) || $0.properties.generalCategory == .format
                    || $0.value == 0x2028 || $0.value == 0x2029
            }
    }
}

/// Canonical public HTTPS metadata policy, separate from identity-provider trust.
/// No DNS lookup is performed, and a syntactically public host is not a trusted Docs deployment.
public enum DocsPadURLPolicy {
    public static func validate(_ url: URL) throws {
        let raw = url.absoluteString
        guard url.baseURL == nil, raw.utf8.count <= 2048, raw.hasPrefix("https://"),
              TrustPolicy.isVisibleASCII(raw),
              !raw.contains("%"), !raw.contains("\\"), !raw.contains("@"),
              !raw.contains("?"), !raw.contains("#"),
              let components = URLComponents(string: raw), components.scheme == "https",
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.port == nil || components.port == 443,
              let host = components.host, host == host.lowercased(), TrustPolicy.validDNSName(host),
              host != "localhost", !host.hasSuffix(".localhost"),
              !host.hasSuffix(".local"), !host.hasSuffix(".internal"),
              let tld = host.split(separator: ".").last, tld.count >= 2,
              tld.utf8.allSatisfy({ (97...122).contains($0) }) else {
            throw DocsWorkspaceError.invalidURL
        }
        // Exact authority refuses empty ports, numeric alternate ports and parser-normalized hosts.
        let remainder = raw.dropFirst("https://".count)
        guard let slash = remainder.firstIndex(of: "/") else { throw DocsWorkspaceError.invalidURL }
        let authority = String(remainder[..<slash])
        let path = String(remainder[slash...])
        guard authority == host || authority == host + ":443",
              path.count > 1, !path.contains("//"),
              !path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }),
              path.utf8.allSatisfy({ byte in
                  (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte)
                      || [45, 46, 47, 95, 126].contains(byte)
              }), components.percentEncodedPath == path else { throw DocsWorkspaceError.invalidURL }
    }
}

/// Preview metadata is not proof that a document exists, is current, or is accessible to the member.
public struct DocsPadSummary: Equatable, Sendable {
    public let id: String
    public let title: String
    public let padURL: URL
    public static let maximumIDBytes = 128
    public let updatedAtEpochSeconds: UInt64
    public init(id: String, title: String, padURL: URL, updatedAtEpochSeconds: UInt64) throws {
        guard (1...Self.maximumIDBytes).contains(id.utf8.count), TrustPolicy.isVisibleASCII(id),
              DocsWorkspaceScope.boundedText(title) else { throw DocsWorkspaceError.invalidPad }
        try DocsPadURLPolicy.validate(padURL)
        self.id = id
        self.title = title
        self.padURL = padURL
        self.updatedAtEpochSeconds = updatedAtEpochSeconds
    }
}

public struct DocsWorkspaceState: Equatable, Sendable {
    public enum Availability: Equatable, Sendable { case unprovisioned, localPreviewOnly, stopped }
    public static let maximumPads = 32
    public private(set) var scope: DocsWorkspaceScope?
    public private(set) var availability: Availability = .unprovisioned
    public private(set) var pads: [DocsPadSummary] = []
    public init() {}

    public mutating func configure(_ scope: DocsWorkspaceScope?) throws {
        guard availability != .stopped else { throw DocsWorkspaceError.stopped }
        clear()
        self.scope = scope
    }
    public mutating func beginLocalPreview(scope: DocsWorkspaceScope, pads: [DocsPadSummary]) throws {
        guard availability != .stopped else { throw DocsWorkspaceError.stopped }
        let validated = try Self.validatedPads(pads)
        clear()
        self.scope = scope
        self.pads = validated
        availability = .localPreviewOnly
    }
    public mutating func replacePads(_ pads: [DocsPadSummary]) throws {
        guard availability == .localPreviewOnly else { throw DocsWorkspaceError.unavailable }
        self.pads = try Self.validatedPads(pads)
    }
    /// Logical teardown; a stopped reducer cannot be revived by clear or leave.
    public mutating func clear() {
        scope = nil; pads = []
        if availability != .stopped { availability = .unprovisioned }
    }
    public mutating func leave() { clear() }
    public mutating func stop() { clear(); availability = .stopped }
    private static func validatedPads(_ pads: [DocsPadSummary]) throws -> [DocsPadSummary] {
        guard (1...maximumPads).contains(pads.count), Set(pads.map(\.id)).count == pads.count else {
            throw DocsWorkspaceError.invalidPads
        }
        return pads.sorted {
            $0.updatedAtEpochSeconds == $1.updatedAtEpochSeconds
                ? $0.id.utf8.lexicographicallyPrecedes($1.id.utf8)
                : $0.updatedAtEpochSeconds > $1.updatedAtEpochSeconds
        }
    }
}
