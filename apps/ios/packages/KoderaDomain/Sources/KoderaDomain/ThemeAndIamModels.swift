import Foundation

public enum WorkspacePreferencesError: Error, Equatable, Sendable {
    case invalidTheme, invalidProfile, invalidPolicy, invalidDocument, revisionOverflow, unavailable, staleContext, stopped
}

public enum KoderaThemeMode: String, Codable, CaseIterable, Sendable {
    case light, dark, black
    public static let monogramBackgroundHex = "#000000"
}

private func admittedText(_ value: String, bytes: Int, optional: Bool = false) -> Bool {
    (optional || !value.isEmpty) && value.utf8.count <= bytes
        && value == value.trimmingCharacters(in: .whitespacesAndNewlines)
        && !value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) || $0.properties.generalCategory == .format || $0.value == 0x2028 || $0.value == 0x2029 }
}

private func admittedUUID(_ value: String) -> Bool {
    value.utf8.count == 36 && value != "00000000-0000-0000-0000-000000000000" && TrustPolicy.canonicalUUID(value)
}

/// Same escaping as `kodera-rs` `quoted`, so exported front matter is byte-identical across platforms.
private func quoted(_ value: String) -> String {
    var result = "\""
    for scalar in value.unicodeScalars {
        switch scalar {
        case "\"": result += "\\\""
        case "\\": result += "\\\\"
        case "\n": result += "\\n"
        case "\r": result += "\\r"
        case "\t": result += "\\t"
        default:
            if scalar.properties.generalCategory == .control {
                result += String(format: "\\u%04x", scalar.value)
            } else {
                result.unicodeScalars.append(scalar)
            }
        }
    }
    return result + "\""
}

/// A text field keeps its previous value when an edit would exceed its byte bound:
/// the extra keystroke or paste is refused, and what the person already typed is kept.
public enum BoundedTextInput {
    public static func admitting(_ proposed: String, previous: String, maximumBytes: Int) -> String {
        proposed.utf8.count <= maximumBytes ? proposed : previous
    }
}

public struct ThemeRGB: Equatable, Sendable {
    public let red: UInt8, green: UInt8, blue: UInt8
    public init(_ value: String) throws {
        guard value.utf8.count <= 18, value.hasPrefix("rgb("), value.hasSuffix(")") else { throw WorkspacePreferencesError.invalidTheme }
        let pieces = value.dropFirst(4).dropLast().components(separatedBy: ", ")
        guard pieces.count == 3, pieces.allSatisfy({
            !$0.isEmpty && $0.utf8.allSatisfy { (48...57).contains($0) } && ($0 == "0" || !$0.hasPrefix("0"))
        }), let r = UInt8(pieces[0]), let g = UInt8(pieces[1]), let b = UInt8(pieces[2]) else { throw WorkspacePreferencesError.invalidTheme }
        red = r; green = g; blue = b
    }
    fileprivate init(red: UInt8, green: UInt8, blue: UInt8) {
        self.red = red; self.green = green; self.blue = blue
    }
    fileprivate var cssLiteral: String { "rgb(\(red), \(green), \(blue))" }
}

public struct ShareableThemeTokens: Equatable, Sendable {
    public let page: String, surface: String, sunken: String, action: String, ink: String
    public let pageRGB: ThemeRGB, surfaceRGB: ThemeRGB, sunkenRGB: ThemeRGB, actionRGB: ThemeRGB, inkRGB: ThemeRGB
    public init(page: String, surface: String, sunken: String, action: String, ink: String) throws {
        pageRGB = try ThemeRGB(page); surfaceRGB = try ThemeRGB(surface); sunkenRGB = try ThemeRGB(sunken)
        actionRGB = try ThemeRGB(action); inkRGB = try ThemeRGB(ink)
        self.page = page; self.surface = surface; self.sunken = sunken; self.action = action; self.ink = ink
    }
    fileprivate init(pageRGB: ThemeRGB, surfaceRGB: ThemeRGB, sunkenRGB: ThemeRGB, actionRGB: ThemeRGB, inkRGB: ThemeRGB) {
        self.pageRGB = pageRGB; self.surfaceRGB = surfaceRGB; self.sunkenRGB = sunkenRGB
        self.actionRGB = actionRGB; self.inkRGB = inkRGB
        self.page = pageRGB.cssLiteral; self.surface = surfaceRGB.cssLiteral; self.sunken = sunkenRGB.cssLiteral
        self.action = actionRGB.cssLiteral; self.ink = inkRGB.cssLiteral
    }
}

