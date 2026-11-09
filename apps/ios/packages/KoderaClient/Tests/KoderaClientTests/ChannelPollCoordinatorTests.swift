import XCTest
import KoderaDomain
@testable import KoderaClient

final class ChannelPollCoordinatorTests: XCTestCase {
    private func scope(_ org: String = "019a5e62-6ca0-7303-8303-030303030303", channel: String = "text") throws -> ChannelPollScope {
        try ChannelPollScope(organisationId: org, channelId: channel)
    }
    private func begin(_ poll: inout ChannelPollCoordinator, scope: ChannelPollScope? = nil) throws -> ChannelPollContext {
        try poll.beginLocalPreview(scope: scope ?? self.scope(), question: "Local question",
                                   optionLabels: ["One", "Two"], allowsMultipleChoices: true)
    }
    private typealias Mutation = (inout ChannelPollCoordinator, ChannelPollContext?) throws -> Void
    private var mutations: [Mutation] { [
        { try $0.toggleOption(0, context: $1) },
        { try $0.closePoll(context: $1) },
    ] }
    func testDefaultIsUnavailableAndExplicitPreviewTracksOnlyLocalVotes() throws {
        var poll = ChannelPollCoordinator()
        try poll.configure(scope())
        for mutate in mutations { XCTAssertThrowsError(try mutate(&poll, nil)) }
        XCTAssertTrue(poll.state.options.isEmpty)
        let context = try begin(&poll)
        try poll.toggleOption(0, context: context); try poll.toggleOption(1, context: context)
        XCTAssertEqual(poll.state.totalVotes, 1)
        XCTAssertEqual(poll.state.options.map(\.percentage), [100, 100])
        try poll.closePoll(context: context)
        let closed = poll.state
        for mutate in mutations { XCTAssertThrowsError(try mutate(&poll, context)); XCTAssertEqual(poll.state, closed) }
    }
    func testNilForeignOwnerAndOldScopeContextsCannotVoteOrCloseCurrentPoll() throws {
        var poll = ChannelPollCoordinator()
        let old = try begin(&poll)
        var foreign = ChannelPollCoordinator()
        let wrongOwner = try begin(&foreign)
        let current = try begin(&poll, scope: scope(channel: "other"))
        let original = poll.state
        for context in [nil, wrongOwner, old] {
            for mutate in mutations { XCTAssertThrowsError(try mutate(&poll, context)); XCTAssertEqual(poll.state, original) }
        }
        try poll.toggleOption(1, context: current)
        XCTAssertEqual(poll.state.totalVotes, 1)
    }
    func testInvalidDefinitionOrOptionPreservesStateAndWorkingContext() throws {
        var poll = ChannelPollCoordinator()
        let context = try begin(&poll)
        try poll.toggleOption(0, context: context)
        let original = poll.state
        for labels in [[], ["One"], ["One", "One"]] {
            XCTAssertThrowsError(try poll.beginLocalPreview(scope: scope(channel: "wrong"), question: "Question", optionLabels: labels, allowsMultipleChoices: false))
            XCTAssertEqual(poll.state, original)
        }
        for id in [Int.min, -1, 2, Int.max] {
            XCTAssertThrowsError(try poll.toggleOption(id, context: context))
            XCTAssertEqual(poll.state, original)
        }
        try poll.toggleOption(1, context: context)
        XCTAssertTrue(poll.state.options[1].isSelectedByCurrentUser)
    }
    func testSameScopeReplacementInvalidatesOldActionsAndObsoleteDisposal() throws {
        var poll = ChannelPollCoordinator()
        let old = try begin(&poll)
        try poll.toggleOption(0, context: old); try poll.closePoll(context: old)
        let current = try begin(&poll)
        poll.leavePreview(context: old)
        let original = poll.state
        XCTAssertFalse(original.isClosed)
        for mutate in mutations { XCTAssertThrowsError(try mutate(&poll, old)); XCTAssertEqual(poll.state, original) }
        try poll.toggleOption(1, context: current)
        poll.leavePreview(context: current)
        XCTAssertEqual(poll.state, ChannelPollState())
    }
    func testOwnerClearLeaveAndAwayBackInvalidateAllDelayedPreviewActions() throws {
        for action in 0..<3 {
            var poll = ChannelPollCoordinator()
            let old = try begin(&poll)
            try poll.closePoll(context: old)
            if action == 0 { poll.clear() }
            else if action == 1 { poll.leave() }
            else {
                try poll.switchOrganisation(to: scope("019a5e62-6ca0-7303-8303-030303030304"))
                XCTAssertTrue(poll.state.options.isEmpty)
                try poll.switchOrganisation(to: scope())
            }
            let current = try begin(&poll)
            let original = poll.state
            for mutate in mutations { XCTAssertThrowsError(try mutate(&poll, old)); XCTAssertEqual(poll.state, original) }
            try poll.toggleOption(1, context: current)
        }
    }
    func testTerminalStopClearsClosedPollAndRejectsAllOldActions() throws {
        var poll = ChannelPollCoordinator()
        let context = try begin(&poll)
        try poll.toggleOption(0, context: context); try poll.closePoll(context: context)
        poll.stop(); poll.clear(); poll.leave(); poll.leavePreview(context: context)
        XCTAssertEqual(poll.state.availability, .stopped)
        XCTAssertNil(poll.state.scope)
        XCTAssertTrue(poll.state.options.isEmpty)
        for mutate in mutations { XCTAssertThrowsError(try mutate(&poll, context)) }
        XCTAssertThrowsError(try poll.configure(scope()))
        XCTAssertThrowsError(try begin(&poll))
    }
}
