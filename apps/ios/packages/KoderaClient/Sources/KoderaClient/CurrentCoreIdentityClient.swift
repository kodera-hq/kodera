import Foundation
import KoderaDomain

/// An unwired observation reader. The port must truthfully bind the real accepted local owner;
/// neither a snapshot, admitted issuer nor a Core projection is authentication provenance.
@MainActor
public final class CurrentCoreIdentityClient {
    public struct CoreIdentity: Equatable, Sendable, CustomStringConvertible {
        public let id: String
        public let issuer: String
        public let realm: String
        public let subject: String
        public let organisationId: String
        public var description: String { "CoreIdentity(<redacted>)" }
    }
    public enum Failure: Error, Equatable, Sendable {
        case protocolViolation, notEligible, forbidden, serviceUnavailable, identityUnavailable
        case transport(TransportFailure)
    }
    public enum State {
        case idle, loading(ReadHandle), resolved(ReadHandle, CoreIdentity)
        case unavailable(ReadHandle?, Failure), closed
    }
    public enum TerminalStrength: Int, Sendable { case none, signedOut, signedOutNotWiped }
    public enum TerminalKind: Equatable, Sendable { case ended, requireWipe }
    public enum ExecutionKind: Equatable, Sendable { case worker, postdecode, ownerPort, observer }
    public enum DropReason: Equatable, Sendable { case cancelled, superseded, ended, closed, notCurrent, execution }
    public enum DeliveryKind: Equatable, Sendable { case identity, unavailable }
    public enum Disposition: Sendable {
        case delivered(DeliveryKind), terminalRecorded(TerminalReceipt), dropped(DropReason)
    }
    public struct ExecutionError: Error {
        public let kind: ExecutionKind
        public let cause: any Error
        public let secondary: [any Error]
    }
    public struct OwnerPortContractError: Error { public init() {} }

    /// Exact immutable local context. External marker lifetime nonreuse is a port precondition;
    /// there is deliberately no historical marker registry.
    public final class OwnerSnapshot {
        public let marker: AnyObject
        public let requester: CoreRequester
        public let issuer: AdmittedIssuer
        public let organisationId: String
        public init(marker: AnyObject, requester: CoreRequester, issuer: AdmittedIssuer, organisationId: String) {
            self.marker = marker; self.requester = requester; self.issuer = issuer; self.organisationId = organisationId
        }
    }
    /// Synchronous, pure, bounded and nonreentrant. Never obtain a token or mutate an owner here.
    @MainActor public protocol OwnerPort: AnyObject {
        func capture() throws -> OwnerSnapshot?
        func isCurrent(_ snapshot: OwnerSnapshot) throws -> Bool
    }
    fileprivate final class Token {}

