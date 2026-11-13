import Foundation

public enum MatrixInvitationError: Error, Equatable, Sendable {
    case emptyInput
    case exceedsMaximumLength
    case invalidCharacter
    case missingSigil
    case invalidLocalpart
    case invalidDomain
    case invalidPort
    case unsupportedScheme
    case unsupportedHost
    case authorityNotAllowed
    case unsupportedAction
    case missingRoomTarget
    case invalidViaServer
}

/// Validated federated Matrix server name (`hostname[:port]`).
/// Rejects single-label hosts, pure numeric hosts, trailing/leading dots or hyphens, and non-canonical ports.
public struct MatrixServerName: Equatable, Hashable, Sendable {
    public static let maximumLength = 253
    public let host: String
    public let port: UInt16?

    public var rawValue: String {
        if let port { return "\(host):\(port)" }
        return host
    }

    public init(_ raw: String) throws {
        guard !raw.isEmpty else { throw MatrixInvitationError.invalidDomain }
        guard raw.utf8.count <= Self.maximumLength + 6, Self.isVisibleASCII(raw) else {
            throw MatrixInvitationError.invalidDomain
        }
        let hostPart: String
        let portPart: UInt16?
        if let colonIndex = raw.firstIndex(of: ":") {
            hostPart = String(raw[..<colonIndex])
            let portText = String(raw[raw.index(after: colonIndex)...])
            guard !portText.isEmpty, portText.utf8.count <= 5,
                  let firstByte = portText.utf8.first, (49...57).contains(firstByte),
                  portText.utf8.allSatisfy({ (48...57).contains($0) }),
                  let parsedPort = UInt16(portText), parsedPort >= 1 else {
                throw MatrixInvitationError.invalidPort
            }
            portPart = parsedPort
        } else {
            hostPart = raw
            portPart = nil
        }

        let normalizedHost = hostPart.lowercased()
        guard TrustPolicy.validDNSName(normalizedHost) else {
            throw MatrixInvitationError.invalidDomain
        }
        self.host = normalizedHost
        self.port = portPart
    }

    fileprivate static func isVisibleASCII(_ value: String) -> Bool {
        value.utf8.allSatisfy { $0 >= 0x21 && $0 <= 0x7E }
    }
}

/// Validated Matrix User ID (`@localpart:domain`), bounded to 255 UTF-8 bytes per Matrix specification.
public struct MatrixUserId: Equatable, Hashable, Sendable {
    public static let maximumBytes = 255
    public let localpart: String
    public let serverName: MatrixServerName

    public var rawValue: String { "@\(localpart):\(serverName.rawValue)" }

    public init(_ raw: String) throws {
        guard !raw.isEmpty else { throw MatrixInvitationError.emptyInput }
        guard raw.utf8.count <= Self.maximumBytes else { throw MatrixInvitationError.exceedsMaximumLength }
        guard MatrixServerName.isVisibleASCII(raw) else { throw MatrixInvitationError.invalidCharacter }
        guard raw.hasPrefix("@") else { throw MatrixInvitationError.missingSigil }
        let remainder = raw.dropFirst()
        guard let colon = remainder.firstIndex(of: ":") else {
            throw MatrixInvitationError.invalidDomain
        }
        let local = String(remainder[..<colon])
        let domain = String(remainder[remainder.index(after: colon)...])
        guard !local.isEmpty, Self.isValidUserLocalpart(local) else {
            throw MatrixInvitationError.invalidLocalpart
        }
        let server = try MatrixServerName(domain)
        let normalized = "@\(local):\(server.rawValue)"
        guard normalized.utf8.count <= Self.maximumBytes else {
            throw MatrixInvitationError.exceedsMaximumLength
        }
        self.localpart = local
        self.serverName = server
    }

    /// Printable non-whitespace ASCII excluding `:` (`0x3A`), matching Web's `isMatrixUserId`.
    private static func isValidUserLocalpart(_ value: String) -> Bool {
        value.utf8.allSatisfy { ($0 >= 0x21 && $0 <= 0x39) || ($0 >= 0x3B && $0 <= 0x7E) }
    }
}

/// Validated canonical Matrix room alias (`#alias:domain`), bounded to 255 UTF-8 bytes.
public struct MatrixRoomAlias: Equatable, Hashable, Sendable {
    public static let maximumBytes = 255
    public let aliasLocalpart: String
    public let serverName: MatrixServerName

    public var rawValue: String { "#\(aliasLocalpart):\(serverName.rawValue)" }
    /// Path component without leading `#` for `matrix:r/<alias>:<domain>`.
    public var matrixURIPath: String { "\(aliasLocalpart):\(serverName.rawValue)" }

