import XCTest
import KoderaDomain
@testable import KoderaClient

final class VoiceCallCoordinatorTests: XCTestCase {
    private func scope(org: String = "019a5e62-6ca0-7303-8303-030303030303", channel: String = "audio") throws -> VoiceCallScope {
        try VoiceCallScope(organisationId: org, channelId: channel)
    }
    private func roster(_ id: String = "member") throws -> [VoiceCallParticipant] {
        [try VoiceCallParticipant(id: id, displayName: "Member", isMuted: false, isSpeaking: true)]
    }
    func testDefaultCompositionFailsClosedAndPreviewNeverClaimsMedia() throws {
        var call = VoiceCallCoordinator()
        try call.configure(scope())
        XCTAssertEqual(call.state.availability, .unprovisioned)
        XCTAssertThrowsError(try call.setMuted(false))
        let context = try call.beginLocalPreview(scope: scope(), participants: roster())
        try call.setMuted(false)
        try call.setDeafened(true)
        XCTAssertTrue(call.state.isMuted && call.state.isDeafened)
        try call.setMuted(false)
        XCTAssertFalse(call.state.isDeafened)
        try call.replaceParticipants(roster("another"), context: context)
        XCTAssertEqual(call.state.participants.first?.id, "another")
        XCTAssertEqual(call.state.availability, .localPreviewOnly)
        XCTAssertFalse(call.state.isMicrophoneCapturing || call.state.isRemoteAudioPlaying || call.state.isTransmitting)
    }
    func testUnverifiedOtherOwnerAndOldChannelContextsCannotMutateRoster() throws {
        var call = VoiceCallCoordinator()
        let old = try call.beginLocalPreview(scope: scope(), participants: roster())
        var other = VoiceCallCoordinator()
        let foreign = try other.beginLocalPreview(scope: scope(), participants: roster())
        let current = try call.beginLocalPreview(scope: scope(channel: "other"), participants: roster("current"))
        let expected = call.state
        for context in [nil, foreign, old] {
            XCTAssertThrowsError(try call.replaceParticipants(roster("wrong"), context: context))
            XCTAssertEqual(call.state, expected)
        }
        try call.replaceParticipants(roster("valid"), context: current)
        XCTAssertEqual(call.state.participants.first?.id, "valid")
    }
    func testLeaveThenSameScopeRejoinRejectsOldGeneration() throws {
        var call = VoiceCallCoordinator()
        let old = try call.beginLocalPreview(scope: scope(), participants: roster())
        try call.setDeafened(true)
        call.leave()
        XCTAssertEqual(call.state, VoiceCallDockState())
        _ = try call.beginLocalPreview(scope: scope(), participants: roster("new"))
        let expected = call.state
        XCTAssertThrowsError(try call.replaceParticipants(roster("late"), context: old))
        XCTAssertEqual(call.state, expected)
    }
    func testStartingAnotherPreviewOfSameScopeFencesEarlierCallbacks() throws {
        var call = VoiceCallCoordinator()
        let old = try call.beginLocalPreview(scope: scope(), participants: roster())
        let current = try call.beginLocalPreview(scope: scope(), participants: roster("current"))
        let expected = call.state
        XCTAssertThrowsError(try call.replaceParticipants(roster("old"), context: old))
        XCTAssertEqual(call.state, expected)
        try call.replaceParticipants(roster("valid"), context: current)
    }
    func testOrganisationSwitchClearsStateAndRejectsOldCallbacks() throws {
        var call = VoiceCallCoordinator()
        let old = try call.beginLocalPreview(scope: scope(), participants: roster())
        try call.setMuted(false)
        let next = try scope(org: "019a5e62-6ca0-7303-8303-030303030304")
        try call.switchOrganisation(to: next)
        XCTAssertEqual(call.state.scope, next)
        XCTAssertTrue(call.state.participants.isEmpty)
        XCTAssertTrue(call.state.isMuted)
        XCTAssertFalse(call.state.isDeafened)
        XCTAssertEqual(call.state.availability, .unprovisioned)
        XCTAssertThrowsError(try call.replaceParticipants(roster(), context: old))
    }
    func testInvalidRosterCannotReplaceWorkingGeneration() throws {
        var call = VoiceCallCoordinator()
        let context = try call.beginLocalPreview(scope: scope(), participants: roster())
        let expected = call.state
        XCTAssertThrowsError(try call.beginLocalPreview(scope: scope(channel: "invalid"), participants: []))
        XCTAssertEqual(call.state, expected)
        try call.replaceParticipants(roster("still-current"), context: context)
    }
    func testStopIsTerminalAndRejectsAllLateMetadata() throws {
        var call = VoiceCallCoordinator()
        let context = try call.beginLocalPreview(scope: scope(), participants: roster())
        call.stop()
        XCTAssertEqual(call.state.availability, .stopped)
        XCTAssertNil(call.state.scope)
        XCTAssertTrue(call.state.participants.isEmpty)
        XCTAssertThrowsError(try call.replaceParticipants(roster(), context: context))
        XCTAssertThrowsError(try call.configure(scope()))
        XCTAssertThrowsError(try call.beginLocalPreview(scope: scope(), participants: roster()))
    }
}
