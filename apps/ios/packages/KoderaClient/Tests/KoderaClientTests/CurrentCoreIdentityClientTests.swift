import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
import KoderaDomain
@testable import KoderaClient

private typealias IdentityReader = CurrentCoreIdentityClient
private struct IdentityTestError: Error {}
private struct OldIdentityPublishedAfterNewIdentity: Error {}
private struct WrongIssuerIdentityAccepted: Error {}
private struct DanglingMembershipLinkAccepted: Error {}
private struct SameClosedOwnerWipeReceiptLost: Error {}
private struct RetiredOwnerWipeReceiptAdmitted: Error {}

private actor IdentityTokens: AccessTokenProvider {
    var failure: AccessTokenFailure?
    var failWipe = false
    var calls: [Bool] = []
    var ends = 0
    var signOuts = 0
    func setFailure(_ value: AccessTokenFailure?) { failure = value }
    func setFailWipe() { failWipe = true }
    func accessToken(forceRefresh: Bool) async throws(AccessTokenFailure) -> AccessToken {
        calls.append(forceRefresh)
        if let failure { throw failure }
        return AccessToken(value: "synthetic-identity-access", session: 7)
    }
    func signOut() async throws(SessionNotWiped) { signOuts += 1 }
    func endSessionLocally(servedBy session: UInt64) async throws(SessionNotWiped) {
        ends += 1
        if failWipe { throw SessionNotWiped() }
    }
}

/// G2 starts in the synchronous loading callback, but its REAL requester cannot send HTTP
/// until Old has actually decoded. This fake token provider supplies no decoded response.
private actor IdentityHeldTokens: AccessTokenProvider {
    var waiting = false
    private var released = false
    private var continuation: CheckedContinuation<Void, Never>?
    func accessToken(forceRefresh: Bool) async throws(AccessTokenFailure) -> AccessToken {
        waiting = true
        if !released { await withCheckedContinuation { continuation = $0 } }
        return AccessToken(value: "synthetic-held-g2-access", session: 8)
    }
    func release() { released = true; continuation?.resume(); continuation = nil }
    func signOut() async throws(SessionNotWiped) {}
    func endSessionLocally(servedBy session: UInt64) async throws(SessionNotWiped) {}
}

/// Holds an outcome only AFTER the actual requester and strict decoder have returned it.
private actor IdentityReductionGate {
    let subject: String?
    let fail: Bool
    var entered = false
    var observed: IdentityReader.Outcome?
    private var released = false
    private var continuation: CheckedContinuation<Void, Never>?
    init(subject: String? = nil, fail: Bool = false) { self.subject = subject; self.fail = fail }
    func hold(_ outcome: IdentityReader.Outcome) async throws {
        if let subject {
            guard case let .identity(identity) = outcome, identity.subject == subject else { return }
        }
        guard !entered else { return }
        observed = outcome
        entered = true
        if !released { await withCheckedContinuation { continuation = $0 } }
        if fail { throw IdentityTestError() }
    }
    func release() { released = true; continuation?.resume(); continuation = nil }
}

@MainActor
private final class IdentityPort: IdentityReader.OwnerPort {
    var snapshot: IdentityReader.OwnerSnapshot?
    var captureHook: (() throws -> Void)?
    var currentHook: (() throws -> Void)?
    var current = true
    var checks = 0
    func capture() throws -> IdentityReader.OwnerSnapshot? { try captureHook?(); return snapshot }
    func isCurrent(_ value: IdentityReader.OwnerSnapshot) throws -> Bool {
        checks += 1
        try currentHook?()
        guard let snapshot else { return false }
        return current && snapshot.marker === value.marker && snapshot.requester === value.requester &&
            snapshot.issuer == value.issuer && snapshot.organisationId == value.organisationId
    }
}

@MainActor
private final class IdentityFixture {
    static let organisation = "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f"
    static let identity = "11111111-2222-4333-8444-555555555555"
    static let otherIdentity = "99999999-2222-4333-8444-555555555555"
    static let issuer = "https://id.example.test/realms/example"
    let port = IdentityPort()
    let tokens = IdentityTokens()
    let requester: CoreRequester
    var reader: IdentityReader!
    var states: [IdentityReader.State] = []
    var events: [IdentityReader.TerminalEvent] = []
    var onRead: ((IdentityReader.ReadHandle, IdentityReader.State) throws -> Void)?
    var onTerminal: ((IdentityReader.OwnerHandle, IdentityReader.TerminalEvent) throws -> Void)?

    init(gate: IdentityReductionGate? = nil) throws {
        requester = try CoreRequester(coreApiOrigin: "https://core.test", loopback: .refuse,
            tokens: tokens, protocolClass: URLProtocolFixture.self, timeout: 2)
        port.snapshot = try Self.snapshot(requester)
        reader = IdentityReader(owners: port, onReadState: { [weak self] read, state in
            guard let self else { return }; states.append(state); try onRead?(read, state)
        }, onTerminal: { [weak self] owner, event in
            guard let self else { return }; events.append(event); try onTerminal?(owner, event)
        }, beforeReductionForTest: { outcome in try await gate?.hold(outcome) })
    }
    static func snapshot(_ requester: CoreRequester, marker: AnyObject = NSObject(),
                         organisation: String = IdentityFixture.organisation) throws -> IdentityReader.OwnerSnapshot {
        IdentityReader.OwnerSnapshot(marker: marker, requester: requester,
            issuer: try IssuerAdmission.admit(issuer: issuer, admittedOrigins: ["https://id.example.test"], loopback: .refuse),
            organisationId: organisation)
    }
    static func body(_ subject: String = "Case-Sensitive|Subject") -> [String: Any] {
        ["id": "22222222-2222-4333-8444-555555555555", "staff": false,
         "identities": [["id": identity, "issuer": issuer, "realm": "example", "subject": subject]],
         "organisations": [["organisation": ["id": organisation, "slug": "example", "realm": "example"],
                            "state": "active", "identity_id": identity]]]
    }
    static func data(_ body: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]) }
    static func install(_ body: [String: Any] = IdentityFixture.body(), status: Int = 200) throws {
        URLProtocolFixture.install(.body(status: status, headers: [:], chunks: [try data(body)]))
    }
    func accept() throws -> IdentityReader.OwnerHandle { try XCTUnwrap(reader.acceptCurrentOwner()) }
    func prepare(_ owner: IdentityReader.OwnerHandle? = nil) throws -> IdentityReader.ReadHandle {
        let accepted = try owner ?? accept()
        return try XCTUnwrap(reader.prepareRead(accepted))
    }
    func begin(_ owner: IdentityReader.OwnerHandle? = nil) throws -> IdentityReader.ReadHandle {
        let read = try prepare(owner); reader.startRead(read); return read
    }
    func replace() throws -> IdentityReader.OwnerHandle {
        port.snapshot = try Self.snapshot(requester)
        return try accept()
    }
    var identity: IdentityReader.CoreIdentity? {
        guard case let .resolved(_, identity) = reader.state else { return nil }; return identity
    }
    var failure: IdentityReader.Failure? {
        guard case let .unavailable(_, failure) = reader.state else { return nil }; return failure
    }
}

