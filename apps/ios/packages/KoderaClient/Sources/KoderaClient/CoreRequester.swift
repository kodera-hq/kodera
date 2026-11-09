import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import KoderaDomain

/// Passive internal test observations. Counts are logical Data counts, never capacity or process memory.
struct CoreBodyObservation: Sendable {
    enum Phase: Equatable, Sendable { case completeBody, retained, headerAccepted, headerRejected, overflow, terminal, sessionDrained }
    let attempt: UUID
    let sequence: Int
    let phase: Phase
    let retained: Int
    let incoming: Int
}

/// Why an access token could not be supplied.
public enum AccessTokenFailure: Error, Equatable, Sendable {
    /// The grant is gone (refused refresh, revoked, never signed in). The stored state is already wiped.
    case signedOut
    /// The grant is gone, as for `signedOut`, but its stored copy could not be deleted from this device.
    case signedOutNotWiped
    /// The identity provider could not be reached; the stored state is kept.
    case unavailable
}

/// The session ended, but its stored copy could not be deleted from this device. The caller must say so,
/// and make sure the copy is never resumed.
public struct SessionNotWiped: Error, Equatable, Sendable {
    public init() {}
}

/// An access token, and the session that served it.
public struct AccessToken: Sendable {
    public let value: String
    /// Opaque to Core clients: handed back to `endSessionLocally(servedBy:)`, so a refusal ends the session
    /// that served the token and never one that replaced it.
    public let session: UInt64

    public init(value: String, session: UInt64) {
        self.value = value
        self.session = session
    }
}

/// The sign-in owner, seen from Core clients. Implementations never log or expose tokens otherwise.
public protocol AccessTokenProvider: Sendable {
    /// A currently valid access token, refreshed first when it has expired or when `forceRefresh` is set.
    func accessToken(forceRefresh: Bool) async throws(AccessTokenFailure) -> AccessToken
    /// The member's explicit sign-out: wipe the stored state, then revoke the refresh token. The session
    /// is over either way; the error says the stored copy is still on the device.
    func signOut() async throws(SessionNotWiped)
    /// End the session that served a token on this device only: wipe the stored state and ask the provider
    /// nothing, since revocation would end the member's sessions on their other devices too. Nothing
    /// happens when that session has already ended. The error is `signOut()`'s.
    func endSessionLocally(servedBy session: UInt64) async throws(SessionNotWiped)
}

/// What one authorised Core request came to, before its caller reads the body.
enum CoreReply: Equatable, Sendable {
    /// Core answered with a status other than 401 or 403, and a body within `StrictJSON.byteLimit`.
    case answered(status: Int, body: Data)
    /// Core's answer was over `StrictJSON.byteLimit`; nothing of it is handed on.
    case tooLarge
    /// The path could leave the Core origin. It was refused before any token was asked for, and nothing
    /// was sent.
    case pathRefused
    /// 403: no access. It is not retried, and the session is kept.
    case forbidden
    /// The session ended: Core refused a freshly refreshed token, or the refresh itself was refused.
    case signedOut
    /// The session ended, as for `signedOut`, but its stored copy could not be deleted from this device.
    case signedOutNotWiped
    /// The identity provider could not be reached for a token; nothing was sent to Core.
    case identityUnavailable
    /// Core answered with a redirect, which is never followed.
    case redirected
    /// The request did not complete, or (`.other`) the call was cancelled or the requester was invalidated.
    case transport(TransportFailure)
}