    /// An event has immutable local ownership, not an SDK generation. Only the reader can mint it.
    @MainActor public final class TerminalEvent {
        public let kind: TerminalKind
        fileprivate let reader: Token
        fileprivate let owner: Token
        fileprivate let requester: CoreRequester
        fileprivate init(kind: TerminalKind, reader: Token, owner: Token, requester: CoreRequester) {
            self.kind = kind; self.reader = reader; self.owner = owner; self.requester = requester
        }
    }
    public struct TerminalReceipt: Sendable {
        public let strength: TerminalStrength
        public let pendingEvents: [TerminalEvent]
    }
    /// Public durable read/ack survives reader release, G2 replacement and exceptional completion.
    /// Bounded storage: one strength, at most one event per kind and two acknowledgement bits.
    @MainActor public final class OwnerHandle {
        fileprivate let reader: Token
        fileprivate let identity = Token()
        fileprivate let snapshot: OwnerSnapshot
        fileprivate var dataEligible = true
        fileprivate var admitsTerminal = true
        fileprivate var strength = TerminalStrength.none
        fileprivate var ended: TerminalEvent?
        fileprivate var wipe: TerminalEvent?
        fileprivate var endedAcknowledged = false
        fileprivate var wipeAcknowledged = false
        fileprivate init(reader: Token, snapshot: OwnerSnapshot) { self.reader = reader; self.snapshot = snapshot }
        public var terminalReceipt: TerminalReceipt {
            var pending: [TerminalEvent] = []
            if let ended, !endedAcknowledged { pending.append(ended) }
            if let wipe, !wipeAcknowledged { pending.append(wipe) }
            return TerminalReceipt(strength: strength, pendingEvents: pending)
        }
        /// Returns false for a different owner/reader/event. Authentic acknowledgement is idempotent.
        @discardableResult public func acknowledgeTerminal(_ event: TerminalEvent) -> Bool {
            guard event.reader === reader, event.owner === identity, event.requester === snapshot.requester else { return false }
            if event === ended { endedAcknowledged = true; return true }
            if event === wipe { wipeAcknowledged = true; return true }
            return false
        }
    }
    /// Stable, private settle-once completion; an awaiter's cancellation never cancels the real read.
    @MainActor public final class ReadHandle {
        public let owner: OwnerHandle
        fileprivate let reader: Token
        fileprivate var started = false
        fileprivate var startFinished = false
        fileprivate var reductionFinished = false
        fileprivate var drop: DropReason?
        fileprivate var failure: ExecutionError?
        fileprivate var result: Result<Disposition, ExecutionError>?
        fileprivate var waiters: [CheckedContinuation<Disposition, any Error>] = []
        fileprivate init(owner: OwnerHandle, reader: Token) { self.owner = owner; self.reader = reader }
        public func waitForCompletion() async throws -> Disposition {
            if let result { return try result.get() }
            return try await withCheckedThrowingContinuation { waiters.append($0) }
        }
        fileprivate func fail(_ kind: ExecutionKind, _ cause: any Error) {
            if let failure { self.failure = ExecutionError(kind: failure.kind, cause: failure.cause, secondary: failure.secondary + [cause]) }
            else { failure = ExecutionError(kind: kind, cause: cause, secondary: []) }
        }
        fileprivate func settle(_ disposition: Disposition) {
            guard result == nil, !started || (startFinished && reductionFinished) else { return }
            let completed: Result<Disposition, ExecutionError> = failure.map { .failure($0) } ?? .success(disposition)
            result = completed
            let pending = waiters; waiters = []
            for waiter in pending {
                switch completed { case let .success(value): waiter.resume(returning: value); case let .failure(error): waiter.resume(throwing: error) }
            }
        }
    }

    // Internal outcome and scheduling seam cannot replace the requester or inject decoded acceptance.
    enum Outcome: Sendable { case identity(CoreIdentity), unavailable(Failure), signedOut, signedOutNotWiped }
    private struct WorkerResult: Sendable { let outcome: Outcome; let postdecodeFailure: (any Error)? }
    private let owners: any OwnerPort
    private let identity = Token()
    private let onReadState: @MainActor (ReadHandle, State) throws -> Void
    private let onTerminal: @MainActor (OwnerHandle, TerminalEvent) throws -> Void
    private let beforeReduction: @Sendable (Outcome) async throws -> Void
    private var owner: OwnerHandle?
    private var read: ReadHandle?
    private var readsClosed = false
    private var presentation = State.idle
    private var inPort = false
    private var portViolation = false

