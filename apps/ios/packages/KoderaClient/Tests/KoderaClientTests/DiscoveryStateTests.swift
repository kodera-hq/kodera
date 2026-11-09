import XCTest
@testable import KoderaClient

final class DiscoveryStateTests: XCTestCase {
    func testBeginPublishesLoadingForCurrentTicket() {
        var state = DiscoveryState()
        _ = state.begin()
        XCTAssertEqual(state.value, .loading)
    }
    func testNewerTicketFencesOlderResult() {
        var state = DiscoveryState()
        let old = state.begin()
        let current = state.begin()
        state.receive(.result(.single(DiscoveryFixtures.metadata())), for: old)
        XCTAssertEqual(state.value, .loading)
        state.receive(.result(.noMatch), for: current)
        XCTAssertEqual(state.value, .noMatch)
    }
    func testLifecycleResetFencesAllPriorCallbacks() {
        var state = DiscoveryState()
        let old = state.begin()
        state.reset()
        state.receive(.result(.single(DiscoveryFixtures.metadata())), for: old)
        XCTAssertEqual(state.value, .editing)
    }
    func testCancelAndResetNeverBecomeNoMatch() {
        var state = DiscoveryState()
        let ticket = state.begin()
        state.cancel()
        XCTAssertEqual(state.value, .cancelled)
        state.receive(.result(.noMatch), for: ticket)
        XCTAssertEqual(state.value, .cancelled)
        state.reset()
        XCTAssertEqual(state.value, .editing)
    }
    func testMultipleChoicesRequireExplicitCurrentSelection() throws {
        var state = DiscoveryState()
        let first = DiscoveryFixtures.metadata()
        let second = DiscoveryFixtures.metadata(id: "22222222-2222-4222-8222-222222222222", slug: "bureau")
        let ticket = state.begin()
        state.receive(.result(.multiple([first, second])), for: ticket)
        XCTAssertEqual(state.value, .choosing([first, second]))
        XCTAssertThrowsError(try state.select(organisationId: "absent"))
        try state.select(organisationId: second.organisationId)
        XCTAssertEqual(state.value, .selected(second))
        state.reset()
        XCTAssertThrowsError(try state.select(organisationId: second.organisationId))
    }
    func testSingleAndZeroRemainAnonymousMetadata() {
        var state = DiscoveryState()
        let metadata = DiscoveryFixtures.metadata()
        let single = state.begin()
        state.receive(.result(.single(metadata)), for: single)
        XCTAssertEqual(state.value, .selected(metadata))
        let zero = state.begin()
        state.receive(.result(.noMatch), for: zero)
        XCTAssertEqual(state.value, .noMatch)
    }
}