public struct ShareableThemeSpec: Equatable, Sendable {
    public let id: String, name: String, author: String
    public let baseMode: KoderaThemeMode
    public let tokens: ShareableThemeTokens
    public init(id: String, name: String, author: String, baseMode: KoderaThemeMode, tokens: ShareableThemeTokens) throws {
        guard (1...64).contains(id.utf8.count), id.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }),
              admittedText(name, bytes: 64), admittedText(author, bytes: 64) else { throw WorkspacePreferencesError.invalidTheme }
        self.id = id; self.name = name; self.author = author; self.baseMode = baseMode; self.tokens = tokens
    }
    fileprivate init(presetId: String, name: String, author: String, baseMode: KoderaThemeMode, tokens: ShareableThemeTokens) {
        self.id = presetId; self.name = name; self.author = author; self.baseMode = baseMode; self.tokens = tokens
    }
    public func selectingMode(_ mode: KoderaThemeMode) throws -> Self {
        try Self(id: id, name: name, author: author, baseMode: mode, tokens: tokens)
    }
}

public enum ShareableThemeCodec {
    public static let prefix = "kodera-theme:v1:"
    public static let maxCodeBytes = 2048
    public static func encode(_ spec: ShareableThemeSpec) throws -> String {
        let t = spec.tokens
        let json = "{\"v\":1,\"id\":\(quoted(spec.id)),\"name\":\(quoted(spec.name)),\"author\":\(quoted(spec.author)),\"baseMode\":\(quoted(spec.baseMode.rawValue)),\"tokens\":{\"--c-page\":\(quoted(t.page)),\"--c-surface\":\(quoted(t.surface)),\"--c-sunken\":\(quoted(t.sunken)),\"--c-action\":\(quoted(t.action)),\"--c-ink\":\(quoted(t.ink))}}"
        let code = prefix + Data(json.utf8).base64EncodedString()
        guard code.utf8.count <= maxCodeBytes else { throw WorkspacePreferencesError.invalidTheme }
        return code
    }
    public static func decode(_ code: String) throws -> ShareableThemeSpec {
        guard code.utf8.count <= maxCodeBytes, code.hasPrefix(prefix) else { throw WorkspacePreferencesError.invalidTheme }
        let encoded = String(code.dropFirst(prefix.count))
        guard !encoded.isEmpty, let data = Data(base64Encoded: encoded), data.base64EncodedString() == encoded,
              String(data: data, encoding: .utf8) != nil else { throw WorkspacePreferencesError.invalidTheme }
        var parser = ThemeJSONParser(bytes: Array(data))
        let fields = try parser.object(depth: 0)
        parser.whitespace()
        guard parser.atEnd, Set(fields.keys) == ["v", "id", "name", "author", "baseMode", "tokens"],
              fields["v"]?.integer == 1, let mode = KoderaThemeMode(rawValue: try fields.required("baseMode")),
              let tokens = fields["tokens"]?.object, Set(tokens.keys) == ["--c-page", "--c-surface", "--c-sunken", "--c-action", "--c-ink"] else { throw WorkspacePreferencesError.invalidTheme }
        return try ShareableThemeSpec(id: fields.required("id"), name: fields.required("name"), author: fields.required("author"), baseMode: mode,
                                     tokens: ShareableThemeTokens(page: tokens.required("--c-page"), surface: tokens.required("--c-surface"), sunken: tokens.required("--c-sunken"), action: tokens.required("--c-action"), ink: tokens.required("--c-ink")))
    }
    public static let curatedPresets: [ShareableThemeSpec] = [
        ShareableThemeSpec(
            presetId: "preset-real-black-oled",
            name: "Real Black OLED",
            author: "Kodera Design System",
            baseMode: .black,
            tokens: ShareableThemeTokens(
                pageRGB: ThemeRGB(red: 0, green: 0, blue: 0),
                surfaceRGB: ThemeRGB(red: 11, green: 12, blue: 14),
                sunkenRGB: ThemeRGB(red: 6, green: 6, blue: 7),
                actionRGB: ThemeRGB(red: 67, green: 97, blue: 238),
                inkRGB: ThemeRGB(red: 241, green: 244, blue: 248)
            )
        ),
        ShareableThemeSpec(
            presetId: "preset-cobalt-polaire",
            name: "Polar Cobalt",
            author: "Kodera Design System",
            baseMode: .light,
            tokens: ShareableThemeTokens(
                pageRGB: ThemeRGB(red: 255, green: 255, blue: 255),
                surfaceRGB: ThemeRGB(red: 255, green: 255, blue: 255),
                sunkenRGB: ThemeRGB(red: 238, green: 242, blue: 246),
                actionRGB: ThemeRGB(red: 43, green: 75, blue: 219),
                inkRGB: ThemeRGB(red: 30, green: 41, blue: 51)
            )
        ),
        ShareableThemeSpec(
            presetId: "preset-terminal-ambre",
            name: "Amber Terminal",
            author: "Kodera Design System",
            baseMode: .black,
            tokens: ShareableThemeTokens(
                pageRGB: ThemeRGB(red: 0, green: 0, blue: 0),
                surfaceRGB: ThemeRGB(red: 16, green: 14, blue: 10),
                sunkenRGB: ThemeRGB(red: 10, green: 8, blue: 5),
                actionRGB: ThemeRGB(red: 216, green: 155, blue: 60),
                inkRGB: ThemeRGB(red: 245, green: 230, blue: 200)
            )
        ),
        ShareableThemeSpec(
            presetId: "preset-foret-souveraine",
            name: "Sovereign Forest",
            author: "Kodera Design System",
            baseMode: .dark,
            tokens: ShareableThemeTokens(
                pageRGB: ThemeRGB(red: 8, green: 16, blue: 12),
                surfaceRGB: ThemeRGB(red: 14, green: 26, blue: 20),
                sunkenRGB: ThemeRGB(red: 10, green: 19, blue: 14),
                actionRGB: ThemeRGB(red: 53, green: 169, blue: 106),
                inkRGB: ThemeRGB(red: 235, green: 245, blue: 239)
            )
        )
    ]
}

