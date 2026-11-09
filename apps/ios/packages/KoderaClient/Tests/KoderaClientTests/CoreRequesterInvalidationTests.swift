import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
import KoderaDomain
@testable import KoderaClient

/// Serves tokens like `FakeTokens`, and invalidates the requester it is aimed at just as it serves one: the
/// app left the session while a request was fetching its token. `onForcedRefresh` picks which token: the
/// first one, or the forced refresh after a 401.
private actor InvalidatingTokens: AccessTokenProvider {
    private let onForcedRefresh: Bool
    private var target: CoreRequester?
    private(set) var requested = 0
    private(set) var localEnds = 0

    init(onForcedRefresh: Bool) { self.onForcedRefresh = onForcedRefresh }

    func aim(at requester: CoreRequester) { target = requester }

    func accessToken(forceRefresh: Bool) async throws(AccessTokenFailure) -> AccessToken {
        requested += 1
        if forceRefresh == onForcedRefresh { target?.invalidate() }
        return AccessToken(value: "synthetic-access-\(requested)", session: UInt64(100 + requested))
    }

    func signOut() async throws(SessionNotWiped) {}

    func endSessionLocally(servedBy session: UInt64) async throws(SessionNotWiped) { localEnds += 1 }
}

/// Answers every request with a 401 and, on request number `invalidateOn`, invalidates the requester it is
/// aimed at before that answer goes back: the app left the session while Core was answering.
private final class InvalidatingUnauthorizedProtocol: URLProtocol, @unchecked Sendable {
    private final class Storage: @unchecked Sendable {
        let lock = NSLock()
        var target: CoreRequester?
        var invalidateOn = 0
        var requests = 0
    }
    private static let storage = Storage()

    static func install(target: CoreRequester, invalidateOn: Int) {
        storage.lock.withLock {
            storage.target = target
            storage.invalidateOn = invalidateOn
            storage.requests = 0
        }
    }
    static var requests: Int { storage.lock.withLock { storage.requests } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let target = Self.storage.lock.withLock { () -> CoreRequester? in
            Self.storage.requests += 1
            return Self.storage.requests == Self.storage.invalidateOn ? Self.storage.target : nil
        }
        target?.invalidate()
        let response = HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/problem+json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// A bounded wait's deadline passed. The test has already failed, by name.
private struct DeadlinePassed: Error {
    let what: String
}

/// The first of an operation's result and a deadline; later ones are ignored.
private final class FirstValue<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var finished = false
    private var early: Result<T, DeadlinePassed>?
    private var waiter: CheckedContinuation<T, any Error>?

    func finish(_ result: Result<T, DeadlinePassed>) {
        let waiting: CheckedContinuation<T, any Error>? = lock.withLock {
            guard !finished else { return nil }
            finished = true
            guard let waiter else {
                early = result
                return nil
            }
            self.waiter = nil
            return waiter
        }
        waiting?.resume(with: result.mapError { $0 as any Error })
    }

    func value() async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            let ready: Result<T, DeadlinePassed>? = lock.withLock {
                if let early { return early }
                waiter = continuation
                return nil
            }
            if let ready { continuation.resume(with: ready.mapError { $0 as any Error }) }
        }
    }
}

/// An invalidated requester never reaches the transport: the app invalidates it when it leaves the session
/// that owns it, so a long-lived client still holding it cannot send that session's bearer, or the next one's.
final class CoreRequesterInvalidationTests: XCTestCase {
    private static let path = "/api/v1/resource"
    private static let ok = URLProtocolFixture.Response.body(status: 200,
        headers: ["Content-Type": "application/json", "Cache-Control": "no-store"], chunks: [Data("{}".utf8)])
    private static let unauthorized = URLProtocolFixture.Response.body(status: 401,
        headers: ["Content-Type": "application/problem+json"], chunks: [Data("{}".utf8)])

    private func requester(_ tokens: any AccessTokenProvider) throws -> CoreRequester {
        try CoreRequester(coreApiOrigin: "https://core.test", loopback: .refuse, tokens: tokens,
            protocolClass: URLProtocolFixture.self, timeout: 2)
    }

    /// Every wait here is bounded: a regression fails the test by name, it never hangs the suite. Past the
    /// deadline the operation is cancelled and left behind rather than awaited.
    private func bounded<T: Sendable>(_ what: String, within limit: Duration = .seconds(5),
                                      file: StaticString = #filePath, line: UInt = #line,
                                      _ operation: @escaping @Sendable () async -> T) async throws -> T {
        let first = FirstValue<T>()
        let work = Task {
            let value = await operation()
            first.finish(.success(value))
        }
        let deadline = Task {
            do { try await Task.sleep(for: limit) } catch { return }
            first.finish(.failure(DeadlinePassed(what: what)))
        }
        defer { deadline.cancel() }
        do { return try await first.value() } catch let passed as DeadlinePassed {
            work.cancel()
            XCTFail("\(passed.what) did not finish within \(limit)", file: file, line: line)
            throw passed
        }
    }

