import XCTest
@testable import KoderaDomain

final class IssuerAdmissionTests: XCTestCase {
    private let origins: Set<String> = ["https://auth.kodera.test"]

    func testExactConfiguredOriginAndRealmIsAdmitted() throws {
        let admitted = try IssuerAdmission.admit(issuer: "https://auth.kodera.test/realms/acme-sa",
            admittedOrigins: origins, loopback: .refuse)
        XCTAssertEqual(admitted.issuer, "https://auth.kodera.test/realms/acme-sa")
        XCTAssertEqual(admitted.origin, "https://auth.kodera.test")
        XCTAssertEqual(admitted.realm, "acme-sa")
    }

    func testAnyOtherIssuerShapeIsRefused() {
        let refused = [
            "https://auth.kodera.test.evil/realms/acme-sa",
            "https://evil.test/realms/acme-sa",
            "https://auth.kodera.test:8443/realms/acme-sa",
            "https://user@auth.kodera.test/realms/acme-sa",
            "http://auth.kodera.test/realms/acme-sa",
            "HTTPS://auth.kodera.test/realms/acme-sa",
            "https://auth.kodera.test/realms/acme-sa/",
            "https://auth.kodera.test/realms/acme-sa/extra",
            "https://auth.kodera.test/realms/ACME-SA",
            "https://auth.kodera.test/realms/acme%2Dsa",
            "https://auth.kodera.test/realms/acme-sa?x=1",
            "https://auth.kodera.test/realms/acme-sa#x",
            "https://auth.kodera.test/realms/abc",
            "https://auth.kodera.test/realms/",
            "https://auth.kodera.test/auth/realms/acme-sa",
            "",
        ]
        for issuer in refused {
            XCTAssertThrowsError(try IssuerAdmission.admit(issuer: issuer, admittedOrigins: origins,
                loopback: .admitForDevelopment), issuer) {
                XCTAssertEqual($0 as? DomainError, .untrustedIssuer, issuer)
            }
        }
    }

    func testNoConfiguredOriginAdmitsNothing() {
        XCTAssertThrowsError(try IssuerAdmission.admit(issuer: "https://auth.kodera.test/realms/acme-sa",
            admittedOrigins: [], loopback: .refuse)) {
            XCTAssertEqual($0 as? DomainError, .untrustedIssuer)
        }
    }

    func testLoopbackOriginIsAdmittedOnlyForDevelopment() throws {
        let local: Set<String> = ["http://localhost:8080"]
        let issuer = "http://localhost:8080/realms/kodera-dev"
        XCTAssertThrowsError(try IssuerAdmission.admit(issuer: issuer, admittedOrigins: local, loopback: .refuse)) {
            XCTAssertEqual($0 as? DomainError, .invalidOrigin)
        }
        let admitted = try IssuerAdmission.admit(issuer: issuer, admittedOrigins: local, loopback: .admitForDevelopment)
        XCTAssertEqual(admitted.realm, "kodera-dev")
        // The configured port only: another local listener is a different origin.
        XCTAssertThrowsError(try IssuerAdmission.admit(issuer: "http://localhost:8081/realms/kodera-dev",
            admittedOrigins: local, loopback: .admitForDevelopment)) {
            XCTAssertEqual($0 as? DomainError, .untrustedIssuer)
        }
    }

    func testOnlyExactLoopbackFormsPassOverHTTP() {
        for value in ["http://localhost:8080", "http://127.0.0.1:1", "http://localhost:65535"] {
            XCTAssertNoThrow(try IssuerAdmission.validateOrigin(value, loopback: .admitForDevelopment), value)
        }
        for value in ["http://localhost", "http://localhost:", "http://localhost:0", "http://localhost:08080",
                      "http://localhost:65536", "http://localhost:8080/", "http://localhost.evil.test:8080",
                      "http://127.0.0.2:8080", "http://[::1]:8080", "http://auth.kodera.test",
                      "http://localhost:80a", "https://localhost:8080", "https://auth.kodera.test/"] {
            XCTAssertThrowsError(try IssuerAdmission.validateOrigin(value, loopback: .admitForDevelopment), value) {
                XCTAssertEqual($0 as? DomainError, .invalidOrigin, value)
            }
        }
    }

    func testEndpointsMustShareTheIssuerOrigin() throws {
        let admitted = try IssuerAdmission.admit(issuer: "https://auth.kodera.test/realms/acme-sa",
            admittedOrigins: origins, loopback: .refuse)
        XCTAssertTrue(IssuerAdmission.sharesOrigin(
            "https://auth.kodera.test/realms/acme-sa/protocol/openid-connect/revoke", with: admitted))
        for url in ["https://auth.kodera.test.evil/revoke", "https://evil.test/revoke",
                    "https://auth.kodera.test:444/revoke", "http://auth.kodera.test/revoke",
                    "https://auth.kodera.test", "https://auth.kodera.test/a@evil.test",
                    "https://auth.kodera.test/a\\b", "https://auth.kodera.test/a b"] {
            XCTAssertFalse(IssuerAdmission.sharesOrigin(url, with: admitted), url)
        }
    }
}
