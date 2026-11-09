import Foundation
import KoderaDomain

/// An in-process preview fence, not authentication, membership or Docs-service authority.
public struct DocsPreviewContext: Sendable {
    fileprivate let owner: UUID
    fileprivate let generation: UInt64
    fileprivate let scope: DocsWorkspaceScope
}

/// The caller serializes this value reducer on its owning actor. Copies retain ownership;
/// this is not a unique security authority. A real Docs adapter must establish trust separately.
public struct DocsWorkspaceCoordinator: Sendable {
    private let owner = UUID()
    private var generation: UInt64 = 1
    public private(set) var state = DocsWorkspaceState()
    public init() {}

    public mutating func configure(_ scope: DocsWorkspaceScope?) throws {
        try state.configure(scope)
        advanceGeneration()
    }
    public mutating func beginLocalPreview(scope: DocsWorkspaceScope, pads: [DocsPadSummary]) throws -> DocsPreviewContext {
        guard generation != 0 else { throw DocsWorkspaceError.stopped }
        try state.beginLocalPreview(scope: scope, pads: pads)
        advanceGeneration()
        guard generation != 0 else { throw DocsWorkspaceError.stopped }
        return DocsPreviewContext(owner: owner, generation: generation, scope: scope)
    }
    public mutating func replacePads(_ pads: [DocsPadSummary], context: DocsPreviewContext?) throws {
        guard let context, generation != 0, context.owner == owner,
              context.generation == generation, context.scope == state.scope,
              state.availability == .localPreviewOnly else { throw DocsWorkspaceError.staleContext }
        try state.replacePads(pads)
    }
    public mutating func clear() { state.clear(); advanceGeneration() }
    public mutating func leave() { state.leave(); advanceGeneration() }
    public mutating func stop() { state.stop(); advanceGeneration() }
    public mutating func switchOrganisation(to scope: DocsWorkspaceScope) throws { try configure(scope) }
    private mutating func advanceGeneration() {
        if generation == 0 || generation == UInt64.max { generation = 0; state.stop() }
        else { generation += 1 }
    }
}
