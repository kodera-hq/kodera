import Foundation
import KoderaDomain

/// In-process operation fence, not a provider credential or audio-service authority.
public struct SoundPreferencesContext: Sendable {
    fileprivate let owner: UUID
    fileprivate let generation: UInt64
    fileprivate let scope: SoundPreferencesScope
}

/// The caller serializes this value reducer on its owning actor. Copies retain ownership;
/// it is not a unique security authority. No persistence, hardware or audio engine is created.
public struct SoundPreferencesCoordinator: Sendable {
    private let owner = UUID()
    private var generation: UInt64 = 1
    public private(set) var state = SoundPreferencesState()
    public init() {}

    public mutating func configure(_ scope: SoundPreferencesScope?) throws {
        try state.configure(scope)
        advanceGeneration()
    }
    public mutating func beginLocalPreview(scope: SoundPreferencesScope) throws -> SoundPreferencesContext {
        guard generation != 0 else { throw SoundPreferencesError.stopped }
        try state.beginLocalPreview(scope: scope)
        advanceGeneration()
        guard generation != 0 else { throw SoundPreferencesError.stopped }
        return SoundPreferencesContext(owner: owner, generation: generation, scope: scope)
    }
    public mutating func selectPack(_ pack: SoundPackId, context: SoundPreferencesContext?) throws {
        try requireContext(context)
        try state.selectPack(pack)
    }
    public mutating func setVolumePercent(_ value: Int, context: SoundPreferencesContext?) throws {
        try requireContext(context)
        try state.setVolumePercent(value)
    }
    public mutating func setMuted(_ value: Bool, context: SoundPreferencesContext?) throws {
        try requireContext(context)
        try state.setMuted(value)
    }
    public mutating func setCallDuckingActive(_ value: Bool, context: SoundPreferencesContext?) throws {
        try requireContext(context)
        try state.setCallDuckingActive(value)
    }
    public mutating func clear() { state.clear(); advanceGeneration() }
    public mutating func leave() { state.leave(); advanceGeneration() }
    public mutating func stop() { state.stop(); advanceGeneration() }
    public mutating func switchOrganisation(to scope: SoundPreferencesScope) throws { try configure(scope) }
    private func requireContext(_ context: SoundPreferencesContext?) throws {
        guard let context, generation != 0, context.owner == owner,
              context.generation == generation, context.scope == state.scope,
              state.availability == .localPreviewOnly else { throw SoundPreferencesError.staleContext }
    }
    private mutating func advanceGeneration() {
        if generation == 0 || generation == UInt64.max { generation = 0; state.stop() }
        else { generation += 1 }
    }
}
