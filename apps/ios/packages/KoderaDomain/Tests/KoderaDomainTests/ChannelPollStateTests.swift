import Foundation
import XCTest
@testable import KoderaDomain

final class ChannelPollStateTests: XCTestCase {
    private let org = "019a5e62-6ca0-7303-8303-030303030303"
    private func scope(_ channel: String = "text-main") throws -> ChannelPollScope {
        try ChannelPollScope(organisationId: org, channelId: channel)
    }
    private func preview(multiple: Bool = false, labels: [String] = ["One", "Two"]) throws -> ChannelPollState {
        var state = ChannelPollState()
        try state.beginLocalPreview(scope: scope(), question: "Choose a time", optionLabels: labels,
                                    allowsMultipleChoices: multiple)
        return state
    }
    func testScopeUsesCanonicalOrganisationAndExactBoundedChannelBytes() throws {
        for invalid in ["", "org", org.uppercased(), " " + org] {
            XCTAssertThrowsError(try ChannelPollScope(organisationId: invalid, channelId: "text"))
        }
        for invalid in ["", " ", " text", "text ", "text\n", "text\u{202e}", String(repeating: "a", count: 256)] {
            XCTAssertThrowsError(try scope(invalid))
        }
        XCTAssertEqual(try scope(String(repeating: "a", count: 255)).channelId.utf8.count, 255)
        XCTAssertNotEqual(try scope("caf\u{e9}"), try scope("cafe\u{301}"))
    }
    func testDefinitionBoundsControlAndExactDuplicateRefusalsAreTransactional() throws {
        var state = try preview()
        try state.toggleOption(1)
        let original = state
        for bad in ["", " ", " Question", "Question ", "Question\n", "Question\u{200b}", String(repeating: "a", count: 281)] {
            XCTAssertThrowsError(try state.beginLocalPreview(scope: scope(), question: bad, optionLabels: ["One", "Two"], allowsMultipleChoices: false))
            XCTAssertEqual(state, original)
        }
        for labels in [[], ["One"], Array(repeating: "One", count: 11), ["One", "One"], ["One", ""],
                       ["One", " Two"], ["One", "Two\n"], ["One", "Two\u{202e}"],
                       ["One", String(repeating: "é", count: 61)]] {
            XCTAssertThrowsError(try state.beginLocalPreview(scope: scope(), question: "Question", optionLabels: labels, allowsMultipleChoices: true))
            XCTAssertEqual(state, original)
        }
        let labels = (0..<10).map { String($0) + String(repeating: "a", count: 119) }
        try state.beginLocalPreview(scope: scope(), question: String(repeating: "é", count: 140), optionLabels: labels, allowsMultipleChoices: true)
        XCTAssertEqual(state.question.utf8.count, 280)
        XCTAssertEqual(state.options.map(\.label), labels)
        // Label identity is exact UTF-8, matching the other native implementation.
        XCTAssertNoThrow(try preview(labels: ["caf\u{e9}", "cafe\u{301}"]))
    }
    func testUnavailableStateNeverAcceptsVotesOrCloseAndExposesNoInventedPoll() throws {
        var state = ChannelPollState()
        try state.configure(scope())
        let original = state
        XCTAssertThrowsError(try state.toggleOption(0))
        XCTAssertThrowsError(try state.closePoll())
        XCTAssertEqual(state, original)
        XCTAssertEqual(state.availability, .unprovisioned)
        XCTAssertTrue(state.options.isEmpty)
        XCTAssertEqual(state.question, "")
        XCTAssertEqual(state.totalVotes, 0)
    }
    func testSingleChoiceRepeatsAreIdempotentAndReplacementNeverDoubleCounts() throws {
        var state = try preview()
        XCTAssertEqual(state.options.map(\.percentage), [0, 0])
        try state.toggleOption(1)
        let selected = state
        try state.toggleOption(1)
        XCTAssertEqual(state, selected)
        XCTAssertEqual(state.totalVotes, 1)
        try state.toggleOption(0)
        XCTAssertEqual(state.options.map(\.voteCount), [1, 0])
        XCTAssertEqual(state.options.map(\.isSelectedByCurrentUser), [true, false])
        XCTAssertEqual(state.options.map(\.percentage), [100, 0])
        XCTAssertEqual(state.totalVotes, 1)
        let original = state
        for invalid in [Int.min, -1, 2, Int.max] {
            XCTAssertThrowsError(try state.toggleOption(invalid))
            XCTAssertEqual(state, original)
        }
    }
    func testMultipleChoicesToggleAndEmptyBallotRemovesTheOneLocalVoter() throws {
        var state = try preview(multiple: true, labels: (0..<10).map { "Option " + String($0) })
        for id in 0..<10 {
            try state.toggleOption(id)
            XCTAssertEqual(state.totalVotes, 1)
            XCTAssertEqual(state.options.filter(\.isSelectedByCurrentUser).count, id + 1)
        }
        XCTAssertEqual(state.options.map(\.percentage).reduce(0, +), 1000)
        for id in 0..<10 { try state.toggleOption(id) }
        XCTAssertEqual(state.totalVotes, 0)
        XCTAssertTrue(state.options.allSatisfy { $0.voteCount == 0 && $0.percentage == 0 && !$0.isSelectedByCurrentUser })
    }
    func testPercentageRoundingMatchesIndependentFormulaWithinTheFullBound() throws {
        XCTAssertEqual(try ChannelPollState.roundedPercentage(voteCount: 1, totalVotes: 3), 33)
        XCTAssertEqual(try ChannelPollState.roundedPercentage(voteCount: 2, totalVotes: 3), 67)
        XCTAssertEqual(try ChannelPollState.roundedPercentage(voteCount: 1, totalVotes: 8), 13)
        for total in 0...512 {
            for count in 0...total {
                let expected = total == 0 ? 0 : Int((Double(count) * 100 / Double(total)).rounded())
                XCTAssertEqual(try ChannelPollState.roundedPercentage(voteCount: count, totalVotes: total), expected)
            }
        }
        for (count, total) in [(1, 0), (-1, 1), (2, 1), (0, -1), (0, 513), (Int.max, Int.max), (Int.min, 1)] {
            XCTAssertThrowsError(try ChannelPollState.roundedPercentage(voteCount: count, totalVotes: total))
        }
    }
    func testClosedPollRejectsAllVoteAndRepeatedCloseMutationsWithoutChangingResults() throws {
        var state = try preview(multiple: true)
        try state.toggleOption(0)
        try state.closePoll()
        let original = state
        for id in [Int.min, 0, 1, Int.max] {
            XCTAssertThrowsError(try state.toggleOption(id)) { XCTAssertEqual($0 as? ChannelPollError, .closed) }
            XCTAssertEqual(state, original)
        }
        XCTAssertThrowsError(try state.closePoll())
        XCTAssertEqual(state, original)
        state.clear()
        XCTAssertEqual(state, ChannelPollState())
        try state.beginLocalPreview(scope: scope(), question: "New preview", optionLabels: ["A", "B"], allowsMultipleChoices: false)
        XCTAssertFalse(state.isClosed)
    }
    func testLifecycleClearsClosedPollAndStopRemainsTerminal() throws {
        var state = try preview()
        try state.toggleOption(1); try state.closePoll(); state.leave()
        XCTAssertEqual(state, ChannelPollState())
        state = try preview()
        try state.toggleOption(0); try state.closePoll()
        let next = try ChannelPollScope(organisationId: "019a5e62-6ca0-7303-8303-030303030304", channelId: "other")
        try state.configure(next)
        XCTAssertEqual(state.scope, next)
        XCTAssertEqual(state.availability, .unprovisioned)
        XCTAssertTrue(state.options.isEmpty)
        state.stop(); state.clear(); state.leave()
        XCTAssertNil(state.scope)
        XCTAssertEqual(state.availability, .stopped)
        XCTAssertThrowsError(try state.configure(scope()))
        XCTAssertThrowsError(try state.beginLocalPreview(scope: scope(), question: "Question", optionLabels: ["A", "B"], allowsMultipleChoices: false))
    }
}