    public convenience init(owners: any OwnerPort,
                            onReadState: @escaping @MainActor (ReadHandle, State) throws -> Void,
                            onTerminal: @escaping @MainActor (OwnerHandle, TerminalEvent) throws -> Void) {
        self.init(owners: owners, onReadState: onReadState, onTerminal: onTerminal, beforeReductionForTest: { _ in })
    }
    init(owners: any OwnerPort, onReadState: @escaping @MainActor (ReadHandle, State) throws -> Void,
         onTerminal: @escaping @MainActor (OwnerHandle, TerminalEvent) throws -> Void,
         beforeReductionForTest: @escaping @Sendable (Outcome) async throws -> Void) {
        self.owners = owners; self.onReadState = onReadState; self.onTerminal = onTerminal
        beforeReduction = beforeReductionForTest
    }
    public var state: State {
        guard entry() else { return .closed }
        return presentation
    }
    public func acceptCurrentOwner() throws -> OwnerHandle? {
        try throwingEntry()
        let snapshot: OwnerSnapshot?
        do { snapshot = try port { try owners.capture() } }
        catch { shutdownData(.ownerPort, error); throw error }
        guard let snapshot else { if let owner { endOwner(owner) }; return nil }
        if let owner, owner.snapshot.marker === snapshot.marker {
            guard same(owner.snapshot, snapshot) else { shutdownData(.ownerPort, OwnerPortContractError()); throw OwnerPortContractError() }
            return owner.dataEligible && owner.admitsTerminal && !snapshot.requester.isInvalidated ? owner : nil
        }
        guard valid(snapshot) else { if let owner { endOwner(owner) }; return nil }
        if let owner { retireOwner(owner) }
        let accepted = OwnerHandle(reader: identity, snapshot: snapshot)
        owner = accepted
        return accepted
    }
    public func prepareRead(_ accepted: OwnerHandle) throws -> ReadHandle? {
        try throwingEntry()
        guard !readsClosed, owner === accepted, accepted.reader === identity, accepted.dataEligible, valid(accepted.snapshot) else { return nil }
        let current: Bool
        do { current = try port { try owners.isCurrent(accepted.snapshot) } }
        catch { shutdownData(.ownerPort, error); throw error }
        guard current, !readsClosed, owner === accepted, accepted.dataEligible, valid(accepted.snapshot) else { return nil }
        if let read, read.result == nil, read.drop == nil { return read }
        invalidateRead(.superseded)
        let prepared = ReadHandle(owner: accepted, reader: identity)
        read = prepared
        return prepared
    }
    public func startRead(_ handle: ReadHandle) {
        guard entry(), handle.reader === identity, !handle.started, handle.result == nil else { return }
        guard pendingIsCurrent(handle) else { abandonPrepared(handle, .notCurrent); return }
        do {
            guard try port({ try owners.isCurrent(handle.owner.snapshot) }), pendingIsCurrent(handle) else {
                abandonPrepared(handle, .notCurrent); return
            }
        } catch {
            handle.fail(.ownerPort, error); shutdownData(); handle.settle(.dropped(.execution)); return
        }
        handle.started = true
        let snapshot = handle.owner.snapshot
        let requester = snapshot.requester, issuer = snapshot.issuer, target = snapshot.organisationId, gate = beforeReduction
        let worker = Task.detached {
            let outcome = await Self.fetch(requester: requester, issuer: issuer, target: target)
            let failure: (any Error)?
            do { try await gate(outcome); failure = nil } catch { failure = error }
            return WorkerResult(outcome: outcome, postdecodeFailure: failure)
        }
        // This coordinator retains real work/reader/handle through worker termination and reduction.
        // Neither the reader nor the handle retains this Task; settled handles do not retain the reader.
        Task { [self, handle] in
            let result = await worker.value
            reduce(handle, result)
        }
        presentation = .loading(handle)
        notify(handle, presentation)
        handle.startFinished = true
    }
    public func cancelRead(_ handle: ReadHandle) {
        guard entry(), handle.reader === identity, read === handle else { return }
        invalidateRead(.cancelled)
    }
    public func endOwner(_ accepted: OwnerHandle) {
        guard entry(), accepted.reader === identity, owner === accepted else { return }
        accepted.dataEligible = false
        invalidateRead(.ended)
    }
    public func retireOwner(_ accepted: OwnerHandle) {
        guard entry(), accepted.reader === identity, owner === accepted else { return }
        accepted.admitsTerminal = false; accepted.dataEligible = false
        invalidateRead(.superseded); owner = nil
    }
    public func closeReads() { guard entry() else { return }; shutdownData() }

