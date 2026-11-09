import Foundation
@preconcurrency import AppAuth
import KoderaDomain
#if canImport(UIKit)
import UIKit
#endif

/// AppAuth behind `AuthorizationBackend`: discovery from the admitted issuer, authorization code with
/// PKCE S256 in a non-ephemeral `ASWebAuthenticationSession`, the RFC 9207 `iss` check, the code exchange
/// (with AppAuth's ID token checks, an ID token being required), refresh, and RFC 7009 revocation. Every
/// AppAuth request goes out on a `HardenedSession`. Every AppAuth object stays on the main actor; only the
/// archived `OIDAuthState` leaves it.
@MainActor
public final class AppAuthBackend: AuthorizationBackend {
    #if os(iOS)
    public typealias Presenter = @MainActor () -> UIViewController?
    private let presenter: Presenter
    private var flow: (any OIDExternalUserAgentSession)?

    /// `presenter` returns the view controller the browser sheet is presented from.
    public init(presenter: @escaping Presenter) {
        self.presenter = presenter
        Self.hardenNetworking()
    }
    #else
    public init() {
        Self.hardenNetworking()
    }
    #endif

    private static var networkHardened = false

    /// AppAuth sends discovery, the code exchange and every refresh through `OIDURLSessionProvider`'s one
    /// session. It is replaced, once, by a `HardenedSession`: no cache, cookies or credential storage, and
    /// no redirect followed, so a code or a refresh token cannot be forwarded off the admitted origin.
    static func hardenNetworking() {
        guard !networkHardened else { return }
        networkHardened = true
        OIDURLSessionProvider.setSession(HardenedSession.make())
    }

    public func authorize(issuer: AdmittedIssuer, configuration: SignInConfiguration) async throws(BackendFailure)
        -> StoredGrant {
        guard let issuerURL = URL(string: issuer.issuer),
              let redirect = URL(string: SignInConfiguration.redirectURI) else { throw .protocolViolation }
        let service = try await discover(issuerURL)
        try Self.check(service, against: issuer)
        // This initializer generates state, nonce and a PKCE S256 verifier and challenge.
        let request = OIDAuthorizationRequest(configuration: service, clientId: configuration.clientID,
            scopes: configuration.scopes, redirectURL: redirect, responseType: OIDResponseTypeCode,
            additionalParameters: nil)
        let response = try await present(request)
        // RFC 9207, before the code is exchanged: required when discovery advertises it (Keycloak does),
        // and when present it must be the admitted issuer.
        try Self.checkIssuerParameter(response.additionalParameters?["iss"],
                                      required: Self.advertisesIssuerParameter(service), against: issuer)
        let tokens = try await Self.exchange(response)
        // A sign-in that fails after the provider issued tokens drops them, and never revokes them:
        // revocation would end the member's sessions for this client on their other devices too.
        try Self.checkTokens(accessToken: tokens.accessToken, idToken: tokens.idToken)
        let state = OIDAuthState(authorizationResponse: response, tokenResponse: tokens)
        guard state.isAuthorized else { throw .refused }
        return StoredGrant(issuer: issuer.issuer, archive: try Self.archive(state))
    }

    public func freshAccessToken(grant: StoredGrant, forceRefresh: Bool) async throws(BackendFailure) -> FreshToken {
        let state = try Self.unarchive(grant.archive)
        if forceRefresh { state.setNeedsTokenRefresh() }
        let token = try await Self.performWithFreshTokens(state)
        return FreshToken(accessToken: token, grant: StoredGrant(issuer: grant.issuer, archive: try Self.archive(state)))
    }

    public func revoke(grant: StoredGrant, issuer: AdmittedIssuer, configuration: SignInConfiguration) async {
        guard let state = try? Self.unarchive(grant.archive),
              let token = state.refreshToken,
              let endpoint = Self.revocationEndpoint(state.lastAuthorizationResponse.request.configuration),
              let request = Revocation.request(endpoint: endpoint, refreshToken: token,
                                              clientID: configuration.clientID, issuer: issuer) else { return }
        await Revocation.send(request)
    }