    public init(_ raw: String) throws {
        guard !raw.isEmpty else { throw MatrixInvitationError.emptyInput }
        guard raw.utf8.count <= Self.maximumBytes else { throw MatrixInvitationError.exceedsMaximumLength }
        guard MatrixServerName.isVisibleASCII(raw) else { throw MatrixInvitationError.invalidCharacter }
        guard raw.hasPrefix("#") else { throw MatrixInvitationError.missingSigil }
        let remainder = raw.dropFirst()
        guard let colon = remainder.firstIndex(of: ":") else {
            throw MatrixInvitationError.invalidDomain
        }
        let local = String(remainder[..<colon])
        let domain = String(remainder[remainder.index(after: colon)...])
        guard !local.isEmpty, Self.isValidAliasLocalpart(local) else {
            throw MatrixInvitationError.invalidLocalpart
        }
        let server = try MatrixServerName(domain)
        let normalized = "#\(local):\(server.rawValue)"
        guard normalized.utf8.count <= Self.maximumBytes else {
            throw MatrixInvitationError.exceedsMaximumLength
        }
        self.aliasLocalpart = local
        self.serverName = server
    }

    public static func suggested(channelSlug: String, serverName: MatrixServerName) throws -> MatrixRoomAlias {
        let slug = channelSlug
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: "-")
        return try MatrixRoomAlias("#\(slug):\(serverName.rawValue)")
    }

    private static func isValidAliasLocalpart(_ value: String) -> Bool {
        value.utf8.allSatisfy { byte in
            byte >= 0x21 && byte <= 0x7E
                && byte != 0x3A // ':'
                && byte != 0x23 // '#'
                && byte != 0x2F // '/'
                && byte != 0x3F // '?'
                && byte != 0x26 // '&'
        }
    }
}

/// Validated Matrix room identifier (`!opaque:domain`), bounded to 255 UTF-8 bytes.
public struct MatrixRoomId: Equatable, Hashable, Sendable {
    public static let maximumBytes = 255
    public let opaqueId: String
    public let serverName: MatrixServerName

    public var rawValue: String { "!\(opaqueId):\(serverName.rawValue)" }
    public var matrixURIPath: String { "\(opaqueId):\(serverName.rawValue)" }

    public init(_ raw: String) throws {
        guard !raw.isEmpty else { throw MatrixInvitationError.emptyInput }
        guard raw.utf8.count <= Self.maximumBytes else { throw MatrixInvitationError.exceedsMaximumLength }
        guard MatrixServerName.isVisibleASCII(raw) else { throw MatrixInvitationError.invalidCharacter }
        guard raw.hasPrefix("!") else { throw MatrixInvitationError.missingSigil }
        let remainder = raw.dropFirst()
        guard let colon = remainder.firstIndex(of: ":") else {
            throw MatrixInvitationError.invalidDomain
        }
        let opaque = String(remainder[..<colon])
        let domain = String(remainder[remainder.index(after: colon)...])
        guard !opaque.isEmpty, Self.isValidOpaqueId(opaque) else {
            throw MatrixInvitationError.invalidLocalpart
        }
        let server = try MatrixServerName(domain)
        let normalized = "!\(opaque):\(server.rawValue)"
        guard normalized.utf8.count <= Self.maximumBytes else {
            throw MatrixInvitationError.exceedsMaximumLength
        }
        self.opaqueId = opaque
        self.serverName = server
    }

    private static func isValidOpaqueId(_ value: String) -> Bool {
        value.utf8.allSatisfy { byte in
            (byte >= 0x30 && byte <= 0x39)
                || (byte >= 0x41 && byte <= 0x5A)
                || (byte >= 0x61 && byte <= 0x7A)
                || byte == 0x2D || byte == 0x2E || byte == 0x5F || byte == 0x3D
        }
    }
}

public enum MatrixInvitationTarget: Equatable, Sendable {
    case roomAlias(MatrixRoomAlias, via: [MatrixServerName])
    case roomID(MatrixRoomId, suggestedAlias: MatrixRoomAlias?, via: [MatrixServerName])
    case directUser(MatrixUserId)
}

/// Universal Matrix invitation URI builder and parser supporting:
/// - `https://matrix.to/#/...`
/// - `matrix:r/<alias>:<domain>?action=join` (and `matrix:roomid/...`, `matrix:u/...`)
/// - Canonical `#alias:domain`
/// - Direct `@user:domain`
public struct UniversalMatrixInvitation: Equatable, Sendable {
    public static let maximumURIBytes = 1024
    public let target: MatrixInvitationTarget