/// The one path every authorised Core request takes, so the refusal policy lives in one place.
///
/// It is bound to one Core origin, validated once when it is built, and a request names only a path on
/// it: a path that could leave the origin is refused before any token is asked for, so the bearer token
/// is only ever sent to that origin. The app builds one requester per signed-in session, hands it to
/// every Core client of that session, and invalidates it when it leaves that session: from then on the
/// requester asks for no token and sends no request (see `invalidate()`).
///
/// The bearer comes from the sign-in owner. A 401 earns exactly one forced refresh and one retry; a second
/// 401 ends the session that served the refused token, on this device only and without revoking, and never
/// one that replaced it. A 403 is "no access", with no retry and no sign-out. Each request goes out on its
/// own ephemeral session with no cookies, cache or credential storage, and no redirect is followed, so the
/// token cannot be forwarded to another origin.
public actor CoreRequester {
    private let origin: String
    private let tokens: any AccessTokenProvider
    private let protocolClass: URLProtocol.Type?
    private let timeout: TimeInterval
    private let observeBody: (@Sendable (CoreBodyObservation) -> Void)?
    /// Set by `invalidate()`. Behind a lock rather than on the actor, so the owner closes the requester
    /// synchronously as it leaves the session, before any later call can reach the actor.
    private let closed = ClosedFlag()

    /// Throws when `coreApiOrigin` is not an origin `IssuerAdmission.validateOrigin` admits.
    public init(coreApiOrigin: String, loopback: LoopbackPolicy, tokens: any AccessTokenProvider) throws {
        try self.init(coreApiOrigin: coreApiOrigin, loopback: loopback, tokens: tokens, protocolClass: nil, timeout: 15,
                      observeBody: nil)
    }

    /// `protocolClass` is the test seam; production callers cannot supply a fixture transport.
    init(coreApiOrigin: String, loopback: LoopbackPolicy, tokens: any AccessTokenProvider,
         protocolClass: URLProtocol.Type?, timeout: TimeInterval,
         observeBody: (@Sendable (CoreBodyObservation) -> Void)? = nil) throws {
        try IssuerAdmission.validateOrigin(coreApiOrigin, loopback: loopback)
        origin = coreApiOrigin
        self.tokens = tokens
        self.protocolClass = protocolClass
        self.timeout = timeout
        self.observeBody = observeBody
    }

    /// Closes the requester for good, once its session is left. Every later `get(path:)` asks for no token
    /// and sends nothing (`.transport(.other)`). A request in flight stops at its next check: before the
    /// forced refresh, before each send and before a local session end. A request already sent is not
    /// cancelled; its answer comes back, but nothing more is sent or ended for it. Idempotent.
    public nonisolated func invalidate() { closed.close() }

    /// Whether `invalidate()` has run; an invalidated requester starts nothing more.
    public nonisolated var isInvalidated: Bool { closed.isClosed }

    /// `GET` of `path` on the Core origin, such as `/api/v1/me`.
    func get(path: String) async -> CoreReply {
        guard Self.staysOnOrigin(path), let url = URL(string: origin + path) else { return .pathRefused }
        guard !closed.isClosed else { return .transport(.other) }
        let first: AccessToken
        do { first = try await tokens.accessToken(forceRefresh: false) }
        catch { return Self.reply(error) }
        switch await attempt(url, token: first.value) {
        case let .done(reply): return reply
        case .unauthorized: break
        }
        // The refreshed grant may belong to a session that replaced this one: an invalidated requester asks
        // for nothing more.
        guard !closed.isClosed else { return .transport(.other) }
        let second: AccessToken
        do { second = try await tokens.accessToken(forceRefresh: true) }
        catch { return Self.reply(error) }
        switch await attempt(url, token: second.value) {
        case let .done(reply): return reply
        case .unauthorized: return await endSession(servedBy: second.session)
        }
    }

    /// Core refused a freshly refreshed token: the session that served it ends on this device. A request
    /// cancelled by then, or whose requester was invalidated, ends nothing: its caller has moved on (a
    /// sign-out, a new sign-in) and the answer belongs to a session that may already be gone. A late local
    /// end would otherwise wipe, without revoking, a session the member is signing out of.
    func endSession(servedBy session: UInt64) async -> CoreReply {
        guard !Task.isCancelled, !closed.isClosed else { return .transport(.other) }
        do throws(SessionNotWiped) { try await tokens.endSessionLocally(servedBy: session) }
        catch { return .signedOutNotWiped }
        return .signedOut
    }

    /// A path is `/` and one or more segments of unreserved characters (RFC 3986: letters, digits, `-`,
    /// `.`, `_`, `~`), with no empty, `.` or `..` segment. Everything else is refused: an absolute URL or
    /// a path without its leading `/` (which would extend the host), `//host`, dot segments, and `@`, `\`,
    /// `:`, `%` (every encoded variant), `?`, `#`, spaces and non-ASCII. A query, when a Core call needs
    /// one, is added here with its own rule.
    static func staysOnOrigin(_ path: String) -> Bool {
        let bytes = Array(path.utf8)
        guard bytes.first == UInt8(ascii: "/") else { return false }
        for segment in bytes.dropFirst().split(separator: UInt8(ascii: "/"), omittingEmptySubsequences: false) {
            guard !segment.isEmpty else { return false }
            guard !segment.elementsEqual(".".utf8), !segment.elementsEqual("..".utf8) else { return false }
            guard segment.allSatisfy(isUnreserved) else { return false }
        }
        return true
    }

    private static func isUnreserved(_ byte: UInt8) -> Bool {
        switch byte {
        case UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "A")...UInt8(ascii: "Z"),
             UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "-"), UInt8(ascii: "."), UInt8(ascii: "_"),
             UInt8(ascii: "~"):
            true
        default: false
        }
    }

    private static func reply(_ failure: AccessTokenFailure) -> CoreReply {
        switch failure {
        case .signedOut: .signedOut
        case .signedOutNotWiped: .signedOutNotWiped
        case .unavailable: .identityUnavailable
        }
    }

    private enum Attempt { case done(CoreReply), unauthorized }

    private func attempt(_ url: URL, token: String) async -> Attempt {
        // Checked again here: the requester may have been invalidated while the token was fetched.
        guard !Task.isCancelled, !closed.isClosed else { return .done(.transport(.other)) }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "GET"
        request.httpShouldHandleCookies = false
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json, application/problem+json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        let result = await BearerTransport(protocolClass: protocolClass, timeout: timeout, observeBody: observeBody).perform(request)
        switch result {
        case let .failure(reason): return .done(.transport(reason))
        case .redirected: return .done(.redirected)
        case .tooLarge: return .done(.tooLarge)
        case let .response(status, body):
            switch status {
            case 401: return .unauthorized
            case 403: return .done(.forbidden)
            default: return .done(.answered(status: status, body: body))
            }
        }
    }
}