    // MARK: AppAuth calls

    private func discover(_ issuer: URL) async throws(BackendFailure) -> OIDServiceConfiguration {
        let result: Result<OIDServiceConfiguration, BackendFailure> = await withCheckedContinuation { continuation in
            OIDAuthorizationService.discoverConfiguration(forIssuer: issuer) { configuration, error in
                if let configuration { continuation.resume(returning: .success(configuration)) }
                else { continuation.resume(returning: .failure(Self.classify(error))) }
            }
        }
        return try result.get()
    }

    /// How long the browser step may stay open. `ASWebAuthenticationSession` reports a cancel when the
    /// member closes the sheet; if no callback ever came, the flow is cancelled here, so a sign-in (and
    /// the `flow` slot every later sign-in needs) is never held forever.
    static let browserLimit: Duration = .seconds(600)

    /// The browser step alone. AppAuth checks `state` against the request before it answers.
    private func present(_ request: OIDAuthorizationRequest) async throws(BackendFailure) -> OIDAuthorizationResponse {
        #if os(iOS)
        guard flow == nil else { throw .unavailable }
        guard let presenting = presenter() else { throw .unavailable }
        let watchdog = Task { @MainActor [weak self] in
            try? await Task.sleep(for: AppAuthBackend.browserLimit)
            guard !Task.isCancelled else { return }
            // AppAuth answers a cancelled flow through its callback, with programCanceledAuthorizationFlow.
            // The explicit form: AppAuth's `cancel(completion:)` is also imported as an async `cancel()`.
            self?.flow?.cancel(completion: nil)
        }
        defer { watchdog.cancel() }
        let result: Result<OIDAuthorizationResponse, BackendFailure> = await withCheckedContinuation { continuation in
            // Non-ephemeral by owner decision: the system browser keeps its cookies, so saved passwords and
            // passkeys work. Whether a live Keycloak browser session spares a second sign-in is expected, not
            // yet measured (see docs/native-auth.md).
            flow = OIDAuthorizationService.present(request, presenting: presenting,
                                                   prefersEphemeralSession: false) { response, error in
                if let response { continuation.resume(returning: .success(response)) }
                else { continuation.resume(returning: .failure(Self.classify(error))) }
            }
        }
        flow = nil
        return try result.get()
        #else
        throw .unavailable
        #endif
    }

    /// The code exchange, as `OIDAuthState.authState(byPresenting:)` does it: with the original response,
    /// so AppAuth checks the ID token's issuer, audience, expiry and nonce.
    private static func exchange(_ response: OIDAuthorizationResponse) async throws(BackendFailure) -> OIDTokenResponse {
        guard let request = response.tokenExchangeRequest() else { throw .protocolViolation }
        let result: Result<OIDTokenResponse, BackendFailure> = await withCheckedContinuation { continuation in
            OIDAuthorizationService.perform(request, originalAuthorizationResponse: response) { tokens, error in
                if let tokens { continuation.resume(returning: .success(tokens)) }
                else { continuation.resume(returning: .failure(classify(error))) }
            }
        }
        return try result.get()
    }

    private static func performWithFreshTokens(_ state: OIDAuthState) async throws(BackendFailure) -> String {
        let result: Result<String, BackendFailure> = await withCheckedContinuation { continuation in
            state.performAction { accessToken, _, error in
                if let accessToken, error == nil { continuation.resume(returning: .success(accessToken)) }
                else {
                    continuation.resume(returning: .failure(refreshOutcome(stillAuthorized: state.isAuthorized,
                                                                           error: error)))
                }
            }
        }
        return try result.get()
    }

    // MARK: Checks and mapping

