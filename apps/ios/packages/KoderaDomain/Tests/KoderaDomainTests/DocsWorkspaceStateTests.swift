import XCTest
@testable import KoderaDomain

final class DocsWorkspaceStateTests: XCTestCase {
    private let org = "019a5e62-6ca0-7303-8303-030303030303"
    private func scope(_ channel: String = "text-main") throws -> DocsWorkspaceScope {
        try DocsWorkspaceScope(organisationId: org, channelId: channel)
    }
    private func pad(_ id: String = "pad", updated: UInt64 = 1) throws -> DocsPadSummary {
        try DocsPadSummary(id: id, title: "Document " + id,
                           padURL: URL(string: "https://docs.example.org/docs/" + id)!, updatedAtEpochSeconds: updated)
    }
    func testScopeAndMetadataBoundsAreStrict() throws {
        for id in ["", "invalid", org.uppercased(), " " + org] {
            XCTAssertThrowsError(try DocsWorkspaceScope(organisationId: id, channelId: "text"))
        }
        for channel in ["", " ", " text", "text ", "text\n", String(repeating: "x", count: 256)] {
            XCTAssertThrowsError(try scope(channel))
        }
        XCTAssertEqual(try scope(String(repeating: "x", count: 255)).channelId.utf8.count, 255)
        let url = URL(string: "https://docs.example.org/docs/pad")!
        for id in ["", "has space", "x\n", "é", String(repeating: "x", count: 129)] {
            XCTAssertThrowsError(try DocsPadSummary(id: id, title: "Title", padURL: url, updatedAtEpochSeconds: 0))
        }
        for title in ["", " ", " Title", "Title ", "Title\n", String(repeating: "é", count: 128)] {
            XCTAssertThrowsError(try DocsPadSummary(id: "id", title: title, padURL: url, updatedAtEpochSeconds: 0))
        }
        XCTAssertEqual(try DocsPadSummary(id: String(repeating: "x", count: 128), title: String(repeating: "x", count: 255),
                                         padURL: url, updatedAtEpochSeconds: UInt64.max).updatedAtEpochSeconds, UInt64.max)
    }
    func testCanonicalPublicHTTPSPathsAndExplicit443AreAccepted() throws {
        for raw in ["https://docs.example.org/docs/pad-one", "https://docs.example.org:443/pads/pad_2",
                    "https://collab.example.org/other-path/document~one/"] {
            let url = URL(string: raw)!
            XCTAssertNoThrow(try DocsPadURLPolicy.validate(url), raw)
            XCTAssertEqual(try DocsPadSummary(id: "id", title: "Title", padURL: url, updatedAtEpochSeconds: 0).padURL, url)
        }
    }
    func testUnsafeSchemesHostsAndAuthorityFormsAreRejected() throws {
        for raw in ["http://docs.example.org/docs/pad", "file:///docs/pad", "HTTPS://docs.example.org/docs/pad",
                    "https://DOCS.example.org/docs/pad", "https://localhost/docs/pad", "https://a.localhost/docs/pad",
                    "https://docs.local/docs/pad", "https://docs.internal/docs/pad", "https://127.0.0.1/docs/pad",
                    "https://0x7f.0.0.1/docs/pad", "https://2130706433/docs/pad", "https://[::1]/docs/pad",
                    "https://user@docs.example.org/docs/pad", "https://@docs.example.org/docs/pad",
                    "https://docs.example.org:444/docs/pad", "https://docs.example.org:/docs/pad",
                    "https://docs.example.org:0443/docs/pad", "https://docs.example.org./docs/pad"] {
            if let url = URL(string: raw) { XCTAssertThrowsError(try DocsPadURLPolicy.validate(url), raw) }
        }
    }
    func testParserNormalizationAndPathSuffixBypassesAreRejected() throws {
        for suffix in ["", "/", "/docs/../pad", "/docs/./pad", "/docs//pad", "/docs/%2e%2e/pad",
                       "/docs/%2Fpad", "/docs/%252e%252e/pad", "/docs/pad?", "/docs/pad?x=1",
                       "/docs/pad#", "/docs/pad#section", "/docs/pad\\other", "/docs/pad other",
                       "/docs/pad\nother", "/docs/é", "/docs/" + String(repeating: "x", count: 2048)] {
            let raw = "https://docs.example.org" + suffix
            if let url = URL(string: raw) { XCTAssertThrowsError(try DocsPadURLPolicy.validate(url), raw) }
        }
        let relative = URL(string: "docs/pad", relativeTo: URL(string: "https://docs.example.org/")!)!
        XCTAssertThrowsError(try DocsPadURLPolicy.validate(relative))
    }
    func testPadsAreBoundedUniqueAndSortedWithoutTimestampOverflow() throws {
        var state = DocsWorkspaceState()
        let oldest = try pad("old", updated: 0)
        let a = try pad("a", updated: UInt64.max)
        let z = try pad("z", updated: UInt64.max)
        try state.beginLocalPreview(scope: scope(), pads: [oldest, z, a])
        XCTAssertEqual(state.pads, [a, z, oldest])
        let full = try (0..<32).map { try pad(String(format: "%02d", $0)) }
        try state.replacePads(Array(full.reversed()))
        XCTAssertEqual(state.pads, full)
        let original = state
        for invalid in [[], full + [try pad("32")], [a, a]] {
            XCTAssertThrowsError(try state.replacePads(invalid))
            XCTAssertEqual(state, original)
            XCTAssertThrowsError(try state.beginLocalPreview(scope: scope("replacement"), pads: invalid))
            XCTAssertEqual(state, original)
        }
    }
    func testUnprovisionedStateRejectsMetadataReplacement() throws {
        var state = DocsWorkspaceState()
        try state.configure(scope())
        let original = state
        XCTAssertThrowsError(try state.replacePads([pad()]))
        XCTAssertEqual(state, original)
        XCTAssertEqual(state.availability, .unprovisioned)
        XCTAssertTrue(state.pads.isEmpty)
    }
    func testClearLeaveAndScopeReplacementEraseOldPads() throws {
        var state = DocsWorkspaceState()
        try state.beginLocalPreview(scope: scope(), pads: [pad()])
        state.clear()
        XCTAssertEqual(state, DocsWorkspaceState())
        try state.beginLocalPreview(scope: scope(), pads: [pad()])
        state.leave()
        XCTAssertEqual(state, DocsWorkspaceState())
        try state.beginLocalPreview(scope: scope(), pads: [pad()])
        let replacement = try scope("replacement")
        try state.configure(replacement)
        XCTAssertEqual(state.scope, replacement)
        XCTAssertTrue(state.pads.isEmpty)
        XCTAssertEqual(state.availability, .unprovisioned)
    }
    func testStopIsTerminalAndClearCannotReviveIt() throws {
        var state = DocsWorkspaceState()
        try state.beginLocalPreview(scope: scope(), pads: [pad()])
        state.stop(); state.clear(); state.leave()
        XCTAssertEqual(state.availability, .stopped)
        XCTAssertNil(state.scope)
        XCTAssertTrue(state.pads.isEmpty)
        XCTAssertThrowsError(try state.configure(scope()))
        XCTAssertThrowsError(try state.beginLocalPreview(scope: scope(), pads: [pad()]))
    }
    func testChannelScopeIdentityPreservesExactUTF8AcrossViewTransitions() throws {
        let composed = try DocsWorkspaceScope(organisationId: org, channelId: "é")
        let decomposed = try DocsWorkspaceScope(organisationId: org, channelId: "e\u{0301}")
        XCTAssertNotEqual(composed, decomposed)
        XCTAssertEqual(composed, try DocsWorkspaceScope(organisationId: org, channelId: "é"))
    }

    func testSharedPadBounds() throws {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("packages/kodera-rs/tests/vectors/docs-pad/bounds.tsv")
        for line in try String(contentsOf: file, encoding: .utf8).split(separator: "\n") {
            let fields = line.split(separator: " ")
            let size = try XCTUnwrap(Int(fields[1]))
            let expected = fields[2] == "true"
            if fields[0] == "id" {
                let id = String(repeating: "a", count: size)
                let summary = try? DocsPadSummary(id: id, title: "Title", padURL: URL(string: "https://docs.example.org/pad")!, updatedAtEpochSeconds: 0)
                let draft = try? DocsPadDraft(padId: id, channelId: "channel", title: "Title", markdownBody: "", updatedBy: org)
                XCTAssertEqual(summary != nil, expected, String(line))
                XCTAssertEqual(draft != nil, expected, String(line))
            } else {
                XCTAssertEqual(fields[0], "count")
                var state = DocsWorkspaceState()
                var admitted = true
                do { try state.beginLocalPreview(scope: scope(), pads: (0..<size).map { try pad("pad-\($0)") }) }
                catch { admitted = false }
                XCTAssertEqual(admitted, expected, String(line))
            }
        }
    }

}
