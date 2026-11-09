import SwiftUI
import KoderaAuth
import KoderaClient

@MainActor
final class OrganisationEntryModel: ObservableObject {
    @Published private(set) var organisationSlug = ""
    @Published private(set) var state: AnonymousDiscoveryState = .editing
    private let configuration: AppConfiguration
    private var stateMachine = DiscoveryState()
    private var client: CoreDiscoveryClient?
    private var lookupTask: Task<Void, Never>?
    private var currentTicket: DiscoveryTicket?
    private var closeTask: Task<Void, Never>?
    private var isActive = false

    init(configuration: AppConfiguration) {
        self.configuration = configuration
        if configuration.discoveryConfiguration == nil { present(.notConfigured) }
    }

    deinit { lookupTask?.cancel() }

    var isLoading: Bool { if case .loading = state { true } else { false } }
    var canLookup: Bool {
        isActive && client != nil && !isLoading && canonicalSlug
    }
    private var canonicalSlug: Bool {
        let bytes = Array(organisationSlug.utf8)
        let alphanumeric: (UInt8) -> Bool = { (48...57).contains($0) || (97...122).contains($0) }
        guard (5...20).contains(bytes.count), let first = bytes.first, let last = bytes.last,
              alphanumeric(first), alphanumeric(last) else { return false }
        return bytes.allSatisfy { alphanumeric($0) || $0 == 45 }
    }
    var candidates: [AnonymousOrganisationMetadata] {
        if case let .choosing(values) = state { values } else { [] }
    }
    var selected: AnonymousOrganisationMetadata? {
        if case let .selected(value) = state { value } else { nil }
    }
    /// The typed entry state: no organisation found, try again later, network error, several candidates.
    var presentation: DiscoveryPresentation { DiscoveryPresentation(state) }
    var titleKey: String {
        switch presentation {
        case .ready: "discovery.status_ready"
        case .searching: "discovery.status_loading"
        case .noOrganisation: "discovery.status_no_match"
        case .severalCandidates: "discovery.status_choose"
        case .found: "discovery.status_selected"
        case .cancelled: "discovery.status_cancelled"
        case .tryAgainLater: "discovery.status_try_later"
        case .networkError: "discovery.status_network"
        case .serviceUnavailable, .requestRefused, .invalidResponse, .invalidInput, .notConfigured:
            "discovery.status_unavailable"
        }
    }
    var messageKey: String {
        switch presentation {
        case .ready: "discovery.ready"
        case .searching: "discovery.loading"
        case .noOrganisation: "discovery.no_match"
        case .severalCandidates: "discovery.choose"
        case .found: "discovery.selected_explanation"
        case .cancelled: "discovery.cancelled"
        // A quota answer is never retried by the app: the member searches again later.
        case .tryAgainLater: "discovery.rate_limited"
        case let .networkError(reason):
            switch reason {
            case .timeout: "discovery.timeout"
            case .offline: "discovery.offline"
            case .tls, .authenticationChallenge, .other: "discovery.connection_unavailable"
            }
        case .serviceUnavailable: "discovery.service_unavailable"
        case .requestRefused: "discovery.request_refused"
        case .invalidResponse: "discovery.invalid_response"
        case .invalidInput: "discovery.input_rules"
        case .notConfigured: "discovery.unavailable"
        }
    }

    func activate() {
        isActive = true
        guard configuration.discoveryConfiguration != nil else { present(.notConfigured); return }
        if closeTask == nil { prepareClient() }
    }

    func deactivate() {
        isActive = false
        cancelWork()
        stateMachine.reset()
        publish()
        guard closeTask == nil, let retired = client else { return }
        client = nil
        closeTask = Task { [weak self] in
            await retired.close()
            guard let self else { return }
            self.closeTask = nil
            if self.isActive { self.prepareClient() }
        }
    }

    /// The text field binds through this key path. A `Binding(get:set:)` closure would be
    /// converted to SwiftUI's `@isolated(any) @Sendable` setter, and Swift 6.3 (Xcode 26.6)
    /// crashes in IRGen on that thunk. Writing it is exactly `updateSlug`.
    var slugInput: String {
        get { organisationSlug }
        set { updateSlug(newValue) }
    }

    func updateSlug(_ value: String) {
        guard value != organisationSlug else { return }
        cancelWork()
        organisationSlug = value
        stateMachine.reset()
        publish()
        if configuration.discoveryConfiguration == nil { present(.notConfigured) }
    }

    func lookup() {
        guard isActive, let client else { present(.notConfigured); return }
        guard !isLoading else { return }
        guard canonicalSlug else { present(.invalidInput); return }
        cancelWork()
        let ticket = stateMachine.begin()
        currentTicket = ticket
        let slug = organisationSlug
        publish()
        lookupTask = Task { [weak self, client] in
            let outcome = await client.discover(slug: slug)
            guard let self, !Task.isCancelled, self.isActive, self.currentTicket == ticket else { return }
            self.currentTicket = nil
            self.stateMachine.receive(outcome, for: ticket)
            self.publish()
            self.lookupTask = nil
        }
    }

    func cancelLookup() {
        cancelWork()
        stateMachine.cancel()
        publish()
    }

    func select(organisationId: String) {
        do { try stateMachine.select(organisationId: organisationId); publish() }
        catch { present(.protocolViolation) }
    }

    func reset() {
        cancelWork()
        organisationSlug = ""
        stateMachine.reset()
        publish()
        if configuration.discoveryConfiguration == nil { present(.notConfigured) }
    }

    private func prepareClient() {
        guard client == nil, let profile = configuration.discoveryConfiguration else { return }
        client = CoreDiscoveryClient(configuration: profile)
        // Publish readiness of this local form, never service reachability or identity.
        stateMachine.reset()
        publish()
    }
    private func cancelWork() {
        lookupTask?.cancel()
        lookupTask = nil
        currentTicket = nil
    }
    private func publish() { state = stateMachine.value }
    private func present(_ failure: DiscoveryFailure) {
        cancelWork()
        let ticket = stateMachine.begin()
        stateMachine.receive(.failure(failure), for: ticket)
        publish()
    }
}
