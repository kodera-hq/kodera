import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import KoderaClient

/// Deliberately ignores task cancellation: an SDK operation already in progress can still return a receipt.
private actor ChannelGate {
    private var open = false
    private var waiter: CheckedContinuation<Void, Never>?
    func wait() async {
        if open { return }
        await withCheckedContinuation { waiter = $0 }
    }
    func release() { open = true; waiter?.resume(); waiter = nil }
}

private struct ChannelStep<Value: Sendable>: Sendable {
    let value: Value
    var gate: ChannelGate? = nil
}

private actor ChannelScript<Value: Sendable> {
    private var steps: [ChannelStep<Value>]
    private let fallback: Value
    private(set) var calls = 0
    init(_ steps: [ChannelStep<Value>], fallback: Value) { self.steps = steps; self.fallback = fallback }
    func fetch() async -> Value {
        calls += 1
        guard !steps.isEmpty else { return fallback }
        let step = steps.removeFirst()
        await step.gate?.wait()
        return step.value
    }
}

private actor ChannelTokens: AccessTokenProvider {
    func accessToken(forceRefresh: Bool) async throws(AccessTokenFailure) -> AccessToken {
        AccessToken(value: "synthetic", session: 1)
    }
    func signOut() async throws(SessionNotWiped) {}
    func endSessionLocally(servedBy session: UInt64) async throws(SessionNotWiped) {}
}

/// Synthetic SDK boundary, with the real unchanged requester and readers above it.
private actor WipeRaceTokens: AccessTokenProvider {
    let gate = ChannelGate()
    private let initialMember: Bool
    private let heldFailure: AccessTokenFailure
    private let plainGate: ChannelGate?
    private(set) var calls = 0
    init(initialMember: Bool, heldFailure: AccessTokenFailure = .signedOutNotWiped, plainGate: ChannelGate? = nil) {
        self.initialMember = initialMember; self.heldFailure = heldFailure; self.plainGate = plainGate
    }
    func accessToken(forceRefresh: Bool) async throws(AccessTokenFailure) -> AccessToken {
        calls += 1
        let call = calls
        if initialMember && call == 1 { return AccessToken(value: "synthetic", session: 1) }
        if call == (initialMember ? 2 : 1) {
            await gate.wait()
            throw heldFailure
        }
        await plainGate?.wait()
        throw .signedOut
    }
    func signOut() async throws(SessionNotWiped) {}
    func endSessionLocally(servedBy session: UInt64) async throws(SessionNotWiped) {}
}

/// Records the real reader result and exact requester before forwarding the result unchanged.
private actor ChannelReceipts {
    struct MemberReceipt: Sendable {
        let requester: CoreRequester
        let outcome: MeOutcome
    }
    struct WorkspaceReceipt: Sendable {
        let requester: CoreRequester
        let outcome: WorkspaceOutcome
    }
    private(set) var members: [MemberReceipt] = []
    private(set) var workspaces: [WorkspaceReceipt] = []
    func member(_ outcome: MeOutcome, requester: CoreRequester) { members.append(.init(requester: requester, outcome: outcome)) }
    func workspace(_ outcome: WorkspaceOutcome, requester: CoreRequester) { workspaces.append(.init(requester: requester, outcome: outcome)) }
}

private actor ChannelCompletion {
    private(set) var done = false
    func finish() { done = true }
}

@MainActor
private final class ChannelEvents {
    var states: [OrganisationChannelsLoader.State] = []
    var effects: [OrganisationChannelsLoader.Effect] = []
    var ends: Int { effects.filter { if case .ended = $0 { true } else { false } }.count }
    var wipes: Int { effects.filter { $0 == .requireWipe }.count }
    func loader() -> OrganisationChannelsLoader {
        OrganisationChannelsLoader(onChange: { self.states.append($0) }, onEffect: { self.effects.append($0) })
    }
}

private struct ChannelDeadline: Error {}
private struct ChannelSetupFailure: Error {}
private struct SameOwnerTerminalLost: Error {}
private struct RetiredOwnerTerminalAdmitted: Error {}

@MainActor
final class OrganisationChannelsLoaderTests: XCTestCase {
    private let organisation = "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f"
    private let other = "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e60"
    private let realm = "example"

