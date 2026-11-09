import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import KoderaDomain

/// Protected anonymous origins only; construction establishes no reachability or identity.
/// Every origin goes through `IssuerAdmission.validateOrigin`, the one validator sign-in also uses, so a
/// development build (`.admitForDevelopment`) can discover against a loopback Core and realm.
public struct CoreDiscoveryConfiguration: Equatable, Sendable {
    public let trust: DiscoveryTrust
    public init(coreApiOrigin: String, admittedIssuerOrigins: Set<String>, loopback: LoopbackPolicy = .refuse) throws {
        try IssuerAdmission.validateOrigin(coreApiOrigin, loopback: loopback)
        guard !admittedIssuerOrigins.isEmpty else { throw DiscoveryFailure.notConfigured }
        for origin in admittedIssuerOrigins { try IssuerAdmission.validateOrigin(origin, loopback: loopback) }
        self.trust = DiscoveryTrust(coreApiOrigin: coreApiOrigin, admittedIssuerOrigins: admittedIssuerOrigins,
                                    loopback: loopback)
    }
}

/// What one discovery looks up: exactly one of the two members `RealmDiscoveryRequest` allows.
public enum DiscoveryQuery: Equatable, Sendable {
    /// A canonical organisation slug, sent as typed: no URL parsing or case repair.
    case slug(String)
    /// An approved ASCII email. Core uses only its domain, against verified organisation domains.
    case email(String)
}

/// Anonymous discovery only (`discoverRealm`, `POST /api/v1/auth/discover`, contract `contracts/v0.26.0`).
/// Every call owns a separate nonpersistent session/task, bound to the configured Core origin: no bearer, no
/// cookie, no cache, no redirect. The request sends `Content-Type: application/json` and a fresh
/// `Idempotency-Key`, which Core checks from the headers before any quota charge, and never `Origin` or
/// `Sec-Fetch-Site`: Core refuses a browser's cross-site request on those, and a request carrying neither is a
/// native client's. A call is one request: nothing here retries, so a quota answer (429 `rate-limited`)
/// reaches the caller as it came.
public actor CoreDiscoveryClient {
    private let configuration: CoreDiscoveryConfiguration?
    private let protocolClass: URLProtocol.Type?
    private let resourceTimeout: TimeInterval
    private let completionGate: (@Sendable () -> Void)?
    private var active: [UUID: DiscoveryTransport] = [:]
    private var closed = false

    public init(configuration: CoreDiscoveryConfiguration?) {
        self.configuration = configuration
        self.protocolClass = nil
        self.resourceTimeout = 15
        self.completionGate = nil
    }

    // Internal test seam; production callers cannot supply a fixture/session provider.
    init(configuration: CoreDiscoveryConfiguration?, protocolClass: URLProtocol.Type,
         resourceTimeout: TimeInterval, completionGate: (@Sendable () -> Void)? = nil) throws {
        guard resourceTimeout.isFinite, resourceTimeout > 0, resourceTimeout <= 15 else {
            throw DiscoveryFailure.notConfigured
        }
        self.configuration = configuration
        self.protocolClass = protocolClass
        self.resourceTimeout = resourceTimeout
        self.completionGate = completionGate
    }

    public func discover(slug: String) async -> AnonymousDiscoveryOutcome {
        await discover(.slug(slug))
    }

    public func discover(email: String) async -> AnonymousDiscoveryOutcome {
        await discover(.email(email))
    }

    public func discover(_ query: DiscoveryQuery) async -> AnonymousDiscoveryOutcome {
        guard !closed, let configuration else { return .failure(.notConfigured) }
        let member: [String: String]
        let requestedSlug: String?
        switch query {
        case let .slug(slug):
            guard DiscoveryEnvelope.canonicalSlug(slug) else { return .failure(.invalidInput) }
            member = ["slug": slug]
            requestedSlug = slug
        case let .email(email):
            guard DiscoveryEnvelope.approvedEmail(email) else { return .failure(.invalidInput) }
            member = ["email": email]
            // Core matches the email's domain, so the organisation found has its own slug.
            requestedSlug = nil
        }
        guard !Task.isCancelled else { return .cancelled }
        guard let url = URL(string: configuration.trust.coreApiOrigin + "/api/v1/auth/discover"),
              let body = try? JSONSerialization.data(withJSONObject: member, options: [.sortedKeys]),
              body.count <= 4096 else { return .failure(.invalidInput) }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: resourceTimeout)
        request.httpMethod = "POST"
        request.httpBody = body
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json, application/problem+json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "Idempotency-Key")
        let transport = DiscoveryTransport(configuration: configuration, protocolClass: protocolClass,
            timeout: resourceTimeout, requestedSlug: requestedSlug, completionGate: completionGate)
        let identity = UUID()
        active[identity] = transport
        let outcome = await withTaskCancellationHandler {
            await transport.perform(request)
        } onCancel: {
            transport.cancel()
        }
        active.removeValue(forKey: identity)
        return outcome
    }

    public func close() async {
        closed = true
        let transports = Array(active.values)
        for transport in transports { transport.cancel() }
        for transport in transports { await transport.cancelAndWait() }
    }
}

