import Foundation
import KoderaDomain

/// An in-process operation fence, not authenticated membership or a remote voting credential.
public struct ChannelPollContext: Sendable {
    fileprivate let owner: UUID
    fileprivate let generation: UInt64
    fileprivate let scope: ChannelPollScope
}

/// The caller serializes this value reducer on its owning actor. Copies retain ownership;
/// the context is not a unique security authority. No remote poll adapter is implemented.
public struct ChannelPollCoordinator: Sendable {
    private let owner = UUID()
    private var generation: UInt64 = 1
    public private(set) var state = ChannelPollState()
    public init() {}

    public mutating func configure(_ scope: ChannelPollScope?) throws {
        try state.configure(scope)
        advanceGeneration()
    }
    public mutating func beginLocalPreview(scope: ChannelPollScope, question: String,
                                          optionLabels: [String], allowsMultipleChoices: Bool) throws -> ChannelPollContext {
        guard generation != 0 else { throw ChannelPollError.stopped }
        try state.beginLocalPreview(scope: scope, question: question,
                                    optionLabels: optionLabels, allowsMultipleChoices: allowsMultipleChoices)
        advanceGeneration()
        guard generation != 0 else { throw ChannelPollError.stopped }
        return ChannelPollContext(owner: owner, generation: generation, scope: scope)
    }
    public mutating func toggleOption(_ id: Int, context: ChannelPollContext?) throws {
        try requireContext(context)
        try state.toggleOption(id)
    }
    public mutating func closePoll(context: ChannelPollContext?) throws {
        try requireContext(context)
        try state.closePoll()
    }
    /// An obsolete view cannot dispose a newer preview, even in the same scope.
    public mutating func leavePreview(context: ChannelPollContext?) {
        guard valid(context) else { return }
        leave()
    }
    /// These are trusted owner lifecycle operations, not asynchronous preview callbacks.
    public mutating func clear() { state.clear(); advanceGeneration() }
    public mutating func leave() { state.leave(); advanceGeneration() }
    public mutating func stop() { state.stop(); advanceGeneration() }
    public mutating func switchOrganisation(to scope: ChannelPollScope) throws { try configure(scope) }
    private func valid(_ context: ChannelPollContext?) -> Bool {
        guard let context else { return false }
        return generation != 0 && context.owner == owner && context.generation == generation
            && context.scope == state.scope && state.availability == .localPreviewOnly
    }
    private func requireContext(_ context: ChannelPollContext?) throws {
        guard valid(context) else { throw ChannelPollError.staleContext }
    }
    private mutating func advanceGeneration() {
        if generation == 0 || generation == UInt64.max { generation = 0; state.stop() }
        else { generation += 1 }
    }
}
