import Foundation
import KoderaDomain

/// RFC 7009 refresh-token revocation for a public client. Used by the explicit sign-out only: Keycloak
/// answers it by ending the member's sessions for this client on every device.
enum Revocation {
    /// `nil` unless the endpoint sits on the admitted issuer's origin. The request then goes out on a
    /// `HardenedSession`, which follows no redirect, so the refresh token reaches that origin and no other.
    static func request(endpoint: String, refreshToken: String, clientID: String, issuer: AdmittedIssuer) -> URLRequest? {
        request(endpoint: endpoint, token: refreshToken, hint: "refresh_token", clientID: clientID, issuer: issuer)
    }

    private static func request(endpoint: String, token: String, hint: String, clientID: String,
                                issuer: AdmittedIssuer) -> URLRequest? {
        guard IssuerAdmission.sharesOrigin(endpoint, with: issuer), let url = URL(string: endpoint) else { return nil }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.httpShouldHandleCookies = false
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(form([("token", token), ("token_type_hint", hint), ("client_id", clientID)]).utf8)
        return request
    }

    static func form(_ fields: [(String, String)]) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return fields.map { name, value in
            name + "=" + (value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")
        }.joined(separator: "&")
    }

    static let revocationLimit: TimeInterval = 10

    /// The session every revocation is sent on.
    static func session() -> URLSession {
        HardenedSession.make(timeout: revocationLimit, resource: revocationLimit)
    }

    /// The outcome is not used: the local state is already wiped, and the provider's answer changes nothing.
    static func send(_ request: URLRequest) async {
        // Its whole exchange ends before a sign-in stops waiting for it (15 s), so the app never opens
        // the browser while its own revocation is still in flight.
        let session = Self.session()
        defer { session.finishTasksAndInvalidate() }
        _ = try? await session.data(for: request)
    }
}

/// The network policy of every identity call (AppAuth's discovery, code exchange and refresh, and
/// revocation): an ephemeral session with no cache, cookies or credential storage, and no redirect is
/// ever followed. A code or a refresh token therefore reaches only the endpoint the origin checks admitted.
enum HardenedSession {
    static let resourceLimit: TimeInterval = 60

    static func make(timeout: TimeInterval = 15, resource: TimeInterval = HardenedSession.resourceLimit) -> URLSession {
        let settings = URLSessionConfiguration.ephemeral
        settings.urlCache = nil
        settings.httpCookieStorage = nil
        settings.urlCredentialStorage = nil
        settings.httpShouldSetCookies = false
        settings.requestCachePolicy = .reloadIgnoringLocalCacheData
        settings.timeoutIntervalForRequest = timeout
        // A server that trickles bytes cannot hold a sign-in or a refresh open: the whole exchange is bounded.
        settings.timeoutIntervalForResource = resource
        return URLSession(configuration: settings, delegate: RefuseRedirects(), delegateQueue: nil)
    }
}

/// Answers every redirect with "do not follow": the task completes with the 3xx response itself.
final class RefuseRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? { nil }
}
