import XCTest
@testable import KoderaDomain

final class MatrixInvitationTests: XCTestCase {
    func testDirectMatrixUserIdAcceptsValidFederatedIdentifiersAndPorts() throws {
        let simple = try MatrixUserId("@alice:community.kodera.io")
        XCTAssertEqual(simple.localpart, "alice")
        XCTAssertEqual(simple.serverName.rawValue, "community.kodera.io")
        XCTAssertEqual(simple.rawValue, "@alice:community.kodera.io")

        let historical = try MatrixUserId("@jean-pierre_1+ops=dev:Matrix.Partner.FR:8448")
        XCTAssertEqual(historical.localpart, "jean-pierre_1+ops=dev")
        XCTAssertEqual(historical.serverName.host, "matrix.partner.fr")
        XCTAssertEqual(historical.serverName.port, 8448)
        XCTAssertEqual(historical.rawValue, "@jean-pierre_1+ops=dev:matrix.partner.fr:8448")
    }

    func testDirectMatrixUserIdRejectsMalformedMXIDsAndDomains() {
        let invalidInputs = [
            "",
            "alice:kodera.io",
            "@:kodera.io",
            "@alice:",
            "@alice:localhost",
            "@alice:127.0.0.1",
            "@alice:-kodera.io",
            "@alice:kodera-.io",
            "@alice:.kodera.io",
            "@alice:kodera.io.",
            "@alice:kodera..io",
            "@alice:kodera.io:0",
            "@alice:kodera.io:65536",
            "@alice:kodera.io:08448",
            "@alice:kodera.io:https",
            "@ali ce:kodera.io",
            "@alice\n:kodera.io",
            "@alice:bob:kodera.io",
            "@" + String(repeating: "a", count: 250) + ":kodera.io",
        ]
        for candidate in invalidInputs {
            XCTAssertThrowsError(try MatrixUserId(candidate), "Expected refusal for \(candidate)")
        }
    }

    func testUniversalRoomAliasBuilderAndParserRoundTripAllCanonicalFormats() throws {
        let alias = try MatrixRoomAlias("#partner-onboarding:community.kodera.io")
        let server = try MatrixServerName("community.kodera.io")
        let invitation = UniversalMatrixInvitation.forRoomAlias(alias, via: [server])

        XCTAssertEqual(invitation.canonicalIdentifier, "#partner-onboarding:community.kodera.io")
        XCTAssertEqual(
            invitation.matrixToURLString,
            "https://matrix.to/#/%23partner-onboarding%3Acommunity.kodera.io?via=community.kodera.io"
        )
        XCTAssertEqual(
            invitation.matrixURIString,
            "matrix:r/partner-onboarding:community.kodera.io?action=join&via=community.kodera.io"
        )

        let fromMatrixTo = try UniversalMatrixInvitation.parse(invitation.matrixToURLString)
        XCTAssertEqual(fromMatrixTo, invitation)

        let fromMatrixURI = try UniversalMatrixInvitation.parse(invitation.matrixURIString)
        XCTAssertEqual(fromMatrixURI, invitation)

        let fromBareJoinURI = try UniversalMatrixInvitation.parse(
            "matrix:r/announcements:community.kodera.io?action=join"
        )
        XCTAssertEqual(
            fromBareJoinURI,
            .forRoomAlias(try MatrixRoomAlias("#announcements:community.kodera.io"))
        )

        let fromCanonicalAlias = try UniversalMatrixInvitation.parse("#announcements:community.kodera.io")
        XCTAssertEqual(fromCanonicalAlias, fromBareJoinURI)

        let fromDirectUser = try UniversalMatrixInvitation.parse("@partner:example.org")
        XCTAssertEqual(fromDirectUser.matrixURIString, "matrix:u/partner:example.org?action=chat")
        XCTAssertEqual(try UniversalMatrixInvitation.parse(fromDirectUser.matrixURIString), fromDirectUser)
        XCTAssertEqual(try UniversalMatrixInvitation.parse(fromDirectUser.matrixToURLString), fromDirectUser)
    }

    func testRoomWithoutCanonicalAliasNeverFabricatesJoinAliasTarget() throws {
        let roomId = try MatrixRoomId("!opaqueRoom_42:community.kodera.io")
        let server = try MatrixServerName("community.kodera.io")
        let invitation = try UniversalMatrixInvitation.forRoom(
            roomId: roomId,
            canonicalAlias: nil,
            channelSlug: "Partner Feedback",
            serverName: server
        )

        XCTAssertTrue(invitation.isSuggestedAlias)
        XCTAssertEqual(invitation.canonicalIdentifier, "!opaqueRoom_42:community.kodera.io")
        XCTAssertEqual(invitation.displayAlias, "#partner-feedback:community.kodera.io")
        XCTAssertEqual(
            invitation.matrixURIString,
            "matrix:roomid/opaqueRoom_42:community.kodera.io?action=join&via=community.kodera.io"
        )
        let parsed = try UniversalMatrixInvitation.parse(invitation.matrixURIString)
        XCTAssertEqual(parsed.canonicalIdentifier, "!opaqueRoom_42:community.kodera.io")
    }

    func testUniversalParserRefusesUntrustedHostsAuthoritiesAndMalformedTargets() {
        let badURIs = [
            "http://matrix.to/#/%23dev%3Acommunity.kodera.io",
            "https://evil.example/#/%23dev%3Acommunity.kodera.io",
            "https://matrix.to/#/",
            "matrix://community.kodera.io/r/dev:community.kodera.io?action=join",
            "matrix:r/dev:community.kodera.io?action=delete",
            "matrix:r/dev:localhost?action=join",
            "matrix:r/dev:community.kodera.io?action=join&via=localhost",
            "matrix:u/alice:community.kodera.io?action=chat&via=community.kodera.io",
            "javascript:alert(1)",
        ]
        for candidate in badURIs {
            XCTAssertThrowsError(try UniversalMatrixInvitation.parse(candidate), "Expected refusal for \(candidate)")
        }
    }
}
