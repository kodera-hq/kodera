import Foundation
import XCTest
@testable import KoderaClient

final class DiscoveryProblemTests: XCTestCase {
    private func decode(status: Int, type: String, retry: Any? = nil,
                        header: String? = nil) throws -> DiscoveryFailure {
        try DiscoveryProblem.decode(data: DiscoveryFixtures.problem(status: status, type: type, retry: retry),
            status: status, headers: DiscoveryFixtures.problemHeaders(retry: header))
    }
    func testContractedStatusTypeAndSafeCorrelationMapping() throws {
        let rejections: [(Int, String, RequestRejection)] = [(400, "malformed-request", .malformedRequest),
            (400, "idempotency-key-missing", .idempotencyKeyMissing), (403, "forbidden", .forbidden),
            (413, "payload-too-large", .payloadTooLarge), (415, "unsupported-media-type", .unsupportedMediaType),
            (422, "validation-error", .validationError)]
        for (status, type, reason) in rejections {
            XCTAssertEqual(try decode(status: status, type: type), .rejectedRequest(reason), type)
        }
        // A documented type under another status is not that problem.
        for (status, type) in [(400, "forbidden"), (403, "malformed-request"), (422, "payload-too-large")] {
            XCTAssertThrowsError(try decode(status: status, type: type), "\(status) \(type)")
        }
        XCTAssertEqual(try decode(status: 500, type: "internal-error"),
            .internalServiceError(ProblemCorrelation(requestID: DiscoveryFixtures.requestID)))
        XCTAssertThrowsError(try decode(status: 400, type: "unknown"))
    }
    func testStatusAndRequestIdDisagreementRefuses() throws {
        let data = try DiscoveryFixtures.problem(status: 400, type: "malformed-request")
        XCTAssertThrowsError(try DiscoveryProblem.decode(data: data, status: 422,
            headers: DiscoveryFixtures.problemHeaders()))
        var headers = DiscoveryFixtures.problemHeaders()
        headers["X-Request-Id"] = "different"
        XCTAssertThrowsError(try DiscoveryProblem.decode(data: data, status: 400, headers: headers))
        for requestID in ["", String(repeating: "a", count: 65), "request\n"] {
            var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            object["request_id"] = requestID
            headers["X-Request-Id"] = requestID
            XCTAssertThrowsError(try DiscoveryProblem.decode(data: DiscoveryFixtures.json(object), status: 400, headers: headers))
        }
        for field in ["type", "title", "status", "request_id"] {
            var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            object.removeValue(forKey: field)
            XCTAssertThrowsError(try DiscoveryProblem.decode(data: DiscoveryFixtures.json(object), status: 400,
                headers: DiscoveryFixtures.problemHeaders()))
        }
    }
    func testProblemProseNeverEntersPublicResult() throws {
        let failure = try decode(status: 500, type: "internal-error")
        XCTAssertFalse(String(describing: failure).contains("PRIVATE TITLE SENTINEL"))
        XCTAssertFalse(String(describing: failure).contains("PRIVATE DETAIL SENTINEL"))
        var problem = try XCTUnwrap(JSONSerialization.jsonObject(with:
            DiscoveryFixtures.problem(status: 400, type: "malformed-request")) as? [String: Any])
        problem["future_extension"] = ["ignored": "PRIVATE DETAIL SENTINEL"]
        XCTAssertEqual(try DiscoveryProblem.decode(data: DiscoveryFixtures.json(problem), status: 400,
            headers: DiscoveryFixtures.problemHeaders()), .rejectedRequest(.malformedRequest))
    }
    func testRateLimitAndUnavailableRetryHints() throws {
        let correlation = ProblemCorrelation(requestID: DiscoveryFixtures.requestID)
        XCTAssertEqual(try decode(status: 429, type: "rate-limited", retry: 1, header: "1"),
            .rateLimited(RetryHint(seconds: 1), correlation))
        XCTAssertEqual(try decode(status: 503, type: "service-unavailable", retry: 5, header: "5"),
            .temporarilyUnavailable(RetryHint(seconds: 5), correlation))
    }
    func testRetryHintMismatchMalformedAndOverflowRefuses() throws {
        let invalid: [(Any, String)] = [(0, "0"), (-1, "-1"), (1.5, "1.5"),
            (true, "1"), (NSNull(), "1"), (2, "1"), (1, "999999999999999999999999"), (1, "+1")]
        for (value, header) in invalid {
            XCTAssertThrowsError(try decode(status: 429, type: "rate-limited", retry: value, header: header))
        }
        XCTAssertThrowsError(try decode(status: 429, type: "rate-limited"))
        XCTAssertThrowsError(try decode(status: 503, type: "service-unavailable", retry: 4, header: "4"))
        let exponent = Data(#"{"type":"https://kodera.io/problems/rate-limited","title":"test","status":429,"request_id":"test-request-1","retry_after_s":1e0}"#.utf8)
        XCTAssertThrowsError(try DiscoveryProblem.decode(data: exponent, status: 429,
            headers: DiscoveryFixtures.problemHeaders(retry: "1")))
    }
    func testServiceUnavailableRequiresExactSchemaDelayFive() throws {
        let correlation = ProblemCorrelation(requestID: DiscoveryFixtures.requestID)
        XCTAssertEqual(try decode(status: 503, type: "service-unavailable", retry: 5, header: "5"),
            .temporarilyUnavailable(RetryHint(seconds: 5), correlation))
        XCTAssertThrowsError(try decode(status: 503, type: "service-unavailable", retry: 6, header: "6"))
    }
}
