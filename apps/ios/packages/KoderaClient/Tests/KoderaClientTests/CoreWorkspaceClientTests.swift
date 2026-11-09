import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
import KoderaDomain
@testable import KoderaClient

@MainActor
final class CoreWorkspaceClientTests: XCTestCase {
    private typealias Object = [String: Any]
    private static let organisation = "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f"
    private static let channel = "0192f3a4-5b6c-7d8e-9f01-23456789abcf"
    private static let headers = ["Content-Type": "application/json", "Cache-Control": "no-store", "ETag": "\"synthetic-view\""]
    private static let raw = """
    {"organisation_id":"6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f","state":"initialised",
     "setup":{"state":"ready","reason":null},"can_initialise":false,"id":"0192f3a4-5b6c-7d8e-9f01-23456789abcd",
     "categories":[{"id":"0192f3a4-5b6c-7d8e-9f01-23456789abce","name":"Stored category","template_key":"future_section",
       "channels":[{"id":"0192f3a4-5b6c-7d8e-9f01-23456789abcf","kind":"text","name":"Stored channel","template_key":"general",
          "topic":"A topic","lifecycle":"active","room_state":"ready"},
         {"id":"0192f3a4-5b6c-7d8e-9f01-23456789abd0","kind":"audio","name":"Lounge","template_key":null,
          "topic":"","lifecycle":"archived","room_state":"pending"}]}],
     "uncategorised_channels":[{"id":"0192f3a4-5b6c-7d8e-9f01-23456789abd1","kind":"text","name":"Elsewhere","template_key":null,
       "topic":"","lifecycle":"active","room_state":"failed"}]}
    """

