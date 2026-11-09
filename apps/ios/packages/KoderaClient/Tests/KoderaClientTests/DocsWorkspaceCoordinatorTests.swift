import XCTest
import KoderaDomain
@testable import KoderaClient

final class DocsWorkspaceCoordinatorTests: XCTestCase {
    private func scope(org: String = "019a5e62-6ca0-7303-8303-030303030303", channel: String = "text") throws -> DocsWorkspaceScope {
        try DocsWorkspaceScope(organisationId: org, channelId: channel)
    }
    private func pads(_ id: String = "pad") throws -> [DocsPadSummary] {
        [try DocsPadSummary(id: id, title: "Document", padURL: URL(string: "https://docs.example.org/docs/" + id)!, updatedAtEpochSeconds: 0)]
    }
    func testDefaultIsUnprovisionedAndOnlyExplicitPreviewAcceptsMetadata() throws {
        var docs = DocsWorkspaceCoordinator()
        try docs.configure(scope())
        XCTAssertEqual(docs.state.availability, .unprovisioned)
        XCTAssertTrue(docs.state.pads.isEmpty)
        XCTAssertThrowsError(try docs.replacePads(pads(), context: nil))
        let context = try docs.beginLocalPreview(scope: scope(), pads: pads())
        try docs.replacePads(pads("new"), context: context)
        XCTAssertEqual(docs.state.pads.first?.id, "new")
        XCTAssertEqual(docs.state.availability, .localPreviewOnly)
    }
    func testNilForeignAndOldScopeContextsCannotMutateCurrentPreview() throws {
        var docs = DocsWorkspaceCoordinator()
        let old = try docs.beginLocalPreview(scope: scope(), pads: pads())
        var other = DocsWorkspaceCoordinator()
        let foreign = try other.beginLocalPreview(scope: scope(), pads: pads())
        let current = try docs.beginLocalPreview(scope: scope(channel: "next"), pads: pads("current"))
        let original = docs.state
        for context in [nil, foreign, old] {
            XCTAssertThrowsError(try docs.replacePads(pads("wrong"), context: context))
            XCTAssertEqual(docs.state, original)
        }
        try docs.replacePads(pads("valid"), context: current)
    }
    func testReplacingSameScopeInvalidatesTheEarlierGeneration() throws {
        var docs = DocsWorkspaceCoordinator()
        let old = try docs.beginLocalPreview(scope: scope(), pads: pads())
        let current = try docs.beginLocalPreview(scope: scope(), pads: pads("current"))
        XCTAssertThrowsError(try docs.replacePads(pads("wrong"), context: old))
        XCTAssertEqual(docs.state.pads.first?.id, "current")
        try docs.replacePads(pads("valid"), context: current)
    }
    func testInvalidListsPreserveStateAndValidContext() throws {
        var docs = DocsWorkspaceCoordinator()
        let context = try docs.beginLocalPreview(scope: scope(), pads: pads())
        let original = docs.state
        for invalid in [[], try pads() + pads()] {
            XCTAssertThrowsError(try docs.replacePads(invalid, context: context))
            XCTAssertEqual(docs.state, original)
            XCTAssertThrowsError(try docs.beginLocalPreview(scope: scope(channel: "wrong"), pads: invalid))
            XCTAssertEqual(docs.state, original)
        }
        try docs.replacePads(pads("still-current"), context: context)
    }
    func testClearLeaveAndReturnToSameScopeInvalidateCallbacks() throws {
        for clear in [true, false] {
            var docs = DocsWorkspaceCoordinator()
            let old = try docs.beginLocalPreview(scope: scope(), pads: pads())
            if clear { docs.clear() } else { docs.leave() }
            XCTAssertEqual(docs.state, DocsWorkspaceState())
            _ = try docs.beginLocalPreview(scope: scope(), pads: pads("new"))
            let original = docs.state
            XCTAssertThrowsError(try docs.replacePads(pads("late"), context: old))
            XCTAssertEqual(docs.state, original)
        }
    }
    func testSwitchAwayAndBackToSameOrganisationFencesEarlierPreview() throws {
        var docs = DocsWorkspaceCoordinator()
        let old = try docs.beginLocalPreview(scope: scope(), pads: pads())
        try docs.switchOrganisation(to: scope(org: "019a5e62-6ca0-7303-8303-030303030304"))
        XCTAssertTrue(docs.state.pads.isEmpty)
        XCTAssertEqual(docs.state.availability, .unprovisioned)
        try docs.switchOrganisation(to: scope())
        _ = try docs.beginLocalPreview(scope: scope(), pads: pads("new"))
        XCTAssertThrowsError(try docs.replacePads(pads("late"), context: old))
        XCTAssertEqual(docs.state.pads.first?.id, "new")
    }
    func testStopPermanentlyClearsScopeAndRejectsOldMetadata() throws {
        var docs = DocsWorkspaceCoordinator()
        let old = try docs.beginLocalPreview(scope: scope(), pads: pads())
        docs.stop(); docs.clear(); docs.leave()
        XCTAssertNil(docs.state.scope)
        XCTAssertTrue(docs.state.pads.isEmpty)
        XCTAssertEqual(docs.state.availability, .stopped)
        XCTAssertThrowsError(try docs.replacePads(pads(), context: old))
        XCTAssertThrowsError(try docs.configure(scope()))
        XCTAssertThrowsError(try docs.beginLocalPreview(scope: scope(), pads: pads()))
    }
}