    private func entry() -> Bool {
        if inPort { portViolation = true; return false }
        return true
    }
    private func throwingEntry() throws { guard entry() else { throw OwnerPortContractError() } }
    private func port<T>(_ call: () throws -> T) throws -> T {
        inPort = true; portViolation = false
        defer { inPort = false }
        let value = try call()
        guard !portViolation else { throw OwnerPortContractError() }
        return value
    }
    private func same(_ lhs: OwnerSnapshot, _ rhs: OwnerSnapshot) -> Bool {
        lhs.marker === rhs.marker && lhs.requester === rhs.requester && lhs.issuer == rhs.issuer && lhs.organisationId == rhs.organisationId
    }
    private func valid(_ snapshot: OwnerSnapshot) -> Bool {
        TrustPolicy.canonicalNonNilUUID(snapshot.organisationId) && !snapshot.requester.isInvalidated
    }
    private func pendingIsCurrent(_ handle: ReadHandle) -> Bool {
        !readsClosed && handle.reader === identity && read === handle && owner === handle.owner &&
            handle.drop == nil && handle.result == nil && !handle.started && handle.owner.dataEligible &&
            handle.owner.admitsTerminal && same(handle.owner.snapshot, owner!.snapshot) && valid(handle.owner.snapshot)
    }
    private func abandonPrepared(_ handle: ReadHandle, _ reason: DropReason) {
        handle.drop = handle.drop ?? reason
        if read === handle { read = nil; if !readsClosed { presentation = .idle } }
        handle.settle(.dropped(handle.drop!))
    }
    private func invalidateRead(_ reason: DropReason) {
        if let read {
            read.drop = read.drop ?? reason
            if !read.started { read.settle(.dropped(read.drop!)) }
        }
        read = nil
        if !readsClosed { presentation = .idle }
    }
    private func shutdownData(_ kind: ExecutionKind? = nil, _ cause: (any Error)? = nil) {
        readsClosed = true
        if let read, let kind, let cause { read.fail(kind, cause) }
        invalidateRead(.closed); presentation = .closed
    }
    /// The complete data predicate. Terminal admission must NEVER pass through this fence.
    private func mayPublish(_ handle: ReadHandle) throws -> Bool {
        guard handle.reader === identity, owner === handle.owner, read === handle,
              handle.started, handle.drop == nil, handle.failure == nil, handle.owner.dataEligible,
              handle.owner.admitsTerminal, !readsClosed, same(handle.owner.snapshot, owner!.snapshot),
              !handle.owner.snapshot.requester.isInvalidated,
              case let .loading(loading) = presentation, loading === handle else { return false }
        return try port { try owners.isCurrent(handle.owner.snapshot) }
    }
    private func clearFailedRead(_ handle: ReadHandle) {
        guard read === handle, owner === handle.owner else { return }
        handle.drop = .execution; read = nil
        if !readsClosed { presentation = .idle }
    }
    private func notify(_ handle: ReadHandle, _ state: State) {
        do { try onReadState(handle, state) }
        catch { handle.fail(.observer, error); clearFailedRead(handle) }
    }
    private func reduce(_ handle: ReadHandle, _ result: WorkerResult) {
        var disposition = Disposition.dropped(handle.drop ?? .notCurrent)
        defer {
            handle.reductionFinished = true
            handle.settle(disposition)
        }
        if let failure = result.postdecodeFailure { handle.fail(.postdecode, failure) }
        // Terminal owner/requester authority precedes EVERY data/cancel/live-requester/failure fence.
        switch result.outcome {
        case .signedOut, .signedOutNotWiped:
            let strength: TerminalStrength = if case .signedOutNotWiped = result.outcome { .signedOutNotWiped } else { .signedOut }
            if recordTerminal(strength, from: handle) { disposition = .terminalRecorded(handle.owner.terminalReceipt) }
            return
        case .identity, .unavailable: break
        }
        guard handle.failure == nil else { clearFailedRead(handle); return }
        do { guard try mayPublish(handle) else { return } }
        catch { handle.fail(.ownerPort, error); shutdownData(); return }
        switch result.outcome {
        case let .identity(value):
            presentation = .resolved(handle, value); notify(handle, presentation); disposition = .delivered(.identity)
        case let .unavailable(failure):
            presentation = .unavailable(handle, failure); notify(handle, presentation); disposition = .delivered(.unavailable)
        case .signedOut, .signedOutNotWiped: break
        }
        // No state writes after callbacks: observer reentry owns whatever it installed.
    }
    private func recordTerminal(_ strength: TerminalStrength, from handle: ReadHandle) -> Bool {
        let accepted = handle.owner
        guard handle.reader === identity, owner === accepted, accepted.admitsTerminal,
              accepted.reader === identity, accepted.snapshot.requester === handle.owner.snapshot.requester else { return false }
        if strength.rawValue > accepted.strength.rawValue { accepted.strength = strength }
        accepted.dataEligible = false
        invalidateRead(.ended)
        var created: [TerminalEvent] = []
        if accepted.ended == nil {
            let event = TerminalEvent(kind: .ended, reader: identity, owner: accepted.identity, requester: accepted.snapshot.requester)
            accepted.ended = event; created.append(event)
        }
        if accepted.strength == .signedOutNotWiped && accepted.wipe == nil {
            let event = TerminalEvent(kind: .requireWipe, reader: identity, owner: accepted.identity, requester: accepted.snapshot.requester)
            accepted.wipe = event; created.append(event)
        }
        // Both obligations are committed before any callback. A throw/reentrant G2 cannot consume
        // the wipe obligation or suppress its independently attempted owner-tagged notification.
        for event in created {
            do { try onTerminal(accepted, event) } catch { handle.fail(.observer, error) }
        }
        return true
    }

