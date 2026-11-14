import Foundation
import XCTest
import KoderaDomain
@testable import KoderaClient

private actor RecordingInviteTransport: MatrixRoomInviteTransport {
    struct Call: Equatable, Sendable {
        let organisationId: String
        let roomIdentifier: String
        let recipient: MatrixUserId
    }

    private(set) var calls: [Call] = []
    private let shouldFail: Bool

    init(shouldFail: Bool = false) {
        self.shouldFail = shouldFail
    }

    func sendRoomInvite(
        organisationId: String,
        roomIdentifier: String,
        recipient: MatrixUserId
    ) async throws {
        if shouldFail {
            struct Failure: Error {}
            throw Failure()
        }
        calls.append(Call(organisationId: organisationId, roomIdentifier: roomIdentifier, recipient: recipient))
    }
}

@MainActor
final class ChannelInviteCoordinatorTests: XCTestCase {
    private let orgA = "11111111-1111-4111-8111-111111111111"
    private let orgB = "22222222-2222-4222-8222-222222222222"

    func testScopeBuildsCanonicalLinksAndHonestUnprovisionedDirectSend() async throws {
        let server = try MatrixServerName("community.kodera.io")
        let scope = try ChannelInviteScope(
            organisationId: orgA,
            channelId: "partner-onboarding",
            channelName: "partner-onboarding",
            serverName: server
        )
        XCTAssertFalse(scope.hasProvisionedRoomTarget)
        XCTAssertEqual(scope.invitation.displayAlias, "#partner-onboarding:community.kodera.io")
        XCTAssertEqual(
            scope.invitation.matrixURIString,
            "matrix:r/partner-onboarding:community.kodera.io?action=join&via=community.kodera.io"
        )
        XCTAssertEqual(
            scope.invitation.matrixToURLString,
            "https://matrix.to/#/%23partner-onboarding%3Acommunity.kodera.io?via=community.kodera.io"
        )

        let coordinator = ChannelInviteCoordinator()
        let context = try coordinator.openSheet(scope: scope)
        try coordinator.recordCopiedFormat(.matrixURI, context: context)
        XCTAssertEqual(coordinator.lastCopiedFormat, .matrixURI)

        let status = await coordinator.sendDirectInvite(
            rawInput: "  @alice:partner.example.org  ",
            context: context,
            transport: nil
        )
        let expectedUser = try MatrixUserId("@alice:partner.example.org")
        XCTAssertEqual(status, .unprovisioned(expectedUser))
        XCTAssertEqual(coordinator.status, .unprovisioned(expectedUser))
    }

    func testProvisionedDirectSendDeliversAndRejectsMalformedMXIDsAndStaleContexts() async throws {
        let server = try MatrixServerName("community.kodera.io")
        let alias = try MatrixRoomAlias("#announcements:community.kodera.io")
        let scopeA = try ChannelInviteScope(
            organisationId: orgA,
            channelId: "announcements",
            channelName: "announcements",
            serverName: server,
            canonicalAlias: alias
        )
        let scopeB = try ChannelInviteScope(
            organisationId: orgB,
            channelId: "dev",
            channelName: "dev",
            serverName: server,
            canonicalAlias: try MatrixRoomAlias("#dev:community.kodera.io")
        )

        let transport = RecordingInviteTransport()
        let coordinator = ChannelInviteCoordinator()
        let contextA = try coordinator.openSheet(scope: scopeA)

        let invalid = await coordinator.sendDirectInvite(
            rawInput: "alice:community.kodera.io",
            context: contextA,
            transport: transport
        )
        XCTAssertEqual(invalid, .failed(.invalidRecipient(.missingSigil)))

        let valid = await coordinator.sendDirectInvite(
            rawInput: "@bob:federated.example.org",
            context: contextA,
            transport: transport
        )
        let bob = try MatrixUserId("@bob:federated.example.org")
        XCTAssertEqual(valid, .sent(bob))
        let recorded = await transport.calls
        XCTAssertEqual(recorded.count, 1)
        XCTAssertEqual(recorded.first?.organisationId, orgA)
        XCTAssertEqual(recorded.first?.roomIdentifier, "#announcements:community.kodera.io")
        XCTAssertEqual(recorded.first?.recipient, bob)

        // Switching to orgB fences out contextA without mutating the newer sheet state.
        let contextB = try coordinator.openSheet(scope: scopeB)
        XCTAssertThrowsError(try coordinator.recordCopiedFormat(.canonicalAlias, context: contextA))
        let staleResult = await coordinator.sendDirectInvite(
            rawInput: "@carol:federated.example.org",
            context: contextA,
            transport: transport
        )
        XCTAssertEqual(staleResult, .failed(.staleContext))
        XCTAssertEqual(coordinator.status, .idle)

        try coordinator.recordCopiedFormat(.matrixToURL, context: contextB)
        XCTAssertEqual(coordinator.lastCopiedFormat, .matrixToURL)
        coordinator.stop()
        let afterStop = await coordinator.sendDirectInvite(
            rawInput: "@carol:federated.example.org",
            context: contextB,
            transport: transport
        )
        XCTAssertEqual(afterStop, .failed(.stopped))
    }
}