@MainActor
final class CurrentCoreIdentityClientTests: XCTestCase {
    private typealias C = IdentityReader
    private typealias F = IdentityFixture
    private func until(_ predicate: @MainActor () async -> Bool, file: StaticString = #filePath,
                       line: UInt = #line) async throws {
        let clock = ContinuousClock(), deadline = ContinuousClock().now + .seconds(5)
        while !(await predicate()) {
            guard clock.now < deadline else { XCTFail("identity operation did not finish", file: file, line: line); throw IdentityTestError() }
            try await Task.sleep(for: .milliseconds(5))
        }
    }
    @discardableResult private func settled(_ read: C.ReadHandle) async throws -> C.Disposition {
        var completed = false
        let task = Task { @MainActor in
            defer { completed = true }
            return try await read.waitForCompletion()
        }
        try await until { completed }
        return try await task.value
    }
    private func exceptional(_ read: C.ReadHandle, _ kind: C.ExecutionKind) async throws {
        do { _ = try await settled(read); XCTFail("execution failure must not become a normal disposition") }
        catch let error as C.ExecutionError { XCTAssertEqual(error.kind, kind) }
    }
    private func refused(_ body: [String: Any], _ failure: C.Failure = .protocolViolation) async throws {
        try F.install(body); let f = try F(); try await settled(f.begin()); XCTAssertEqual(f.failure, failure); XCTAssertNil(f.identity)
    }
    private func withMembership(_ mutate: (inout [String: Any]) -> Void) -> [String: Any] {
        var body = F.body(); var entries = body["organisations"] as! [[String: Any]]
        mutate(&entries[0]); body["organisations"] = entries; return body
    }
    private func withIdentity(_ mutate: (inout [String: Any]) -> Void) -> [String: Any] {
        var body = F.body(); var entries = body["identities"] as! [[String: Any]]
        mutate(&entries[0]); body["identities"] = entries; return body
    }

