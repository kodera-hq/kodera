import XCTest
import KoderaDomain
@testable import KoderaClient

@MainActor
final class WorkspacePreferencesControllerTests: XCTestCase {
    private func scope(_ channel: String = "channel", org: String = "11111111-1111-4111-8111-111111111111") throws -> WorkspacePreferencesScope {
        try WorkspacePreferencesScope(organisationId: org, channelId: channel)
    }
    private func profile() throws -> KoderaUserProfile {
        try KoderaUserProfile(userId: "00000000-0000-4000-8000-000000000001", displayName: "Local user", handle: "local-user", roleTitle: "Local preview", presence: .offline, rank: .guest)
    }
    private func begin(_ controller: WorkspacePreferencesController, scope: WorkspacePreferencesScope? = nil) throws -> WorkspacePreferencesContext {
        try controller.beginLocalPreview(scope: scope ?? self.scope(), profile: profile(), title: "Local draft")
    }
    private func policy(_ channel: String = "channel") throws -> ChannelIamPolicy {
        try ChannelIamPolicy(channelId: channel, categoryId: "category", isVoice: false, minReadRank: .member, minWriteRank: .member, minManageRank: .admin, allowPolls: true, allowConnectors: true)
    }
    func testDefaultIsUnprovisionedAndExplicitDraftStartsLeastRank() async throws {
        let c = WorkspacePreferencesController()
        XCTAssertNil(c.profile); XCTAssertNil(c.activeDocsPad); XCTAssertTrue(c.shareCode.isEmpty)
        XCTAssertEqual(c.evaluateAccess(for: try policy(), context: nil), .denied)
        XCTAssertThrowsError(try c.selectThemeMode(.light, context: nil))
        let context = try begin(c)
        XCTAssertTrue(c.previewMatches(context, scope: try scope()))
        XCTAssertEqual(c.profile?.rank, .guest); XCTAssertEqual(c.activeDocsPad?.revision, 1)
        XCTAssertEqual(c.evaluateAccess(for: try policy(), context: context), .denied)
        XCTAssertEqual(try ShareableThemeCodec.decode(c.shareCode), c.activeThemeSpec)
    }
    func testThemeModePresetsImportsAndRefusalAreTransactional() async throws {
        let c = WorkspacePreferencesController(); let context = try begin(c)
        try c.selectThemeMode(.light, context: context)
        XCTAssertEqual(c.themeMode, .light)
        XCTAssertEqual(c.activeThemeSpec.id, "preset-cobalt-polaire")
        XCTAssertEqual(c.activeThemeSpec.tokens.page, "rgb(255, 255, 255)")
        XCTAssertEqual(try ShareableThemeCodec.decode(c.shareCode).baseMode, .light)
        for p in ShareableThemeCodec.curatedPresets {
            try c.applyPreset(id: p.id, context: context)
            XCTAssertEqual(c.activeThemeSpec, p)
            try c.importShareCode(ShareableThemeCodec.encode(p), context: context)
            XCTAssertEqual(c.themeMode, p.baseMode)
        }
        let old = c.activeThemeSpec; let code = c.shareCode
        XCTAssertThrowsError(try c.importShareCode("invalid", context: context))
        XCTAssertEqual(c.activeThemeSpec, old); XCTAssertEqual(c.shareCode, code)
        XCTAssertEqual(c.lastError, .invalidTheme)
        XCTAssertThrowsError(try c.applyPreset(id: "missing", context: context))
        XCTAssertEqual(c.activeThemeSpec, old)
        try c.selectThemeMode(.black, context: context); XCTAssertNil(c.lastError)
    }
    func testNilForeignReplacementAndAwayBackContextsCannotChangeState() async throws {
        let c = WorkspacePreferencesController(); let old = try begin(c)
        let foreign = WorkspacePreferencesController(); let foreignContext = try begin(foreign)
        let other = try begin(c, scope: scope("other"))
        let current = try begin(c)
        for invalid in [nil, old, foreignContext, other] {
            XCTAssertThrowsError(try c.selectThemeMode(.light, context: invalid))
            XCTAssertThrowsError(try c.updateDocsPad(title: "Bad", markdownBody: "bad", context: invalid))
            XCTAssertEqual(c.themeMode, .black); XCTAssertEqual(c.activeDocsPad?.revision, 1)
            XCTAssertEqual(c.evaluateAccess(for: try policy(), context: invalid), .denied)
        }
        c.leavePreview(context: old)
        XCTAssertTrue(c.previewMatches(current, scope: try scope()))
        c.leavePreview(context: current)
        XCTAssertNil(c.profile); XCTAssertNil(c.activeDocsPad); XCTAssertTrue(c.shareCode.isEmpty)
    }
    func testSelectedPreviewRankAffectsOnlyMatchingChannelArithmetic() async throws {
        let c = WorkspacePreferencesController(); let context = try begin(c)
        try c.updateProfile(displayName: "New local name", handle: "local-member", roleTitle: "Local role", presence: .online, rank: .owner, context: context)
        let decision = c.evaluateAccess(for: try policy(), context: context)
        XCTAssertTrue(decision.canManage); XCTAssertTrue(decision.canCreatePoll)
        XCTAssertFalse(decision.canJoinVoice)
        XCTAssertEqual(c.evaluateAccess(for: try policy("different"), context: context), .denied)
        let saved = c.profile
        XCTAssertThrowsError(try c.updateProfile(displayName: "", handle: "bad", roleTitle: "Role", presence: .offline, rank: .guest, context: context))
        XCTAssertEqual(c.profile, saved)
    }
    func testDocsInvalidUpdatePreservesRevisionAndOwnerClearErasesData() async throws {
        let c = WorkspacePreferencesController(); let context = try begin(c)
        try c.updateDocsPad(title: "Local edited draft", markdownBody: "**literal Markdown**", context: context)
        let saved = c.activeDocsPad
        XCTAssertEqual(saved?.revision, 2)
        XCTAssertThrowsError(try c.updateDocsPad(title: "New", markdownBody: String(repeating: "x", count: 65537), context: context))
        XCTAssertEqual(c.activeDocsPad, saved)
        c.clear(); XCTAssertFalse(c.isPreviewing); XCTAssertNil(c.scope); XCTAssertNil(c.profile); XCTAssertNil(c.activeDocsPad)
        XCTAssertThrowsError(try c.updateDocsPad(title: "Late", markdownBody: "", context: context))
    }
    func testStopIsTerminalAndScopeIdentityDoesNotNormalizeUnicode() async throws {
        let c = WorkspacePreferencesController(); let old = try begin(c)
        c.stop(); XCTAssertTrue(c.isStopped)
        XCTAssertThrowsError(try begin(c))
        XCTAssertThrowsError(try c.selectThemeMode(.light, context: old))
        XCTAssertNotEqual(try scope("é"), try scope("e\u{0301}"))
        let unicode = WorkspacePreferencesController()
        let context = try begin(unicode, scope: scope("é"))
        XCTAssertFalse(unicode.previewMatches(context, scope: try scope("e\u{0301}")))
        XCTAssertThrowsError(try scope("bad\u{200b}"))
        XCTAssertThrowsError(try scope(org: "invalid"))
    }
}