    nonisolated private static func fetch(requester: CoreRequester, issuer: AdmittedIssuer, target: String) async -> Outcome {
        switch await requester.get(path: "/api/v1/me") {
        case let .answered(status, body):
            switch status {
            case 200: return decode(body, issuer: issuer, target: target)
            case 429, 500...599: return .unavailable(.serviceUnavailable)
            default: return .unavailable(.protocolViolation)
            }
        case .signedOut: return .signedOut
        case .signedOutNotWiped: return .signedOutNotWiped
        case .forbidden: return .unavailable(.forbidden)
        case .identityUnavailable: return .unavailable(.identityUnavailable)
        case let .transport(reason): return .unavailable(.transport(reason))
        case .redirected, .tooLarge, .pathRefused: return .unavailable(.protocolViolation)
        }
    }
    nonisolated private static func decode(_ data: Data, issuer: AdmittedIssuer, target: String) -> Outcome {
        do {
            guard let root = try StrictJSON.parse(data).object,
                  let id = root["id"]?.string, TrustPolicy.canonicalNonNilUUID(id),
                  case .some(.boolean(false)) = root["staff"],
                  let identities = root["identities"]?.array,
                  let memberships = root["organisations"]?.array, memberships.count <= 100 else { throw Failure.protocolViolation }
            var ids: [String: CoreIdentity] = [:], issuers: Set<String> = []
            for entry in identities {
                guard let item = entry.object, let id = item["id"]?.string, TrustPolicy.canonicalNonNilUUID(id), ids[id] == nil,
                      let origin = item["issuer"]?.string, visible(origin, limit: 2048), issuers.insert(origin).inserted,
                      let realm = item["realm"]?.string, TrustPolicy.canonicalSlug(realm),
                      let subject = item["subject"]?.string, visible(subject, limit: 255) else { throw Failure.protocolViolation }
                ids[id] = CoreIdentity(id: id, issuer: origin, realm: realm, subject: subject, organisationId: target)
            }
            var organisations: Set<String> = [], matches = 0, selectedTarget: String?, active = false, link: String?
            for entry in memberships {
                guard let membership = entry.object, let organisation = membership["organisation"]?.object,
                      let id = organisation["id"]?.string, TrustPolicy.canonicalNonNilUUID(id), organisations.insert(id).inserted,
                      let slug = organisation["slug"]?.string, TrustPolicy.canonicalSlug(slug),
                      let state = membership["state"]?.string, ["invited", "active", "suspended", "removed"].contains(state) else { throw Failure.protocolViolation }
                var realm: String?
                if let value = organisation["realm"], !value.isNull {
                    guard let text = value.string, TrustPolicy.canonicalSlug(text), text == slug else { throw Failure.protocolViolation }
                    realm = text
                }
                var identity: String?
                if let value = membership["identity_id"] {
                    guard let text = value.string, TrustPolicy.canonicalNonNilUUID(text) else { throw Failure.protocolViolation }
                    identity = text
                }
                if realm == issuer.realm { matches += 1; selectedTarget = id; active = state == "active"; link = identity }
            }
            guard matches <= 1 else { throw Failure.protocolViolation }
            guard matches == 1, selectedTarget == target, active, let link else { return .unavailable(.notEligible) }
            guard let selected = ids[link], selected.issuer == issuer.issuer, selected.realm == issuer.realm else { throw Failure.protocolViolation }
            return .identity(selected)
        } catch { return .unavailable(.protocolViolation) }
    }
    nonisolated private static func visible(_ value: String, limit: Int) -> Bool {
        (1...limit).contains(value.utf8.count) && value.utf8.allSatisfy { (33...126).contains($0) }
    }
}
