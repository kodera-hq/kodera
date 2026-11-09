import Foundation

/// The signed-in interface's read lifecycle. Token, SDK and persistence policy remain with the app owner.
/// Obsolete data is discarded; a failed wipe from an obsolete read still belongs to its terminal owner.
@MainActor
public final class OrganisationChannelsLoader {
    public enum Member: Equatable, Sendable {
        case loading
        case loaded(name: String, organisation: String?)
        case unavailable(MemberUnavailable)
    }
    public enum Workspace: Equatable, Sendable {
        case hidden, loading, targetUnavailable
        case loaded(WorkspaceSnapshot)
        case unavailable(WorkspaceFailure)
    }
    public struct State: Equatable, Sendable {
        public var member: Member = .loading
        public var workspace: Workspace = .hidden
        public init() {}
    }
    public enum Effect: Equatable, Sendable {
        case ended(explicit: Bool)
        case requireWipe
        case clearNotice
        case authenticationStopped
    }
    public enum TerminalStrength: Int, Equatable, Sendable {
        case none, signedOut, signedOutNotWiped
    }
    /// Opaque operation receipts cannot be constructed by app consumers or confused with SDK generations.
    public struct SignOutContext: Sendable {
        let owner: UUID
        let requester: CoreRequester?
    }
    public struct AuthenticationContext: Sendable {
        let id: UUID
        let terminal: SignOutContext
    }

    private final class Owner {
        let id = UUID()
        let accepted: Bool
        let realm: String
        let requester: CoreRequester?
        let fetchMember: (@Sendable () async -> MeOutcome)?
        let fetchWorkspace: (@Sendable (String) async -> WorkspaceOutcome)?
        var terminal: TerminalStrength = .none
        var ended = false
        var warned = false
        init(realm: String, requester: CoreRequester?, accepted: Bool = true, fetchMember: (@Sendable () async -> MeOutcome)?,
             fetchWorkspace: (@Sendable (String) async -> WorkspaceOutcome)?) {
            self.accepted = accepted; self.realm = realm; self.requester = requester
            self.fetchMember = fetchMember; self.fetchWorkspace = fetchWorkspace
        }
        var context: SignOutContext { SignOutContext(owner: id, requester: requester) }
    }
    private struct Binding: Sendable {
        let context: SignOutContext
        let ticket: UUID
        var organisation: String? = nil
    }

    public private(set) var state = State() { didSet { onChange(state) } }
    public var onChange: @MainActor (State) -> Void
    public var onEffect: @MainActor (Effect) -> Void
    private var owner: Owner?
    private var ticket = UUID()
    private var target: String?
    private var foreground = false
    private var readsClosed = false
    private var loading = false
    private var authentication: UUID?
    // Internal read handle lets host tests acknowledge the whole real worker, including reduction/publication.
    private(set) var readTask: Task<Void, Never>?

    public init(onChange: @escaping @MainActor (State) -> Void = { _ in },
                onEffect: @escaping @MainActor (Effect) -> Void = { _ in }) {
        self.onChange = onChange; self.onEffect = onEffect
    }
    public var terminalStrength: TerminalStrength { owner?.terminal ?? .none }
    public var isAuthenticating: Bool { authentication != nil }
    public var canRetry: Bool {
        owner?.accepted == true && owner?.terminal == TerminalStrength.none && foreground && !readsClosed && !loading && !isAuthenticating
    }

    /// Serialises app authentication completions without placing asynchronous owner decisions in the wrapper.
    public func beginAuthentication() -> AuthenticationContext? {
        guard authentication == nil else { return nil }
        if let owner, owner.accepted && owner.terminal == .none { return nil }
        if owner == nil {
            // Restore/sign-in may fail to wipe before any Core requester exists; never wildcard a Core receipt.
            owner = Owner(realm: "", requester: nil, accepted: false, fetchMember: nil, fetchWorkspace: nil)
        }
        guard let owner else { return nil }
        let id = UUID(); authentication = id
        if !owner.warned { onEffect(.clearNotice) }
        guard authentication == id else { return nil }
        return AuthenticationContext(id: id, terminal: owner.context)
    }
    public func completeAuthentication(_ context: AuthenticationContext, failed: Bool = false, notWiped: Bool = false,
                                       apply: @MainActor () -> Void) {
        guard authentication == context.id else { return }
        authentication = nil
        if notWiped { terminal(.signedOutNotWiped, context: context.terminal) }
        guard owner?.id == context.terminal.owner, owner?.requester === context.terminal.requester else { return }
        if notWiped || (failed && owner?.warned == true) {
            onEffect(.authenticationStopped)
            return
        }
        apply()
    }

    /// A genuine accepted SDK session: retire the previous terminal owner, even with equal realm/public fields.
    public func enter(realm: String, requester: CoreRequester?,
                      fetchMember: (@Sendable () async -> MeOutcome)? = nil,
                      fetchWorkspace: (@Sendable (String) async -> WorkspaceOutcome)? = nil) {
        invalidateRead()
        owner?.requester?.invalidate()
        authentication = nil
        owner = Owner(realm: realm, requester: requester, fetchMember: fetchMember, fetchWorkspace: fetchWorkspace)
        readsClosed = false
        loadMember()
    }