    private func tree() throws -> Object {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(Self.raw.utf8)) as? Object)
    }
    private func changed(_ edit: (inout Object) -> Void) throws -> Data {
        var object = try tree()
        edit(&object)
        return try DiscoveryFixtures.json(object)
    }
    private func category(_ root: inout Object, _ edit: (inout Object) -> Void) {
        var categories = root["categories"] as! [Object]
        edit(&categories[0])
        root["categories"] = categories
    }
    private func channel(_ root: inout Object, _ edit: (inout Object) -> Void) {
        category(&root) { value in
            var channels = value["channels"] as! [Object]
            edit(&channels[0])
            value["channels"] = channels
        }
    }
    private func setup(_ root: inout Object, _ edit: (inout Object) -> Void) {
        var value = root["setup"] as! Object
        edit(&value)
        root["setup"] = value
    }
    private func uninitialised() throws -> Object {
        var object = try tree()
        object["state"] = "not_initialised"; object["id"] = NSNull()
        object["categories"] = []; object["uncategorised_channels"] = []
        return object
    }
    private func decode(_ data: Data) throws -> WorkspaceSnapshot {
        try CoreWorkspaceClient.decode(data, organisationId: Self.organisation)
    }
    private func requester(_ tokens: FakeTokens, timeout: TimeInterval = 2) throws -> CoreRequester {
        try CoreRequester(coreApiOrigin: "https://core.test", loopback: .refuse, tokens: tokens,
            protocolClass: URLProtocolFixture.self, timeout: timeout)
    }
    private func fetch(_ response: URLProtocolFixture.Response, tokens: FakeTokens = FakeTokens()) async throws -> WorkspaceOutcome {
        URLProtocolFixture.install(response)
        return await CoreWorkspaceClient(requester: try requester(tokens)).fetch(organisationId: Self.organisation)
    }
    private func response(_ status: Int, body: Data = Data()) -> URLProtocolFixture.Response {
        .body(status: status, headers: Self.headers, chunks: [body])
    }
    private func paddedWorkspace(_ size: Int) -> Data {
        // Encode a complete valid Unicode fixture first, then append legal JSON whitespace bytes.
        var body = Data(Self.raw.replacingOccurrences(of: "A topic", with: "UTF-8: é 😀").utf8)
        precondition(body.count <= size)
        body.append(Data(repeating: 32, count: size - body.count))
        return body
    }

    func testTheReadPreservesTheFilteredTreeWithoutProviderAuthority() throws {
        let workspace = try decode(Data(Self.raw.utf8))
        XCTAssertEqual(workspace.organisationId, Self.organisation)
        XCTAssertEqual(workspace.id, "0192f3a4-5b6c-7d8e-9f01-23456789abcd")
        XCTAssertEqual(workspace.state, .initialised)
        XCTAssertEqual(workspace.setup.state, .ready)
        XCTAssertNil(workspace.setup.reason)
        XCTAssertFalse(workspace.canInitialise)
        let category = try XCTUnwrap(workspace.categories.first)
        XCTAssertEqual(category.name, "Stored category")
        XCTAssertEqual(category.templateKey, "future_section")
        XCTAssertEqual(category.channels.map(\.id), [Self.channel, "0192f3a4-5b6c-7d8e-9f01-23456789abd0"])
        XCTAssertEqual(category.channels[0].kind, .text)
        XCTAssertEqual(category.channels[0].name, "Stored channel")
        XCTAssertEqual(category.channels[0].templateKey, "general")
        XCTAssertEqual(category.channels[0].topic, "A topic")
        XCTAssertEqual(category.channels[0].lifecycle, .active)
        XCTAssertEqual(category.channels[0].roomState, .ready)
        XCTAssertEqual(category.channels[1].kind, .audio)
        XCTAssertEqual(category.channels[1].lifecycle, .archived)
        XCTAssertEqual(category.channels[1].roomState, .pending)
        XCTAssertNil(category.channels[1].templateKey)
        XCTAssertEqual(workspace.uncategorisedChannels.map(\.roomState), [.failed])
    }

    func testUninitialisedAndInitialisedEmptyViewsRemainDistinct() throws {
        var object = try uninitialised(); object["can_initialise"] = true
        let pending = try decode(DiscoveryFixtures.json(object))
        XCTAssertEqual(pending.state, .notInitialised)
        XCTAssertNil(pending.id)
        XCTAssertTrue(pending.canInitialise)
        XCTAssertTrue(pending.categories.isEmpty && pending.uncategorisedChannels.isEmpty)
        let empty = try decode(changed { root in root["categories"] = []; root["uncategorised_channels"] = [] })
        XCTAssertEqual(empty.state, .initialised)
        XCTAssertNotNil(empty.id)
        XCTAssertTrue(empty.categories.isEmpty)
    }

    func testEverySetupStateAndDocumentedReasonIsPreserved() throws {
        for state in ["pending", "running", "ready", "failed"] {
            let workspace = try decode(changed { root in setup(&root) { $0["state"] = state } })
            XCTAssertEqual(workspace.setup.state.rawValue, state)
        }
        for (reason, state) in [("awaiting_owner_confirmation", "pending"), ("issuer_untrusted", "failed"), ("realm_job_failed", "failed")] {
            let workspace = try decode(changed { root in setup(&root) { $0["state"] = state; $0["reason"] = reason } })
            XCTAssertEqual(workspace.setup.reason?.rawValue, reason)
        }
    }

    func testTheReturnedOrganisationMustBeTheRequestedOne() throws {
        XCTAssertThrowsError(try decode(changed { $0["organisation_id"] = "11111111-2222-4333-8444-555555555555" }))
        XCTAssertThrowsError(try CoreWorkspaceClient.decode(Data(Self.raw.utf8), organisationId: "bad"))
    }

    func testUnknownRoomStateIsRefusedInsteadOfBecomingReady() throws {
        XCTAssertThrowsError(try decode(changed { root in channel(&root) { $0["room_state"] = "future" } }))
    }

    func testRequiredFieldsAndAdditionalPropertiesAreEnforcedAtEveryLevel() throws {
        for key in ["organisation_id", "state", "setup", "can_initialise", "id", "categories", "uncategorised_channels"] {
            XCTAssertThrowsError(try decode(changed { $0.removeValue(forKey: key) }), key)
        }
        for key in ["state", "reason"] {
            XCTAssertThrowsError(try decode(changed { root in setup(&root) { $0.removeValue(forKey: key) } }), key)
        }
        for key in ["id", "name", "template_key", "channels"] {
            XCTAssertThrowsError(try decode(changed { root in category(&root) { $0.removeValue(forKey: key) } }), key)
        }
        for key in ["id", "kind", "name", "template_key", "topic", "lifecycle", "room_state"] {
            XCTAssertThrowsError(try decode(changed { root in channel(&root) { $0.removeValue(forKey: key) } }), key)
        }
        let edits: [(inout Object) -> Void] = [
            { $0["unexpected"] = true }, { root in self.setup(&root) { $0["unexpected"] = true } },
            { root in self.category(&root) { $0["unexpected"] = true } }, { root in self.channel(&root) { $0["unexpected"] = true } },
        ]
        for edit in edits { XCTAssertThrowsError(try decode(changed(edit))) }
    }

    func testClosedEnumsTypesAndIdentityFieldsAreStrict() throws {
        let edits: [(inout Object) -> Void] = [
            { $0["organisation_id"] = "bad" }, { $0["id"] = "bad" }, { $0["state"] = "future" },
            { $0["can_initialise"] = "false" }, { $0["categories"] = "none" }, { $0["uncategorised_channels"] = false },
            { root in self.setup(&root) { $0["state"] = "future" } }, { root in self.setup(&root) { $0["reason"] = "future" } },
            { root in self.setup(&root) { $0["reason"] = false } }, { root in self.category(&root) { $0["id"] = "bad" } },
            { root in self.category(&root) { $0["channels"] = "none" } }, { root in self.channel(&root) { $0["id"] = "bad" } },
            { root in self.channel(&root) { $0["kind"] = "video" } }, { root in self.channel(&root) { $0["lifecycle"] = "deleted" } },
            { root in self.channel(&root) { $0["topic"] = NSNull() } }, { root in self.channel(&root) { $0["name"] = 1 } },
            { root in self.category(&root) { $0["template_key"] = "Bad-Key" } },
            { root in self.channel(&root) { $0["template_key"] = String(repeating: "a", count: 33) } },
            { root in self.channel(&root) { $0["template_key"] = "valid\n" } },
        ]
        for edit in edits { XCTAssertThrowsError(try decode(changed(edit))) }
    }

    func testContradictoryWorkspaceAndSetupStatesAreRefused() throws {
        var empty = try uninitialised(); empty["id"] = "0192f3a4-5b6c-7d8e-9f01-23456789abcd"
        XCTAssertThrowsError(try decode(DiscoveryFixtures.json(empty)))
        XCTAssertThrowsError(try decode(changed { $0["state"] = "not_initialised"; $0["id"] = NSNull() }))
        XCTAssertThrowsError(try decode(changed { $0["id"] = NSNull() }))
        XCTAssertThrowsError(try decode(changed { $0["can_initialise"] = true }))
        var running = try uninitialised(); running["can_initialise"] = true
        setup(&running) { $0["state"] = "running" }
        XCTAssertThrowsError(try decode(DiscoveryFixtures.json(running)))
        for reason in ["awaiting_owner_confirmation", "issuer_untrusted"] {
            XCTAssertThrowsError(try decode(changed { root in setup(&root) { $0["reason"] = reason } }))
        }
    }

    func testNamesAndTopicsUseUnicodeScalarBoundsWithoutChangingStoredText() throws {
        let name = String(repeating: "e\u{301}", count: 50) // 100 scalars, 50 graphemes
        let topic = String(repeating: "e\u{301}", count: 512)
        let workspace = try decode(changed { root in
            category(&root) { $0["name"] = name; $0["template_key"] = NSNull() }
            channel(&root) { $0["name"] = "  Stored text  "; $0["topic"] = topic }
        })
        XCTAssertEqual(workspace.categories[0].name.unicodeScalars.count, 100)
        XCTAssertNil(workspace.categories[0].templateKey)
        XCTAssertEqual(workspace.categories[0].channels[0].name, "  Stored text  ")
        XCTAssertEqual(workspace.categories[0].channels[0].topic.unicodeScalars.count, 1024)
        for invalid in ["", " \t", name + "x"] {
            XCTAssertThrowsError(try decode(changed { root in category(&root) { $0["name"] = invalid } }))
            XCTAssertThrowsError(try decode(changed { root in channel(&root) { $0["name"] = invalid } }))
        }
        XCTAssertThrowsError(try decode(changed { root in channel(&root) { $0["topic"] = topic + "x" } }))
    }

    func testMalformedDuplicateAndInvalidUTF8BodiesProduceNoPartialSnapshot() throws {
        let duplicate = Self.raw.replacingOccurrences(of: "\"topic\":\"A topic\"", with: "\"topic\":\"A topic\",\"topic\":\"other\"")
        for data in [Data("not json".utf8), Data("[]".utf8), Data("{}".utf8), Data((Self.raw + " {}").utf8),
                     Data(duplicate.utf8), Data([0xff, 0xfe])] {
            XCTAssertThrowsError(try decode(data))
        }
    }

    func testValidWorkspaceByteBoundaryIsEnforcedByTheDecoder() throws {
        let lower = paddedWorkspace(65_536), upper = paddedWorkspace(65_537)
        XCTAssertEqual(lower.count, 65_536); XCTAssertEqual(upper.count, 65_537)
        let workspace = try decode(lower)
        XCTAssertEqual(workspace.organisationId, Self.organisation)
        XCTAssertEqual(workspace.categories[0].channels[0].topic, "UTF-8: é 😀")
        XCTAssertThrowsError(try decode(upper))
    }

    func testValidWorkspaceByteBoundaryIsEnforcedThroughTransport() async throws {
        for size in [65_536, 65_537] {
            let body = paddedWorkspace(size)
            XCTAssertEqual(body.count, size)
            let outcome = try await fetch(response(200, body: body))
            XCTAssertEqual(URLProtocolFixture.requests.count, 1)
            if size == 65_536 {
                guard case let .loaded(workspace) = outcome else { return XCTFail("\(outcome)") }
                XCTAssertEqual(workspace.organisationId, Self.organisation)
                XCTAssertEqual(workspace.categories[0].channels[0].topic, "UTF-8: é 😀")
            } else { XCTAssertEqual(outcome, .unavailable(.protocolViolation)) }
        }
    }

    func testInvalidOrganisationIsRefusedBeforeAnyTokenOrRequest() async throws {
        URLProtocolFixture.install(.hold)
        let tokens = FakeTokens()
        let client = CoreWorkspaceClient(requester: try requester(tokens))
        for id in ["bad", Self.organisation + "/../other", Self.organisation + "%2fother", Self.organisation.uppercased()] {
            let outcome = await client.fetch(organisationId: id)
            XCTAssertEqual(outcome, .unavailable(.protocolViolation))
        }
        let requested = await tokens.requested
        XCTAssertEqual(requested, 0)
        XCTAssertTrue(URLProtocolFixture.requests.isEmpty)
    }

    func testUnconditionalGetUsesOnlyTheSessionRequesterAndDoesNotReuseAView() async throws {
        URLProtocolFixture.install(sequence: [response(200, body: Data(Self.raw.utf8)), response(404)])
        let tokens = FakeTokens()
        let client = CoreWorkspaceClient(requester: try requester(tokens))
        let first = await client.fetch(organisationId: Self.organisation)
        guard case .loaded = first else { return XCTFail("\(first)") }
        let second = await client.fetch(organisationId: Self.organisation)
        XCTAssertEqual(second, .unavailable(.notFound))
        XCTAssertEqual(URLProtocolFixture.requests.count, 2)
        for request in URLProtocolFixture.requests {
            XCTAssertEqual(request.url?.absoluteString, "https://core.test/api/v1/organisations/\(Self.organisation)/workspace")
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-store")
            for header in ["Cookie", "If-None-Match", "If-Modified-Since", "Proxy-Authorization"] {
                XCTAssertNil(request.value(forHTTPHeaderField: header))
            }
        }
        XCTAssertEqual(URLProtocolFixture.requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-access-1")
        let requested = await tokens.requested, forced = await tokens.forcedRefreshes
        XCTAssertEqual(requested, 2); XCTAssertEqual(forced, 0)
    }

    func testUnsolicited304IsNeverAnEmptyAuthorisedWorkspace() async throws {
        let outcome = try await fetch(response(304))
        XCTAssertEqual(outcome, .unavailable(.protocolViolation))
        XCTAssertEqual(URLProtocolFixture.requests.count, 1)
    }

    func testStatusFailuresAreSafeAndNeverRetried() async throws {
        for (status, failure) in [(403, WorkspaceFailure.forbidden), (404, .notFound), (429, .serviceUnavailable),
                                  (500, .serviceUnavailable), (503, .serviceUnavailable), (204, .protocolViolation)] {
            let tokens = FakeTokens()
            let outcome = try await fetch(response(status), tokens: tokens)
            XCTAssertEqual(outcome, .unavailable(failure), "\(status)")
            let forced = await tokens.forcedRefreshes, ended = await tokens.localEnds, signOuts = await tokens.signOuts
            XCTAssertEqual(forced, 0); XCTAssertEqual(ended, 0); XCTAssertEqual(signOuts, 0)
            XCTAssertEqual(URLProtocolFixture.requests.count, 1)
        }
    }

    func test401RefreshesOnceAndEndsOnlyTheServingSessionOnASecond401() async throws {
        let tokens = FakeTokens()
        URLProtocolFixture.install(sequence: [response(401), response(200, body: Data(Self.raw.utf8))])
        let success = await CoreWorkspaceClient(requester: try requester(tokens)).fetch(organisationId: Self.organisation)
        guard case .loaded = success else { return XCTFail("\(success)") }
        let forced = await tokens.forcedRefreshes
        XCTAssertEqual(forced, 1); XCTAssertEqual(URLProtocolFixture.requests.count, 2)
        let refused = FakeTokens()
        URLProtocolFixture.install(sequence: [response(401), response(401)])
        let failure = await CoreWorkspaceClient(requester: try requester(refused)).fetch(organisationId: Self.organisation)
        XCTAssertEqual(failure, .signedOut)
        let sessions = await refused.endedSessions, signOuts = await refused.signOuts
        XCTAssertEqual(sessions, [102]); XCTAssertEqual(signOuts, 0)
    }

    func testSignedOutNotWipedIsPreservedForBothRefusalPaths() async throws {
        for refusesRefresh in [false, true] {
            let tokens = FakeTokens(refusesRefresh: refusesRefresh, keepsStoredCopy: true)
            URLProtocolFixture.install(sequence: [response(401), response(401)])
            let outcome = await CoreWorkspaceClient(requester: try requester(tokens)).fetch(organisationId: Self.organisation)
            XCTAssertEqual(outcome, .signedOutNotWiped)
        }
    }

    func testRequesterFailuresPassThroughWithoutAnAnonymousFallback() async throws {
        let unavailable = try await fetch(response(200, body: Data(Self.raw.utf8)), tokens: FakeTokens(unavailable: true))
        XCTAssertEqual(unavailable, .unavailable(.identityUnavailable))
        XCTAssertTrue(URLProtocolFixture.requests.isEmpty)
        let offline = try await fetch(.failure(.notConnectedToInternet))
        XCTAssertEqual(offline, .unavailable(.transport(.offline)))
        URLProtocolFixture.install(.hold)
        let tokens = FakeTokens()
        let closedRequester = try requester(tokens)
        closedRequester.invalidate()
        let outcome = await CoreWorkspaceClient(requester: closedRequester).fetch(organisationId: Self.organisation)
        XCTAssertEqual(outcome, .unavailable(.transport(.other)))
        let requested = await tokens.requested
        XCTAssertEqual(requested, 0); XCTAssertTrue(URLProtocolFixture.requests.isEmpty)
    }

    func testMalformedWireBodyIsNotAWorkspace() async throws {
        let outcome = try await fetch(response(200, body: Data("not json".utf8)))
        XCTAssertEqual(outcome, .unavailable(.protocolViolation))
    }

    func testRedirectIsNeverFollowedWithTheToken() async throws {
        #if canImport(FoundationNetworking)
        throw XCTSkip("swift-corelibs-foundation cannot deliver a URLProtocol redirect; the macOS job runs this")
        #else
        URLProtocolFixture.install(.redirect(status: 302, location: "https://elsewhere.test/workspace"))
        let clock = ContinuousClock()
        let start = clock.now
        let client = CoreWorkspaceClient(requester: try requester(FakeTokens(), timeout: 10))
        let outcome = await client.fetch(organisationId: Self.organisation)
        XCTAssertLessThan(clock.now - start, .seconds(5), "the refused redirect only ended at the transport timeout")
        XCTAssertEqual(outcome, .unavailable(.protocolViolation))
        XCTAssertEqual(URLProtocolFixture.requests.map { $0.url?.absoluteString },
            ["https://core.test/api/v1/organisations/\(Self.organisation)/workspace"])
        #endif
    }
    func testNilWorkspaceCategoryAndChannelIDsCannotBecomeLoadedMetadata() throws {
        let nilID = "00000000-0000-0000-0000-000000000000"
        let invalid = try [changed { $0["id"] = nilID },
                           changed { root in category(&root) { $0["id"] = nilID } },
                           changed { root in channel(&root) { $0["id"] = nilID } }]
        for body in invalid { XCTAssertThrowsError(try decode(body)) }
        XCTAssertThrowsError(try CoreWorkspaceClient.decode(Data(Self.raw.utf8), organisationId: nilID))
    }

    func testNilOrganisationRefusesBeforeFetchingATokenOrSendingARequest() async throws {
        URLProtocolFixture.install(response(200, body: Data(Self.raw.utf8)))
        let tokens = FakeTokens()
        let client = CoreWorkspaceClient(requester: try requester(tokens))
        let outcome = await client.fetch(organisationId: "00000000-0000-0000-0000-000000000000")
        XCTAssertEqual(outcome, .unavailable(.protocolViolation))
        let requested = await tokens.requested
        XCTAssertEqual(requested, 0)
        XCTAssertTrue(URLProtocolFixture.requests.isEmpty)
    }

}
