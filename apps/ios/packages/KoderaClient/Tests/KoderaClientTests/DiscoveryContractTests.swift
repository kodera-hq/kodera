import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
import KoderaDomain
@testable import KoderaClient

/// `discoverRealm` at `contracts/v0.26.0`, end to end through the real URLSession transport: the request
/// Core checks before any quota charge, every documented answer, and the entry states they become.
/// Every await is bounded by the client's one-second resource timeout.
@MainActor
final class DiscoveryContractTests: XCTestCase {
    private let browserHeaders = ["Origin", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest", "Referer"]

    private func client(_ configuration: CoreDiscoveryConfiguration? = nil) throws -> CoreDiscoveryClient {
        let profile: CoreDiscoveryConfiguration
        if let configuration { profile = configuration } else { profile = try DiscoveryFixtures.configuration }
        return try CoreDiscoveryClient(configuration: profile, protocolClass: URLProtocolFixture.self,
                                       resourceTimeout: 1)
    }
    private func install(status: Int = 200, body: Data, headers: [String: String] = DiscoveryFixtures.headers) {
        URLProtocolFixture.install(.body(status: status, headers: headers, chunks: [body]))
    }
    private func presentation(_ outcome: AnonymousDiscoveryOutcome) -> DiscoveryPresentation {
        var state = DiscoveryState()
        let ticket = state.begin()
        state.receive(outcome, for: ticket)
        return DiscoveryPresentation(state.value)
    }
    /// The one-organisation contract example with its issuer (and the well-known URL derived from it) moved.
    private func oneWithIssuer(_ issuer: String) throws -> Data {
        var object = try DiscoveryFixtures.object("discovery-one")
        object["issuer"] = issuer
        object["openid_configuration_url"] = issuer + "/.well-known/openid-configuration"
        return try DiscoveryFixtures.json(object)
    }

    // MARK: Fixtures are the contract's examples

    func testFixturesAreTheContractExamples() throws {
        let configuration = try DiscoveryFixtures.configuration
        XCTAssertEqual(try DiscoveryEnvelope.decode(data: DiscoveryFixtures.data("discovery-zero"),
            configuration: configuration), .noMatch)
        let atelier = AnonymousOrganisationMetadata(organisationId: "11111111-1111-4111-8111-111111111111",
            organisationSlug: "atelier", displayName: "Atelier Example", realm: "atelier",
            issuer: "https://id.kodera.io/realms/atelier",
            openidConfigurationURL: "https://id.kodera.io/realms/atelier/.well-known/openid-configuration")
        let bureau = AnonymousOrganisationMetadata(organisationId: "22222222-2222-4222-8222-222222222222",
            organisationSlug: "bureau", displayName: "Bureau Example", realm: "bureau",
            issuer: "https://id.kodera.io/realms/bureau",
            openidConfigurationURL: "https://id.kodera.io/realms/bureau/.well-known/openid-configuration")
        XCTAssertEqual(try DiscoveryEnvelope.decode(data: DiscoveryFixtures.data("discovery-one"),
            configuration: configuration), .single(atelier))
        XCTAssertEqual(try DiscoveryEnvelope.decode(data: DiscoveryFixtures.data("discovery-many"),
            configuration: configuration), .multiple([atelier, bureau]))
    }

    // MARK: The request

    func testRequestCarriesTheHeadersCoreChecksBeforeAnyQuotaCharge() async throws {
        install(body: try DiscoveryFixtures.data("discovery-zero"))
        let client = try client()
        let first = await client.discover(slug: "atelier")
        let second = await client.discover(slug: "atelier")
        await client.close()
        XCTAssertEqual(first, .result(.noMatch))
        XCTAssertEqual(second, .result(.noMatch))
        let requests = URLProtocolFixture.requests
        XCTAssertEqual(requests.count, 2)
        var keys: [String] = []
        for request in requests {
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.absoluteString, "https://core.test/api/v1/auth/discover")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"), "discovery is anonymous")
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            // DiscoveryCompatibilityKey: ^[!-~][ -~]{14,253}[!-~]$, validated then discarded by Core.
            let key = try XCTUnwrap(request.value(forHTTPHeaderField: "Idempotency-Key"))
            let bytes = Array(key.utf8)
            XCTAssertTrue((16...255).contains(bytes.count), key)
            XCTAssertTrue(bytes.first.map { (33...126).contains($0) } == true, key)
            XCTAssertTrue(bytes.last.map { (33...126).contains($0) } == true, key)
            XCTAssertTrue(bytes.allSatisfy { (32...126).contains($0) }, key)
            keys.append(key)
        }
        XCTAssertEqual(Set(keys).count, 2, "every lookup sends a fresh compatibility key")
    }