/// URLSession callbacks and Swift task cancellation share only lock-protected state.
/// No lock is held while cancelling a task, invoking a delegate completion or resuming a continuation.
private final class DiscoveryTransport: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let configuration: CoreDiscoveryConfiguration
    private let protocolClass: URLProtocol.Type?
    private let timeout: TimeInterval
    private let requestedSlug: String?
    private let completionGate: (@Sendable () -> Void)?
    private let lock = NSLock()
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var watchdog: Task<Void, Never>?
    private var continuation: CheckedContinuation<AnonymousDiscoveryOutcome, Never>?
    private var terminationWaiters: [CheckedContinuation<Void, Never>] = []
    private var pending: AnonymousDiscoveryOutcome?
    private var result: AnonymousDiscoveryOutcome?
    private var body = Data()
    private var status: Int?
    private var headers: [String: String] = [:]

    init(configuration: CoreDiscoveryConfiguration, protocolClass: URLProtocol.Type?, timeout: TimeInterval,
         requestedSlug: String?, completionGate: (@Sendable () -> Void)?) {
        self.configuration = configuration
        self.protocolClass = protocolClass
        self.timeout = timeout
        self.requestedSlug = requestedSlug
        self.completionGate = completionGate
    }

    func perform(_ request: URLRequest) async -> AnonymousDiscoveryOutcome {
        await withCheckedContinuation { continuation in
            let setup: (AnonymousDiscoveryOutcome?, URLSessionDataTask?) = lock.withLock {
                if let result { return (result, nil) }
                self.continuation = continuation
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
                let task = session.dataTask(with: request)
                self.session = session
                self.task = task
                return (nil, task)
            }
            if let result = setup.0 {
                continuation.resume(returning: result)
                return
            }
            let timer = Task { [weak self, timeout] in
                do { try await Task.sleep(for: .seconds(timeout)) }
                catch { return }
                self?.stop(.failure(.transport(.timeout)))
            }
            let finished = lock.withLock {
                if result != nil || pending != nil { return true }
                watchdog = timer
                return false
            }
            if finished { timer.cancel() }
            setup.1?.resume()
        }
    }

    func cancel() { stop(.cancelled) }

    func cancelAndWait() async {
        cancel()
        await withCheckedContinuation { continuation in
            let finished = lock.withLock {
                if result != nil { return true }
                terminationWaiters.append(continuation)
                return false
            }
            if finished { continuation.resume() }
        }
    }

    private func stop(_ outcome: AnonymousDiscoveryOutcome) {
        let task = lock.withLock { () -> URLSessionDataTask? in
            guard result == nil else { return nil }
            if pending == nil { pending = outcome }
            return self.task
        }
        if let task { task.cancel() }
        else { complete(outcome) }
    }

    private func complete(_ outcome: AnonymousDiscoveryOutcome) {
        let terminal = lock.withLock { () -> (CheckedContinuation<AnonymousDiscoveryOutcome, Never>?, URLSession?, Task<Void, Never>?, AnonymousDiscoveryOutcome, [CheckedContinuation<Void, Never>])? in
            guard result == nil else { return nil }
            let resolved = pending ?? outcome
            result = resolved
            let terminal = (continuation, session, watchdog, resolved, terminationWaiters)
            continuation = nil
            session = nil
            task = nil
            watchdog = nil
            terminationWaiters = []
            body = Data()
            return terminal
        }
        guard let terminal else { return }
        terminal.2?.cancel()
        terminal.1?.invalidateAndCancel()
        terminal.0?.resume(returning: terminal.3)
        for waiter in terminal.4 { waiter.resume() }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse,
              response.url?.absoluteString == configuration.trust.coreApiOrigin + "/api/v1/auth/discover" else {
            stop(.failure(.protocolViolation)); completionHandler(.cancel); return
        }
        // Exactly the statuses `discoverRealm` documents; any other is not this service.
        guard [200, 400, 403, 413, 415, 422, 429, 500, 503].contains(response.statusCode) else {
            stop(.failure((300...399).contains(response.statusCode) ? .protocolViolation : .unsupportedService))
            completionHandler(.cancel)
            return
        }
        do {
            var fields: [String: String] = [:]
            for (key, value) in response.allHeaderFields {
                guard let name = key as? String, let text = value as? String else {
                    throw DiscoveryFailure.protocolViolation
                }
                fields[name] = text
            }
            let normalized = try DiscoveryProblem.validateHeaders(fields, problem: response.statusCode != 200)
            if let length = normalized["content-length"] {
                guard !length.isEmpty, length.utf8.allSatisfy({ (48...57).contains($0) }),
                      let count = Int(length), count <= StrictJSON.byteLimit else {
                    throw DiscoveryFailure.protocolViolation
                }
            }
            let stopped = lock.withLock {
                guard result == nil, pending == nil, status == nil else { return true }
                status = response.statusCode
                headers = normalized
                return false
            }
            completionHandler(stopped ? .cancel : .allow)
        } catch {
            stop(.failure(.protocolViolation))
            completionHandler(.cancel)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let overflow = lock.withLock {
            guard result == nil, pending == nil else { return false }
            guard data.count <= StrictJSON.byteLimit - body.count else {
                pending = .failure(.protocolViolation)
                return true
            }
            body.append(data)
            return false
        }
        if overflow { dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        // Internal tests may gate this session's private delegate queue; public construction always passes nil.
        completionGate?()
        let snapshot = lock.withLock { (pending, status, headers, body) }
        if let pending = snapshot.0 { complete(pending); return }
        if let error {
            let code = (error as? URLError)?.code
            switch code {
            case .cancelled: complete(.cancelled)
            case .timedOut: complete(.failure(.transport(.timeout)))
            case .notConnectedToInternet, .networkConnectionLost, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed:
                complete(.failure(.transport(.offline)))
            case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot,
                 .serverCertificateNotYetValid, .secureConnectionFailed, .clientCertificateRejected, .clientCertificateRequired:
                complete(.failure(.transport(.tls)))
            case .userAuthenticationRequired, .userCancelledAuthentication:
                complete(.failure(.transport(.authenticationChallenge)))
            default: complete(.failure(.transport(.other)))
            }
            return
        }
        guard let status = snapshot.1 else { complete(.failure(.protocolViolation)); return }
        do {
            if status == 200 {
                let metadata = try DiscoveryEnvelope.decode(data: snapshot.3, configuration: configuration)
                if let requested = requestedSlug, case let .single(organisation) = metadata,
                   organisation.organisationSlug != requested {
                    throw DiscoveryFailure.protocolViolation
                }
                complete(.result(metadata))
            } else {
                complete(.failure(try DiscoveryProblem.decode(data: snapshot.3, status: status, headers: snapshot.2)))
            }
        } catch { complete(.failure(.protocolViolation)) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        stop(.failure(.protocolViolation))
        completionHandler(nil)
    }

    private func challenge(_ challenge: URLAuthenticationChallenge,
                           completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        #if canImport(Darwin)
        // Server trust stays with the system evaluator. swift-corelibs-foundation verifies TLS
        // inside its transport and never surfaces this method, so Linux only refuses.
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        #endif
        stop(.failure(.transport(.authenticationChallenge)))
        completionHandler(.cancelAuthenticationChallenge, nil)
    }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        self.challenge(challenge, completionHandler: completionHandler)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        self.challenge(challenge, completionHandler: completionHandler)
    }
}
