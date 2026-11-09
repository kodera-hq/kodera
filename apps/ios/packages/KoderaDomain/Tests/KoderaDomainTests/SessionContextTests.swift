import XCTest
@testable import KoderaDomain

final class SessionContextTests: XCTestCase {
    private func matrix(user: String = "@member-1:atelier.test", device: String = "device-a",
                        homeserver: String = "https://matrix.test") -> MatrixIdentity {
        MatrixIdentity(userId: user, deviceId: device, homeserverOrigin: homeserver)
    }
    private func bind(core: CoreIdentity = Fixtures.core(), matrix: MatrixIdentity? = nil,
                      generation: UInt64 = 1) throws -> AccountContext {
        try AccountContext.bind(discovery: Fixtures.validatedDiscovery(), descriptor: Fixtures.validatedDescriptor(coreIdentity: core),
            coreIdentity: core, matrixIdentity: matrix ?? self.matrix(), generation: generation)
    }

    func testDistinctIdentityFieldsAndOptionalFactorAbsenceDoNotRequireConsoleTrust() throws {
        let context = try bind()
        XCTAssertEqual(context.coreIdentity, Fixtures.core())
        XCTAssertEqual(context.matrixIdentity, matrix())
        // Local identities contain no factor claim; real verification/current membership is an adapter gate.
        XCTAssertTrue(context.accepts(coreIdentity: Fixtures.core(), generation: 1))
    }

    func testSameSubjectFromDifferentIssuerOrOrganisationCannotShareContext() throws {
        let context = try bind()
        XCTAssertFalse(context.accepts(coreIdentity: Fixtures.core(issuer: "https://other.test/realms/atelier"), generation: 1))
        XCTAssertFalse(context.accepts(coreIdentity: Fixtures.core(organisationId: Fixtures.otherOrganisation), generation: 1))
        XCTAssertFalse(context.accepts(coreIdentity: Fixtures.core(), generation: 2))
        XCTAssertThrowsError(try bind(core: Fixtures.core(organisationId: Fixtures.otherOrganisation)))
        XCTAssertThrowsError(try bind(core: Fixtures.core(issuer: "https://other.test/realms/atelier")))
        XCTAssertThrowsError(try bind(generation: 0))
    }

    func testMatrixMappingRequiresExactOriginalSubjectServerAndHomeserver() {
        for identity in [matrix(user: "@member-10:atelier.test"), matrix(user: "@Member-1:atelier.test"),
            matrix(user: "@member-1:other.test"), matrix(device: ""), matrix(homeserver: "https://other.test")] {
            XCTAssertThrowsError(try bind(matrix: identity))
        }
    }

    func testUnsupportedSubjectsAreNotLowercasedEscapedOrRepaired() {
        for subject in ["Member-1", "member:1", "member%31", "f:remote", "", "member name", "équipe"] {
            XCTAssertThrowsError(try bind(core: Fixtures.core(subject: subject),
                matrix: matrix(user: "@" + subject.lowercased() + ":atelier.test"))) {
                XCTAssertEqual($0 as? DomainError, .unsupportedSubject)
            }
        }
    }

    func testCanonicalLowercaseUUIDSubjectIsSupportedWithoutModification() throws {
        let subject = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        let context = try bind(core: Fixtures.core(subject: subject), matrix: matrix(user: "@\(subject):atelier.test"))
        XCTAssertEqual(context.coreIdentity.subject, subject)
    }

    func testValidatedDescriptorCannotTransferToAnotherCoreSubject() throws {
        XCTAssertThrowsError(try AccountContext.bind(discovery: Fixtures.validatedDiscovery(),
            descriptor: Fixtures.validatedDescriptor(), coreIdentity: Fixtures.core(subject: "member-2"),
            matrixIdentity: matrix(user: "@member-2:atelier.test"), generation: 1)) {
            XCTAssertEqual($0 as? DomainError, .identityMismatch)
        }
    }

    func testSignedOutGenerationCannotReviveFromLateIdentityCallback() throws {
        var session = SessionContext()
        let context = try bind(generation: session.generation)
        try session.activate(context)
        XCTAssertEqual(session.account, context)
        session.signOut()
        XCTAssertNil(session.account)
        XCTAssertGreaterThan(session.generation, context.generation)
        XCTAssertThrowsError(try session.activate(context)) {
            XCTAssertEqual($0 as? DomainError, .staleGeneration)
        }
    }
}
