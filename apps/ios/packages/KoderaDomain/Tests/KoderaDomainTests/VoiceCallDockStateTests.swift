import XCTest
@testable import KoderaDomain

final class VoiceCallDockStateTests: XCTestCase {
    private let org = "019a5e62-6ca0-7303-8303-030303030303"
    private func scope(_ channel: String = "audio-main") throws -> VoiceCallScope {
        try VoiceCallScope(organisationId: org, channelId: channel)
    }
    private func participant(_ id: String, muted: Bool = false, speaking: Bool = false) throws -> VoiceCallParticipant {
        try VoiceCallParticipant(id: id, displayName: "Member " + id, isMuted: muted, isSpeaking: speaking)
    }
    func testScopeRejectsNoncanonicalOrganisationAndUnboundedOrBlankChannel() throws {
        for id in ["", "not-an-org", org.uppercased(), " " + org] {
            XCTAssertThrowsError(try VoiceCallScope(organisationId: id, channelId: "audio"))
        }
        for channel in ["", " ", " audio", "audio ", "audio\nroom", String(repeating: "a", count: 256)] {
            XCTAssertThrowsError(try scope(channel))
        }
        XCTAssertEqual(try scope(String(repeating: "a", count: 255)).channelId.utf8.count, 255)
        XCTAssertEqual(try scope().organisationId, org)
    }
    func testParticipantValidationAndMutedSpeakerNormalization() throws {
        for value in ["", " ", "x\n", String(repeating: "a", count: 256)] {
            XCTAssertThrowsError(try VoiceCallParticipant(id: value, displayName: "Name", isMuted: false, isSpeaking: false))
            XCTAssertThrowsError(try VoiceCallParticipant(id: "id", displayName: value, isMuted: false, isSpeaking: false))
        }
        XCTAssertFalse(try participant("a", muted: true, speaking: true).isSpeaking)
        XCTAssertTrue(try participant("a", speaking: true).isSpeaking)
    }
    func testUnavailableNeverAllowsAudioActionsOrClaimsMedia() throws {
        var state = VoiceCallDockState()
        try state.configure(scope())
        let original = state
        XCTAssertThrowsError(try state.setMuted(false))
        XCTAssertThrowsError(try state.setDeafened(true))
        XCTAssertThrowsError(try state.replaceParticipants([participant("a")]))
        XCTAssertEqual(state, original)
        XCTAssertTrue(state.isMuted)
        XCTAssertFalse(state.isDeafened)
        XCTAssertFalse(state.isMicrophoneCapturing)
        XCTAssertFalse(state.isRemoteAudioPlaying)
        XCTAssertFalse(state.isTransmitting)
    }
    func testAllMuteDeafenTransitionsPreserveInvariant() throws {
        for initialMuted in [false, true] {
            for initialDeafened in [false, true] {
                for nextMuted in [false, true] {
                    for nextDeafened in [false, true] {
                        var state = VoiceCallDockState()
                        try state.beginLocalPreview(scope: scope(), participants: [participant("a")])
                        try state.setMuted(initialMuted)
                        try state.setDeafened(initialDeafened)
                        try state.setMuted(nextMuted)
                        XCTAssertFalse(state.isDeafened && !state.isMuted)
                        if !nextMuted { XCTAssertFalse(state.isDeafened) }
                        try state.setDeafened(nextDeafened)
                        XCTAssertEqual(state.isDeafened, nextDeafened)
                        if nextDeafened { XCTAssertTrue(state.isMuted) }
                        XCTAssertFalse(state.isMicrophoneCapturing || state.isRemoteAudioPlaying || state.isTransmitting)
                    }
                }
            }
        }
    }
    func testUndeafenDoesNotUnexpectedlyUnmute() throws {
        var state = VoiceCallDockState()
        try state.beginLocalPreview(scope: scope(), participants: [participant("a")])
        try state.setMuted(false)
        try state.setDeafened(true)
        try state.setDeafened(false)
        XCTAssertTrue(state.isMuted)
        XCTAssertFalse(state.isDeafened)
    }
    func testRosterBoundsUniqueIDsAndStableByteOrderingAreTransactional() throws {
        var state = VoiceCallDockState()
        let roster = try (0..<64).map { try participant(String(format: "%02d", $0)) }
        try state.beginLocalPreview(scope: scope(), participants: Array(roster.reversed()))
        XCTAssertEqual(state.participants, roster)
        let original = state
        for invalid in [[], roster + [try participant("64")], [try participant("a"), try participant("a")]] {
            XCTAssertThrowsError(try state.replaceParticipants(invalid))
            XCTAssertEqual(state, original)
        }
        try state.replaceParticipants([participant("a")])
        XCTAssertEqual(state.participants.count, 1)
    }
    func testLeaveAndOrganisationSwitchEraseAllState() throws {
        var state = VoiceCallDockState()
        try state.beginLocalPreview(scope: scope(), participants: [participant("a")])
        try state.setDeafened(true)
        state.leave()
        XCTAssertEqual(state, VoiceCallDockState())
        try state.beginLocalPreview(scope: scope(), participants: [participant("a")])
        let newScope = try VoiceCallScope(organisationId: "019a5e62-6ca0-7303-8303-030303030304", channelId: "other")
        try state.configure(newScope)
        XCTAssertEqual(state.scope, newScope)
        XCTAssertTrue(state.participants.isEmpty)
        XCTAssertTrue(state.isMuted)
        XCTAssertFalse(state.isDeafened)
        XCTAssertEqual(state.availability, .unprovisioned)
    }
    func testStopIsTerminalAndClearsScopeAndPreferences() throws {
        var state = VoiceCallDockState()
        try state.beginLocalPreview(scope: scope(), participants: [participant("a")])
        try state.setMuted(false)
        state.stop()
        XCTAssertNil(state.scope)
        XCTAssertTrue(state.participants.isEmpty)
        XCTAssertTrue(state.isMuted)
        XCTAssertThrowsError(try state.configure(scope()))
        XCTAssertThrowsError(try state.beginLocalPreview(scope: scope(), participants: [participant("b")]))
        state.leave()
        XCTAssertEqual(state.availability, .stopped)
    }
    func testChannelScopeIdentityPreservesExactUTF8AcrossViewTransitions() throws {
        let composed = try VoiceCallScope(organisationId: org, channelId: "é")
        let decomposed = try VoiceCallScope(organisationId: org, channelId: "e\u{0301}")
        XCTAssertNotEqual(composed, decomposed)
        XCTAssertEqual(composed, try VoiceCallScope(organisationId: org, channelId: "é"))
    }

    func testParticipantIdentityDedupAndUIKeysUseExactUTF8() throws {
        let composed = try VoiceCallParticipant(id: "é", displayName: "Local member", isMuted: true, isSpeaking: false)
        let decomposed = try VoiceCallParticipant(id: "e\u{0301}", displayName: "Local member", isMuted: true, isSpeaking: false)
        XCTAssertNotEqual(composed, decomposed)
        XCTAssertNotEqual(composed.identityBytes, decomposed.identityBytes)
        var state = VoiceCallDockState()
        try state.beginLocalPreview(scope: scope(), participants: [composed, decomposed])
        XCTAssertEqual(state.participants.map(\.identityBytes), [decomposed.identityBytes, composed.identityBytes])
        let old = state
        XCTAssertThrowsError(try state.replaceParticipants([composed, composed]))
        XCTAssertEqual(state, old)
    }

}
