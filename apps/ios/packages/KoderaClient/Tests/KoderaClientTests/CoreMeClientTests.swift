import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
import KoderaDomain
@testable import KoderaClient

/// `/me`'s own mapping. The bearer, the 401 and 403 policy and the transport are `CoreRequester`'s, and
/// `CoreRequesterTests` prove them.
@MainActor
final class CoreMeClientTests: XCTestCase {
    private static let headers = ["Content-Type": "application/json", "Cache-Control": "no-store"]
    private static let member: [String: Any] = [
        "id": "11111111-2222-4333-8444-555555555555",
        "email": "member@example.test",
        "display_name": "Synthetic Member",
        "locale": "fr",
        "staff": false,
        "identities": [],
        "organisations": [[
            "organisation": ["id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f", "slug": "kodera-dev",
                             "name": "Synthetic organisation", "realm": "kodera-dev"],
            "membership_id": "7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c",
            "role": "org_member",
            "state": "active",
        ]],
    ]

    private func client(_ tokens: FakeTokens, timeout: TimeInterval = 2) throws -> CoreMeClient {
        CoreMeClient(requester: try CoreRequester(coreApiOrigin: "https://core.test", loopback: .refuse,
            tokens: tokens, protocolClass: URLProtocolFixture.self, timeout: timeout))
    }
    private func ok(_ object: [String: Any] = member) throws -> URLProtocolFixture.Response {
        .body(status: 200, headers: Self.headers, chunks: [try DiscoveryFixtures.json(object)])
    }
    private let unauthorized = URLProtocolFixture.Response.body(status: 401,
        headers: ["Content-Type": "application/problem+json"], chunks: [Data("{}".utf8)])

    func testSuccessMapsTheMemberAndSendsTheBearerToken() async throws {
        URLProtocolFixture.install(try ok())
        let tokens = FakeTokens()
        let outcome = try await client(tokens).fetch()
        guard case let .member(profile) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(profile.displayName, "Synthetic Member")
        XCTAssertEqual(profile.email, "member@example.test")
        XCTAssertEqual(profile.organisation(realm: "kodera-dev")?.name, "Synthetic organisation")
        XCTAssertEqual(profile.organisation(realm: "kodera-dev")?.role, "org_member")
        XCTAssertNil(profile.organisation(realm: "other-realm"))
        let request = try XCTUnwrap(URLProtocolFixture.requests.first)
        XCTAssertEqual(request.url?.absoluteString, "https://core.test/api/v1/me")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-access-1")
        XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
        let forced = await tokens.forcedRefreshes
        XCTAssertEqual(forced, 0)
    }

    func testNullDisplayNameAndRealmAreAccepted() async throws {
        var object = Self.member
        object["display_name"] = NSNull()
        var membership = (object["organisations"] as! [[String: Any]])[0]
        var organisation = membership["organisation"] as! [String: Any]
        organisation["realm"] = NSNull()
        membership["organisation"] = organisation
        object["organisations"] = [membership]
        URLProtocolFixture.install(try ok(object))
        let outcome = try await client(FakeTokens()).fetch()
        guard case let .member(profile) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertNil(profile.displayName)
        XCTAssertNil(profile.organisations.first?.realm)
    }

    func testEmptyDisplayNameIsNoName() async throws {
        var object = Self.member
        object["display_name"] = ""
        URLProtocolFixture.install(try ok(object))
        let outcome = try await client(FakeTokens()).fetch()
        guard case let .member(profile) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertNil(profile.displayName, "an empty name falls back to the email")
    }

    func testEmailNeedsOnlyToBeAnAddressNotAnInventedLength() async throws {
        var long = Self.member
        long["email"] = String(repeating: "a", count: 400) + "@example.test"
        URLProtocolFixture.install(try ok(long))
        let accepted = try await client(FakeTokens()).fetch()
        guard case .member = accepted else { return XCTFail("\(accepted)") }
        for email in ["", "no-at-sign"] {
            var object = Self.member
            object["email"] = email
            URLProtocolFixture.install(try ok(object))
            let outcome = try await client(FakeTokens()).fetch()
            XCTAssertEqual(outcome, .unavailable(.protocolViolation), email)
        }
        var longName = Self.member
        longName["display_name"] = String(repeating: "n", count: 201)
        URLProtocolFixture.install(try ok(longName))
        let refused = try await client(FakeTokens()).fetch()
        XCTAssertEqual(refused, .unavailable(.protocolViolation))
    }

