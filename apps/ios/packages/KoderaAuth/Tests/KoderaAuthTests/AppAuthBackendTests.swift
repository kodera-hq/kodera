import Foundation
import XCTest
@preconcurrency import AppAuth
import KoderaDomain
@testable import KoderaAuth

final class AppAuthBackendTests: XCTestCase {
    private func admitted(_ issuer: String = "https://auth.kodera.test/realms/acme-sa") throws -> AdmittedIssuer {
        try IssuerAdmission.admit(issuer: issuer, admittedOrigins: ["https://auth.kodera.test"], loopback: .refuse)
    }

    private func service(issuer: String, authorization: String, token: String,
                         extra: [String: Any] = [:]) throws -> OIDServiceConfiguration {
        let fields: [String: Any] = [
            "issuer": issuer,
            "authorization_endpoint": authorization,
            "token_endpoint": token,
            "jwks_uri": issuer + "/protocol/openid-connect/certs",
            "response_types_supported": ["code"],
            "subject_types_supported": ["public"],
            "id_token_signing_alg_values_supported": ["RS256"],
        ]
        let discovery = try OIDServiceDiscovery(dictionary: fields.merging(extra) { $1 })
        return OIDServiceConfiguration(discoveryDocument: discovery)
    }

    @MainActor
    func testDiscoveryMustNameTheAdmittedIssuerAndKeepEndpointsOnItsOrigin() throws {
        let issuer = "https://auth.kodera.test/realms/acme-sa"
        let endpoint = issuer + "/protocol/openid-connect"
        XCTAssertNoThrow(try AppAuthBackend.check(service(issuer: issuer, authorization: endpoint + "/auth",
            token: endpoint + "/token"), against: admitted()))
        let refused = [
            (issuer + "/", endpoint + "/auth", endpoint + "/token"),
            ("https://auth.kodera.test/realms/other-org", endpoint + "/auth", endpoint + "/token"),
            (issuer, "https://evil.test/auth", endpoint + "/token"),
            (issuer, endpoint + "/auth", "https://evil.test/token"),
            (issuer, endpoint + "/auth", "http://auth.kodera.test/realms/acme-sa/token"),
        ]
        for (claimed, authorization, token) in refused {
            XCTAssertThrowsError(try AppAuthBackend.check(service(issuer: claimed, authorization: authorization,
                token: token), against: admitted()), "\(claimed) \(authorization) \(token)") {
                XCTAssertEqual($0 as? BackendFailure, .protocolViolation)
            }
        }
    }

