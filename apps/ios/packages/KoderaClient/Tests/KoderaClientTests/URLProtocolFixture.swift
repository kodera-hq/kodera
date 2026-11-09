import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import KoderaClient

// Synthetic transport only. This file is never compiled into the application library.
final class URLProtocolFixture: URLProtocol, @unchecked Sendable {
    enum Response: Sendable {
        case body(status: Int, headers: [String: String], chunks: [Data])
        case stream(status: Int, headers: [String: String], chunks: [Data])
        case redirect(status: Int, location: String)
        case failure(URLError.Code)
        case hold
    }
    private final class Storage: @unchecked Sendable {
        let lock = NSLock()
        var responses: [Response] = [.hold]
        var requests: [URLRequest] = []
        var stopped = 0
    }
    private static let storage = Storage()
    /// This load's own stop, so a delayed answer never reaches a load the session has stopped.
    private let instanceLock = NSLock()
    private var instanceStopped = false

    static func install(_ response: Response) { install(sequence: [response]) }

    /// One response per request, in order; the last one repeats.
    static func install(sequence: [Response]) {
        precondition(!sequence.isEmpty)
        storage.lock.withLock {
            storage.responses = sequence
            storage.requests = []
            storage.stopped = 0
        }
    }
    static var requests: [URLRequest] { storage.lock.withLock { storage.requests } }
    static var stopCount: Int { storage.lock.withLock { storage.stopped } }

    static func bodyData(_ request: URLRequest) throws -> Data {
        if let body = request.httpBody { return body }
        let stream = try XCTUnwrap(request.httpBodyStream)
        stream.open()
        defer { stream.close() }
        var body = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while body.count <= 4096 {
            let count = stream.read(&buffer, maxLength: min(buffer.count, 4097 - body.count))
            if count == 0 { return body }
            guard count > 0 else { throw URLError(.cannotDecodeRawData) }
            body.append(contentsOf: buffer.prefix(count))
        }
        throw URLError(.dataLengthExceedsMaximum)
    }

    /// URLSession calls stopLoading asynchronously after a task is cancelled, so the
    /// count is read only once it moves or the deadline passes.
    static func waitForStop() async -> Int {
        for _ in 0..<400 {
            if stopCount > 0 { break }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return stopCount
    }

    static func waitForStart() async {
        for _ in 0..<40 {
            if !requests.isEmpty { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = Self.storage.lock.withLock {
            Self.storage.requests.append(request)
            let next = Self.storage.responses[0]
            if Self.storage.responses.count > 1 { Self.storage.responses.removeFirst() }
            return next
        }
        switch response {
        case let .body(status, headers, chunks):
            send(status: status, headers: headers, chunks: chunks, finish: true)
        case let .stream(status, headers, chunks):
            send(status: status, headers: headers, chunks: chunks, finish: false)
        case let .redirect(status, location):
            let response = HTTPURLResponse(url: request.url!, statusCode: status,
                httpVersion: "HTTP/1.1", headerFields: ["Location": location])!
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: URL(string: location)!),
                redirectResponse: response)
            // A delegate that refuses the redirect receives the 3xx itself, as from a server, so the load
            // finishes with it rather than at the transport timeout. The 3xx goes out only after a hop
            // and only if this load is still running: a followed redirect stops this load and starts a
            // new one, and must never be answered by a 3xx queued before the delegate decided.
            let answer = Deferred { [self] in
                guard !instanceLock.withLock({ instanceStopped }) else { return }
                send(status: status, headers: ["Location": location], chunks: [], finish: true)
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(100)) { answer.run() }
        case let .failure(code): client?.urlProtocol(self, didFailWithError: URLError(code))
        case .hold: break
        }
    }

    private func send(status: Int, headers: [String: String], chunks: [Data], finish: Bool) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status,
            httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for chunk in chunks { client?.urlProtocol(self, didLoad: chunk) }
        if finish { client?.urlProtocolDidFinishLoading(self) }
    }

    override func stopLoading() {
        instanceLock.withLock { instanceStopped = true }
        Self.storage.lock.withLock { Self.storage.stopped += 1 }
    }
}

/// Carries a load's delayed answer across the hop. swift-corelibs-foundation does not let a URLProtocol
/// be captured in a `@Sendable` closure; the answer touches the load only through its client and its lock.
private final class Deferred: @unchecked Sendable {
    let run: () -> Void
    init(_ run: @escaping () -> Void) { self.run = run }
}

enum DiscoveryFixtures {
    static let requestID = "test-request-1"
    static let headers = ["Content-Type": "application/json", "Cache-Control": "no-store",
                          "X-Request-Id": requestID]
    /// The contract's own examples (`RealmDiscoveryResult.examples` at `contracts/v0.26.0`) put realms on
    /// `https://id.kodera.io`, so that is the one configured issuer origin here.
    static var configuration: CoreDiscoveryConfiguration {
        get throws {
            try CoreDiscoveryConfiguration(coreApiOrigin: "https://core.test",
                admittedIssuerOrigins: ["https://id.kodera.io"])
        }
    }
    static func data(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }
    static func json(_ object: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
    static func object(_ name: String = "discovery-one") throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data(name)) as? [String: Any])
    }
    static func candidate(id: String = "11111111-1111-4111-8111-111111111111", slug: String = "atelier") -> [String: Any] {
        let issuer = "https://id.kodera.io/realms/" + slug
        return ["realm": slug, "issuer": issuer,
            "openid_configuration_url": issuer + "/.well-known/openid-configuration",
            "organisation": ["id": id, "slug": slug, "name": "Atelier Example", "realm": slug]]
    }
    static func metadata(id: String = "11111111-1111-4111-8111-111111111111",
                         slug: String = "atelier") -> AnonymousOrganisationMetadata {
        let issuer = "https://id.kodera.io/realms/" + slug
        return AnonymousOrganisationMetadata(organisationId: id, organisationSlug: slug,
            displayName: "Atelier Example", realm: slug, issuer: issuer,
            openidConfigurationURL: issuer + "/.well-known/openid-configuration")
    }
    static func problem(status: Int, type: String, retry: Any? = nil) throws -> Data {
        var value: [String: Any] = ["type": "https://kodera.io/problems/" + type,
            "title": "PRIVATE TITLE SENTINEL", "detail": "PRIVATE DETAIL SENTINEL",
            "status": status, "request_id": requestID]
        if let retry { value["retry_after_s"] = retry }
        return try json(value)
    }
    static func problemHeaders(retry: String? = nil) -> [String: String] {
        var value = headers
        value["Content-Type"] = "application/problem+json"
        if let retry { value["Retry-After"] = retry }
        return value
    }
}
