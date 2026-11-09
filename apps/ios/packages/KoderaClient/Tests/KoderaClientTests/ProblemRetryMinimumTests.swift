import Foundation
import XCTest
@testable import KoderaClient

final class ProblemRetryMinimumTests: XCTestCase {
    func testNonRateProblemRejectsNegativeRetryButAcceptsZeroAndNull() throws {
        let headers = DiscoveryFixtures.problemHeaders()
        let negative = try DiscoveryFixtures.problem(status: 400, type: "malformed-request", retry: -1)
        XCTAssertThrowsError(try DiscoveryProblem.decode(data: negative, status: 400, headers: headers)) {
            XCTAssertEqual($0 as? DiscoveryFailure, .protocolViolation)
        }
        let validRetries: [Any] = [0, NSNull()]
        for retry in validRetries {
            let data = try DiscoveryFixtures.problem(status: 400, type: "malformed-request", retry: retry)
            XCTAssertEqual(try DiscoveryProblem.decode(data: data, status: 400, headers: headers), .rejectedRequest(.malformedRequest))
        }
    }
}
