/// The signed-in screen's `/me` fetches, for one session. The latest fetch wins: a newer one cancels the one in
/// flight, and that one's answer is dropped. The app's session model holds one per session and maps each answer
/// to what it shows.
@MainActor
public final class MemberLoader {
    public enum State: Equatable, Sendable {
        case idle
        /// A fetch is in flight.
        case loading
        /// The latest fetch's answer, already handed to `onAnswer`.
        case answered(MeOutcome)
    }

    public private(set) var state: State = .idle
    private let fetch: @Sendable () async -> MeOutcome
    private let onAnswer: @MainActor (MeOutcome) -> Void
    /// Written on the main actor only; `deinit`, which runs once nothing else holds the loader, reads it too.
    nonisolated(unsafe) private var task: Task<Void, Never>?
    private var generation: UInt64 = 0

    /// `fetch` is the session's `CoreMeClient.fetch`; `onAnswer` gets each answer of the latest fetch, once.
    public init(fetch: @escaping @Sendable () async -> MeOutcome, onAnswer: @escaping @MainActor (MeOutcome) -> Void) {
        self.fetch = fetch
        self.onAnswer = onAnswer
    }

    /// A loader let go of (its session left or replaced) cancels its fetch, so a cancelled fetch ends nothing.
    deinit {
        task?.cancel()
    }

    /// A fresh fetch: entering the session, or Retry after Core was unavailable. Replaces any fetch in flight.
    public func load() {
        task?.cancel()
        generation &+= 1
        let current = generation
        state = .loading
        let fetch = self.fetch
        task = Task { [weak self] in
            let outcome = await fetch()
            self?.answer(outcome, generation: current)
        }
    }

    /// Fetches `/me` again from the settled "no organisation yet" state only (Core's 403): the app came back to
    /// the foreground (after the Console, for one) or the member tapped Check again. Finishing a claim in the Console
    /// changes Core's answer. A fetch in flight is `loading`, so a call during one sends nothing; and no answer
    /// calls this, so it never loops. Returns whether it fetched.
    @discardableResult
    public func checkAgain() -> Bool {
        guard case let .answered(.unavailable(failure)) = state, MemberUnavailable(failure) == .noOrganisationYet
        else { return false }
        load()
        return true
    }

    /// Leaving the session: the fetch in flight is cancelled and its answer dropped.
    public func cancel() {
        task?.cancel()
        task = nil
        generation &+= 1
        state = .idle
    }

    private func answer(_ outcome: MeOutcome, generation: UInt64) {
        guard generation == self.generation else { return }
        task = nil
        state = .answered(outcome)
        onAnswer(outcome)
    }
}
