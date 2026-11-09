import XCTest
@testable import KoderaDomain

final class AnonymousDiscoveryTrustTests: XCTestCase {
    private let trust = DiscoveryTrust(
        coreApiOrigin: "https://core.test", admittedIssuerOrigins: ["https://identity.test"]
    )

    func testAnonymousDiscoveryUsesOnlyProtectedCoreAndIssuerOrigins() throws {
        let metadata = try TrustPolicy.validateDiscovery(Fixtures.discovery(), trust: trust)
        XCTAssertEqual(metadata.selection, Fixtures.discovery())
    }

    func testAnonymousDiscoveryPreservesLeadingDigitAndExactMetadata() throws {
        let selection = Fixtures.discovery(slug: "1team", realm: "1team",
            issuer: "https://identity.test/realms/1team")
        XCTAssertEqual(try TrustPolicy.validateDiscovery(selection, trust: trust).selection, selection)
    }

    func testAnonymousDiscoveryStillRefusesMalformedProtectedOrigins() {
        for core in ["http://core.test", "https://core.test:443", "https://user@core.test",
                     "https://core.test/path", "https://core.test\n", "https://0x7f.1"] {
            let invalid = DiscoveryTrust(coreApiOrigin: core,
                admittedIssuerOrigins: ["https://identity.test"])
            XCTAssertThrowsError(try TrustPolicy.validateDiscovery(Fixtures.discovery(), trust: invalid), core) {
                XCTAssertEqual($0 as? DomainError, .invalidOrigin, core)
            }
        }
        for issuerOrigin in ["http://identity.test", "https://identity.test:443",
                             "https://identity.test/realms/atelier", "https://identity.test\n"] {
            let invalid = DiscoveryTrust(coreApiOrigin: "https://core.test",
                admittedIssuerOrigins: [issuerOrigin])
            XCTAssertThrowsError(try TrustPolicy.validateDiscovery(Fixtures.discovery(), trust: invalid), issuerOrigin) {
                XCTAssertEqual($0 as? DomainError, .invalidOrigin, issuerOrigin)
            }
        }
    }

    /// One origin validator for discovery and sign-in: a loopback Core and realm pass only with the
    /// development policy, and exactly as `IssuerAdmission` admits them.
    func testLoopbackDiscoveryNeedsTheDevelopmentPolicy() throws {
        let issuer = "http://localhost:8080/realms/atelier"
        let selection = Fixtures.discovery(issuer: issuer)
        let development = DiscoveryTrust(coreApiOrigin: "http://localhost:8000",
            admittedIssuerOrigins: ["http://localhost:8080"], loopback: .admitForDevelopment)
        XCTAssertEqual(try TrustPolicy.validateDiscovery(selection, trust: development).selection, selection)
        let refused = DiscoveryTrust(coreApiOrigin: "http://localhost:8000",
            admittedIssuerOrigins: ["http://localhost:8080"])
        XCTAssertEqual(refused.loopback, .refuse, "refusal is the default")
        XCTAssertThrowsError(try TrustPolicy.validateDiscovery(selection, trust: refused)) {
            XCTAssertEqual($0 as? DomainError, .invalidOrigin)
        }
        for (core, issuerOrigin) in [("http://localhost.evil.test:8000", "http://localhost:8080"),
                                     ("http://localhost:8000", "http://localhost:8080/"),
                                     ("http://localhost:8000", "http://[::1]:8080"),
                                     ("http://localhost:8000", "http://localhost:08080")] {
            let lookalike = DiscoveryTrust(coreApiOrigin: core, admittedIssuerOrigins: [issuerOrigin],
                loopback: .admitForDevelopment)
            XCTAssertThrowsError(try TrustPolicy.validateDiscovery(selection, trust: lookalike), core + " " + issuerOrigin) {
                XCTAssertEqual($0 as? DomainError, .invalidOrigin, core + " " + issuerOrigin)
            }
        }
    }

    func testAnonymousDiscoveryStillRefusesIssuerAndOrganisationBindingErrors() {
        let refused: [(DiscoverySelection, DomainError)] = [
            (Fixtures.discovery(organisationId: "invalid"), .invalidOrganisation),
            (Fixtures.discovery(slug: "ATELIER", realm: "ATELIER"), .invalidSlug),
            (Fixtures.discovery(realm: "other"), .mismatchedRealm),
            (Fixtures.discovery(issuer: "https://identity.test.evil/realms/atelier"), .untrustedIssuer),
            (Fixtures.discovery(issuer: "https://identity.test/realms/%61telier"), .untrustedIssuer),
            (Fixtures.discovery(issuer: "https://identity.test/realms/atelier\n"), .untrustedIssuer),
            (Fixtures.discovery(wellKnown: "https://identity.test/other"), .mismatchedWellKnown),
        ]
        for (selection, expected) in refused {
            XCTAssertThrowsError(try TrustPolicy.validateDiscovery(selection, trust: trust)) {
                XCTAssertEqual($0 as? DomainError, expected)
            }
        }
        let emptyIssuers = DiscoveryTrust(coreApiOrigin: "https://core.test", admittedIssuerOrigins: [])
        XCTAssertThrowsError(try TrustPolicy.validateDiscovery(Fixtures.discovery(), trust: emptyIssuers)) {
            XCTAssertEqual($0 as? DomainError, .untrustedIssuer)
        }
    }

    func testOriginalFullEnvironmentStillRequiresItsClientProfile() {
        for clientId in ["", " ", "test-client\n"] {
            let incomplete = EnvironmentTrust(coreApiOrigin: "https://core.test",
                admittedIssuerOrigins: ["https://identity.test"], nativeClientId: clientId,
                redirectUri: "", matrixRedirectUri: "")
            XCTAssertThrowsError(try TrustPolicy.validateDiscovery(Fixtures.discovery(), environment: incomplete)) {
                XCTAssertEqual($0 as? DomainError, .unsupportedContract)
            }
        }
    }

    func testOriginalCallbacksStillRefuseAbsentOrSharedCallbackProfiles() {
        let absent = EnvironmentTrust(coreApiOrigin: "https://core.test",
            admittedIssuerOrigins: ["https://identity.test"], nativeClientId: "",
            redirectUri: "", matrixRedirectUri: "")
        let shared = EnvironmentTrust(coreApiOrigin: "https://core.test",
            admittedIssuerOrigins: ["https://identity.test"], nativeClientId: "test-client",
            redirectUri: "test.kodera.ios:/shared/callback", matrixRedirectUri: "test.kodera.ios:/shared/callback")
        for hop in [CallbackHop.core, .matrix] {
            XCTAssertThrowsError(try TrustPolicy.validateCallback("", hop: hop, environment: absent)) {
                XCTAssertEqual($0 as? DomainError, .callbackMismatch)
            }
            XCTAssertThrowsError(try TrustPolicy.validateCallback("test.kodera.ios:/shared/callback",
                hop: hop, environment: shared)) {
                XCTAssertEqual($0 as? DomainError, .callbackMismatch)
            }
        }
    }
}
