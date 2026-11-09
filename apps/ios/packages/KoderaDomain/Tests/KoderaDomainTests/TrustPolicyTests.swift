import XCTest
@testable import KoderaDomain

// Synthetic local values only; no endpoint, token or authenticated adapter exists.
enum Fixtures {
    static let organisation = "11111111-1111-4111-8111-111111111111"
    static let channel = "22222222-2222-4222-8222-222222222222"
    static let otherOrganisation = "33333333-3333-4333-8333-333333333333"
    static let issuer = "https://identity.test/realms/atelier"
    static let environment = EnvironmentTrust(
        coreApiOrigin: "https://core.test", admittedIssuerOrigins: ["https://identity.test"],
        nativeClientId: "test.kodera.ios", redirectUri: "test.kodera.ios:/core/callback",
        matrixRedirectUri: "test.kodera.ios:/matrix/callback"
    )
    static func discovery(
        organisationId: String = organisation, slug: String = "atelier", realm: String = "atelier",
        issuer: String = issuer, wellKnown: String? = nil
    ) -> DiscoverySelection {
        DiscoverySelection(organisationId: organisationId, organisationSlug: slug, realm: realm,
            issuer: issuer, openidConfigurationUrl: wellKnown ?? issuer + "/.well-known/openid-configuration")
    }
    static func core(subject: String = "member-1", organisationId: String = organisation,
                     issuer: String = issuer) -> CoreIdentity {
        CoreIdentity(organisationId: organisationId, issuer: issuer, subject: subject)
    }
    static func descriptor(schema: Int? = 1, organisationId: String = organisation,
                           server: String = "atelier.test", homeserver: String = "https://matrix.test",
                           rooms: String = "https://rooms.test", readiness: ServiceReadiness? = .ready)
        -> CollaborationDescriptor {
        CollaborationDescriptor(schemaVersion: schema, organisationId: organisationId,
            matrixServerName: server, homeserverOrigin: homeserver,
            roomAccessOrigin: rooms, readiness: readiness)
    }
    static func provenance(origin: String = "https://core.test", organisationId: String = organisation,
                           issuer: String = issuer, subject: String = "member-1") -> DescriptorProvenance {
        .authenticatedCore(origin: origin, organisationId: organisationId, issuer: issuer, subject: subject)
    }
    static func validatedDiscovery() throws -> ValidatedDiscovery {
        try TrustPolicy.validateDiscovery(discovery(), environment: environment)
    }
    static func validatedDescriptor(readiness: ServiceReadiness = .ready,
                                    coreIdentity: CoreIdentity = core()) throws -> ValidatedDescriptor {
        try TrustPolicy.validateDescriptor(descriptor(readiness: readiness),
            discovery: validatedDiscovery(), coreIdentity: coreIdentity, environment: environment,
            provenance: provenance(organisationId: coreIdentity.organisationId,
                issuer: coreIdentity.issuer, subject: coreIdentity.subject))
    }
}

final class TrustPolicyTests: XCTestCase {
    func testApprovedDiscoveryPreservesExactValuesWithoutLogin() throws {
        let value = try Fixtures.validatedDiscovery()
        XCTAssertEqual(value.selection, Fixtures.discovery())
    }

    func testOriginProfileRejectsAmbiguousOrInsecureInput() {
        let refused = ["http://core.test", "HTTPS://core.test", "https://Core.test", "https://core.test:443",
            "https://core.test:8443", "https://core.test:", "https://core.test:no", "https://user@core.test",
            "https://core.test/path", "https://core.test?query", "https://core.test#fragment",
            "https://core%2etest", "https://core.test/%2f", "https://core.test/../",
            "https://core.test\\evil", "https://", "https://-bad.test", "https://bad..test",
            "https://127.0.0.1", "https://core.test.", " https://core.test", "https://core.test\n",
            "https://core.test\t", "https://core.\ntest", "https://core.test\r"]
        for value in refused {
            XCTAssertThrowsError(try TrustPolicy.validateOrigin(value), value) {
                XCTAssertEqual($0 as? DomainError, .invalidOrigin, value)
            }
        }
        XCTAssertNoThrow(try TrustPolicy.validateOrigin("https://core.test"))
        XCTAssertNoThrow(try TrustPolicy.validateOrigin("https://core.test/"))
    }

    func testIssuerMustMatchExactAdmittedOriginAndRealmPath() {
        for issuer in ["https://identity.test.evil/realms/atelier", "https://other.test/realms/atelier",
            "https://identity.test:443/realms/atelier", "https://identity.test/realms/other",
            "https://identity.test/realms/atelier/", "https://identity.test/realms/%61telier",
            "https://identity.test/realms/atelier?x", "https://identity.test/realms/atelier#x",
            "https://identity.test/realms/atelier\n", "https://identity.test/realms/atelier\t"] {
            XCTAssertThrowsError(try TrustPolicy.validateDiscovery(Fixtures.discovery(issuer: issuer),
                environment: Fixtures.environment), issuer)
        }
    }