    func testMalformedBodiesAreProtocolViolations() async throws {
        var missingEmail = Self.member
        missingEmail.removeValue(forKey: "email")
        var badID = Self.member
        badID["id"] = "not-a-uuid"
        var badOrganisation = Self.member
        badOrganisation["organisations"] = [["organisation": ["id": "x"], "role": "org_member", "state": "active"]]
        let bodies: [Data] = [
            Data("not json".utf8),
            Data(#"{"id":"11111111-2222-4333-8444-555555555555","id":"11111111-2222-4333-8444-555555555555"}"#.utf8),
            Data("[]".utf8),
            try DiscoveryFixtures.json(missingEmail),
            try DiscoveryFixtures.json(badID),
            try DiscoveryFixtures.json(badOrganisation),
            Data(repeating: 32, count: 70_000),
        ]
        for body in bodies {
            URLProtocolFixture.install(.body(status: 200, headers: Self.headers, chunks: [body]))
            let outcome = try await client(FakeTokens()).fetch()
            XCTAssertEqual(outcome, .unavailable(.protocolViolation), String(decoding: body.prefix(80), as: UTF8.self))
        }
    }

    /// Core's 403 problem, end to end: the screen's "no organisation yet" state, with the session kept.
    func testA403IsTheNoOrganisationYetState() async throws {
        URLProtocolFixture.install(.body(status: 403, headers: ["Content-Type": "application/problem+json"],
            chunks: [Data(#"{"type":"https://kodera.io/problems/forbidden","title":"Access refused","status":403}"#.utf8)]))
        let tokens = FakeTokens()
        let outcome = try await client(tokens).fetch()
        guard case let .unavailable(failure) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(MemberUnavailable(failure), .noOrganisationYet)
        let localEnds = await tokens.localEnds
        XCTAssertEqual(localEnds, 0, "a 403 ends no session")
    }

    /// Only a 403 is "no organisation yet": every other failure keeps the retry of "Core unavailable".
    func testEveryOtherFailureIsCoreUnavailable() {
        for failure in [MeFailure.protocolViolation, .serviceUnavailable, .identityUnavailable, .transport(.timeout)] {
            XCTAssertEqual(MemberUnavailable(failure), .coreUnavailable, "\(failure)")
        }
    }

    func testStatusesMapToWhatTheAppShows() async throws {
        for (status, failure) in [(403, MeFailure.forbidden), (429, .serviceUnavailable), (503, .serviceUnavailable),
                                  (500, .serviceUnavailable), (404, .protocolViolation)] {
            URLProtocolFixture.install(.body(status: status, headers: Self.headers, chunks: [Data("{}".utf8)]))
            let tokens = FakeTokens()
            let outcome = try await client(tokens).fetch()
            XCTAssertEqual(outcome, .unavailable(failure), "\(status)")
            let signOuts = await tokens.signOuts
            let localEnds = await tokens.localEnds
            XCTAssertEqual(signOuts, 0)
            XCTAssertEqual(localEnds, 0)
        }
    }

    /// The requester's session and transport outcomes reach the app unchanged.
    func testSessionAndTransportOutcomesMapThrough() async throws {
        URLProtocolFixture.install(sequence: [unauthorized, unauthorized])
        let ended = try await client(FakeTokens()).fetch()
        XCTAssertEqual(ended, .signedOut)

        URLProtocolFixture.install(sequence: [unauthorized, unauthorized])
        let notWiped = try await client(FakeTokens(keepsStoredCopy: true)).fetch()
        XCTAssertEqual(notWiped, .signedOutNotWiped)

        URLProtocolFixture.install(try ok())
        let identity = try await client(FakeTokens(unavailable: true)).fetch()
        XCTAssertEqual(identity, .unavailable(.identityUnavailable))

        URLProtocolFixture.install(.failure(.notConnectedToInternet))
        let offline = try await client(FakeTokens()).fetch()
        XCTAssertEqual(offline, .unavailable(.transport(.offline)))
    }

    func testRedirectIsNeverFollowedWithTheToken() async throws {
        #if canImport(FoundationNetworking)
        throw XCTSkip("swift-corelibs-foundation cannot deliver a URLProtocol redirect; the macOS job runs this")
        #else
        URLProtocolFixture.install(.redirect(status: 302, location: "https://elsewhere.test/api/v1/me"))
        let clock = ContinuousClock()
        let start = clock.now
        // The transport timeout bounds the wait; the task must end well before it, with the 3xx.
        let outcome = try await client(FakeTokens(), timeout: 10).fetch()
        XCTAssertLessThan(clock.now - start, .seconds(5), "the refused redirect only ended at the transport timeout")
        XCTAssertEqual(outcome, .unavailable(.protocolViolation))
        XCTAssertEqual(URLProtocolFixture.requests.map { $0.url?.absoluteString }, ["https://core.test/api/v1/me"],
                       "the redirect was followed")
        #endif
    }

    /// An answer over the size limit is a protocol violation, as before.
    func testAnOversizedAnswerIsAProtocolViolation() async throws {
        URLProtocolFixture.install(.body(status: 200, headers: Self.headers,
                                         chunks: [Data(repeating: 32, count: StrictJSON.byteLimit + 1)]))
        let outcome = try await client(FakeTokens()).fetch()
        XCTAssertEqual(outcome, .unavailable(.protocolViolation))
    }
    func testNilEntityIDsAreRefusedAtTheActualCoreResponseBoundary() async throws {
        let nilID = "00000000-0000-0000-0000-000000000000"
        var nilMember = Self.member
        nilMember["id"] = nilID
        var nilOrganisation = Self.member
        var memberships = Self.member["organisations"] as! [[String: Any]]
        var organisation = memberships[0]["organisation"] as! [String: Any]
        organisation["id"] = nilID
        memberships[0]["organisation"] = organisation
        nilOrganisation["organisations"] = memberships
        for body in [nilMember, nilOrganisation] {
            URLProtocolFixture.install(try ok(body))
            let outcome = try await client(FakeTokens()).fetch()
            XCTAssertEqual(outcome, .unavailable(.protocolViolation))
        }
    }

}
