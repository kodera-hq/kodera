import XCTest
@testable import KoderaDomain

final class ThemeAndIamModelsTests: XCTestCase {
    private let user = "00000000-0000-4000-8000-000000000001"
    private func code(_ json: String) -> String { ShareableThemeCodec.prefix + Data(json.utf8).base64EncodedString() }
    private var canonical: String {
        "{\"v\":1,\"id\":\"preset-real-black-oled\",\"name\":\"Real Black OLED\",\"author\":\"Kodera Design System\",\"baseMode\":\"black\",\"tokens\":{\"--c-page\":\"rgb(0, 0, 0)\",\"--c-surface\":\"rgb(11, 12, 14)\",\"--c-sunken\":\"rgb(6, 6, 7)\",\"--c-action\":\"rgb(67, 97, 238)\",\"--c-ink\":\"rgb(241, 244, 248)\"}}"
    }
    func testExactSharedCanonicalFixtureAndFourPresetRoundTrips() throws {
        XCTAssertEqual(try ShareableThemeCodec.encode(ShareableThemeCodec.curatedPresets[0]), code(canonical))
        XCTAssertEqual(ShareableThemeCodec.curatedPresets.map(\.id), ["preset-real-black-oled", "preset-cobalt-polaire", "preset-terminal-ambre", "preset-foret-souveraine"])
        for preset in ShareableThemeCodec.curatedPresets {
            let encoded = try ShareableThemeCodec.encode(preset)
            XCTAssertLessThanOrEqual(encoded.utf8.count, 2048)
            XCTAssertEqual(try ShareableThemeCodec.decode(encoded), preset)
        }
        XCTAssertEqual(KoderaThemeMode.allCases.map(\.rawValue), ["light", "dark", "black"])
        XCTAssertEqual(KoderaThemeMode.monogramBackgroundHex, "#000000")
    }
    func testSharedThemeShareV1VectorsMatchCuratedPresetsAndRefusals() throws {
        let vectorsURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("packages/kodera-rs/vectors/theme-share-v1.json")
        let data = try Data(contentsOf: vectorsURL)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let valid = try XCTUnwrap(root["valid"] as? [[String: String]])
        let invalid = try XCTUnwrap(root["invalid"] as? [[String: String]])
        XCTAssertEqual(valid.count, 4)
        XCTAssertEqual(invalid.count, 24)
        for entry in valid {
            let id = try XCTUnwrap(entry["id"])
            let code = try XCTUnwrap(entry["code"])
            let preset = try XCTUnwrap(ShareableThemeCodec.curatedPresets.first(where: { $0.id == id }))
            XCTAssertEqual(try ShareableThemeCodec.encode(preset), code, id)
            XCTAssertEqual(try ShareableThemeCodec.decode(code), preset, id)
        }
        for entry in invalid {
            let name = try XCTUnwrap(entry["name"])
            let code = try XCTUnwrap(entry["code"])
            XCTAssertThrowsError(try ShareableThemeCodec.decode(code), name)
        }
    }
    func testWireRejectsDuplicateEscapedUnknownNestedOrIncorrectTypeFields() {
        for json in [canonical.replacingOccurrences(of: "\"v\":1", with: "\"v\":1,\"v\":1"),
                     canonical.replacingOccurrences(of: "\"v\":1", with: "\"v\":1,\"\\u0076\":1"),
                     canonical.replacingOccurrences(of: "\"v\":1", with: "\"v\":1,\"extra\":1"),
                     canonical.replacingOccurrences(of: "\"v\":1", with: "\"v\":true"),
                     canonical.replacingOccurrences(of: "\"v\":1", with: "\"v\":1.0"),
                     canonical.replacingOccurrences(of: "\"v\":1", with: "\"v\":01"),
                     canonical.replacingOccurrences(of: "\"--c-page\":", with: "\"unknown\":"),
                     canonical.replacingOccurrences(of: "\"--c-page\":\"rgb(0, 0, 0)\"", with: "\"--c-page\":{},\"--c-page\":\"rgb(0, 0, 0)\""),
                     canonical.replacingOccurrences(of: "\"--c-page\":", with: "\"--c-page\":\"rgb(0, 0, 0)\",\"--c-page\":"),
                     canonical.replacingOccurrences(of: "Real Black OLED", with: "\\ud800"),
                     canonical + " false"] { XCTAssertThrowsError(try ShareableThemeCodec.decode(code(json))) }
    }
    func testBase64AndEnvelopeAreCanonicalBoundedAndUntrimmed() {
        let valid = code(canonical)
        for bad in [" " + valid, valid + "\n", "kodera-theme:v2:" + valid, ShareableThemeCodec.prefix, valid + "=", valid.replacingOccurrences(of: "ey", with: "e_"), ShareableThemeCodec.prefix + "/x==", ShareableThemeCodec.prefix + "////", String(repeating: "é", count: 1025)] {
            XCTAssertThrowsError(try ShareableThemeCodec.decode(bad))
        }
    }
    func testTextAndRGBRejectControlFormatOverlongAndAmbiguousChannels() throws {
        for bad in ["rgb(256, 0, 0)", "rgb(-1, 0, 0)", "rgb(00, 0, 0)", "rgb(1,2,3)", "rgb(1, 2, 3);", "#000000", "rgb(1.0, 2, 3)"] {
            XCTAssertThrowsError(try ShareableThemeTokens(page: bad, surface: "rgb(0, 0, 0)", sunken: "rgb(0, 0, 0)", action: "rgb(0, 0, 0)", ink: "rgb(0, 0, 0)"))
        }
        let t = ShareableThemeCodec.curatedPresets[0].tokens
        for text in ["", " padded", "bad\nline", "bad\u{200b}", String(repeating: "é", count: 33), "bad\u{2028}"] {
            XCTAssertThrowsError(try ShareableThemeSpec(id: "okay", name: text, author: "Author", baseMode: .black, tokens: t))
            XCTAssertThrowsError(try ShareableThemeSpec(id: "okay", name: "Name", author: text, baseMode: .black, tokens: t))
        }
        for id in ["", "UPPER", "under_score", String(repeating: "a", count: 65)] {
            XCTAssertThrowsError(try ShareableThemeSpec(id: id, name: "Name", author: "Author", baseMode: .black, tokens: t))
        }
        XCTAssertEqual(try ShareableThemeSpec(id: "okay", name: String(repeating: "é", count: 32), author: "Author", baseMode: .black, tokens: t).name.utf8.count, 64)
        XCTAssertEqual(try ShareableThemeCodec.decode(code(canonical.replacingOccurrences(of: "Real Black OLED", with: "Quoted \\\"theme\\\""))).name, "Quoted \"theme\"")
    }
    func testProfilesValidateCanonicalIdentityAndBoundedFields() throws {
        _ = try KoderaUserProfile(userId: user, displayName: "Member", handle: "member.name-1", roleTitle: "Local role", presence: .offline, rank: .guest)
        for handle in ["", "UPPER", "has space", String(repeating: "x", count: 33), "@member"] {
            XCTAssertThrowsError(try KoderaUserProfile(userId: user, displayName: "Name", handle: handle, roleTitle: "Role", presence: .online, rank: .owner))
        }
        for id in ["", "not-an-id", "00000000-0000-0000-0000-000000000000", String(repeating: "a", count: 10000), user.uppercased().replacingOccurrences(of: "1", with: "A")] {
            XCTAssertThrowsError(try KoderaUserProfile(userId: id, displayName: "Name", handle: "member", roleTitle: "Role", presence: .online, rank: .owner))
        }
        for name in ["", " bad", "bad\u{202e}", String(repeating: "a", count: 65)] {
            XCTAssertThrowsError(try KoderaUserProfile(userId: user, displayName: name, handle: "member", roleTitle: "Role", presence: .online, rank: .owner))
        }
    }
    func testEveryRankThresholdMatrixHasReadPrerequisitesAndNoImplicitOwnerBypass() throws {
        XCTAssertEqual(KoderaRoleRank.allCases.map(\.rawValue), [0, 10, 50, 80, 100])
        for rank in KoderaRoleRank.allCases {
            for read in KoderaRoleRank.allCases { for write in KoderaRoleRank.allCases { for manage in KoderaRoleRank.allCases {
                let p = try ChannelIamPolicy(channelId: "channel", categoryId: "category", isVoice: true, minReadRank: read, minWriteRank: write, minManageRank: manage, allowPolls: true, allowConnectors: true)
                let decision = p.evaluate(rank: rank)
                let canRead = rank.rawValue >= read.rawValue
                XCTAssertEqual(decision.canRead, canRead)
                XCTAssertEqual(decision.canWrite, canRead && rank.rawValue >= write.rawValue)
                XCTAssertEqual(decision.canManage, canRead && rank.rawValue >= manage.rawValue)
                XCTAssertEqual(decision.canCreatePoll, decision.canWrite)
                XCTAssertEqual(decision.canManageConnectors, decision.canManage)
                XCTAssertEqual(decision.canJoinVoice, canRead)
            } } }
        }
        let disabled = try ChannelIamPolicy(channelId: "channel", categoryId: "category", isVoice: false, minReadRank: .guest, minWriteRank: .guest, minManageRank: .guest, allowPolls: false, allowConnectors: false).evaluate(rank: .owner)
        XCTAssertFalse(disabled.canCreatePoll); XCTAssertFalse(disabled.canManageConnectors); XCTAssertFalse(disabled.canJoinVoice)
        XCTAssertThrowsError(try ChannelIamPolicy(channelId: "bad\n", categoryId: "category", isVoice: false, minReadRank: .guest, minWriteRank: .guest, minManageRank: .guest, allowPolls: false, allowConnectors: false))
    }
    func testDocsBodyUTF8BoundAndTransactionalUpdateRevision() throws {
        let d = try DocsPadDraft(padId: "pad", channelId: "channel", title: "Title", markdownBody: String(repeating: "é", count: 32768), updatedBy: user)
        XCTAssertEqual(d.markdownBody.utf8.count, 65536)
        XCTAssertThrowsError(try d.updating(title: "Title", markdownBody: d.markdownBody + "x", actor: user))
        XCTAssertThrowsError(try d.updating(title: "bad\n", markdownBody: "", actor: user))
        XCTAssertThrowsError(try d.updating(title: "Title", markdownBody: "bad\u{202e}", actor: user))
        XCTAssertEqual(d.revision, 1)
        let next = try d.updating(title: "New title", markdownBody: "# Markdown\n\tBody", actor: user)
        XCTAssertEqual(next.revision, 2); XCTAssertEqual(next.markdownBody, "# Markdown\n\tBody")
    }
    func testDocsExportEscapesMetadataAndRevisionOverflowFailsClosed() throws {
        let d = try DocsPadDraft(padId: "pad:\"value", channelId: "channel\\name", title: "--- : \"title\"", markdownBody: "<script>literal</script>", revision: Int.max, updatedBy: user)
        let export = d.exportMarkdown()
        XCTAssertTrue(export.contains("pad_id: \"pad:\\\"value\""))
        XCTAssertTrue(export.contains("channel_id: \"channel\\\\name\""))
        XCTAssertTrue(export.hasSuffix("---\n\n<script>literal</script>"))
        XCTAssertThrowsError(try d.updating(title: "Title", markdownBody: "", actor: user))
        XCTAssertThrowsError(try DocsPadDraft(padId: "pad", channelId: "channel", title: "Title", markdownBody: "", revision: -1, updatedBy: user))
        XCTAssertThrowsError(try DocsPadDraft(padId: "pad", channelId: "channel", title: "Title", markdownBody: "", revision: 0, updatedBy: user))
    }
    /// The vectors live with `kodera-rs`, whose tests read the same files: both exports stay byte-identical.
    func testDocsExportMatchesTheSharedRustVectors() throws {
        let directory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("packages/kodera-rs/tests/vectors/docs-pad")
        let names = ["first-revision", "later-revision", "empty-body"]
        for name in names {
            let meta = try String(contentsOf: directory.appendingPathComponent("\(name).meta"), encoding: .utf8)
            func field(_ key: String) throws -> String {
                guard let line = meta.split(separator: "\n", omittingEmptySubsequences: true).first(where: { $0.hasPrefix(key + "=") }) else {
                    throw VectorError.missingField(name, key)
                }
                return String(line.dropFirst(key.count + 1))
            }
            let body = try String(contentsOf: directory.appendingPathComponent("\(name).body.txt"), encoding: .utf8)
            let expected = try String(contentsOf: directory.appendingPathComponent("\(name).export.txt"), encoding: .utf8)
            let draft = try DocsPadDraft(padId: field("pad_id"), channelId: field("channel_id"), title: field("title"),
                                         markdownBody: body, revision: XCTUnwrap(Int(field("revision"))), updatedBy: field("updated_by"))
            XCTAssertEqual(Array(draft.exportMarkdown().utf8), Array(expected.utf8), name)
        }
        let listed = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasSuffix(".meta") }
        XCTAssertEqual(Set(listed), Set(names.map { "\($0).meta" }), "every shared vector is exercised")
    }
    func testBoundedInputRefusesTheExtraKeystrokeAndKeepsWhatWasTyped() {
        XCTAssertEqual(BoundedTextInput.admitting("abcd", previous: "abc", maximumBytes: 4), "abcd")
        XCTAssertEqual(BoundedTextInput.admitting("abcde", previous: "abcd", maximumBytes: 4), "abcd")
        XCTAssertEqual(BoundedTextInput.admitting("abcé", previous: "abc", maximumBytes: 4), "abc")
        XCTAssertEqual(BoundedTextInput.admitting(String(repeating: "x", count: 99), previous: "kept", maximumBytes: 64), "kept")
        XCTAssertEqual(BoundedTextInput.admitting("", previous: "abc", maximumBytes: 4), "")
    }
}

private enum VectorError: Error { case missingField(String, String) }
