import XCTest
@testable import KoderaDomain

final class ChannelIdentityTests: XCTestCase {
    private func reference(id: String = Fixtures.channel, organisation: String = Fixtures.organisation)
        -> ChannelReference {
        ChannelReference(organisationId: organisation, channelId: id, kind: .text, roomState: .ready)
    }

    func testAliasUsesCanonicalUUIDAndPermanentServerRatherThanNetworkHost() throws {
        XCTAssertEqual(try ChannelIdentity.alias(for: reference(), descriptor: Fixtures.validatedDescriptor()),
            "#kodera-ch-22222222-2222-4222-8222-222222222222:atelier.test")
    }

    func testUUIDShapeIsExactWithoutInventedVersionRestrictions() throws {
        XCTAssertNoThrow(try ChannelIdentity.alias(for: reference(id: "aaaaaaaa-bbbb-0ccc-0ddd-eeeeeeeeeeee"),
            descriptor: Fixtures.validatedDescriptor()))
        for id in ["bad", "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", Fixtures.channel + "extra",
            " " + Fixtures.channel, "22222222222242228222222222222222"] {
            XCTAssertThrowsError(try ChannelIdentity.alias(for: reference(id: id), descriptor: Fixtures.validatedDescriptor())) {
                XCTAssertEqual($0 as? DomainError, .invalidChannel)
            }
        }
    }

    func testCrossOrganisationAndSimilarAliasesCannotSubstitute() throws {
        let descriptor = try Fixtures.validatedDescriptor()
        XCTAssertThrowsError(try ChannelIdentity.alias(for: reference(organisation: Fixtures.otherOrganisation),
            descriptor: descriptor))
        let expected = try ChannelIdentity.alias(for: reference(), descriptor: descriptor)
        XCTAssertTrue(try ChannelIdentity.matchesResolvedAlias(expected, reference: reference(), descriptor: descriptor))
        for value in ["atelier", expected + ".evil", expected.replacingOccurrences(of: "atelier.test", with: "matrix.test"),
            "prefix" + expected, expected.uppercased()] {
            XCTAssertFalse(try ChannelIdentity.matchesResolvedAlias(value, reference: reference(), descriptor: descriptor))
        }
        // Exact alias is identity only; SDK room membership remains a real-service gate.
    }
}