    public init(target: MatrixInvitationTarget) {
        self.target = target
    }

    public static func forRoomAlias(_ alias: MatrixRoomAlias, via: [MatrixServerName] = []) -> Self {
        var uniqueVia: [MatrixServerName] = []
        for server in via where !uniqueVia.contains(server) { uniqueVia.append(server) }
        return Self(target: .roomAlias(alias, via: uniqueVia))
    }

    public static func forRoom(
        roomId: MatrixRoomId,
        canonicalAlias: MatrixRoomAlias?,
        channelSlug: String,
        serverName: MatrixServerName
    ) throws -> Self {
        if let canonicalAlias {
            return .forRoomAlias(canonicalAlias, via: [serverName])
        }
        let suggested = try MatrixRoomAlias.suggested(channelSlug: channelSlug, serverName: serverName)
        return Self(target: .roomID(roomId, suggestedAlias: suggested, via: [serverName]))
    }

    public static func forDirectUser(_ userId: MatrixUserId) -> Self {
        Self(target: .directUser(userId))
    }

    public var canonicalIdentifier: String {
        switch target {
        case let .roomAlias(alias, _): alias.rawValue
        case let .roomID(roomId, _, _): roomId.rawValue
        case let .directUser(userId): userId.rawValue
        }
    }

    public var displayAlias: String? {
        switch target {
        case let .roomAlias(alias, _): alias.rawValue
        case let .roomID(_, suggested, _): suggested?.rawValue
        case .directUser: nil
        }
    }

    public var isSuggestedAlias: Bool {
        if case .roomID = target { return true }
        return false
    }

    public var viaServers: [MatrixServerName] {
        switch target {
        case let .roomAlias(_, via), let .roomID(_, _, via): via
        case .directUser: []
        }
    }

    public var matrixToURLString: String {
        let encodedIdentifier = Self.encodeComponent(canonicalIdentifier)
        let viaQuery = viaServers.map { "via=\(Self.encodeComponent($0.rawValue))" }.joined(separator: "&")
        if viaQuery.isEmpty {
            return "https://matrix.to/#/\(encodedIdentifier)"
        }
        return "https://matrix.to/#/\(encodedIdentifier)?\(viaQuery)"
    }

    public var matrixURIString: String {
        switch target {
        case let .roomAlias(alias, via):
            let path = Self.encodeMatrixPath(alias.matrixURIPath)
            let suffix = via.map { "&via=\(Self.encodeComponent($0.rawValue))" }.joined()
            return "matrix:r/\(path)?action=join\(suffix)"
        case let .roomID(roomId, _, via):
            let path = Self.encodeMatrixPath(roomId.matrixURIPath)
            let suffix = via.map { "&via=\(Self.encodeComponent($0.rawValue))" }.joined()
            return "matrix:roomid/\(path)?action=join\(suffix)"
        case let .directUser(userId):
            let path = Self.encodeMatrixPath("\(userId.localpart):\(userId.serverName.rawValue)")
            return "matrix:u/\(path)?action=chat"
        }
    }

    public static func parse(_ raw: String) throws -> UniversalMatrixInvitation {
        guard !raw.isEmpty else { throw MatrixInvitationError.emptyInput }
        guard raw.utf8.count <= maximumURIBytes else { throw MatrixInvitationError.exceedsMaximumLength }
        guard MatrixServerName.isVisibleASCII(raw) else { throw MatrixInvitationError.invalidCharacter }

        if raw.hasPrefix("#") {
            return .forRoomAlias(try MatrixRoomAlias(raw))
        }
        if raw.hasPrefix("@") {
            return .forDirectUser(try MatrixUserId(raw))
        }
        if raw.hasPrefix("https://") || raw.hasPrefix("http://") {
            return try parseMatrixTo(raw)
        }
        if raw.hasPrefix("matrix:") {
            return try parseMatrixScheme(raw)
        }
        throw MatrixInvitationError.unsupportedScheme
    }