    @MainActor
    func testErrorsAreClassifiedWithoutReadingProviderProse() {
        let cases: [(NSError?, BackendFailure)] = [
            (NSError(domain: OIDGeneralErrorDomain, code: OIDErrorCode.userCanceledAuthorizationFlow.rawValue), .cancelled),
            (NSError(domain: OIDGeneralErrorDomain, code: OIDErrorCode.programCanceledAuthorizationFlow.rawValue), .cancelled),
            (NSError(domain: OIDGeneralErrorDomain, code: OIDErrorCode.networkError.rawValue), .unavailable),
            (NSError(domain: OIDGeneralErrorDomain, code: OIDErrorCode.idTokenFailedValidationError.rawValue), .protocolViolation),
            (NSError(domain: OIDOAuthTokenErrorDomain, code: OIDErrorCodeOAuth.invalidGrant.rawValue), .refused),
            (NSError(domain: OIDOAuthAuthorizationErrorDomain, code: OIDErrorCodeOAuth.accessDenied.rawValue), .refused),
            (NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet), .unavailable),
            (NSError(domain: "elsewhere", code: 1), .protocolViolation),
            (nil, .protocolViolation),
        ]
        for (error, expected) in cases {
            XCTAssertEqual(AppAuthBackend.classify(error), expected, "\(String(describing: error))")
        }
    }

    /// RFC 9207: an `iss` in the authorization response must be the admitted issuer, checked before the
    /// code is exchanged.
    func testAnIssuerNamedInTheAuthorizationResponseMustBeTheAdmittedOne() throws {
        let issuer = try admitted()
        XCTAssertNoThrow(try AppAuthBackend.checkIssuerParameter(nil, required: false, against: issuer),
                         "absent is accepted when discovery does not advertise it")
        XCTAssertThrowsError(try AppAuthBackend.checkIssuerParameter(nil, required: true, against: issuer),
                             "absent is refused when discovery advertises it") {
            XCTAssertEqual($0 as? BackendFailure, .protocolViolation)
        }
        let refused: [Any] = ["https://auth.kodera.test/realms/other-org", issuer.issuer + "/",
                              "https://evil.test/realms/acme-sa", "HTTPS://auth.kodera.test/realms/acme-sa", "",
                              42, [issuer.issuer]]
        for required in [false, true] {
            XCTAssertNoThrow(try AppAuthBackend.checkIssuerParameter(issuer.issuer, required: required, against: issuer))
            for value in refused {
                XCTAssertThrowsError(try AppAuthBackend.checkIssuerParameter(value, required: required,
                                                                            against: issuer), "\(value)") {
                    XCTAssertEqual($0 as? BackendFailure, .protocolViolation, "\(value)")
                }
            }
        }
    }

    func testTheIssuerParameterIsRequiredOnlyWhereDiscoveryAdvertisesIt() throws {
        let issuer = "https://auth.kodera.test/realms/acme-sa"
        let endpoint = issuer + "/protocol/openid-connect"
        let plain = try service(issuer: issuer, authorization: endpoint + "/auth", token: endpoint + "/token")
        XCTAssertFalse(AppAuthBackend.advertisesIssuerParameter(plain))
        for (advertised, expected) in [(true, true), (false, false)] {
            let configuration = try service(issuer: issuer, authorization: endpoint + "/auth", token: endpoint + "/token",
                                            extra: ["authorization_response_iss_parameter_supported": advertised])
            XCTAssertEqual(AppAuthBackend.advertisesIssuerParameter(configuration), expected, "\(advertised)")
        }
        let text = try service(issuer: issuer, authorization: endpoint + "/auth", token: endpoint + "/token",
                               extra: ["authorization_response_iss_parameter_supported": "true"])
        XCTAssertFalse(AppAuthBackend.advertisesIssuerParameter(text), "only a JSON true counts")
    }

    /// Without an ID token, AppAuth's nonce, issuer and audience checks would not have run.
    func testTheCodeExchangeMustReturnAnIDToken() {
        XCTAssertNoThrow(try AppAuthBackend.checkTokens(accessToken: "access", idToken: "id"))
        XCTAssertThrowsError(try AppAuthBackend.checkTokens(accessToken: "access", idToken: nil)) {
            XCTAssertEqual($0 as? BackendFailure, .protocolViolation)
        }
        XCTAssertThrowsError(try AppAuthBackend.checkTokens(accessToken: nil, idToken: "id")) {
            XCTAssertEqual($0 as? BackendFailure, .refused)
        }
    }

    /// A refresh signs the member out only on a real refusal; everything else keeps the session.
    func testRefreshSignsOutOnlyOnARealRefusal() {
        let invalidGrant = NSError(domain: OIDOAuthTokenErrorDomain, code: OIDErrorCodeOAuth.invalidGrant.rawValue)
        XCTAssertEqual(AppAuthBackend.refreshOutcome(stillAuthorized: false, error: invalidGrant), .refused)
        let transient = [OIDErrorCodeOAuth.temporarilyUnavailable.rawValue, OIDErrorCodeOAuth.serverError.rawValue]
        for code in transient {
            let error = NSError(domain: OIDOAuthTokenErrorDomain, code: code)
            XCTAssertEqual(AppAuthBackend.refreshOutcome(stillAuthorized: false, error: error), .unavailable, "\(code)")
        }
        let kept: [NSError?] = [
            // A captive portal answers HTML with a 200.
            NSError(domain: OIDGeneralErrorDomain, code: OIDErrorCode.jsonDeserializationError.rawValue),
            NSError(domain: OIDGeneralErrorDomain, code: OIDErrorCode.tokenResponseConstructionError.rawValue),
            // Clock skew: the refreshed ID token looks expired or issued in the future.
            NSError(domain: OIDGeneralErrorDomain, code: OIDErrorCode.idTokenFailedValidationError.rawValue),
            NSError(domain: OIDGeneralErrorDomain, code: OIDErrorCode.serverError.rawValue),
            NSError(domain: OIDGeneralErrorDomain, code: OIDErrorCode.networkError.rawValue),
            NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut),
            nil,
        ]
        for error in kept {
            XCTAssertEqual(AppAuthBackend.refreshOutcome(stillAuthorized: true, error: error), .unavailable,
                           "\(String(describing: error))")
        }
    }

    @MainActor
    func testEveryAppAuthRequestGoesOutOnTheHardenedSession() {
        AppAuthBackend.hardenNetworking()
        let session = OIDURLSessionProvider.session()
        XCTAssertTrue(session.delegate is RefuseRedirects, "AppAuth would follow a redirect with the code or token")
        XCTAssertFalse(session.configuration.httpShouldSetCookies)
        XCTAssertEqual(session.configuration.requestCachePolicy, .reloadIgnoringLocalCacheData)
    }

    func testRedirectsAreNeverFollowed() async throws {
        let session = HardenedSession.make()
        defer { session.invalidateAndCancel() }
        let token = try XCTUnwrap(URL(string: "https://auth.kodera.test/realms/acme-sa/protocol/openid-connect/token"))
        let elsewhere = try XCTUnwrap(URL(string: "https://evil.test/token"))
        let redirect = try XCTUnwrap(HTTPURLResponse(url: token, statusCode: 307, httpVersion: "HTTP/1.1",
                                                     headerFields: ["Location": elsewhere.absoluteString]))
        let next = await RefuseRedirects().urlSession(session, task: session.dataTask(with: token),
                                                      willPerformHTTPRedirection: redirect,
                                                      newRequest: URLRequest(url: elsewhere))
        XCTAssertNil(next)
    }

    func testTheRevocationEndpointComesFromDiscovery() throws {
        let issuer = "https://auth.kodera.test/realms/acme-sa"
        let endpoint = issuer + "/protocol/openid-connect"
        let without = try service(issuer: issuer, authorization: endpoint + "/auth", token: endpoint + "/token")
        XCTAssertNil(AppAuthBackend.revocationEndpoint(without))
        let with = try service(issuer: issuer, authorization: endpoint + "/auth", token: endpoint + "/token",
                               extra: ["revocation_endpoint": endpoint + "/revoke"])
        XCTAssertEqual(AppAuthBackend.revocationEndpoint(with), endpoint + "/revoke")
    }

    /// The revocation request ends, in total, before a sign-in stops waiting for it: the app never opens
    /// the browser while its own revocation is still in flight.
    func testTheRevocationRequestEndsBeforeASignInStopsWaitingForIt() {
        let session = Revocation.session()
        defer { session.invalidateAndCancel() }
        XCTAssertEqual(session.configuration.timeoutIntervalForRequest, Revocation.revocationLimit)
        XCTAssertEqual(session.configuration.timeoutIntervalForResource, Revocation.revocationLimit,
                       "the revocation's whole exchange is bounded by its own limit, not the 60 s identity limit")
        XCTAssertLessThan(Duration.seconds(Revocation.revocationLimit), KoderaSignInService.revocationWaitLimit,
                          "a sign-in must outwait the revocation request it waits for")
    }

    /// No wait in a sign-in is unbounded: every identity request has a whole-exchange limit, and a browser
    /// step whose callback never comes is cancelled.
    @MainActor
    func testNoSignInStepWaitsForever() {
        let session = HardenedSession.make()
        defer { session.invalidateAndCancel() }
        XCTAssertEqual(session.configuration.timeoutIntervalForResource, HardenedSession.resourceLimit)
        XCTAssertLessThanOrEqual(HardenedSession.resourceLimit, 60)
        XCTAssertLessThanOrEqual(AppAuthBackend.browserLimit, .seconds(600))
        XCTAssertGreaterThan(AppAuthBackend.browserLimit, .seconds(60), "long enough to type a password and an OTP")
    }

    @MainActor
    func testUnarchivingGarbageIsAProtocolViolation() {
        XCTAssertThrowsError(try AppAuthBackend.unarchive(Data("not an archive".utf8))) {
            XCTAssertEqual($0 as? BackendFailure, .protocolViolation)
        }
    }

    func testRevocationGoesOnlyToTheIssuerOrigin() throws {
        let issuer = try admitted()
        let endpoint = "https://auth.kodera.test/realms/acme-sa/protocol/openid-connect/revoke"
        let request = try XCTUnwrap(Revocation.request(endpoint: endpoint, refreshToken: "a b+c/=",
            clientID: "kodera-ios", issuer: issuer))
        XCTAssertEqual(request.url?.absoluteString, endpoint)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/x-www-form-urlencoded")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(String(decoding: try XCTUnwrap(request.httpBody), as: UTF8.self),
                       "token=a%20b%2Bc%2F%3D&token_type_hint=refresh_token&client_id=kodera-ios")
        for elsewhere in ["https://evil.test/revoke", "https://auth.kodera.test.evil/revoke",
                          "http://auth.kodera.test/realms/acme-sa/revoke"] {
            XCTAssertNil(Revocation.request(endpoint: elsewhere, refreshToken: "t", clientID: "kodera-ios",
                issuer: issuer), elsewhere)
        }
    }
}
