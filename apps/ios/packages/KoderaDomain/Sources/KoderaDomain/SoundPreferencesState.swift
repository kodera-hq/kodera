public enum SoundPreferencesError: Error, Equatable, Sendable {
    case invalidScope, invalidPack, invalidVolume, unavailable, stopped, staleContext
}

/// Native preference identifiers. Older Web catalogue slugs are not accepted as aliases.
public enum SoundPackId: String, CaseIterable, Equatable, Sendable {
    case givre, cristal, atelier
    case arcade8Bit = "8bit"
    case glitch404 = "404"
    case silent

    public var isSilent: Bool { self == .silent }
    public static func parse(_ slug: String) throws -> Self {
        guard let pack = Self(rawValue: slug) else { throw SoundPreferencesError.invalidPack }
        return pack
    }
}

/// Correlation context for local preferences; not authentication or audio authority.
public struct SoundPreferencesScope: Equatable, Sendable {
    public let organisationId: String
    public init(organisationId: String) throws {
        guard TrustPolicy.canonicalNonNilUUID(organisationId) else { throw SoundPreferencesError.invalidScope }
        self.organisationId = organisationId
    }
}

/// Pure policy preview. Gain/ducking values never imply produced audio or an active voice call.
public struct SoundPreferencesState: Equatable, Sendable {
    public enum Availability: Equatable, Sendable { case unprovisioned, localPreviewOnly, stopped }
    public static let defaultVolumePercent = 80
    public private(set) var scope: SoundPreferencesScope?
    public private(set) var availability: Availability = .unprovisioned
    public private(set) var activePack: SoundPackId = .givre
    public private(set) var volumePercent = defaultVolumePercent
    public private(set) var isManuallyMuted = false
    public private(set) var isCallDuckingActive = false
    public var isMuted: Bool { isManuallyMuted || activePack.isSilent || volumePercent == 0 }
    public var activeDuckingDecibels: Int { isCallDuckingActive && !isMuted ? -6 : 0 }
    /// Rounded -6 dB policy estimate for integer percentages 0...100; not a DSP measurement.
    public var effectiveGainPercent: Int {
        isMuted ? 0 : isCallDuckingActive ? (volumePercent + 1) / 2 : volumePercent
    }
    public var isAudioHardwareActive: Bool { false }
    public init() {}

    public mutating func configure(_ scope: SoundPreferencesScope?) throws {
        guard availability != .stopped else { throw SoundPreferencesError.stopped }
        clear()
        self.scope = scope
    }
    public mutating func beginLocalPreview(scope: SoundPreferencesScope) throws {
        guard availability != .stopped else { throw SoundPreferencesError.stopped }
        clear()
        self.scope = scope
        availability = .localPreviewOnly
    }
    public mutating func selectPack(_ pack: SoundPackId) throws {
        try requirePreview()
        activePack = pack
        if !pack.isSilent && volumePercent == 0 { volumePercent = Self.defaultVolumePercent }
    }
    public mutating func setVolumePercent(_ value: Int) throws {
        try requirePreview()
        guard (0...100).contains(value) else { throw SoundPreferencesError.invalidVolume }
        volumePercent = value
    }
    /// Explicit preference only: clearing it cannot override Silent or zero volume.
    public mutating func setMuted(_ value: Bool) throws {
        try requirePreview()
        isManuallyMuted = value
    }
    public mutating func setCallDuckingActive(_ value: Bool) throws {
        try requirePreview()
        isCallDuckingActive = value
    }
    public mutating func clear() {
        scope = nil; activePack = .givre; volumePercent = Self.defaultVolumePercent
        isManuallyMuted = false; isCallDuckingActive = false
        if availability != .stopped { availability = .unprovisioned }
    }
    public mutating func leave() { clear() }
    public mutating func stop() { clear(); availability = .stopped }
    private func requirePreview() throws {
        guard availability == .localPreviewOnly else { throw SoundPreferencesError.unavailable }
    }
}
