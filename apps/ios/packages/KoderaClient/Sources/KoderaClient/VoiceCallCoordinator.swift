import Foundation
import KoderaDomain

/// An opaque local operation fence, not proof of Core membership, provider authentication or media.
public struct VoiceCallPreviewContext: Sendable {
    fileprivate let owner: UUID
    fileprivate let generation: UInt64
    fileprivate let scope: VoiceCallScope
}

/// Synchronous value reducer: the caller serializes access on its owning actor.
/// Copies retain operation ownership; this value is not a unique security authority.
/// A future authenticated adapter must verify membership before supplying metadata here.
/// This seam only permits explicitly local previews; it never captures or transmits audio.
public struct VoiceCallCoordinator: Sendable {
    private let owner = UUID()
    private var generation: UInt64 = 1
    public private(set) var state = VoiceCallDockState()
    public init() {}

    public mutating func configure(_ scope: VoiceCallScope?) throws {
        try state.configure(scope)
        advanceGeneration()
    }
    public mutating func beginLocalPreview(scope: VoiceCallScope, participants: [VoiceCallParticipant]) throws -> VoiceCallPreviewContext {
        guard generation != 0 else { throw VoiceCallError.stopped }
        try state.beginLocalPreview(scope: scope, participants: participants)
        advanceGeneration()
        guard generation != 0 else { throw VoiceCallError.stopped }
        return VoiceCallPreviewContext(owner: owner, generation: generation, scope: scope)
    }
    /// Nil, other-owner, obsolete and cross-scope callbacks leave the current state untouched.
    public mutating func replaceParticipants(_ participants: [VoiceCallParticipant], context: VoiceCallPreviewContext?) throws {
        guard let context, generation != 0, context.owner == owner,
              context.generation == generation, context.scope == state.scope,
              state.availability == .localPreviewOnly else { throw VoiceCallError.staleContext }
        try state.replaceParticipants(participants)
    }
    public mutating func setMuted(_ muted: Bool) throws { try state.setMuted(muted) }
    public mutating func setDeafened(_ deafened: Bool) throws { try state.setDeafened(deafened) }
    public mutating func leave() { state.leave(); advanceGeneration() }
    public mutating func stop() { state.stop(); advanceGeneration() }
    public mutating func switchOrganisation(to scope: VoiceCallScope) throws { try configure(scope) }
    private mutating func advanceGeneration() {
        if generation == 0 || generation == UInt64.max { generation = 0; state.stop() }
        else { generation += 1 }
    }
}
