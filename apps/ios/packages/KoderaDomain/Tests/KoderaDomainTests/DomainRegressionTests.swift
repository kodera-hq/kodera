import XCTest
@testable import KoderaDomain

final class DomainRegressionTests: XCTestCase {
    func testLeadingDigitOrganisationMatchesCurrentCoreDiscoveryContract() {
        // Core's slug/realm pattern permits a leading digit; no native naming convention is added.
        let selection = Fixtures.discovery(slug: "1team", realm: "1team",
            issuer: "https://identity.test/realms/1team")
        XCTAssertNoThrow(try TrustPolicy.validateDiscovery(selection, environment: Fixtures.environment))
    }
    func testDNSOnlyOriginProfileRejectsLegacyHexadecimalIPv4Forms() {
        for value in ["https://0x7f.1", "https://0x7f.0.0.1", "https://0x7f.0x0.0x0.0x1"] {
            XCTAssertThrowsError(try TrustPolicy.validateOrigin(value), value) {
                XCTAssertEqual($0 as? DomainError, .invalidOrigin, value)
            }
        }
    }
}
