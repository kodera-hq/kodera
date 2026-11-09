import XCTest
@testable import KoderaDomain

// These are labelled local reducer inputs, never a production fake-success adapter.
final class ConnectionStateTests: XCTestCase {
    private func initial(readiness: ServiceReadiness = .ready, adapter: Bool = true) -> MediaState {
        MediaState(generation: 1, organisationId: Fixtures.organisation, readiness: readiness, adapterAvailable: adapter)
    }
    private func attempt(id: String = "attempt-a", generation: UInt64 = 1,
                         organisation: String = Fixtures.organisation, room: String = "!room:atelier.test") -> MediaAttempt {
        MediaAttempt(attemptId: id, generation: generation, organisationId: organisation, matrixRoomId: room)
    }

    func testMissingAdapterAndUnreadyMetadataCannotJoin() {
        for state in [initial(adapter: false), initial(readiness: .pending),
            initial(readiness: .unavailable(.forbidden)), initial(readiness: .unknown)] {
            XCTAssertEqual(state.applying(.requestJoin(attempt())).phase, state.phase)
            XCTAssertNotEqual(state.phase, .joined)
        }
        XCTAssertEqual(initial(adapter: false).phase, .unavailable(.notConfigured))
    }

    func testRequestAndGrantAreNotConnectedOrPublishedMedia() {
        let joining = initial().applying(.requestJoin(attempt()))
        XCTAssertEqual(joining.phase, .joining)
        let granted = joining.applying(.grantReceived(attempt()))
        XCTAssertEqual(granted.phase, .joining)
        XCTAssertFalse(granted.cameraIntent)
        XCTAssertFalse(granted.cameraPublished)
        XCTAssertEqual(granted.applying(.transportConnected(attempt())).phase, .joined)
    }

    func testStaleWrongRoomAndWrongAccountCallbacksAreIgnored() {
        let joining = initial().applying(.requestJoin(attempt()))
        for callback in [attempt(id: "old"), attempt(generation: 2),
            attempt(organisation: Fixtures.otherOrganisation), attempt(room: "!other:atelier.test")] {
            XCTAssertEqual(joining.applying(.transportConnected(callback)), joining)
        }
        XCTAssertEqual(initial().applying(.transportConnected(attempt())), initial())
        XCTAssertEqual(initial().applying(.requestJoin(attempt(generation: 2))), initial())
    }

    func testLeaveRevocationAndSignOutBeatLateCallbacks() {
        let joining = initial().applying(.requestJoin(attempt()))
        for event in [MediaEvent.leave, .revoke, .signOut] {
            let ended = joining.applying(event)
            XCTAssertEqual(ended.phase, .ended)
            XCTAssertNil(ended.attempt)
            XCTAssertFalse(ended.cameraPublished)
            XCTAssertEqual(ended.applying(.transportConnected(attempt())), ended)
            XCTAssertEqual(ended.applying(.cameraPublication(attempt(), active: true)), ended)
            XCTAssertEqual(ended.applying(.requestJoin(attempt())), ended)
        }
    }

    func testLostTransportShowsReconnectingAndFailureEndsWithoutFalseSuccess() {
        let joined = initial().applying(.requestJoin(attempt())).applying(.transportConnected(attempt()))
        let lost = joined.applying(.transportLost(attempt()))
        XCTAssertEqual(lost.phase, .reconnecting)
        XCTAssertFalse(lost.cameraPublished)
        XCTAssertEqual(lost.applying(.transportConnected(attempt())).phase, .joined)
        XCTAssertEqual(lost.applying(.transportFailed(attempt())).phase, .ended)
    }

    func testCameraRequiresIntentPermissionAndMatchingPublicationEvent() {
        let joined = initial().applying(.requestJoin(attempt())).applying(.transportConnected(attempt()))
        XCTAssertFalse(joined.applying(.cameraPublication(attempt(), active: true)).cameraPublished)
        let intent = joined.applying(.cameraIntent(true))
        XCTAssertFalse(intent.cameraPublished)
        XCTAssertFalse(intent.applying(.cameraPublication(attempt(), active: true)).cameraPublished)
        let permission = intent.applying(.cameraPermission(true))
        XCTAssertFalse(permission.cameraPublished)
        XCTAssertFalse(permission.applying(.cameraPublication(attempt(id: "old"), active: true)).cameraPublished)
        let published = permission.applying(.cameraPublication(attempt(), active: true))
        XCTAssertTrue(published.cameraPublished)
        XCTAssertFalse(published.applying(.cameraIntent(false)).cameraPublished)
        XCTAssertFalse(published.applying(.cameraPermission(false)).cameraPublished)
        XCTAssertFalse(published.applying(.transportLost(attempt())).cameraPublished)
    }
}
