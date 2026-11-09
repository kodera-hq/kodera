import Foundation
import XCTest
import KoderaDomain
@testable import KoderaClient

/// Actual local reducers exercised together, without claiming a provider or device journey.
@MainActor
final class WorkspaceLifecycleAuditTests: XCTestCase {
    func testWorkspacePreviewJourneyErasesOldOrganisationAndRejectsLateCallbacks() async throws {
        let first = "11111111-1111-4111-8111-111111111111"
        let second = "22222222-2222-4222-8222-222222222222"
        let user = "33333333-3333-4333-8333-333333333333"
        let preferences = WorkspacePreferencesController()
        let profile = try KoderaUserProfile(userId: user, displayName: "Local audit member", handle: "local.audit",
                                            roleTitle: "Local simulation", presence: .offline, rank: .member)
        let oldPreferences = try preferences.beginLocalPreview(
            scope: WorkspacePreferencesScope(organisationId: first, channelId: "text"), profile: profile, title: "First draft")
        try preferences.importShareCode(ShareableThemeCodec.encode(ShareableThemeCodec.curatedPresets[3]), context: oldPreferences)
        try preferences.updateDocsPad(title: "Edited first draft", markdownBody: "# Literal Markdown", context: oldPreferences)

        var sounds = SoundPreferencesCoordinator()
        let oldSound = try sounds.beginLocalPreview(scope: SoundPreferencesScope(organisationId: first))
        try sounds.selectPack(.silent, context: oldSound)
        var polls = ChannelPollCoordinator()
        let oldPoll = try polls.beginLocalPreview(scope: ChannelPollScope(organisationId: first, channelId: "text"),
                                                  question: "Local choice?", optionLabels: ["One", "Two"], allowsMultipleChoices: false)
        try polls.toggleOption(1, context: oldPoll)
        try polls.closePoll(context: oldPoll)
        var voice = VoiceCallCoordinator()
        let oldVoice = try voice.beginLocalPreview(scope: VoiceCallScope(organisationId: first, channelId: "audio"),
            participants: [VoiceCallParticipant(id: "local", displayName: "Local member", isMuted: false, isSpeaking: false)])
        try voice.setDeafened(true)
        XCTAssertTrue(voice.state.isMuted)
        var docs = DocsWorkspaceCoordinator()
        let pad = try DocsPadSummary(id: "pad", title: "Local metadata", padURL: URL(string: "https://docs.example.org/docs/local")!, updatedAtEpochSeconds: 1)
        let oldDocs = try docs.beginLocalPreview(scope: DocsWorkspaceScope(organisationId: first, channelId: "text"), pads: [pad])

        let newScope = try WorkspacePreferencesScope(organisationId: second, channelId: "text")
        let newPreferences = try preferences.beginLocalPreview(scope: newScope, profile: profile, title: "Second draft")
        try sounds.switchOrganisation(to: SoundPreferencesScope(organisationId: second))
        try polls.switchOrganisation(to: ChannelPollScope(organisationId: second, channelId: "text"))
        try voice.switchOrganisation(to: VoiceCallScope(organisationId: second, channelId: "audio"))
        try docs.switchOrganisation(to: DocsWorkspaceScope(organisationId: second, channelId: "text"))

        XCTAssertThrowsError(try preferences.updateDocsPad(title: "Late first edit", markdownBody: "old", context: oldPreferences))
        preferences.leavePreview(context: oldPreferences)
        XCTAssertTrue(preferences.previewMatches(newPreferences, scope: newScope))
        XCTAssertEqual(preferences.activeDocsPad?.title, "Second draft")
        XCTAssertEqual(preferences.activeDocsPad?.markdownBody, "")
        XCTAssertEqual(preferences.activeThemeSpec.id, "preset-real-black-oled")
        XCTAssertThrowsError(try sounds.setMuted(false, context: oldSound))
        XCTAssertThrowsError(try polls.toggleOption(0, context: oldPoll))
        XCTAssertThrowsError(try voice.replaceParticipants([], context: oldVoice))
        XCTAssertThrowsError(try docs.replacePads([pad], context: oldDocs))
        XCTAssertEqual(sounds.state.activePack, .givre)
        XCTAssertFalse(sounds.state.isAudioHardwareActive)
        XCTAssertTrue(polls.state.options.isEmpty)
        XCTAssertTrue(voice.state.participants.isEmpty)
        XCTAssertFalse(voice.state.isMicrophoneCapturing)
        XCTAssertTrue(docs.state.pads.isEmpty)
        preferences.stop(); sounds.stop(); polls.stop(); voice.stop(); docs.stop()
        XCTAssertNil(preferences.activeDocsPad)
        XCTAssertThrowsError(try preferences.selectThemeMode(.light, context: newPreferences))
    }
}