    /// Owned by the check at the top of `get(path:)`, as on Android: an invalidated requester asks for no
    /// token, so none is refreshed for a session that is gone, and sends nothing.
    func testAnInvalidatedRequesterAsksForNoTokenAndSendsNothing() async throws {
        URLProtocolFixture.install(Self.ok)
        let tokens = FakeTokens()
        let requester = try requester(tokens)
        XCTAssertFalse(requester.isInvalidated, "a new requester is already invalidated")
        requester.invalidate()
        XCTAssertTrue(requester.isInvalidated, "invalidate() did not mark the requester invalidated")

        let path = Self.path
        let (reply, requested, again) = try await bounded("the invalidated requests") {
            let reply = await requester.get(path: path)
            requester.invalidate() // idempotent
            let again = await requester.get(path: path)
            let requested = await tokens.requested
            return (reply, requested, again)
        }
        XCTAssertEqual(reply, .transport(.other), "the first request after invalidate()")
        XCTAssertEqual(again, .transport(.other), "a request after a second invalidate()")
        XCTAssertEqual(requested, 0, "an invalidated requester asked for a token")
        XCTAssertEqual(URLProtocolFixture.requests.count, 0, "an invalidated requester reached the transport")
    }

    /// Owned by the check in `attempt`, which Android does not have: a requester invalidated while its
    /// request was fetching the token sends nothing with it, and a 401's retry never goes out.
    func testARequesterInvalidatedWhileFetchingItsTokenSendsNothing() async throws {
        for onForcedRefresh in [false, true] {
            let label = onForcedRefresh ? "invalidated during the 401's refresh" : "invalidated during the first token"
            URLProtocolFixture.install(sequence: [Self.unauthorized, Self.ok])
            let tokens = InvalidatingTokens(onForcedRefresh: onForcedRefresh)
            let requester = try requester(tokens)
            let path = Self.path
            let (reply, requested, localEnds) = try await bounded("the request \(label)") {
                await tokens.aim(at: requester)
                let reply = await requester.get(path: path)
                let requested = await tokens.requested
                let localEnds = await tokens.localEnds
                return (reply, requested, localEnds)
            }
            XCTAssertTrue(requester.isInvalidated, label)
            XCTAssertEqual(reply, .transport(.other), label)
            XCTAssertEqual(requested, onForcedRefresh ? 2 : 1, label)
            XCTAssertEqual(localEnds, 0, "\(label): an invalidated requester ended a session")
            XCTAssertEqual(URLProtocolFixture.requests.count, onForcedRefresh ? 1 : 0,
                           "\(label): a bearer went out after the requester was invalidated")
        }
    }

    /// Invalidated while a sent request waits for Core's answer, which is a 401. The request is not
    /// cancelled and its answer comes back, but nothing more goes out for it.
    /// - After the first attempt, the check before the forced refresh owns it: no token is refreshed for a
    ///   session that may have been replaced, and no retry is sent.
    /// - After the retry, the check in `endSession` owns it: no session is ended locally. Otherwise a late
    ///   second 401 after a sign-out would wipe a session without revoking it.
    func testARequesterInvalidatedWhileCoreAnswersRefreshesSendsAndEndsNothingMore() async throws {
        for invalidateOn in [1, 2] {
            let label = invalidateOn == 1 ? "invalidated while the first attempt waited for its 401"
                                          : "invalidated while the retry waited for its 401"
            let tokens = FakeTokens()
            let requester = try CoreRequester(coreApiOrigin: "https://core.test", loopback: .refuse, tokens: tokens,
                protocolClass: InvalidatingUnauthorizedProtocol.self, timeout: 2)
            InvalidatingUnauthorizedProtocol.install(target: requester, invalidateOn: invalidateOn)
            let path = Self.path
            let (reply, forced, localEnds) = try await bounded("the request \(label)") {
                let reply = await requester.get(path: path)
                let forced = await tokens.forcedRefreshes
                let localEnds = await tokens.localEnds
                return (reply, forced, localEnds)
            }
            XCTAssertEqual(reply, .transport(.other), label)
            XCTAssertEqual(forced, invalidateOn == 1 ? 0 : 1,
                           "\(label): a forced refresh was asked for after the requester was invalidated")
            XCTAssertEqual(InvalidatingUnauthorizedProtocol.requests, invalidateOn,
                           "\(label): a request went out after the requester was invalidated")
            XCTAssertEqual(localEnds, 0, "\(label): an invalidated requester ended the session locally")
        }
    }
}