    func testWrongWellKnownRealmSlugAndOrganisationAreRejected() {
        for selection in [Fixtures.discovery(wellKnown: "https://identity.test/other"),
            Fixtures.discovery(slug: "other"), Fixtures.discovery(slug: "ATELIER", realm: "ATELIER"),
            Fixtures.discovery(slug: "tiny", realm: "tiny"), Fixtures.discovery(organisationId: "bad")] {
            XCTAssertThrowsError(try TrustPolicy.validateDiscovery(selection, environment: Fixtures.environment))
        }
    }

    func testDiscoveryRequiresExplicitCandidateSelection() throws {
        XCTAssertNil(try TrustPolicy.selectDiscovery([], selectedOrganisationId: nil, environment: Fixtures.environment))
        let choices = [Fixtures.discovery(), Fixtures.discovery(organisationId: Fixtures.otherOrganisation)]
        XCTAssertThrowsError(try TrustPolicy.selectDiscovery(choices, selectedOrganisationId: nil,
            environment: Fixtures.environment)) {
            XCTAssertEqual($0 as? DomainError, .selectionRequired)
        }
        XCTAssertEqual(try TrustPolicy.selectDiscovery(choices, selectedOrganisationId: Fixtures.organisation,
            environment: Fixtures.environment)?.selection.organisationId, Fixtures.organisation)
        XCTAssertThrowsError(try TrustPolicy.selectDiscovery(choices, selectedOrganisationId: "absent",
            environment: Fixtures.environment))
    }

    func testDescriptorNeedsTrustedCoreProvenanceAndMatchingIdentity() throws {
        let discovery = try Fixtures.validatedDiscovery()
        for provenance in [DescriptorProvenance.unverified, Fixtures.provenance(origin: "https://core.test.evil"),
            Fixtures.provenance(organisationId: Fixtures.otherOrganisation),
            Fixtures.provenance(issuer: "https://other.test/realms/atelier"), Fixtures.provenance(subject: "other")] {
            XCTAssertThrowsError(try TrustPolicy.validateDescriptor(Fixtures.descriptor(), discovery: discovery,
                coreIdentity: Fixtures.core(), environment: Fixtures.environment, provenance: provenance)) {
                XCTAssertEqual($0 as? DomainError, .untrustedProvenance)
            }
        }
        XCTAssertThrowsError(try TrustPolicy.validateDescriptor(Fixtures.descriptor(), discovery: discovery,
            coreIdentity: Fixtures.core(organisationId: Fixtures.otherOrganisation),
            environment: Fixtures.environment, provenance: Fixtures.provenance()))
    }

    func testDescriptorRejectsUnsupportedSchemaBindingAndUnsafeDestinations() throws {
        let discovery = try Fixtures.validatedDiscovery()
        let bad = [Fixtures.descriptor(schema: nil), Fixtures.descriptor(schema: 2),
            Fixtures.descriptor(organisationId: Fixtures.otherOrganisation), Fixtures.descriptor(server: "atelier.test:443"),
            Fixtures.descriptor(homeserver: "http://matrix.test"), Fixtures.descriptor(rooms: "https://rooms.test/path"),
            Fixtures.descriptor(readiness: nil), Fixtures.descriptor(readiness: .unknown)]
        for descriptor in bad {
            XCTAssertThrowsError(try TrustPolicy.validateDescriptor(descriptor, discovery: discovery,
                coreIdentity: Fixtures.core(), environment: Fixtures.environment, provenance: Fixtures.provenance()))
        }
    }

    func testPendingAndUnavailableMetadataNeverBecomeReady() throws {
        for readiness in [ServiceReadiness.pending, .unavailable(.serviceUnavailable)] {
            let descriptor = try Fixtures.validatedDescriptor(readiness: readiness)
            XCTAssertEqual(descriptor.readiness, readiness)
            XCTAssertFalse(descriptor.canAttemptConnection)
        }
        XCTAssertTrue(try Fixtures.validatedDescriptor().canAttemptConnection)
    }

    func testCoreAndMatrixCallbacksHaveIndependentExactProfiles() throws {
        XCTAssertNoThrow(try TrustPolicy.validateCallback("test.kodera.ios:/core/callback",
            hop: .core, environment: Fixtures.environment))
        XCTAssertNoThrow(try TrustPolicy.validateCallback("test.kodera.ios:/matrix/callback",
            hop: .matrix, environment: Fixtures.environment))
        for callback in ["test.kodera.ios:/core/callback", "test.kodera.ios:/matrix/callback/",
            "evil:/matrix/callback", "https://matrix.test/_synapse/client/oidc/callback"] {
            XCTAssertThrowsError(try TrustPolicy.validateCallback(callback, hop: .matrix,
                environment: Fixtures.environment)) {
                XCTAssertEqual($0 as? DomainError, .callbackMismatch)
            }
        }
    }
}