private indirect enum ThemeJSONValue {
    case text(String), integer(Int), object([String: ThemeJSONValue])
    var string: String? { if case let .text(s) = self { s } else { nil } }
    var integer: Int? { if case let .integer(n) = self { n } else { nil } }
    var object: [String: ThemeJSONValue]? { if case let .object(o) = self { o } else { nil } }
}
private extension Dictionary where Key == String, Value == ThemeJSONValue {
    func required(_ key: String) throws -> String {
        guard let text = self[key]?.string else { throw WorkspacePreferencesError.invalidTheme }; return text
    }
}
/// Two object levels, six fields per object, bounded by the decoded share-code envelope.
private struct ThemeJSONParser {
    let bytes: [UInt8]
    var offset = 0
    var atEnd: Bool { offset == bytes.count }
    mutating func whitespace() { while offset < bytes.count && [9, 10, 13, 32].contains(bytes[offset]) { offset += 1 } }
    mutating func take(_ value: UInt8) -> Bool {
        guard offset < bytes.count, bytes[offset] == value else { return false }; offset += 1; return true
    }
    mutating func object(depth: Int) throws -> [String: ThemeJSONValue] {
        whitespace()
        guard depth < 2, take(123) else { throw WorkspacePreferencesError.invalidTheme }
        whitespace(); var result: [String: ThemeJSONValue] = [:]
        if take(125) { return result }
        while true {
            guard result.count < 6 else { throw WorkspacePreferencesError.invalidTheme }
            whitespace(); let key = try string()
            guard result[key] == nil else { throw WorkspacePreferencesError.invalidTheme }
            whitespace(); guard take(58) else { throw WorkspacePreferencesError.invalidTheme }; whitespace()
            if offset < bytes.count, bytes[offset] == 34 { result[key] = .text(try string()) }
            else if offset < bytes.count, bytes[offset] == 123 { result[key] = .object(try object(depth: depth + 1)) }
            else if take(49) { result[key] = .integer(1) }
            else { throw WorkspacePreferencesError.invalidTheme }
            whitespace(); if take(125) { return result }
            guard take(44) else { throw WorkspacePreferencesError.invalidTheme }
        }
    }
    mutating func string() throws -> String {
        let start = offset
        guard take(34) else { throw WorkspacePreferencesError.invalidTheme }
        while offset < bytes.count {
            let byte = bytes[offset]; offset += 1
            if byte == 34 {
                guard let value = try? JSONDecoder().decode(String.self, from: Data(bytes[start..<offset])) else { throw WorkspacePreferencesError.invalidTheme }
                return value
            }
            guard byte >= 32 else { throw WorkspacePreferencesError.invalidTheme }
            if byte == 92 {
                guard offset < bytes.count else { throw WorkspacePreferencesError.invalidTheme }
                let escaped = bytes[offset]; offset += 1
                if escaped == 117 {
                    guard bytes.count - offset >= 4, bytes[offset..<(offset + 4)].allSatisfy({ (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) }) else { throw WorkspacePreferencesError.invalidTheme }
                    offset += 4
                } else if ![34, 47, 92, 98, 102, 110, 114, 116].contains(escaped) { throw WorkspacePreferencesError.invalidTheme }
            }
        }
        throw WorkspacePreferencesError.invalidTheme
    }
}