    private static func parseMatrixTo(_ raw: String) throws -> UniversalMatrixInvitation {
        guard raw.hasPrefix("https://matrix.to/#/") else {
            if raw.hasPrefix("http://") { throw MatrixInvitationError.unsupportedScheme }
            throw MatrixInvitationError.unsupportedHost
        }
        let fragment = String(raw.dropFirst("https://matrix.to/#/".count))
        guard !fragment.isEmpty else { throw MatrixInvitationError.missingRoomTarget }

        let targetPart: String
        let queryPart: String?
        if let question = fragment.firstIndex(of: "?") {
            targetPart = String(fragment[..<question])
            queryPart = String(fragment[fragment.index(after: question)...])
        } else {
            targetPart = fragment
            queryPart = nil
        }
        guard !targetPart.isEmpty, let decodedTarget = targetPart.removingPercentEncoding,
              !decodedTarget.isEmpty else {
            throw MatrixInvitationError.missingRoomTarget
        }
        let via = try parseQueryViaAndAction(queryPart, expectedAction: nil)
        if decodedTarget.hasPrefix("#") {
            return .forRoomAlias(try MatrixRoomAlias(decodedTarget), via: via)
        }
        if decodedTarget.hasPrefix("!") {
            return Self(target: .roomID(try MatrixRoomId(decodedTarget), suggestedAlias: nil, via: via))
        }
        if decodedTarget.hasPrefix("@") {
            guard via.isEmpty else { throw MatrixInvitationError.invalidViaServer }
            return .forDirectUser(try MatrixUserId(decodedTarget))
        }
        throw MatrixInvitationError.missingSigil
    }

    private static func parseMatrixScheme(_ raw: String) throws -> UniversalMatrixInvitation {
        let remainder = String(raw.dropFirst("matrix:".count))
        guard !remainder.hasPrefix("/") else {
            throw MatrixInvitationError.authorityNotAllowed
        }
        let pathPart: String
        let queryPart: String?
        if let question = remainder.firstIndex(of: "?") {
            pathPart = String(remainder[..<question])
            queryPart = String(remainder[remainder.index(after: question)...])
        } else {
            pathPart = remainder
            queryPart = nil
        }

        if pathPart.hasPrefix("r/") {
            let encoded = String(pathPart.dropFirst(2))
            guard !encoded.isEmpty, !encoded.contains("/"),
                  let decoded = encoded.removingPercentEncoding else {
                throw MatrixInvitationError.missingRoomTarget
            }
            let via = try parseQueryViaAndAction(queryPart, expectedAction: "join")
            return .forRoomAlias(try MatrixRoomAlias("#" + decoded), via: via)
        }
        if pathPart.hasPrefix("roomid/") {
            let encoded = String(pathPart.dropFirst("roomid/".count))
            guard !encoded.isEmpty, !encoded.contains("/"),
                  let decoded = encoded.removingPercentEncoding else {
                throw MatrixInvitationError.missingRoomTarget
            }
            let via = try parseQueryViaAndAction(queryPart, expectedAction: "join")
            return Self(target: .roomID(try MatrixRoomId("!" + decoded), suggestedAlias: nil, via: via))
        }
        if pathPart.hasPrefix("u/") {
            let encoded = String(pathPart.dropFirst(2))
            guard !encoded.isEmpty, !encoded.contains("/"),
                  let decoded = encoded.removingPercentEncoding else {
                throw MatrixInvitationError.missingRoomTarget
            }
            let via = try parseQueryViaAndAction(queryPart, expectedAction: "chat")
            guard via.isEmpty else { throw MatrixInvitationError.invalidViaServer }
            return .forDirectUser(try MatrixUserId("@" + decoded))
        }
        throw MatrixInvitationError.missingRoomTarget
    }

    private static func parseQueryViaAndAction(_ query: String?, expectedAction: String?) throws -> [MatrixServerName] {
        guard let query, !query.isEmpty else { return [] }
        var via: [MatrixServerName] = []
        for pair in query.split(separator: "&", omittingEmptySubsequences: false) {
            guard let equals = pair.firstIndex(of: "=") else {
                throw MatrixInvitationError.unsupportedAction
            }
            let key = String(pair[..<equals])
            let rawValue = String(pair[pair.index(after: equals)...])
            guard let value = rawValue.removingPercentEncoding, !value.isEmpty else {
                throw MatrixInvitationError.unsupportedAction
            }
            switch key {
            case "action":
                guard let expectedAction, value == expectedAction else {
                    throw MatrixInvitationError.unsupportedAction
                }
            case "via":
                let server: MatrixServerName
                do {
                    server = try MatrixServerName(value)
                } catch {
                    throw MatrixInvitationError.invalidViaServer
                }
                if !via.contains(server) { via.append(server) }
            default:
                throw MatrixInvitationError.unsupportedAction
            }
        }
        return via
    }

    private static func encodeComponent(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    /// Encodes localpart/server characters while keeping `:` unescaped per MSC2312 (`matrix:r/alias:domain`).
    private static func encodeMatrixPath(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~:")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}