    private func until(_ condition: @MainActor () async -> Bool, file: StaticString = #filePath,
                       line: UInt = #line) async throws {
        let clock = ContinuousClock(), deadline = ContinuousClock().now + .seconds(5)
        while !(await condition()) {
            guard clock.now < deadline else { XCTFail("operation did not complete", file: file, line: line); throw ChannelDeadline() }
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    /// Acknowledges completion of the whole real worker, including its MainActor publication/reduction call.
    private func processed(_ task: Task<Void, Never>, file: StaticString = #filePath, line: UInt = #line) async throws {
        let completion = ChannelCompletion()
        let watcher = Task { await task.value; await completion.finish() }
        defer { watcher.cancel() }
        try await until({ await completion.done }, file: file, line: line)
    }

    private func require(_ condition: Bool, _ message: String, file: StaticString = #filePath, line: UInt = #line) throws {
        guard condition else { XCTFail(message, file: file, line: line); throw ChannelSetupFailure() }
    }

    /// Release every gate before waiting for every captured whole worker; do not abandon siblings on error.
    private func finish(gates: [ChannelGate], workers: [Task<Void, Never>]) async throws {
        for gate in gates { await gate.release() }
        var firstError: (any Error)?
        for worker in workers {
            do { try await processed(worker) }
            catch { if firstError == nil { firstError = error } }
        }
        if let firstError { throw firstError }
    }

    private func requester(tokens: any AccessTokenProvider = ChannelTokens()) throws -> CoreRequester {
        try CoreRequester(coreApiOrigin: "https://core.test", loopback: .refuse, tokens: tokens,
                          protocolClass: URLProtocolFixture.self, timeout: 2)
    }
    private func member(_ ids: [String]? = nil) -> MeOutcome {
        .member(MemberProfile(id: "11111111-2222-4333-8444-555555555555", email: "member@example.test",
            displayName: "Synthetic Member", organisations: (ids ?? [organisation]).map {
                MemberOrganisation(id: $0, slug: realm, name: "Organisation", realm: realm, role: "org_owner", state: "active")
            }))
    }
    private func snapshot(_ label: String, id: String? = nil) -> WorkspaceSnapshot {
        WorkspaceSnapshot(organisationId: id ?? organisation, state: .initialised,
            setup: WorkspaceSetup(state: .ready, reason: nil), canInitialise: false,
            id: "0192f3a4-5b6c-7d8e-9f01-23456789abcd", categories: [WorkspaceCategory(
                id: "0192f3a4-5b6c-7d8e-9f01-23456789abce", name: "Section", templateKey: nil, channels: [
                    WorkspaceChannel(id: "0192f3a4-5b6c-7d8e-9f01-23456789abcf", kind: .text, name: label,
                        templateKey: nil, topic: "", lifecycle: .active, roomState: .ready)])], uncategorisedChannels: [])
    }
    private func me(_ values: [ChannelStep<MeOutcome>]) -> ChannelScript<MeOutcome> {
        ChannelScript(values, fallback: .unavailable(.protocolViolation))
    }
    private func channels(_ values: [ChannelStep<WorkspaceOutcome>]) -> ChannelScript<WorkspaceOutcome> {
        ChannelScript(values, fallback: .unavailable(.protocolViolation))
    }
    private func bind(_ loader: OrganisationChannelsLoader, _ requester: CoreRequester,
                      _ me: ChannelScript<MeOutcome>, _ channels: ChannelScript<WorkspaceOutcome>) {
        loader.enter(realm: realm, requester: requester, fetchMember: { await me.fetch() },
                     fetchWorkspace: { _ in await channels.fetch() })
    }
    private func label(_ loader: OrganisationChannelsLoader) -> String? {
        guard case let .loaded(tree) = loader.state.workspace else { return nil }
        return tree.categories.first?.channels.first?.name
    }

    func testOneForegroundChainRevalidatesMemberAndSuppressesDuplicates() async throws {
        let gate = ChannelGate(); defer { Task { await gate.release() } }
        let m = me([.init(value: member()), .init(value: member(), gate: gate)])
        let w = channels([.init(value: .loaded(snapshot("First"))), .init(value: .loaded(snapshot("Second")))])
        let loader = ChannelEvents().loader(); loader.setForeground(true)
        bind(loader, try requester(), m, w)
        try await until { self.label(loader) == "First" }
        loader.setForeground(false); loader.setForeground(true)
        XCTAssertEqual(loader.state.workspace, .hidden)
        for _ in 0..<3 { loader.setForeground(true); loader.retry(); loader.checkAgain() }
        try await until { await m.calls == 2 }
        let before = await w.calls; XCTAssertEqual(before, 1)
        await gate.release()
        try await until { self.label(loader) == "Second" }
        let count = await m.calls; XCTAssertEqual(count, 2)
    }

    func testZeroAndAmbiguousMembershipNeverStartWorkspace() async throws {
        for ids in [[], [organisation, other]] {
            let m = me([.init(value: member(ids))]), w = channels([])
            let loader = ChannelEvents().loader(); loader.setForeground(true)
            bind(loader, try requester(), m, w)
            try await until { loader.state.workspace == .targetUnavailable }
            XCTAssertEqual(loader.state.member, .loaded(name: "Synthetic Member", organisation: nil))
            let calls = await w.calls; XCTAssertEqual(calls, 0)
        }
    }

    func testOldLoadedAnswerCannotReplaceEqualFieldNewGeneration() async throws {
        let gate = ChannelGate(); defer { Task { await gate.release() } }
        let m = me([.init(value: member()), .init(value: member())])
        let w = channels([.init(value: .loaded(snapshot("Old generation")), gate: gate), .init(value: .loaded(snapshot("New generation")))])
        let loader = ChannelEvents().loader(); loader.setForeground(true)
        let first = try requester(); bind(loader, first, m, w)
        try await until { await w.calls == 1 }
        let old = try XCTUnwrap(loader.readTask)
        let second = try requester(); bind(loader, second, m, w)
        try await until { self.label(loader) == "New generation" }
        XCTAssertTrue(first.isInvalidated); XCTAssertFalse(second.isInvalidated)
        await gate.release(); try await processed(old)
        XCTAssertEqual(label(loader), "New generation", "Old generation must never replace the already published New generation")
    }

    func testOldOrganisationAndMemberDataCannotChainAfterRevalidation() async throws {
        let gate = ChannelGate(); defer { Task { await gate.release() } }
        let m = me([.init(value: member([other]), gate: gate), .init(value: member())])
        let w = channels([.init(value: .loaded(snapshot("Current")))])
        let loader = ChannelEvents().loader(); loader.setForeground(true)
        bind(loader, try requester(), m, w)
        try await until { await m.calls == 1 }; let old = try XCTUnwrap(loader.readTask)
        loader.setForeground(false); loader.setForeground(true)
        try await until { self.label(loader) == "Current" }
        await gate.release(); try await processed(old)
        XCTAssertEqual(label(loader), "Current")
        let calls = await w.calls; XCTAssertEqual(calls, 1)
    }

    private func terminalOrder(workspace: Bool, warningFirst: Bool, crossReader: Bool = false) async throws {
        let a = ChannelGate(), b = ChannelGate(); defer { Task { await a.release(); await b.release() } }
        let m = me(crossReader ? [.init(value: member()), .init(value: .signedOut, gate: b)] :
            workspace ? [.init(value: member()), .init(value: member())] : [
                .init(value: .signedOutNotWiped, gate: a), .init(value: .signedOut, gate: b)])
        let w = channels(crossReader ? [.init(value: .signedOutNotWiped, gate: a)] :
            workspace ? [.init(value: .signedOutNotWiped, gate: a), .init(value: .signedOut, gate: b)] : [])
        let events = ChannelEvents(), request = try requester(), loader = events.loader(); loader.setForeground(true)
        bind(loader, request, m, w)
        try await until { if workspace { await w.calls == 1 } else { await m.calls == 1 } }
        let old = try XCTUnwrap(loader.readTask)
        loader.setForeground(false); loader.setForeground(true)
        try await until { if workspace && !crossReader { await w.calls == 2 } else { await m.calls == 2 } }
        let newer = try XCTUnwrap(loader.readTask)
        if warningFirst { await a.release(); try await processed(old) }
        else { await b.release(); try await processed(newer); XCTAssertEqual(events.ends, 1); XCTAssertEqual(events.wipes, 0) }
        XCTAssertTrue(request.isInvalidated)
        loader.setForeground(false)
        if warningFirst { await b.release(); try await processed(newer) }
        else { await a.release(); try await processed(old) }
        XCTAssertEqual(loader.terminalStrength, .signedOutNotWiped)
        XCTAssertEqual(loader.state.workspace, .hidden)
        XCTAssertEqual(events.ends, 1); XCTAssertEqual(events.wipes, 1)
        loader.setForeground(true); loader.retry()
        let count = await m.calls; XCTAssertEqual(count, 2)
    }
    func testMemberPlainEndBeforeObsoleteNotWipedUpgradesClosedOwner() async throws { try await terminalOrder(workspace: false, warningFirst: false) }
    func testMemberNotWipedBeforePlainEndCannotDowngrade() async throws { try await terminalOrder(workspace: false, warningFirst: true) }
    func testWorkspacePlainEndBeforeObsoleteNotWipedUpgradesClosedOwner() async throws { try await terminalOrder(workspace: true, warningFirst: false) }
    func testWorkspaceNotWipedBeforePlainEndCannotDowngrade() async throws { try await terminalOrder(workspace: true, warningFirst: true) }

    func testReadShutdownStillDeliversOwnedWipeObligation() async throws {
        let gate = ChannelGate(); defer { Task { await gate.release() } }
        let m = me([.init(value: .signedOutNotWiped, gate: gate)])
        let events = ChannelEvents(), loader = events.loader(); loader.setForeground(true)
        bind(loader, try requester(), m, channels([]))
        try await until { await m.calls == 1 }; let old = try XCTUnwrap(loader.readTask)
        loader.closeReads(); await gate.release(); try await processed(old)
        XCTAssertEqual(events.ends, 1); XCTAssertEqual(events.wipes, 1)
        loader.setForeground(true); loader.retry()
        let calls = await m.calls; XCTAssertEqual(calls, 1)
    }

    func testExplicitCompletionCannotDowngradeWarningOrAffectG2() async throws {
        let gate = ChannelGate(); defer { Task { await gate.release() } }
        let m = me([.init(value: .signedOutNotWiped, gate: gate), .init(value: member())])
        let events = ChannelEvents(), loader = events.loader(); loader.setForeground(true)
        bind(loader, try requester(), m, channels([]))
        try await until { await m.calls == 1 }; let old = try XCTUnwrap(loader.readTask)
        let context = try XCTUnwrap(loader.beginSignOut())
        await gate.release(); try await processed(old)
        loader.completeSignOut(context, notWiped: false); loader.completeSignOut(context, notWiped: true)
        XCTAssertEqual(events.effects, [.ended(explicit: true), .requireWipe])
        let second = try requester(); bind(loader, second, m, channels([.init(value: .loaded(snapshot("New")))]))
        try await until { self.label(loader) == "New" }
        loader.completeSignOut(context, notWiped: true)
        XCTAssertEqual(label(loader), "New"); XCTAssertFalse(second.isInvalidated)
        XCTAssertEqual(events.wipes, 1)
    }

    func testRetiredSameRealmTerminalCannotEndNewOwner() async throws {
        for terminal in [MeOutcome.signedOutNotWiped, .signedOut] {
            let tokens = WipeRaceTokens(initialMember: false,
                heldFailure: terminal == .signedOutNotWiped ? .signedOutNotWiped : .signedOut)
            let gate = tokens.gate, workspaceGate = ChannelGate(), receipts = ChannelReceipts()
            let first = try requester(tokens: tokens), firstReader = CoreMeClient(requester: first)
            let events = ChannelEvents(), loader = events.loader(); loader.setForeground(true)
            var workers: [Task<Void, Never>] = []
            do {
                loader.enter(realm: realm, requester: first, fetchMember: {
                    let outcome = await firstReader.fetch()
                    await receipts.member(outcome, requester: first)
                    return outcome
                })
                let old = try XCTUnwrap(loader.readTask); workers.append(old)
                try await until { await tokens.calls == 1 }
                let m = me([.init(value: member())])
                let w = channels([.init(value: .loaded(snapshot("New")), gate: workspaceGate)])
                let second = try requester(); bind(loader, second, m, w)
                let memberWorker = try XCTUnwrap(loader.readTask); workers.append(memberWorker)
                try await until { await w.calls == 1 }
                let workspaceWorker = try XCTUnwrap(loader.readTask); workers.append(workspaceWorker)
                await workspaceGate.release()
                try await processed(memberWorker); try await processed(workspaceWorker)
                try await until { self.label(loader) == "New" }
                try require(label(loader) == "New" && !second.isInvalidated && loader.terminalStrength == .none && events.effects.isEmpty,
                            "G2 did not finish its own live workspace before G1 release")
                try require(first !== second && first.isInvalidated, "G2 did not retire the exact G1 requester")
                await gate.release(); try await processed(old)
                let actual = await receipts.members
                try require(actual.count == 1 && actual.first?.requester === first && actual.first?.outcome == terminal,
                            "G1 did not actually classify the expected terminal through its exact requester")
                if terminal == .signedOutNotWiped && loader.terminalStrength == .signedOutNotWiped && second.isInvalidated &&
                    events.effects == [.ended(explicit: false), .requireWipe] {
                    throw RetiredOwnerTerminalAdmitted()
                }
                XCTAssertEqual(label(loader), "New"); XCTAssertTrue(events.effects.isEmpty)
                XCTAssertFalse(second.isInvalidated)
            } catch {
                let original = error
                do { try await finish(gates: [gate, workspaceGate], workers: workers) }
                catch { XCTFail("retired-owner cleanup could not acknowledge every captured worker") }
                throw original
            }
            try await finish(gates: [gate, workspaceGate], workers: workers)
        }
    }

    func testWrongRequesterReceiptCannotUpgradeOwner() throws {
        let events = ChannelEvents(), loader = events.loader()
        loader.enter(realm: realm, requester: try requester())
        let context = try XCTUnwrap(loader.beginSignOut())
        let wrong = OrganisationChannelsLoader.SignOutContext(owner: context.owner, requester: try requester())
        loader.completeSignOut(wrong, notWiped: true)
        XCTAssertEqual(events.wipes, 0); XCTAssertEqual(loader.terminalStrength, .signedOut)
    }

    func testMissingCoreStillPreservesExplicitNotWiped() throws {
        let events = ChannelEvents(), loader = events.loader()
        loader.enter(realm: realm, requester: nil)
        let context = try XCTUnwrap(loader.beginSignOut())
        loader.completeSignOut(context, notWiped: true)
        XCTAssertEqual(events.effects, [.ended(explicit: true), .requireWipe])
    }

    private func classifiedRace(workspace: Bool) async throws {
        let plainGate = ChannelGate(), receipts = ChannelReceipts()
        let tokens = WipeRaceTokens(initialMember: workspace, plainGate: plainGate)
        let request = try requester(tokens: tokens), meClient = CoreMeClient(requester: request)
        let workspaceClient = CoreWorkspaceClient(requester: request)
        let profile = #"{"id":"11111111-2222-4333-8444-555555555555","email":"member@example.test","display_name":"Synthetic","organisations":[{"organisation":{"id":"6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f","slug":"example","name":"Organisation","realm":"example"},"role":"org_owner","state":"active"}]}"#
        URLProtocolFixture.install(.body(status: 200, headers: ["Content-Type": "application/json"], chunks: [Data(profile.utf8)]))
        let events = ChannelEvents(), loader = events.loader(); loader.setForeground(true)
        var workers: [Task<Void, Never>] = []
        do {
            loader.enter(realm: realm, requester: request, fetchMember: {
                let outcome = await meClient.fetch()
                await receipts.member(outcome, requester: request)
                return outcome
            }, fetchWorkspace: {
                let outcome = await workspaceClient.fetch(organisationId: $0)
                await receipts.workspace(outcome, requester: request)
                return outcome
            })
            let first = try XCTUnwrap(loader.readTask); workers.append(first)
            try await until { await tokens.calls == (workspace ? 2 : 1) }
            let old = try XCTUnwrap(loader.readTask)
            if workspace { workers.append(old) }
            loader.setForeground(false); loader.setForeground(true)
            let newer = try XCTUnwrap(loader.readTask); workers.append(newer)
            try await until { await tokens.calls == (workspace ? 3 : 2) }
            try require(!request.isInvalidated && events.effects.isEmpty, "plain result escaped its held token gate")
            await plainGate.release(); try await processed(newer)
            try await until { events.ends == 1 }
            let plain = await receipts.members
            try require(plain.count == (workspace ? 2 : 1) && plain.last?.requester === request && plain.last?.outcome == .signedOut,
                        "B did not actually classify plain sign-out through the same requester")
            try require(loader.terminalStrength == .signedOut && events.effects == [.ended(explicit: false)] &&
                        request.isInvalidated && loader.state.workspace == .hidden,
                        "B did not finish the one same-owner plain terminal reduction")
            XCTAssertEqual(events.wipes, 0); XCTAssertTrue(request.isInvalidated)
            await tokens.gate.release(); try await processed(old)
            if workspace {
                let actual = await receipts.workspaces
                try require(actual.count == 1 && actual.first?.requester === request && actual.first?.outcome == .signedOutNotWiped,
                            "A did not actually classify workspace not-wiped through the same requester")
            } else {
                let actual = await receipts.members
                try require(actual.count == 2 && actual.last?.requester === request && actual.last?.outcome == .signedOutNotWiped,
                            "A did not actually classify member not-wiped through the same requester")
            }
            if loader.terminalStrength == .signedOut && events.ends == 1 && events.wipes == 0 && request.isInvalidated {
                throw SameOwnerTerminalLost()
            }
            XCTAssertEqual(events.ends, 1); XCTAssertEqual(events.wipes, 1)
            XCTAssertEqual(loader.terminalStrength, .signedOutNotWiped)
        } catch {
            let original = error
            do { try await finish(gates: [tokens.gate, plainGate], workers: workers) }
            catch { XCTFail("same-owner cleanup could not acknowledge every captured worker") }
            throw original
        }
        try await finish(gates: [tokens.gate, plainGate], workers: workers)
    }
    func testActualMemberReaderForwardsObsoleteNotWipedAfterPlainEnd() async throws { try await classifiedRace(workspace: false) }
    func testActualWorkspaceReaderForwardsObsoleteNotWipedAfterNewMemberPlainEnd() async throws { try await classifiedRace(workspace: true) }

    func testOrdinaryRefusalWaitsForExplicitRetryAndKeepsSession() async throws {
        let m = me([.init(value: member()), .init(value: member())])
        let w = channels([.init(value: .unavailable(.forbidden)), .init(value: .loaded(snapshot("Retried")))])
        let events = ChannelEvents(), loader = events.loader(); loader.setForeground(true)
        bind(loader, try requester(), m, w)
        try await until { loader.state.workspace == .unavailable(.forbidden) }
        loader.setForeground(true)
        let before = await m.calls; XCTAssertEqual(before, 1); XCTAssertTrue(events.effects.isEmpty)
        loader.retry(); try await until { self.label(loader) == "Retried" }
        let after = await m.calls; XCTAssertEqual(after, 2)
    }

    func testAuthenticationCompletionPolicyIsInsideCoordinator() throws {
        let loader = ChannelEvents().loader()
        let old = try XCTUnwrap(loader.beginAuthentication())
        XCTAssertNil(loader.beginAuthentication())
        loader.enter(realm: realm, requester: nil)
        var applied = 0
        loader.completeAuthentication(old) { applied += 1 }
        XCTAssertEqual(applied, 0)
        XCTAssertNil(loader.beginAuthentication(), "a live accepted session cannot start another sign-in")
        _ = loader.beginSignOut()
        let current = try XCTUnwrap(loader.beginAuthentication())
        loader.completeAuthentication(current) { applied += 1 }
        loader.completeAuthentication(current) { applied += 1 }
        XCTAssertEqual(applied, 1)
    }
    func testAuthenticationNotWipedUsesSameMonotonicOwnerRecord() throws {
        let events = ChannelEvents(), loader = events.loader()
        loader.enter(realm: realm, requester: nil)
        let signOut = try XCTUnwrap(loader.beginSignOut())
        let authentication = try XCTUnwrap(loader.beginAuthentication())
        var applied = false
        loader.completeAuthentication(authentication, failed: true, notWiped: true) { applied = true }
        loader.completeSignOut(signOut, notWiped: true)
        XCTAssertFalse(applied)
        XCTAssertEqual(events.ends, 1); XCTAssertEqual(events.wipes, 1)
        XCTAssertEqual(loader.terminalStrength, .signedOutNotWiped)
        let retry = try XCTUnwrap(loader.beginAuthentication())
        let before = events.effects
        loader.completeAuthentication(retry, failed: true) { applied = true }
        XCTAssertFalse(applied)
        XCTAssertFalse(events.effects.dropFirst(before.count).contains(.clearNotice))
        XCTAssertEqual(events.ends, 1); XCTAssertEqual(events.wipes, 1)
    }

    func testNewMemberPlainEndBeforeOldWorkspaceNotWipedUpgrades() async throws {
        try await terminalOrder(workspace: true, warningFirst: false, crossReader: true)
    }
    func testOldWorkspaceNotWipedBeforeNewMemberPlainEndStaysStrong() async throws {
        try await terminalOrder(workspace: true, warningFirst: true, crossReader: true)
    }
    func testRetryKeepsObsoleteOwnersWipeReceiptWithoutDuplicatingLoading() async throws {
        let gate = ChannelGate(); defer { Task { await gate.release() } }
        let m = me([.init(value: .signedOutNotWiped, gate: gate), .init(value: .unavailable(.identityUnavailable)), .init(value: .signedOut)])
        let events = ChannelEvents(), loader = events.loader(); loader.setForeground(true)
        bind(loader, try requester(), m, channels([]))
        try await until { await m.calls == 1 }; let old = try XCTUnwrap(loader.readTask)
        loader.setForeground(false); loader.setForeground(true)
        try await until { loader.state.member == .unavailable(.coreUnavailable) }
        loader.retry()
        try await until { events.ends == 1 }
        await gate.release(); try await processed(old)
        XCTAssertEqual(events.ends, 1); XCTAssertEqual(events.wipes, 1)
        let calls = await m.calls; XCTAssertEqual(calls, 3)
    }
    func testReadShutdownRejectsOldDataButNotByLosingTheWorker() async throws {
        let gate = ChannelGate(); defer { Task { await gate.release() } }
        let m = me([.init(value: member())]), w = channels([.init(value: .loaded(snapshot("Old")), gate: gate)])
        let events = ChannelEvents(), loader = events.loader(); loader.setForeground(true)
        bind(loader, try requester(), m, w)
        try await until { await w.calls == 1 }; let old = try XCTUnwrap(loader.readTask)
        loader.closeReads(); await gate.release(); try await processed(old)
        XCTAssertEqual(loader.state.workspace, .hidden); XCTAssertTrue(events.effects.isEmpty)
    }
    func testWorkspaceStatesAndEveryOrdinaryFailurePreserveTypedOutcomes() async throws {
        let base = snapshot("Ordered")
        let empty = WorkspaceSnapshot(organisationId: organisation, state: .initialised, setup: base.setup,
            canInitialise: false, id: base.id, categories: [], uncategorisedChannels: [])
        let notInitialised = WorkspaceSnapshot(organisationId: organisation, state: .notInitialised, setup: base.setup,
            canInitialise: false, id: nil, categories: [], uncategorisedChannels: [])
        let failures: [WorkspaceFailure] = [.forbidden, .notFound, .protocolViolation, .serviceUnavailable, .identityUnavailable,
            .transport(.timeout), .transport(.offline), .transport(.tls), .transport(.authenticationChallenge), .transport(.other)]
        let outcomes = [base, empty, notInitialised].map { WorkspaceOutcome.loaded($0) } + failures.map { .unavailable($0) }
        for outcome in outcomes {
            let events = ChannelEvents(), loader = events.loader(); loader.setForeground(true)
            bind(loader, try requester(), me([.init(value: member())]), channels([.init(value: outcome)]))
            switch outcome {
            case let .loaded(expected): try await until { loader.state.workspace == .loaded(expected) }
            case let .unavailable(expected): try await until { loader.state.workspace == .unavailable(expected) }
            case .signedOut, .signedOutNotWiped: XCTFail("unexpected fixture")
            }
            XCTAssertTrue(events.effects.isEmpty)
        }
    }

}