public enum KoderaRoleRank: Int, CaseIterable, Sendable { case guest = 0, member = 10, moderator = 50, admin = 80, owner = 100 }
public enum KoderaPresenceStatus: String, CaseIterable, Sendable { case online, idle, dnd, offline }
public struct KoderaUserProfile: Equatable, Sendable {
    public let userId: String, displayName: String, handle: String, roleTitle: String
    public let presence: KoderaPresenceStatus
    public let rank: KoderaRoleRank
    public init(userId: String, displayName: String, handle: String, roleTitle: String, presence: KoderaPresenceStatus, rank: KoderaRoleRank) throws {
        guard admittedUUID(userId), admittedText(displayName, bytes: 64), admittedText(roleTitle, bytes: 64),
              (1...32).contains(handle.utf8.count), handle.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || [46, 95, 45].contains($0) }) else { throw WorkspacePreferencesError.invalidProfile }
        self.userId = userId; self.displayName = displayName; self.handle = handle; self.roleTitle = roleTitle; self.presence = presence; self.rank = rank
    }
}
public struct ChannelIamDecision: Equatable, Sendable {
    public let canRead: Bool, canWrite: Bool, canManage: Bool, canCreatePoll: Bool, canManageConnectors: Bool, canJoinVoice: Bool
    public static let denied = Self(canRead: false, canWrite: false, canManage: false, canCreatePoll: false, canManageConnectors: false, canJoinVoice: false)
}
/// Local policy arithmetic only. Caller-supplied ranks do not grant service authority.
public struct ChannelIamPolicy: Equatable, Sendable {
    public let channelId: String, categoryId: String
    public let isVoice: Bool, minReadRank: KoderaRoleRank, minWriteRank: KoderaRoleRank, minManageRank: KoderaRoleRank, allowPolls: Bool, allowConnectors: Bool
    public init(channelId: String, categoryId: String, isVoice: Bool, minReadRank: KoderaRoleRank, minWriteRank: KoderaRoleRank, minManageRank: KoderaRoleRank, allowPolls: Bool, allowConnectors: Bool) throws {
        guard admittedText(channelId, bytes: 255), admittedText(categoryId, bytes: 255) else { throw WorkspacePreferencesError.invalidPolicy }
        self.channelId = channelId; self.categoryId = categoryId; self.isVoice = isVoice; self.minReadRank = minReadRank; self.minWriteRank = minWriteRank; self.minManageRank = minManageRank; self.allowPolls = allowPolls; self.allowConnectors = allowConnectors
    }
    public func evaluate(rank: KoderaRoleRank) -> ChannelIamDecision {
        let read = rank.rawValue >= minReadRank.rawValue
        let write = read && rank.rawValue >= minWriteRank.rawValue
        let manage = read && rank.rawValue >= minManageRank.rawValue
        return ChannelIamDecision(canRead: read, canWrite: write, canManage: manage, canCreatePoll: write && allowPolls, canManageConnectors: manage && allowConnectors, canJoinVoice: read && isVoice)
    }
}

public struct DocsPadDraft: Equatable, Sendable {
    public static let maximumBodyBytes = 65_536
    public let padId: String, channelId: String, title: String, markdownBody: String, updatedBy: String
    public let revision: Int
    public init(padId: String, channelId: String, title: String, markdownBody: String, revision: Int = 1, updatedBy: String) throws {
        guard admittedText(padId, bytes: DocsPadSummary.maximumIDBytes), admittedText(channelId, bytes: 255), admittedText(title, bytes: 120),
              markdownBody.utf8.count <= Self.maximumBodyBytes, revision >= 1, admittedUUID(updatedBy),
              !markdownBody.unicodeScalars.contains(where: { (CharacterSet.controlCharacters.contains($0) && $0 != "\n" && $0 != "\t" && $0 != "\r") || $0.properties.generalCategory == .format }) else { throw WorkspacePreferencesError.invalidDocument }
        self.padId = padId; self.channelId = channelId; self.title = title; self.markdownBody = markdownBody; self.revision = revision; self.updatedBy = updatedBy
    }
    public func updating(title: String, markdownBody: String, actor: String) throws -> Self {
        guard revision < Int.max else { throw WorkspacePreferencesError.revisionOverflow }
        return try Self(padId: padId, channelId: channelId, title: title, markdownBody: markdownBody, revision: revision + 1, updatedBy: actor)
    }
    /// Revisions start at 1 and the body follows a blank line, as in `kodera-rs`; see its `tests/vectors/docs-pad`.
    public func exportMarkdown() -> String {
        "---\npad_id: \(quoted(padId))\nchannel_id: \(quoted(channelId))\ntitle: \(quoted(title))\nrevision: \(revision)\nupdated_by: \(quoted(updatedBy))\n---\n\n\(markdownBody)"
    }
}
