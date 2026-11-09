import Foundation

public enum VoiceCallError: Error, Equatable, Sendable {
    case invalidScope, invalidParticipant, invalidRoster, unavailable, stopped, staleContext
}

public struct VoiceCallScope: Equatable, Sendable {
    public let organisationId: String
    public let channelId: String
    public init(organisationId: String, channelId: String) throws {
        guard TrustPolicy.canonicalNonNilUUID(organisationId), Self.boundedText(channelId) else {
            throw VoiceCallError.invalidScope
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

/// A local preview of adapter-supplied metadata, never evidence that a remote peer is connected.
public struct VoiceCallParticipant: Equatable, Sendable {
    public let id: String
    public let displayName: String
    public let isMuted: Bool
    public let isSpeaking: Bool
    public var identityBytes: Data { Data(id.utf8) }
    public init(id: String, displayName: String, isMuted: Bool, isSpeaking: Bool) throws {
        guard VoiceCallScope.boundedText(id), VoiceCallScope.boundedText(displayName) else {
            throw VoiceCallError.invalidParticipant
        }
        self.id = id
        self.displayName = displayName
        self.isMuted = isMuted
        self.isSpeaking = isSpeaking && !isMuted
    }
    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id.utf8.elementsEqual(rhs.id.utf8) && lhs.displayName == rhs.displayName
            && lhs.isMuted == rhs.isMuted && lhs.isSpeaking == rhs.isSpeaking
    }
}

/// No live media state exists until a separately qualified transport integration is implemented.
public struct VoiceCallDockState: Equatable, Sendable {
    public enum Availability: Equatable, Sendable { case unprovisioned, localPreviewOnly, stopped }
    public static let maximumParticipants = 64
    public private(set) var scope: VoiceCallScope?
    public private(set) var availability: Availability = .unprovisioned
    public private(set) var participants: [VoiceCallParticipant] = []
    public private(set) var isMuted = true
    public private(set) var isDeafened = false
    public var isMicrophoneCapturing: Bool { false }
    public var isRemoteAudioPlaying: Bool { false }
    public var isTransmitting: Bool { false }
    public init() {}

    public mutating func configure(_ scope: VoiceCallScope?) throws {
        guard availability != .stopped else { throw VoiceCallError.stopped }
        clear()
        self.scope = scope
    }
    public mutating func beginLocalPreview(scope: VoiceCallScope, participants: [VoiceCallParticipant]) throws {
        guard availability != .stopped else { throw VoiceCallError.stopped }
        let roster = try Self.roster(participants)
        clear()
        self.scope = scope
        self.participants = roster
        availability = .localPreviewOnly
    }
    public mutating func replaceParticipants(_ participants: [VoiceCallParticipant]) throws {
        try requirePreview()
        self.participants = try Self.roster(participants)
    }
    public mutating func setMuted(_ muted: Bool) throws {
        try requirePreview()
        isMuted = muted
        if !muted { isDeafened = false }
    }
    public mutating func setDeafened(_ deafened: Bool) throws {
        try requirePreview()
        isDeafened = deafened
        if deafened { isMuted = true }
    }
    public mutating func leave() {
        let wasStopped = availability == .stopped
        clear()
        if wasStopped { availability = .stopped }
    }
    public mutating func stop() { clear(); availability = .stopped }
    private mutating func clear() {
        scope = nil; participants = []; isMuted = true; isDeafened = false
        availability = .unprovisioned
    }
    private func requirePreview() throws {
        guard availability == .localPreviewOnly else { throw VoiceCallError.unavailable }
    }
    private static func roster(_ participants: [VoiceCallParticipant]) throws -> [VoiceCallParticipant] {
        guard (1...maximumParticipants).contains(participants.count),
              Set(participants.map(\.identityBytes)).count == participants.count else {
            throw VoiceCallError.invalidRoster
        }
        return participants.sorted { $0.id.utf8.lexicographicallyPrecedes($1.id.utf8) }
    }
}