    /// Core refuses a browser's request from `Origin` or `Sec-Fetch-Site` before any quota charge; a request
    /// carrying neither is a native client's and is never refused for its origin.
    func testNativeRequestSendsNeitherOriginNorSecFetchSite() async throws {
        install(body: try DiscoveryFixtures.data("discovery-zero"))
        let client = try client()
        _ = await client.discover(slug: "atelier")
        _ = await client.discover(email: "member@atelier.example")
        await client.close()
        let requests = URLProtocolFixture.requests
        XCTAssertEqual(requests.count, 2)
        for request in requests {
            for name in browserHeaders {
                XCTAssertNil(request.value(forHTTPHeaderField: name), "a native discovery request sent \(name)")
            }
            let sent = Set((request.allHTTPHeaderFields ?? [:]).keys.map { $0.lowercased() })
            XCTAssertTrue(sent.isDisjoint(with: browserHeaders.map { $0.lowercased() }), "\(sent)")
        }
    }

    func testEmailLookupSendsOnlyTheEmailAndZeroResultsMeanNoOrganisation() async throws {
        install(body: try DiscoveryFixtures.data("discovery-zero"))
        let client = try client()
        let outcome = await client.discover(email: "member@atelier.example")
        await client.close()
        XCTAssertEqual(outcome, .result(.noMatch))
        XCTAssertEqual(presentation(outcome), .noOrganisation, "zero candidates is no organisation, never an error")
        let request = try XCTUnwrap(URLProtocolFixture.requests.first)
        let data = try URLProtocolFixture.bodyData(request)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: data) as? [String: String],
                       ["email": "member@atelier.example"])
        XCTAssertNotNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
    }

    func testOnlyAnApprovedEmailIsSent() async throws {
        install(body: try DiscoveryFixtures.data("discovery-zero"))
        let client = try client()
        let refused = ["", "member", "member@", "@atelier.example", "member@localhost", "member@atelier..example",
            "member@-atelier.example", "mem ber@atelier.example", "membré@atelier.example", "member@atelier.example\n",
            String(repeating: "a", count: 65) + "@atelier.example",
            "a@" + Array(repeating: String(repeating: "b", count: 63), count: 4).joined(separator: "."),
            "member@atelier.example.", ".member@atelier.example", "member.@atelier.example", "me\"mber@atelier.example"]
        for email in refused {
            let outcome = await client.discover(email: email)
            XCTAssertEqual(outcome, .failure(.invalidInput), email)
        }
        XCTAssertTrue(URLProtocolFixture.requests.isEmpty, "an unapproved email never leaves the device")
        for email in ["Member.Name+tag@Atelier.Example", String(repeating: "a", count: 64) + "@atelier.example",
                      "o'neil@atelier.example"] {
            let outcome = await client.discover(email: email)
            XCTAssertEqual(outcome, .result(.noMatch), email)
        }
        await client.close()
        XCTAssertEqual(URLProtocolFixture.requests.count, 3)
    }

    func testASingleMatchMustBeTheQueriedSlugButAnEmailMatchNeedNot() async throws {
        install(body: try DiscoveryFixtures.data("discovery-one"))
        let client = try client()
        let bySlug = await client.discover(slug: "bureau")
        let byEmail = await client.discover(email: "member@atelier.example")
        await client.close()
        XCTAssertEqual(bySlug, .failure(.protocolViolation), "a slug answers with that organisation or none")
        guard case let .result(.single(organisation)) = byEmail else {
            return XCTFail("an email lookup answers with the organisation its domain belongs to: \(byEmail)")
        }
        XCTAssertEqual(organisation.organisationSlug, "atelier")
    }

    // MARK: The discovered issuer

    /// The issuer goes through `IssuerAdmission`, the validator sign-in runs. One outside the configured
    /// origins makes the whole answer unusable: no `.found`, so no sign-in can start and no browser opens.
    func testDiscoveredIssuerOutsideTheConfiguredOriginsIsRefusedBeforeAnyBrowserOpens() async throws {
        let foreign = ["https://id.other.example/realms/atelier", "https://id.kodera.io.evil.example/realms/atelier",
                       "https://id.kodera.io:8443/realms/atelier", "http://localhost:8080/realms/atelier"]
        for issuer in foreign {
            install(body: try oneWithIssuer(issuer))
            let client = try client()
            let outcome = await client.discover(slug: "atelier")
            await client.close()
            XCTAssertEqual(outcome, .failure(.protocolViolation), issuer)
            XCTAssertEqual(presentation(outcome), .invalidResponse, issuer)
            XCTAssertNil(presentation(outcome).signInIssuer, "\(issuer) must never reach sign-in")
        }
        var many = try DiscoveryFixtures.object("discovery-many")
        var candidates = try XCTUnwrap(many["candidates"] as? [[String: Any]])
        candidates[1]["issuer"] = "https://id.other.example/realms/bureau"
        candidates[1]["openid_configuration_url"] = "https://id.other.example/realms/bureau/.well-known/openid-configuration"
        many["candidates"] = candidates
        install(body: try DiscoveryFixtures.json(many))
        let client = try client()
        let outcome = await client.discover(slug: "atelier")
        await client.close()
        XCTAssertEqual(outcome, .failure(.protocolViolation), "one foreign candidate refuses the whole answer")
    }

    func testALoopbackIssuerIsAdmittedOnlyUnderTheDevelopmentPolicy() async throws {
        let refusing = try CoreDiscoveryConfiguration(coreApiOrigin: "https://core.test",
            admittedIssuerOrigins: ["https://id.kodera.io"])
        install(body: try oneWithIssuer("http://localhost:8080/realms/atelier"))
        let release = try client(refusing)
        let refused = await release.discover(slug: "atelier")
        await release.close()
        XCTAssertEqual(refused, .failure(.protocolViolation))
        // A loopback origin cannot even be configured without the development policy.
        XCTAssertThrowsError(try CoreDiscoveryConfiguration(coreApiOrigin: "https://core.test",
            admittedIssuerOrigins: ["http://localhost:8080"]))
        let development = try CoreDiscoveryConfiguration(coreApiOrigin: "https://core.test",
            admittedIssuerOrigins: ["http://localhost:8080"], loopback: .admitForDevelopment)
        install(body: try oneWithIssuer("http://localhost:8080/realms/atelier"))
        let debug = try client(development)
        let admitted = await debug.discover(slug: "atelier")
        await debug.close()
        guard case let .result(.single(organisation)) = admitted else {
            return XCTFail("a development build admits its configured loopback realm: \(admitted)")
        }
        XCTAssertEqual(organisation.issuer, "http://localhost:8080/realms/atelier")
    }

    func testAFoundOrganisationsIssuerIsOneSignInAdmits() async throws {
        install(body: try DiscoveryFixtures.data("discovery-one"))
        let client = try client()
        let outcome = await client.discover(slug: "atelier")
        await client.close()
        let issuer = try XCTUnwrap(presentation(outcome).signInIssuer)
        let admitted = try IssuerAdmission.admit(issuer: issuer, admittedOrigins: ["https://id.kodera.io"],
                                                 loopback: .refuse)
        XCTAssertEqual(admitted.realm, "atelier")
        XCTAssertEqual(admitted.origin, "https://id.kodera.io")
    }

    // MARK: Every documented answer

    func testEveryDocumentedProblemReachesItsTypedOutcome() async throws {
        let correlation = ProblemCorrelation(requestID: DiscoveryFixtures.requestID)
        let cases: [(status: Int, type: String, retry: Int?, extra: [String: Any], expected: DiscoveryFailure)] = [
            (400, "malformed-request", nil, [:], .rejectedRequest(.malformedRequest)),
            (400, "idempotency-key-missing", nil, [:], .rejectedRequest(.idempotencyKeyMissing)),
            (403, "forbidden", nil, [:], .rejectedRequest(.forbidden)),
            (413, "payload-too-large", nil, ["limit_bytes": 4096], .rejectedRequest(.payloadTooLarge)),
            (415, "unsupported-media-type", nil, [:], .rejectedRequest(.unsupportedMediaType)),
            (422, "validation-error", nil, ["errors": [["pointer": "/slug", "code": "pattern"]]],
             .rejectedRequest(.validationError)),
            (429, "rate-limited", 3, [:], .rateLimited(RetryHint(seconds: 3), correlation)),
            (500, "internal-error", nil, [:], .internalServiceError(correlation)),
            (503, "service-unavailable", 5, [:], .temporarilyUnavailable(RetryHint(seconds: 5), correlation)),
        ]
        for entry in cases {
            var problem: [String: Any] = ["type": "https://kodera.io/problems/" + entry.type,
                "title": "Synthetic title", "status": entry.status, "request_id": DiscoveryFixtures.requestID]
            if let retry = entry.retry { problem["retry_after_s"] = retry }
            for (key, value) in entry.extra { problem[key] = value }
            install(status: entry.status, body: try DiscoveryFixtures.json(problem),
                    headers: DiscoveryFixtures.problemHeaders(retry: entry.retry.map { String($0) }))
            let client = try client()
            let outcome = await client.discover(slug: "atelier")
            await client.close()
            XCTAssertEqual(outcome, .failure(entry.expected), entry.type)
            XCTAssertEqual(URLProtocolFixture.requests.count, 1, entry.type)
        }
    }

    func testAPayloadLimitThatIsNotACountRefuses() throws {
        for limit in ["4096", -1, 1.5, true] as [Any] {
            let problem: [String: Any] = ["type": "https://kodera.io/problems/payload-too-large",
                "title": "Synthetic title", "status": 413, "request_id": DiscoveryFixtures.requestID,
                "limit_bytes": limit]
            let data = try DiscoveryFixtures.json(problem)
            XCTAssertThrowsError(try DiscoveryProblem.decode(data: data, status: 413,
                headers: DiscoveryFixtures.problemHeaders()), "\(limit)")
        }
    }

    /// Quotas are per IP and looked-up value: one lookup is one request, and a quota answer is shown, not retried.
    func testAQuotaAnswerIsOneRequestAndReadsTryAgainLater() async throws {
        install(status: 429, body: try DiscoveryFixtures.problem(status: 429, type: "rate-limited", retry: 7),
                headers: DiscoveryFixtures.problemHeaders(retry: "7"))
        let client = try client()
        let outcome = await client.discover(slug: "atelier")
        try await Task.sleep(for: .milliseconds(200))
        await client.close()
        XCTAssertEqual(outcome, .failure(.rateLimited(RetryHint(seconds: 7),
            ProblemCorrelation(requestID: DiscoveryFixtures.requestID))))
        XCTAssertEqual(URLProtocolFixture.requests.count, 1, "a quota answer is never retried")
        XCTAssertEqual(presentation(outcome), .tryAgainLater)
    }

    func testAnUnavailableServiceIsOneRequestToo() async throws {
        install(status: 503, body: try DiscoveryFixtures.problem(status: 503, type: "service-unavailable", retry: 5),
                headers: DiscoveryFixtures.problemHeaders(retry: "5"))
        let client = try client()
        let outcome = await client.discover(slug: "atelier")
        try await Task.sleep(for: .milliseconds(200))
        await client.close()
        XCTAssertEqual(URLProtocolFixture.requests.count, 1)
        XCTAssertEqual(presentation(outcome), .serviceUnavailable)
    }

    // MARK: The entry states

    func testEveryStateHasItsTypedEntryState() {
        let atelier = DiscoveryFixtures.metadata()
        let bureau = DiscoveryFixtures.metadata(id: "22222222-2222-4222-8222-222222222222", slug: "bureau")
        let correlation = ProblemCorrelation(requestID: DiscoveryFixtures.requestID)
        let table: [(AnonymousDiscoveryState, DiscoveryPresentation)] = [
            (.editing, .ready), (.loading, .searching), (.cancelled, .cancelled),
            (.noMatch, .noOrganisation),
            (.selected(atelier), .found(atelier)),
            (.choosing([atelier, bureau]), .severalCandidates([atelier, bureau])),
            (.unavailable(.rateLimited(RetryHint(seconds: 1), correlation)), .tryAgainLater),
            (.unavailable(.transport(.offline)), .networkError(.offline)),
            (.unavailable(.transport(.timeout)), .networkError(.timeout)),
            (.unavailable(.transport(.tls)), .networkError(.tls)),
            (.unavailable(.temporarilyUnavailable(RetryHint(seconds: 5), correlation)), .serviceUnavailable),
            (.unavailable(.internalServiceError(correlation)), .serviceUnavailable),
            (.unavailable(.unsupportedService), .serviceUnavailable),
            (.unavailable(.rejectedRequest(.forbidden)), .requestRefused),
            (.unavailable(.rejectedRequest(.validationError)), .requestRefused),
            (.unavailable(.protocolViolation), .invalidResponse),
            (.unavailable(.invalidInput), .invalidInput),
            (.unavailable(.notConfigured), .notConfigured),
        ]
        for (state, expected) in table {
            XCTAssertEqual(DiscoveryPresentation(state), expected, "\(state)")
            if case .found = expected {
                XCTAssertEqual(DiscoveryPresentation(state).signInIssuer, atelier.issuer)
            } else {
                XCTAssertNil(DiscoveryPresentation(state).signInIssuer, "only a found organisation offers sign-in")
            }
        }
    }

    func testChoosingOneOfSeveralCandidatesFindsIt() throws {
        let atelier = DiscoveryFixtures.metadata()
        let bureau = DiscoveryFixtures.metadata(id: "22222222-2222-4222-8222-222222222222", slug: "bureau")
        var state = DiscoveryState()
        let ticket = state.begin()
        state.receive(.result(.multiple([atelier, bureau])), for: ticket)
        XCTAssertNil(DiscoveryPresentation(state.value).signInIssuer, "several candidates need a choice first")
        try state.select(organisationId: bureau.organisationId)
        XCTAssertEqual(DiscoveryPresentation(state.value), .found(bureau))
        XCTAssertEqual(DiscoveryPresentation(state.value).signInIssuer, bureau.issuer)
    }
}