    /// The discovery document must name exactly the admitted issuer, and the endpoints that receive the
    /// code and tokens must sit on its origin.
    nonisolated static func check(_ service: OIDServiceConfiguration, against issuer: AdmittedIssuer) throws(BackendFailure) {
        guard service.issuer?.absoluteString == issuer.issuer,
              IssuerAdmission.sharesOrigin(service.authorizationEndpoint.absoluteString, with: issuer),
              IssuerAdmission.sharesOrigin(service.tokenEndpoint.absoluteString, with: issuer) else {
            throw .protocolViolation
        }
    }

    /// RFC 9207. When the discovery document advertises `authorization_response_iss_parameter_supported`,
    /// an authorization response without `iss` is refused. Otherwise an absent `iss` is accepted (the
    /// discovery check already bound the endpoints). A present one must be exactly the admitted issuer.
    nonisolated static func checkIssuerParameter(_ value: Any?, required: Bool,
                                                 against issuer: AdmittedIssuer) throws(BackendFailure) {
        guard let value else {
            if required { throw .protocolViolation }
            return
        }
        guard let named = value as? String, named == issuer.issuer else { throw .protocolViolation }
    }

    nonisolated static func advertisesIssuerParameter(_ service: OIDServiceConfiguration) -> Bool {
        service.discoveryDocument?.discoveryDictionary["authorization_response_iss_parameter_supported"] as? Bool
            == true
    }

    /// An access token, and an ID token: without one, AppAuth's nonce and issuer checks would not have run.
    nonisolated static func checkTokens(accessToken: String?, idToken: String?) throws(BackendFailure) {
        guard accessToken != nil else { throw .refused }
        guard idToken != nil else { throw .protocolViolation }
    }

    /// A failed refresh is a refusal only when the provider refused the grant: AppAuth marks the state
    /// unauthorized after an OAuth error from the token endpoint, and the error is not a transient one
    /// (`temporarily_unavailable`, `server_error`). A malformed or captive-portal response, an ID token
    /// refused for clock skew, or an unreachable provider keeps the session. (A grant that cannot be
    /// unarchived is a protocol violation, and is wiped.)
    nonisolated static func refreshOutcome(stillAuthorized: Bool, error: (any Error)?) -> BackendFailure {
        if let error = error as NSError?, error.domain == OIDOAuthTokenErrorDomain,
           error.code == OIDErrorCodeOAuth.temporarilyUnavailable.rawValue
            || error.code == OIDErrorCodeOAuth.serverError.rawValue {
            return .unavailable
        }
        return stillAuthorized ? .unavailable : .refused
    }

    nonisolated static func revocationEndpoint(_ service: OIDServiceConfiguration) -> String? {
        service.discoveryDocument?.discoveryDictionary["revocation_endpoint"] as? String
    }

    nonisolated static func classify(_ error: (any Error)?) -> BackendFailure {
        guard let error = error as NSError? else { return .protocolViolation }
        switch error.domain {
        case OIDOAuthAuthorizationErrorDomain, OIDOAuthTokenErrorDomain: return .refused
        case OIDGeneralErrorDomain:
            switch error.code {
            case OIDErrorCode.userCanceledAuthorizationFlow.rawValue,
                 OIDErrorCode.programCanceledAuthorizationFlow.rawValue: return .cancelled
            case OIDErrorCode.networkError.rawValue, OIDErrorCode.serverError.rawValue: return .unavailable
            default: return .protocolViolation
            }
        case NSURLErrorDomain: return .unavailable
        default: return .protocolViolation
        }
    }

    nonisolated static func archive(_ state: OIDAuthState) throws(BackendFailure) -> Data {
        do { return try NSKeyedArchiver.archivedData(withRootObject: state, requiringSecureCoding: true) }
        catch { throw .protocolViolation }
    }

    nonisolated static func unarchive(_ data: Data) throws(BackendFailure) -> OIDAuthState {
        guard let state = try? NSKeyedUnarchiver.unarchivedObject(ofClass: OIDAuthState.self, from: data) else {
            throw .protocolViolation
        }
        return state
    }
}
