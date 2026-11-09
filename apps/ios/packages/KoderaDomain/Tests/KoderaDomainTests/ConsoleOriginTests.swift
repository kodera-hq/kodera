import XCTest
@testable import KoderaDomain

/// The Console action's destination: exactly the configured origin, validated like the other origins.
final class ConsoleOriginTests: XCTestCase {
    func testTheURLIsExactlyTheConfiguredOrigin() throws {
        for policy in [LoopbackPolicy.refuse, .admitForDevelopment] {
            let url = try XCTUnwrap(ConsoleOrigin.admit("https://console.kodera.test", loopback: policy))
            XCTAssertEqual(url.absoluteString, "https://console.kodera.test")
            XCTAssertEqual(url.scheme, "https")
            XCTAssertEqual(url.host, "console.kodera.test")
            XCTAssertNil(url.query)
            XCTAssertNil(url.fragment)
        }
    }

    func testAnUnsetOriginOffersNoConsoleAction() {
        XCTAssertNil(ConsoleOrigin.admit("", loopback: .refuse))
        XCTAssertNil(ConsoleOrigin.admit("", loopback: .admitForDevelopment))
    }

    func testAReleasePolicyRefusesAnHTTPOrigin() {
        for origin in ["http://localhost:5173", "http://127.0.0.1:5173", "http://console.kodera.test"] {
            XCTAssertNil(ConsoleOrigin.admit(origin, loopback: .refuse), origin)
        }
    }

    /// The Release refusal is not vacuous: a development build admits loopback, and only loopback, over HTTP.
    func testADevelopmentPolicyAdmitsLoopbackOnly() throws {
        let url = try XCTUnwrap(ConsoleOrigin.admit("http://localhost:5173", loopback: .admitForDevelopment))
        XCTAssertEqual(url.absoluteString, "http://localhost:5173")
        XCTAssertNil(ConsoleOrigin.admit("http://console.kodera.test", loopback: .admitForDevelopment))
    }

    func testAnythingButABareOriginIsRefused() {
        for value in ["https://console.kodera.test/", "https://console.kodera.test/claim", "https://console.kodera.test?x=1",
                      "https://console.kodera.test#x", "https://user@console.kodera.test", " https://console.kodera.test",
                      "https://console.kodera.test:8443", "HTTPS://console.kodera.test", "console.kodera.test"] {
            XCTAssertNil(ConsoleOrigin.admit(value, loopback: .admitForDevelopment), value)
        }
    }
}
