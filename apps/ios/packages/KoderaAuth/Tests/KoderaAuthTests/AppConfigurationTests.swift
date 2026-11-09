import Foundation
import XCTest
import KoderaDomain
@testable import KoderaAuth

/// `AppConfiguration.read`, which the app's `bundled()` calls with the build's loopback policy and
/// development-issuer switch. The policy given is the one every origin is checked with, the Console's included.
final class AppConfigurationTests: XCTestCase {
    private static let https = ["KoderaCoreOrigin": "https://core.kodera.test",
                                "KoderaIssuerOrigins": "https://id.kodera.test",
                                "KoderaClientID": "app-client"]

    private func read(_ settings: [String: String], loopback: LoopbackPolicy,
                      development: Bool = false) -> AppConfiguration {
        AppConfiguration.read({ settings[$0] ?? "" }, loopback: loopback, admitsDevelopmentIssuer: development)
    }

    /// Owned by the `loopback:` argument of `ConsoleOrigin.admit` in `read`: a Release build's `.refuse` refuses a
    /// plain-HTTP Console origin, loopback or not, and a Debug build's `.admitForDevelopment` admits loopback only.
    func testTheBuildsPolicyReachesTheConsoleOrigin() {
        for console in ["http://localhost:5173", "http://127.0.0.1:5173", "http://console.kodera.test"] {
            var settings = Self.https
            settings["KoderaConsoleOrigin"] = console
            let release = read(settings, loopback: .refuse)
            XCTAssertNotNil(release.signIn, console)
            XCTAssertNil(release.consoleOrigin, "a Release policy admitted \(console)")
        }
        var loopback = Self.https
        loopback["KoderaConsoleOrigin"] = "http://localhost:5173"
        XCTAssertEqual(read(loopback, loopback: .admitForDevelopment).consoleOrigin?.absoluteString,
                       "http://localhost:5173", "a Debug policy refused a loopback Console")
        var remote = Self.https
        remote["KoderaConsoleOrigin"] = "http://console.kodera.test"
        XCTAssertNil(read(remote, loopback: .admitForDevelopment).consoleOrigin, "a Debug policy admitted plain HTTP")
    }

    /// Not vacuous: an HTTPS Console origin is admitted under either policy, exactly; unset offers none.
    func testAnHTTPSConsoleOriginIsAdmittedAndAnUnsetOneIsNone() {
        var settings = Self.https
        settings["KoderaConsoleOrigin"] = "https://console.kodera.test"
        for policy in [LoopbackPolicy.refuse, .admitForDevelopment] {
            XCTAssertEqual(read(settings, loopback: policy).consoleOrigin?.absoluteString, "https://console.kodera.test")
            XCTAssertNil(read(Self.https, loopback: policy).consoleOrigin)
        }
    }

    /// A Release policy given a developer's loopback values is unconfigured, the Console included.
    func testAReleasePolicyGivenLoopbackValuesIsUnconfigured() {
        let local = ["KoderaCoreOrigin": "http://localhost:8000", "KoderaIssuerOrigins": "http://localhost:8080",
                     "KoderaClientID": "app-client", "KoderaDevelopmentIssuer": "http://localhost:8080/realms/kodera-dev",
                     "KoderaConsoleOrigin": "http://localhost:5173"]
        let release = read(local, loopback: .refuse, development: false)
        XCTAssertNil(release.signIn)
        XCTAssertNil(release.discoveryConfiguration)
        XCTAssertNil(release.coreApiOrigin)
        XCTAssertNil(release.developmentIssuer)
        XCTAssertNil(release.consoleOrigin)
        let debug = read(local, loopback: .admitForDevelopment, development: true)
        XCTAssertNotNil(debug.signIn)
        XCTAssertEqual(debug.coreApiOrigin, "http://localhost:8000")
        XCTAssertEqual(debug.developmentIssuer, "http://localhost:8080/realms/kodera-dev")
        XCTAssertEqual(debug.consoleOrigin?.absoluteString, "http://localhost:5173")
    }

    /// The development realm entry only when the build admits it.
    func testTheDevelopmentIssuerNeedsTheBuildsSwitch() {
        var settings = Self.https
        settings["KoderaDevelopmentIssuer"] = "https://id.kodera.test/realms/kodera-dev"
        XCTAssertNil(read(settings, loopback: .refuse, development: false).developmentIssuer)
        XCTAssertEqual(read(settings, loopback: .refuse, development: true).developmentIssuer,
                       "https://id.kodera.test/realms/kodera-dev")
    }
}