/// One request on its own ephemeral session: no cookies, cache or credential storage, and no redirect is
/// ever followed, so a bearer token cannot be forwarded to another origin.
private final class BearerTransport: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    enum Result: Sendable {
        case response(status: Int, body: Data)
        case redirected
        case tooLarge
        case failure(TransportFailure)
    }
    private typealias Sink = @Sendable (CoreBodyObservation) -> Void
    private struct Delivery { let sink: Sink?; let event: CoreBodyObservation }
    private struct Finish {
        let continuation: CheckedContinuation<Result, Never>
        let result: Result
        let task: URLSessionDataTask?
        let session: URLSession?
        let event: Delivery
    }
    private let protocolClass: URLProtocol.Type?
    private let timeout: TimeInterval
    private let lock = NSLock()
    private var observeBody: Sink?
    private let attempt = UUID()
    private var sequence = 0
    private var body = Data()
    private var status: Int?
    private var expectedURL: URL?
    private var task: URLSessionDataTask?
    private var session: URLSession?
    private var continuation: CheckedContinuation<Result, Never>?
    private var selected = false
    private var cancelled = false

    init(protocolClass: URLProtocol.Type?, timeout: TimeInterval,
         observeBody: (@Sendable (CoreBodyObservation) -> Void)?) {
        self.protocolClass = protocolClass
        self.timeout = timeout
        self.observeBody = observeBody
    }

    /// Called only while the body/terminal state lock is held. Delivery always happens outside it.
    private func eventLocked(_ phase: CoreBodyObservation.Phase, incoming: Int = 0) -> Delivery {
        sequence += 1
        return Delivery(sink: observeBody, event: CoreBodyObservation(attempt: attempt, sequence: sequence,
            phase: phase, retained: body.count, incoming: incoming))
    }
    private func emit(_ value: Delivery?) { if let value { value.sink?(value.event) } }

    private func selectLocked(_ result: Result) -> Finish? {
        guard !selected, let continuation else { return nil }
        selected = true
        let finish = Finish(continuation: continuation, result: result, task: task, session: session,
                            event: eventLocked(.terminal))
        self.continuation = nil; task = nil; session = nil; expectedURL = nil; status = nil
        body = Data()
        return finish
    }
    private func finish(_ value: Finish?) {
        guard let value else { return }
        emit(value.event)
        value.task?.cancel()
        value.session?.invalidateAndCancel()
        value.continuation.resume(returning: value.result)
    }
    private func cancel() {
        let value = lock.withLock { cancelled = true; return selectLocked(.failure(.other)) }
        finish(value)
    }

    func perform(_ request: URLRequest) async -> Result {
        let settings = URLSessionConfiguration.ephemeral
        settings.urlCache = nil
        settings.httpCookieStorage = nil
        settings.urlCredentialStorage = nil
        settings.httpShouldSetCookies = false
        settings.requestCachePolicy = .reloadIgnoringLocalCacheData
        settings.timeoutIntervalForRequest = timeout
        settings.timeoutIntervalForResource = timeout
        if let protocolClass { settings.protocolClasses = [protocolClass] }
        let session = URLSession(configuration: settings, delegate: self, delegateQueue: nil)
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                let task = session.dataTask(with: request)
                let value = lock.withLock {
                    self.session = session; self.task = task; self.continuation = continuation
                    expectedURL = request.url
                    return cancelled ? selectLocked(.failure(.other)) : nil
                }
                if let value { finish(value) } else { task.resume() }
            }
        } onCancel: { self.cancel() }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        let action: (Delivery?, Finish?, Bool) = lock.withLock {
            guard !selected else { return (nil, nil, false) }
            guard let response = response as? HTTPURLResponse,
                  response.url?.absoluteString == expectedURL?.absoluteString else {
                return (nil, selectLocked(.redirected), false)
            }
            guard response.expectedContentLength <= Int64(StrictJSON.byteLimit) else {
                let observation = eventLocked(.headerRejected)
                return (observation, selectLocked(.tooLarge), false)
            }
            status = response.statusCode
            return (eventLocked(.headerAccepted), nil, true)
        }
        emit(action.0)
        completionHandler(action.2 ? .allow : .cancel)
        finish(action.1)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let action: (Delivery?, Finish?) = lock.withLock {
            guard !selected else { return (nil, nil) }
            guard data.count <= StrictJSON.byteLimit - body.count else {
                let observation = eventLocked(.overflow, incoming: data.count)
                return (observation, selectLocked(.tooLarge))
            }
            body.append(data)
            return (eventLocked(.retained, incoming: data.count), nil)
        }
        emit(action.0)
        finish(action.1)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let value = lock.withLock {
            if let error { return selectLocked(.failure(Self.reason(error))) }
            guard let status else { return selectLocked(.redirected) }
            return selectLocked(.response(status: status, body: body))
        }
        finish(value)
    }

    func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
        let observation = lock.withLock { let event = eventLocked(.sessionDrained); observeBody = nil; return event }
        emit(observation)
    }

    private static func reason(_ error: Error) -> TransportFailure {
        switch (error as? URLError)?.code {
        case .timedOut: .timeout
        case .notConnectedToInternet, .networkConnectionLost, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed:
            .offline
        case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot,
             .serverCertificateNotYetValid, .secureConnectionFailed:
            .tls
        default: .other
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        let value = lock.withLock { selectLocked(.redirected) }
        completionHandler(nil)
        finish(value)
    }
}

/// Set once, read from any thread.
private final class ClosedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var isClosed: Bool { lock.withLock { value } }
    func close() { lock.withLock { value = true } }
}