    public func setForeground(_ active: Bool) {
        guard active != foreground else { return }
        foreground = active
        invalidateRead()
        if active && !readsClosed && owner?.terminal == TerminalStrength.none { loadMember() }
    }
    /// Data/read teardown does not retire terminal authority or drop an outstanding persistence obligation.
    public func closeReads() { readsClosed = true; invalidateRead() }
    public func retry() { if canRetry { loadMember() } }
    public func checkAgain() {
        if state.member == .unavailable(.noOrganisationYet) { retry() }
    }

    /// End immediately for the explicit user action; its asynchronous SDK completion returns this same context.
    public func beginSignOut() -> SignOutContext? {
        guard let owner, owner.accepted, owner.terminal == .none, !isAuthenticating else { return nil }
        let context = owner.context
        terminal(.signedOut, context: context, explicit: true)
        return context
    }
    public func completeSignOut(_ context: SignOutContext, notWiped: Bool) {
        terminal(notWiped ? .signedOutNotWiped : .signedOut, context: context, explicit: true)
    }

    private func invalidateRead() {
        readTask?.cancel()
        readTask = nil
        ticket = UUID(); target = nil; loading = false
        state.workspace = .hidden
    }
    private func loadMember() {
        guard let owner, owner.accepted, owner.terminal == .none, !readsClosed else { return }
        invalidateRead()
        state.member = .loading
        guard let requester = owner.requester, let fetch = owner.fetchMember, !requester.isInvalidated else {
            state.member = .unavailable(.coreUnavailable)
            return
        }
        loading = true
        let binding = Binding(context: owner.context, ticket: ticket)
        // Retain the coordinator until this operation finishes, including a cancelled SDK wipe receipt.
        readTask = Task {
            let outcome = await fetch()
            memberAnswered(outcome, binding: binding)
        }
    }

    private func isCurrentData(_ binding: Binding) -> Bool {
        guard let owner else { return false }
        return foreground && !readsClosed && owner.terminal == .none && owner.id == binding.context.owner &&
            owner.requester === binding.context.requester && ticket == binding.ticket &&
            binding.context.requester?.isInvalidated == false
    }
    private func memberAnswered(_ outcome: MeOutcome, binding: Binding) {
        // Terminal authority precedes ALL ticket/foreground/cancellation/requester-open data checks.
        switch outcome {
        case .signedOut: terminal(.signedOut, context: binding.context); return
        case .signedOutNotWiped: terminal(.signedOutNotWiped, context: binding.context); return
        case .member, .unavailable: break
        }
        guard isCurrentData(binding), let owner else { return }
        loading = false
        switch outcome {
        case let .member(profile):
            let matching = profile.organisations.filter { $0.realm == owner.realm }
            let organisation = matching.count == 1 ? matching[0] : nil
            state.member = .loaded(name: profile.displayName ?? profile.email, organisation: organisation?.name)
            guard let organisation else { state.workspace = .targetUnavailable; return }
            guard let fetch = owner.fetchWorkspace else { state.workspace = .unavailable(.serviceUnavailable); return }
            target = organisation.id
            var workspaceBinding = binding; workspaceBinding.organisation = organisation.id
            let captured = workspaceBinding
            loading = true; state.workspace = .loading
            readTask = Task {
                let outcome = await fetch(organisation.id)
                workspaceAnswered(outcome, binding: captured)
            }
        case let .unavailable(failure): state.member = .unavailable(MemberUnavailable(failure))
        case .signedOut, .signedOutNotWiped: break // Already handled above, never sent through the data fence.
        }
    }
    private func workspaceAnswered(_ outcome: WorkspaceOutcome, binding: Binding) {
        switch outcome {
        case .signedOut: terminal(.signedOut, context: binding.context); return
        case .signedOutNotWiped: terminal(.signedOutNotWiped, context: binding.context); return
        case .loaded, .unavailable: break
        }
        guard isCurrentData(binding), target == binding.organisation else { return }
        loading = false
        switch outcome {
        case let .loaded(snapshot):
            state.workspace = snapshot.organisationId == binding.organisation ? .loaded(snapshot) : .unavailable(.protocolViolation)
        case let .unavailable(failure): state.workspace = .unavailable(failure)
        case .signedOut, .signedOutNotWiped: break
        }
    }

    /// One bounded owner record, retained through plain end/core=nil/own requester closure for a late upgrade.
    private func terminal(_ receipt: TerminalStrength, context: SignOutContext, explicit: Bool = false) {
        guard let current = owner, current.id == context.owner, current.requester === context.requester else { return }
        if receipt.rawValue > current.terminal.rawValue { current.terminal = receipt }
        let end = !current.ended
        let warn = current.terminal == .signedOutNotWiped && !current.warned
        current.ended = true
        if warn { current.warned = true }
        if end {
            invalidateRead()
            current.requester?.invalidate()
            state = State()
        }
        // Callback reentry may accept a genuine G2; only that retires this owner, not its closed requester.
        guard owner === current else { return }
        if end { onEffect(.ended(explicit: explicit)) }
        guard owner === current else { return }
        if warn { onEffect(.requireWipe) }
    }
}