    func testCurrentIdentityUsesRealRequesterAndPreservesOpaqueSubject() async throws {
        try F.install(); let f = try F(); let read = try f.begin(); try await settled(read)
        XCTAssertEqual(f.identity?.id, F.identity); XCTAssertEqual(f.identity?.subject, "Case-Sensitive|Subject")
        XCTAssertEqual(f.identity?.issuer, F.issuer); XCTAssertEqual(f.identity?.organisationId, F.organisation)
        XCTAssertEqual(URLProtocolFixture.requests.count, 1)
        XCTAssertEqual(URLProtocolFixture.requests.first?.url?.absoluteString, "https://core.test/api/v1/me")
        XCTAssertEqual(URLProtocolFixture.requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-identity-access")
        XCTAssertFalse(f.requester.isInvalidated)
    }
    func testIgnoredDisplayFieldsDoNotBecomeIdentityPrerequisites() async throws {
        var body = F.body(); body["email"] = [false]; body["display_name"] = 9; body["role"] = NSNull()
        var entries = body["organisations"] as! [[String: Any]]; entries[0]["role"] = [9]; entries[0]["membership_id"] = false
        body["organisations"] = entries; try F.install(body); let f = try F(); try await settled(f.begin()); XCTAssertNotNil(f.identity)
    }
    func testSubjectBoundaryAndRawCase() async throws {
        for subject in ["A", String(repeating: "Z", count: 255), "A|b:Case-!~"] {
            try F.install(F.body(subject)); let f = try F(); try await settled(f.begin()); XCTAssertEqual(f.identity?.subject, subject)
        }
        for subject in ["", "has space", "é", "a\n", String(repeating: "s", count: 256)] {
            try await refused(withIdentity { $0["subject"] = subject })
        }
    }
    func testWrongIssuerCannotBeAdmittedAsCurrentIdentity() async throws {
        let body = withIdentity { $0["issuer"] = "https://other.example.test/realms/example" }
        try F.install(body); let f = try F(); try await settled(f.begin())
        if let identity = f.identity, identity.issuer == "https://other.example.test/realms/example",
           identity.id == F.identity, identity.realm == "example", identity.subject == "Case-Sensitive|Subject",
           identity.organisationId == F.organisation { throw WrongIssuerIdentityAccepted() }
        XCTAssertEqual(f.failure, .protocolViolation)
    }
    func testDanglingMembershipLinkCannotAdmitOtherwiseCurrentIdentity() async throws {
        let body = withMembership { $0["identity_id"] = F.otherIdentity }
        try F.install(body); let f = try F(); try await settled(f.begin())
        if let identity = f.identity, identity.id == F.identity, identity.id != F.otherIdentity,
           identity.issuer == F.issuer, identity.realm == "example", identity.subject == "Case-Sensitive|Subject",
           identity.organisationId == F.organisation { throw DanglingMembershipLinkAccepted() }
        XCTAssertEqual(f.failure, .protocolViolation)
    }
    func testMissingLinkIsIneligibleButNullWrongTypeAndMalformedAreProtocolFailures() async throws {
        try await refused(withMembership { $0.removeValue(forKey: "identity_id") }, .notEligible)
        for value in [NSNull(), false, 3, "not-uuid"] as [Any] { try await refused(withMembership { $0["identity_id"] = value }) }
    }
    func testExactIdentityLinkWinsOverArrayOrder() async throws {
        var body = F.body(); var identities = body["identities"] as! [[String: Any]]
        identities.insert(["id": F.otherIdentity, "issuer": "https://linked.example.test/realms/linked", "realm": "linked", "subject": "Other"], at: 0)
        body["identities"] = identities; try F.install(body); let f = try F(); try await settled(f.begin()); XCTAssertEqual(f.identity?.id, F.identity)
    }
    func testWrongSelectedRealmAndMalformedUnusedIdentityRefuse() async throws {
        try await refused(withIdentity { $0["realm"] = "different" })
        var body = F.body(); var ids = body["identities"] as! [[String: Any]]; ids.append(["id": F.otherIdentity])
        body["identities"] = ids; try await refused(body)
    }
    func testDuplicateIdentityIdOrExactIssuerRefuses() async throws {
        for duplicateIssuer in [true, false] {
            var body = F.body(); var ids = body["identities"] as! [[String: Any]]; var second = ids[0]
            if duplicateIssuer { second["id"] = F.otherIdentity } else { second["issuer"] = "https://other.test/realms/example" }
            ids.append(second); body["identities"] = ids; try await refused(body)
        }
    }
    func testIdentityStructuralBounds() async throws {
        for key in ["id", "issuer", "realm", "subject"] {
            try await refused(withIdentity { $0.removeValue(forKey: key) })
            try await refused(withIdentity { $0[key] = NSNull() })
        }
        for issuer in ["", "has space", String(repeating: "i", count: 2049)] { try await refused(withIdentity { $0["issuer"] = issuer }) }
        try await refused(withIdentity { $0["id"] = F.identity.uppercased().replacingOccurrences(of: "1", with: "A") })
        try await refused(withIdentity { $0["realm"] = "UPPER" })
    }
    func testRootIdStaffAndRequiredArrays() async throws {
        for key in ["id", "staff", "identities", "organisations"] {
            var body = F.body(); body.removeValue(forKey: key); try await refused(body)
        }
        for value in [true, 0, "false", NSNull()] as [Any] { var body = F.body(); body["staff"] = value; try await refused(body) }
    }
    func testRealmMembershipAmbiguityIsCountedBeforeEligibility() async throws {
        for state in ["active", "invited", "suspended", "removed"] {
            var body = F.body(); var entries = body["organisations"] as! [[String: Any]]; var second = entries[0]
            var org = second["organisation"] as! [String: Any]; org["id"] = "8f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f"
            second["organisation"] = org; second["state"] = state; entries.append(second); body["organisations"] = entries
            try await refused(body)
        }
    }
    func testMissingNullAndUnmatchedRealmAreIneligible() async throws {
        for value in [nil, NSNull(), "other"] as [Any?] {
            let body = withMembership { entry in
                var org = entry["organisation"] as! [String: Any]
                org["realm"] = value; if value as? String == "other" { org["slug"] = "other" }; entry["organisation"] = org
            }
            try await refused(body, .notEligible)
        }
    }
    func testInactiveOrOtherTargetIsIneligible() async throws {
        for state in ["invited", "suspended", "removed"] { try await refused(withMembership { $0["state"] = state }, .notEligible) }
        try F.install(); let f = try F(); f.port.snapshot = try F.snapshot(f.requester, organisation: "8f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f")
        try await settled(f.begin()); XCTAssertEqual(f.failure, .notEligible)
    }
    func testDuplicateOrganisationAndRealmSlugContradictionRefuse() async throws {
        var body = F.body(); let entries = body["organisations"] as! [[String: Any]]; body["organisations"] = entries + entries
        try await refused(body)
        try await refused(withMembership { entry in var org = entry["organisation"] as! [String: Any]; org["slug"] = "different"; entry["organisation"] = org })
        try await refused(withMembership { $0["state"] = "unknown" })
    }
    func testMembershipBoundAndWrongShapes() async throws {
        var body = F.body(); body["organisations"] = Array(repeating: [String: Any](), count: 101); try await refused(body)
        for key in ["identities", "organisations"] { var body = F.body(); body[key] = false; try await refused(body) }
        try await refused(withMembership { $0["organisation"] = [] })
    }
    func testOneHundredDistinctMembershipsAndMaximumUnusedIssuerAreAccepted() async throws {
        var body = F.body(); var entries = body["organisations"] as! [[String: Any]]
        for index in 1...99 {
            let suffix = String(format: "%012d", index)
            entries.append(["organisation": ["id": "8f1d2e3c-8a4b-4c5d-9e6f-" + suffix, "slug": "other", "realm": "other"], "state": "removed"])
        }
        var identities = body["identities"] as! [[String: Any]]
        identities.append(["id": F.otherIdentity, "issuer": String(repeating: "x", count: 2048), "realm": "other", "subject": "O"])
        body["identities"] = identities; body["organisations"] = entries
        try F.install(body); let f = try F(); try await settled(f.begin()); XCTAssertNotNil(f.identity)
    }
    func testGlobalStrictJsonRejectsMalformedIgnoredValuesAndOversizedBody() async throws {
        let base = String(decoding: try F.data(F.body()), as: UTF8.self)
        let invalid: [Data] = [Data("not-json".utf8), Data((base + " trailing").utf8), Data([0xFF]),
            Data(base.replacingOccurrences(of: "\"staff\":false", with: "\"staff\":false,\"st\\u0061ff\":false").utf8),
            Data(base.replacingOccurrences(of: "\"staff\":false", with: "\"staff\":false,\"ignored\":\"\\uD800\"").utf8),
            Data(base.replacingOccurrences(of: "\"staff\":false", with: "\"staff\":false,\"ignored\":" + String(repeating: "[", count: 20) + "0" + String(repeating: "]", count: 20)).utf8),
            Data(repeating: 32, count: 65537)]
        for bytes in invalid {
            URLProtocolFixture.install(.body(status: 200, headers: [:], chunks: [bytes])); let f = try F(); try await settled(f.begin()); XCTAssertEqual(f.failure, .protocolViolation)
        }
    }
    func testExactLogicalBodyBoundaryAcceptsPadding() async throws {
        var bytes = try F.data(F.body()); bytes.append(Data(repeating: 32, count: 65536 - bytes.count))
        URLProtocolFixture.install(.body(status: 200, headers: [:], chunks: [bytes])); let f = try F(); try await settled(f.begin()); XCTAssertNotNil(f.identity)
    }
    func testStatusMappingsAndNoAutomaticRetry() async throws {
        let cases: [(Int, C.Failure)] = [(403, .forbidden), (429, .serviceUnavailable), (500, .serviceUnavailable),
            (503, .serviceUnavailable), (304, .protocolViolation), (404, .protocolViolation), (302, .protocolViolation)]
        for (status, failure) in cases {
            try F.install(status: status); let f = try F(); try await settled(f.begin()); XCTAssertEqual(f.failure, failure)
            XCTAssertEqual(URLProtocolFixture.requests.count, 1); let calls = await f.tokens.calls; XCTAssertEqual(calls, [false])
        }
    }
    func testOneLogicalGetRetainsExisting401RefreshAndServedSessionEnd() async throws {
        URLProtocolFixture.install(sequence: [.body(status: 401, headers: [:], chunks: []), .body(status: 200, headers: [:], chunks: [try F.data(F.body())])])
        let f = try F(); try await settled(f.begin()); XCTAssertNotNil(f.identity)
        let calls = await f.tokens.calls; XCTAssertEqual(calls, [false, true]); XCTAssertEqual(URLProtocolFixture.requests.count, 2)
        URLProtocolFixture.install(.body(status: 401, headers: [:], chunks: []))
        let second = try f.prepare(); f.reader.startRead(second); try await settled(second)
        XCTAssertEqual(second.owner.terminalReceipt.strength, .signedOut); let ends = await f.tokens.ends; XCTAssertEqual(ends, 1)
    }
    func testIdentityUnavailableAndTransportAreTyped() async throws {
        let f = try F(); await f.tokens.setFailure(.unavailable); try await settled(f.begin()); XCTAssertEqual(f.failure, .identityUnavailable)
        URLProtocolFixture.install(.failure(.notConnectedToInternet)); let g = try F(); try await settled(g.begin()); XCTAssertEqual(g.failure, .transport(.offline))
    }
    func testPrepareIssuesHandleBeforeLoadingAndDuplicateStartSendsOnce() async throws {
        try F.install(); let f = try F(); let owner = try f.accept(); let read = try f.prepare(owner)
        XCTAssertTrue(f.states.isEmpty); XCTAssertTrue(URLProtocolFixture.requests.isEmpty)
        XCTAssertTrue(try f.prepare(owner) === read)
        f.onRead = { observed, state in if case .loading = state { XCTAssertTrue(observed === read) } }
        f.reader.startRead(read); f.reader.startRead(read); try await settled(read)
        XCTAssertEqual(URLProtocolFixture.requests.count, 1); XCTAssertTrue(read.owner === owner)
    }
    func testRepeatedCaptureIsStableAndGenuineEqualFieldReplacementIsNew() throws {
        let f = try F(); let old = try f.accept(); XCTAssertTrue(try f.accept() === old)
        let fresh = try f.replace(); XCTAssertFalse(fresh === old); XCTAssertNil(try f.reader.prepareRead(old))
    }
    func testRetainedMarkerCannotChangeBindingOrReopen() throws {
        try F.install()
        let f = try F(); let owner = try f.accept(); let marker = try XCTUnwrap(f.port.snapshot).marker
        f.port.snapshot = try F.snapshot(f.requester, marker: marker, organisation: "8f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f")
        XCTAssertThrowsError(try f.reader.acceptCurrentOwner()); XCTAssertTrue(URLProtocolFixture.requests.isEmpty)
        let g = try F(); let ended = try g.accept(); g.reader.endOwner(ended); XCTAssertNil(try g.reader.acceptCurrentOwner())
        XCTAssertNil(try g.reader.prepareRead(ended)); _ = owner
    }
    func testCaptureThrowBeforeHandleStartsNoWork() throws {
        try F.install()
        let f = try F(); f.port.captureHook = { throw IdentityTestError() }
        XCTAssertThrowsError(try f.reader.acceptCurrentOwner()); XCTAssertTrue(f.states.isEmpty); XCTAssertTrue(URLProtocolFixture.requests.isEmpty)
        f.port.captureHook = nil; XCTAssertNil(try f.reader.prepareRead(f.replace()))
    }
    func testCaptureSwallowedReentryRemainsSticky() throws {
        try F.install()
        let f = try F(); f.port.captureHook = { do { _ = try f.reader.acceptCurrentOwner() } catch {} }
        XCTAssertThrowsError(try f.reader.acceptCurrentOwner()); XCTAssertTrue(URLProtocolFixture.requests.isEmpty)
    }
    func testPreparePortFailureIsSynchronousAndZeroWork() throws {
        try F.install()
        let f = try F(); let owner = try f.accept(); f.port.currentHook = { throw IdentityTestError() }
        XCTAssertThrowsError(try f.reader.prepareRead(owner)); XCTAssertTrue(URLProtocolFixture.requests.isEmpty)
    }
    func testEveryPrepareToStartInvalidationSettlesSameHandleWithoutWork() async throws {
        for action in 0..<5 {
            try F.install(); let f = try F(); let read = try f.prepare()
            switch action {
            case 0: f.reader.cancelRead(read)
            case 1: f.reader.endOwner(read.owner)
            case 2: f.reader.closeReads()
            case 3: f.requester.invalidate()
            default: _ = try f.replace()
            }
            f.reader.startRead(read); let result = try await settled(read)
            guard case .dropped = result else { return XCTFail("retired pending operation started") }
            XCTAssertTrue(URLProtocolFixture.requests.isEmpty); let calls = await f.tokens.calls; XCTAssertTrue(calls.isEmpty)
        }
    }
    func testStartRechecksPortAndFailureBelongsToIssuedHandle() async throws {
        for throwsError in [false, true] {
            try F.install(); let f = try F(); let read = try f.prepare()
            if throwsError { f.port.currentHook = { throw IdentityTestError() } } else { f.port.current = false }
            f.reader.startRead(read)
            if throwsError { try await exceptional(read, .ownerPort) } else { _ = try await settled(read) }
            XCTAssertTrue(URLProtocolFixture.requests.isEmpty); XCTAssertFalse(f.requester.isInvalidated)
        }
    }
    func testStartRechecksChangedFullSnapshotWithoutScheduling() async throws {
        try F.install()
        let f = try F(); let read = try f.prepare(); let original = try XCTUnwrap(f.port.snapshot)
        f.port.snapshot = try F.snapshot(f.requester, marker: original.marker, organisation: "8f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f")
        f.reader.startRead(read); _ = try await settled(read)
        XCTAssertTrue(URLProtocolFixture.requests.isEmpty); let calls = await f.tokens.calls; XCTAssertTrue(calls.isEmpty)
    }
    func testStartSwallowedPortReentryFailsIssuedHandle() async throws {
        try F.install()
        let f = try F(); let read = try f.prepare()
        f.port.currentHook = { do { _ = try f.reader.acceptCurrentOwner() } catch {} }
        f.reader.startRead(read); try await exceptional(read, .ownerPort); XCTAssertTrue(URLProtocolFixture.requests.isEmpty)
    }
    func testForeignReaderHandlesCannotBeSettledOrStarted() async throws {
        try F.install(); let f = try F(); let g = try F(); let read = try f.prepare()
        g.reader.startRead(read); g.reader.cancelRead(read); g.reader.endOwner(read.owner); g.reader.retireOwner(read.owner)
        XCTAssertTrue(URLProtocolFixture.requests.isEmpty); f.reader.startRead(read); try await settled(read); XCTAssertNotNil(f.identity)
    }
    func testStalePrivatePreparedHandleDoesNotConsultThrowingPort() async throws {
        let f = try F(); let old = try f.prepare(); _ = try f.replace()
        let checks = f.port.checks; f.port.currentHook = { throw IdentityTestError() }
        f.reader.startRead(old); _ = try await settled(old); XCTAssertEqual(f.port.checks, checks)
    }
    func testDecodedOldCannotReplaceAlreadyPublishedNew() async throws {
        let gate = IdentityReductionGate(subject: "Old-Subject"); try F.install(F.body("Old-Subject")); let f = try F(gate: gate)
        let old = try f.begin(); try await until { await gate.entered }
        try F.install(F.body("New-Subject")); let owner = try f.replace(); let fresh = try f.begin(owner); try await settled(fresh)
        XCTAssertEqual(f.identity?.subject, "New-Subject"); await gate.release(); _ = try await settled(old)
        if f.identity?.subject == "Old-Subject" { throw OldIdentityPublishedAfterNewIdentity() }
        XCTAssertEqual(f.identity?.subject, "New-Subject"); XCTAssertFalse(f.requester.isInvalidated)
    }
    func testCancelEndAndCloseWaitForRealWorkerAndReduction() async throws {
        for action in 0..<3 {
            let gate = IdentityReductionGate(); try F.install(); let f = try F(gate: gate); let read = try f.begin()
            try await until { await gate.entered }; var completed = false
            let wait = Task { @MainActor in defer { completed = true }; return try await read.waitForCompletion() }
            switch action { case 0: f.reader.cancelRead(read); case 1: f.reader.endOwner(read.owner); default: f.reader.closeReads() }
            await Task.yield(); XCTAssertFalse(completed); await gate.release(); try await until { completed }; _ = try await wait.value
            XCTAssertNil(f.identity); XCTAssertFalse(f.requester.isInvalidated)
        }
    }
    func testIndependentWaitersAndAwaiterCancellationDoNotCancelOperation() async throws {
        let gate = IdentityReductionGate(); try F.install(); let f = try F(gate: gate); let read = try f.begin()
        try await until { await gate.entered }
        let first = Task { try await read.waitForCompletion() }; let second = Task { try await read.waitForCompletion() }
        first.cancel(); await gate.release(); _ = try await first.value; _ = try await second.value; _ = try await settled(read)
        XCTAssertNotNil(f.identity); XCTAssertEqual(URLProtocolFixture.requests.count, 1)
    }
    func testLoadingObserverReentryCannotBeOverwrittenByOldFinalization() async throws {
        let gate = IdentityReductionGate(subject: "Old-Subject"); try F.install(F.body("Old-Subject")); let f = try F(gate: gate)
        let g2Tokens = IdentityHeldTokens()
        let g2Requester = try CoreRequester(coreApiOrigin: "https://core.test", loopback: .refuse,
            tokens: g2Tokens, protocolClass: URLProtocolFixture.self, timeout: 2)
        defer { g2Requester.invalidate() }
        let g2Snapshot = try F.snapshot(g2Requester)
        var old: C.ReadHandle?, fresh: C.ReadHandle?
        var startedInsideLoading = false
        f.onRead = { _, state in
            if case .loading = state, fresh == nil {
                f.onRead = nil
                f.port.snapshot = g2Snapshot
                fresh = try f.prepare(f.accept())
                f.reader.startRead(fresh!)
                startedInsideLoading = true
            }
        }
        do {
            old = try f.begin(); try await until { fresh != nil }
            let oldRead = try XCTUnwrap(old), freshRead = try XCTUnwrap(fresh)
            try await until { await gate.entered }
            guard case let .identity(decoded)? = await gate.observed,
                  decoded.subject == "Old-Subject", decoded.id == F.identity, decoded.issuer == F.issuer,
                  decoded.realm == "example", decoded.organisationId == F.organisation,
                  startedInsideLoading, oldRead.owner !== freshRead.owner else {
                XCTFail("loading-reentry setup must hold actual decoded Old after starting distinct G2"); throw IdentityTestError()
            }
            try await until { await g2Tokens.waiting }
            try F.install(F.body("New-Subject")); await g2Tokens.release()
            try await settled(freshRead)
            guard case let .resolved(published, identity) = f.reader.state, published === freshRead,
                  identity.id == F.identity, identity.subject == "New-Subject", identity.issuer == F.issuer,
                  identity.realm == "example", identity.organisationId == F.organisation else {
                XCTFail("G2 must complete its real New publication before Old release"); throw IdentityTestError()
            }
            await gate.release(); _ = try await settled(oldRead)
            XCTAssertEqual(f.identity?.subject, "New-Subject")
            guard case let .resolved(published, _) = f.reader.state else { return XCTFail("New state was lost") }
            XCTAssertTrue(published === freshRead)
        } catch {
            await g2Tokens.release(); await gate.release()
            if let fresh { _ = try? await settled(fresh) }
            if let old { _ = try? await settled(old) }
            throw error
        }
    }
    func testFinalObserverMayReplaceOwnerAndThrowWithoutPoisoningNew() async throws {
        try F.install(); let f = try F(); var fresh: C.ReadHandle?
        f.onRead = { _, state in
            if case .resolved = state {
                f.onRead = nil; fresh = try f.prepare(f.replace()); f.reader.startRead(fresh!); throw IdentityTestError()
            }
        }
        let old = try f.begin(); try await exceptional(old, .observer)
        try await settled(try XCTUnwrap(fresh)); XCTAssertNotNil(f.identity)
    }
    func testLoadingAndFinalObserverThrowsSettleExceptionallyWithoutRecursion() async throws {
        for loading in [true, false] {
            try F.install(); let f = try F(); var throwsCount = 0
            f.onRead = { _, state in
                let isLoading: Bool; if case .loading = state { isLoading = true } else { isLoading = false }
                if isLoading == loading { throwsCount += 1; throw IdentityTestError() }
            }
            let read = try f.begin(); try await exceptional(read, .observer); XCTAssertEqual(throwsCount, 1); XCTAssertNil(f.identity)
        }
    }
    func testFinalSwallowedPortReentryCannotAdmitIdentity() async throws {
        let gate = IdentityReductionGate(); try F.install(); let f = try F(gate: gate); let read = try f.begin()
        try await until { await gate.entered }
        f.port.currentHook = { do { _ = try f.reader.acceptCurrentOwner() } catch {} }
        await gate.release(); try await exceptional(read, .ownerPort); XCTAssertNil(f.identity); XCTAssertFalse(f.requester.isInvalidated)
    }
    func testFinalSnapshotChangeAndLiveRequesterFenceDropData() async throws {
        for closedRequester in [true, false] {
            let gate = IdentityReductionGate(); try F.install(); let f = try F(gate: gate); let read = try f.begin()
            try await until { await gate.entered }
            if closedRequester { f.requester.invalidate() } else { f.port.current = false }
            await gate.release(); _ = try await settled(read); XCTAssertNil(f.identity)
        }
    }
    func testFinalPortThrowClosesOnlyDataAndCompletesWholeHandle() async throws {
        let gate = IdentityReductionGate(); try F.install(); let f = try F(gate: gate); let read = try f.begin()
        try await until { await gate.entered }; f.port.currentHook = { throw IdentityTestError() }; await gate.release()
        try await exceptional(read, .ownerPort); XCTAssertNil(f.identity); XCTAssertFalse(f.requester.isInvalidated)
    }
    func testStaleOutcomeNeverConsultsThrowingFinalPort() async throws {
        let gate = IdentityReductionGate(); try F.install(); let f = try F(gate: gate); let read = try f.begin()
        try await until { await gate.entered }; f.reader.cancelRead(read); let checks = f.port.checks
        f.port.currentHook = { throw IdentityTestError() }; await gate.release(); _ = try await settled(read); XCTAssertEqual(f.port.checks, checks)
    }
    func testSameOwnerCancelledAndClosedReadStillRecordsWipeFailure() async throws {
        for action in 0..<4 {
            let gate = IdentityReductionGate(); let f = try F(gate: gate); await f.tokens.setFailure(.signedOutNotWiped)
            let read = try f.begin(); try await until { await gate.entered }
            switch action { case 0: f.reader.cancelRead(read); case 1: f.reader.endOwner(read.owner); case 2: f.reader.closeReads(); default: f.requester.invalidate() }
            await gate.release(); try await settled(read)
            XCTAssertEqual(read.owner.terminalReceipt.strength, .signedOutNotWiped)
            XCTAssertEqual(f.events.filter { $0.kind == .ended }.count, 1); XCTAssertEqual(f.events.filter { $0.kind == .requireWipe }.count, 1)
        }
    }
    func testDelayedSameClosedOwnerUpgradeAndNoDowngradeBothOrders() async throws {
        for firstWipe in [true, false] {
            let gate = IdentityReductionGate(); let f = try F(gate: gate)
            let captured = try XCTUnwrap(f.port.snapshot)
            var callbacks: [(C.OwnerHandle, C.TerminalEvent)] = []
            f.onTerminal = { callbacks.append(($0, $1)) }
            var old: C.ReadHandle?, fresh: C.ReadHandle?
            do {
                await f.tokens.setFailure(firstWipe ? .signedOutNotWiped : .signedOut)
                old = try f.begin(); try await until { await gate.entered }
                let oldRead = try XCTUnwrap(old), capturedOwner = oldRead.owner
                let actual = await gate.observed
                if firstWipe {
                    guard case .signedOutNotWiped? = actual else {
                        XCTFail("upgrade setup must hold an actual failed-wipe outcome"); throw IdentityTestError()
                    }
                } else {
                    guard case .signedOut? = actual else {
                        XCTFail("reverse-order setup must hold actual ordinary end"); throw IdentityTestError()
                    }
                }
                guard captured.requester === f.requester, captured.issuer.issuer == F.issuer,
                      captured.issuer.realm == "example", captured.organisationId == F.organisation else {
                    XCTFail("terminal setup requester/issuer/target binding changed"); throw IdentityTestError()
                }
                f.reader.cancelRead(oldRead)
                await f.tokens.setFailure(firstWipe ? .signedOut : .signedOutNotWiped)
                fresh = try f.begin(oldRead.owner); try await settled(try XCTUnwrap(fresh))
                guard fresh?.owner === capturedOwner,
                      f.port.snapshot === captured,
                      capturedOwner.terminalReceipt.strength == (firstWipe ? .signedOut : .signedOutNotWiped),
                      callbacks.filter({ $0.0 === capturedOwner && $0.1.kind == .ended }).count == 1 else {
                    XCTFail("same-owner newer terminal outcome must complete before delayed receipt"); throw IdentityTestError()
                }
                if firstWipe {
                    guard !callbacks.contains(where: { $0.1.kind == .requireWipe }),
                          !capturedOwner.terminalReceipt.pendingEvents.contains(where: { $0.kind == .requireWipe }) else {
                        XCTFail("upgrade setup already committed a wipe event"); throw IdentityTestError()
                    }
                }
                f.requester.invalidate(); f.reader.closeReads()
                guard captured.requester.isInvalidated else { throw IdentityTestError() }
                await gate.release(); try await settled(oldRead)
                let receipt = capturedOwner.terminalReceipt
                let ended = callbacks.filter { $0.0 === capturedOwner && $0.1.kind == .ended }
                let wipe = callbacks.filter { $0.0 === capturedOwner && $0.1.kind == .requireWipe }
                if firstWipe && receipt.strength == .signedOut && ended.count == 1 && wipe.isEmpty &&
                    !receipt.pendingEvents.contains(where: { $0.kind == .requireWipe }) {
                    throw SameClosedOwnerWipeReceiptLost()
                }
                XCTAssertEqual(oldRead.owner.terminalReceipt.strength, .signedOutNotWiped)
                XCTAssertEqual(f.events.filter { $0.kind == .ended }.count, 1); XCTAssertEqual(f.events.filter { $0.kind == .requireWipe }.count, 1)
            } catch {
                await gate.release()
                if let fresh { _ = try? await settled(fresh) }
                if let old { _ = try? await settled(old) }
                throw error
            }
        }
    }
    func testGenuineG2DropsRetiredG1TerminalEvenWithSamePublicFields() async throws {
        let gate = IdentityReductionGate(); let f = try F(gate: gate); await f.tokens.setFailure(.signedOutNotWiped)
        let capturedG1 = try XCTUnwrap(f.port.snapshot)
        let g2Tokens = IdentityTokens()
        let g2Requester = try CoreRequester(coreApiOrigin: "https://core.test", loopback: .refuse,
            tokens: g2Tokens, protocolClass: URLProtocolFixture.self, timeout: 2)
        defer { g2Requester.invalidate() }
        let capturedG2 = try F.snapshot(g2Requester)
        var callbacks: [(C.OwnerHandle, C.TerminalEvent)] = []
        f.onTerminal = { callbacks.append(($0, $1)) }
        var old: C.ReadHandle?, fresh: C.ReadHandle?
        do {
            old = try f.begin(); try await until { await gate.entered }
            let oldRead = try XCTUnwrap(old), capturedOwner = oldRead.owner
            guard case .signedOutNotWiped? = await gate.observed,
                  capturedOwner.terminalReceipt.strength == .none, capturedOwner.terminalReceipt.pendingEvents.isEmpty,
                  callbacks.isEmpty, capturedG1.requester === f.requester,
                  capturedG2.requester === g2Requester, capturedG2.requester !== capturedG1.requester,
                  capturedG1.marker !== capturedG2.marker, capturedG1.issuer == capturedG2.issuer,
                  capturedG1.organisationId == capturedG2.organisationId else {
                XCTFail("retirement setup must hold actual G1 wipe with exact distinct G2 input binding"); throw IdentityTestError()
            }
            await f.tokens.setFailure(nil); try F.install(F.body("New-Subject"))
            f.port.snapshot = capturedG2
            fresh = try f.begin(f.accept()); let freshRead = try XCTUnwrap(fresh); try await settled(freshRead)
            guard freshRead.owner !== capturedOwner, f.port.snapshot === capturedG2,
                  case let .resolved(published, identity) = f.reader.state, published === freshRead,
                  identity.id == F.identity, identity.subject == "New-Subject", identity.issuer == capturedG1.issuer.issuer,
                  identity.realm == capturedG1.issuer.realm, identity.organisationId == capturedG1.organisationId,
                  capturedOwner.terminalReceipt.strength == .none,
                  !capturedOwner.terminalReceipt.pendingEvents.contains(where: { $0.kind == .requireWipe }), callbacks.isEmpty else {
                XCTFail("genuine G2 must complete New with G1 still uncommitted before Old release"); throw IdentityTestError()
            }
            await gate.release(); _ = try await settled(oldRead)
            let receipt = capturedOwner.terminalReceipt
            let committedWipes = callbacks.filter { $0.0 === capturedOwner && $0.1.kind == .requireWipe }
            if receipt.strength == .signedOutNotWiped && committedWipes.count == 1 &&
                receipt.pendingEvents.contains(where: { $0 === committedWipes[0].1 }) {
                throw RetiredOwnerWipeReceiptAdmitted()
            }
            XCTAssertEqual(oldRead.owner.terminalReceipt.strength, .none); XCTAssertTrue(f.events.isEmpty); XCTAssertEqual(f.identity?.subject, "New-Subject")
        } catch {
            await gate.release()
            if let fresh { _ = try? await settled(fresh) }
            if let old { _ = try? await settled(old) }
            throw error
        }
    }
    func testExplicitOwnerRetirementRejectsLateTerminalAdmission() async throws {
        let gate = IdentityReductionGate(); let f = try F(gate: gate); await f.tokens.setFailure(.signedOutNotWiped)
        let read = try f.begin(); try await until { await gate.entered }; f.reader.retireOwner(read.owner); await gate.release()
        _ = try await settled(read); XCTAssertEqual(read.owner.terminalReceipt.strength, .none); XCTAssertTrue(f.events.isEmpty)
    }
    func testTerminalReconciliationDoesNotConsultDataPortOrReadSlot() async throws {
        let gate = IdentityReductionGate(); let f = try F(gate: gate); await f.tokens.setFailure(.signedOutNotWiped)
        let read = try f.begin(); try await until { await gate.entered }; f.reader.closeReads()
        f.port.currentHook = { throw IdentityTestError() }; f.port.current = false; await gate.release(); try await settled(read)
        XCTAssertEqual(read.owner.terminalReceipt.strength, .signedOutNotWiped)
    }
    func testThrowingEndedObserverCannotConsumeOnlyWipeWarning() async throws {
        let f = try F(); await f.tokens.setFailure(.signedOutNotWiped)
        f.onTerminal = { _, _ in throw IdentityTestError() }
        let read = try f.begin(); try await exceptional(read, .observer)
        let receipt = read.owner.terminalReceipt; XCTAssertEqual(receipt.strength, .signedOutNotWiped)
        XCTAssertEqual(receipt.pendingEvents.count, 2); XCTAssertEqual(f.events.count, 2)
        for event in receipt.pendingEvents { XCTAssertTrue(read.owner.acknowledgeTerminal(event)); XCTAssertTrue(read.owner.acknowledgeTerminal(event)) }
        XCTAssertTrue(read.owner.terminalReceipt.pendingEvents.isEmpty)
    }
    func testCommittedEventsSurviveThrowAndReentrantG2() async throws {
        let f = try F(); await f.tokens.setFailure(.signedOutNotWiped); var newOwner: C.OwnerHandle?
        f.onTerminal = { _, event in
            if event.kind == .ended { newOwner = try f.replace(); throw IdentityTestError() }
        }
        let old = try f.begin(); try await exceptional(old, .observer)
        XCTAssertEqual(old.owner.terminalReceipt.pendingEvents.count, 2)
        XCTAssertEqual(try XCTUnwrap(newOwner).terminalReceipt.strength, .none)
        for event in old.owner.terminalReceipt.pendingEvents { XCTAssertTrue(old.owner.acknowledgeTerminal(event)); XCTAssertFalse(newOwner!.acknowledgeTerminal(event)) }
    }
    func testHandleReadAndAckRemainPublicAfterReaderReleaseAndExceptionalCompletion() async throws {
        let f = try F(); await f.tokens.setFailure(.signedOutNotWiped); f.onTerminal = { _, _ in throw IdentityTestError() }
        let read = try f.begin(); try await exceptional(read, .observer)
        weak var weakReader = f.reader; f.reader = nil
        try await until { weakReader == nil }
        XCTAssertEqual(read.owner.terminalReceipt.strength, .signedOutNotWiped)
        for event in read.owner.terminalReceipt.pendingEvents { XCTAssertTrue(read.owner.acknowledgeTerminal(event)) }
        XCTAssertTrue(read.owner.terminalReceipt.pendingEvents.isEmpty); XCTAssertFalse(f.requester.isInvalidated)
    }
    func testCrossReaderAndCrossOwnerAcknowledgementIsRefused() async throws {
        let f = try F(); await f.tokens.setFailure(.signedOutNotWiped); let read = try f.begin(); try await settled(read)
        let event = try XCTUnwrap(read.owner.terminalReceipt.pendingEvents.first)
        let otherOwner = try f.replace(); let g = try F(); let foreignOwner = try g.accept()
        XCTAssertFalse(otherOwner.acknowledgeTerminal(event)); XCTAssertFalse(foreignOwner.acknowledgeTerminal(event))
        XCTAssertTrue(read.owner.acknowledgeTerminal(event))
    }
    func testSchedulingGateFailureRetainsAlreadyDecodedTerminalObligation() async throws {
        let gate = IdentityReductionGate(fail: true); let f = try F(gate: gate); await f.tokens.setFailure(.signedOutNotWiped)
        let read = try f.begin(); try await until { await gate.entered }; f.reader.closeReads(); await gate.release()
        try await exceptional(read, .postdecode); XCTAssertEqual(read.owner.terminalReceipt.strength, .signedOutNotWiped)
        XCTAssertEqual(read.owner.terminalReceipt.pendingEvents.count, 2)
    }
    func testServingSessionWipeFailureIsRetainedThroughActual401Path() async throws {
        URLProtocolFixture.install(.body(status: 401, headers: [:], chunks: [])); let f = try F(); await f.tokens.setFailWipe()
        let read = try f.begin(); try await settled(read)
        XCTAssertEqual(read.owner.terminalReceipt.strength, .signedOutNotWiped); let ends = await f.tokens.ends; XCTAssertEqual(ends, 1)
        let signOuts = await f.tokens.signOuts; XCTAssertEqual(signOuts, 0)
    }
    func testTerminalCompletionWaitsForObserverReturn() async throws {
        let f = try F(); await f.tokens.setFailure(.signedOutNotWiped); var notified = false
        f.onTerminal = { owner, _ in XCTAssertEqual(owner.terminalReceipt.strength, .signedOutNotWiped); notified = true }
        let read = try f.begin(); try await settled(read); XCTAssertTrue(notified)
        XCTAssertEqual(read.owner.terminalReceipt.pendingEvents.count, 2)
    }
    func testCloseReadsDoesNotAllowReopeningButCanRetireTerminalOwner() async throws {
        let f = try F(); let owner = try f.accept(); f.reader.closeReads(); XCTAssertNil(try f.reader.prepareRead(owner))
        let fresh = try f.replace(); XCTAssertFalse(owner === fresh); XCTAssertNil(try f.reader.prepareRead(fresh))
    }
    func testNilOwnerSnapshotRefusesBeforeTokenOrHTTPWork() async throws {
        try F.install()
        let f = try F()
        f.port.snapshot = try F.snapshot(f.requester, organisation: "00000000-0000-0000-0000-000000000000")
        XCTAssertNil(try f.reader.acceptCurrentOwner())
        let calls = await f.tokens.calls
        XCTAssertTrue(calls.isEmpty)
        XCTAssertTrue(URLProtocolFixture.requests.isEmpty)
        XCTAssertNil(f.identity)
    }
    func testNilMemberAndLinkedIdentityCannotBecomeCurrentIdentity() async throws {
        let nilID = "00000000-0000-0000-0000-000000000000"
        var member = F.body(); member["id"] = nilID
        try await refused(member)
        var linked = withIdentity { $0["id"] = nilID }
        var memberships = linked["organisations"] as! [[String: Any]]
        memberships[0]["identity_id"] = nilID
        linked["organisations"] = memberships
        try await refused(linked)
    }

}
