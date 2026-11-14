import Foundation
import XCTest
import KoderaDomain
@testable import KoderaClient

final class CoreProximityClientTests: XCTestCase {
    private let workspace = "11111111-1111-4111-8111-111111111111"

    private func valid() -> [String: Any] {
        ["workspace_id": workspace, "event_scope": "default", "epoch_mac_key": String(repeating: "ab", count: 32),
         "epoch": 2_000, "epoch_expires_at": 1_800_900, "epoch_rotation_seconds": 900]
    }

    func testExplicitBootstrapUsesBoundedPostAndOneRefreshWithSameBody() async throws {
        let response = try JSONSerialization.data(withJSONObject: valid())
        URLProtocolFixture.install(sequence: [
            .body(status: 401, headers: [:], chunks: []),
            .body(status: 200, headers: ["Content-Type": "application/json"], chunks: [response])
        ])
        let tokens = FakeTokens()
        let requester = try CoreRequester(coreApiOrigin: "https://core.test", loopback: .refuse, tokens: tokens,
            protocolClass: URLProtocolFixture.self, timeout: 2)
        let material = try await CoreProximityClient(requester: requester, clock: { 1_800_000 }).bootstrap(workspaceId: workspace)
        XCTAssertEqual(material.workspaceId, workspace)
        XCTAssertEqual(material.epochMacKey, Data(repeating: 0xab, count: 32))
        XCTAssertEqual(material.epochExpiresAtUnixSeconds, 1_800_900)
        let requests = URLProtocolFixture.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "POST"])
        XCTAssertEqual(requests.map { $0.url?.absoluteString }, Array(repeating: "https://core.test/api/v1/proximity/bootstrap", count: 2))
        XCTAssertEqual(try URLProtocolFixture.bodyData(requests[0]), try URLProtocolFixture.bodyData(requests[1]))
        let refreshed = await tokens.forcedRefreshes
        XCTAssertEqual(refreshed, 1)
        requester.invalidate()
    }

    func testBootstrapRefusesCrossWorkspaceWeakKeysUnknownFieldsAndWrongEpochTypes() throws {
        var mutations: [[String: Any]] = []
        let changes: [(String, Any)] = [
            ("workspace_id", "22222222-2222-4222-8222-222222222222"), ("event_scope", "other"),
            ("epoch_mac_key", String(repeating: "00", count: 32)), ("epoch_mac_key", String(repeating: "AB", count: 32)),
            ("epoch_mac_key", "ab"), ("epoch_rotation_seconds", 901), ("epoch", true), ("epoch", -1), ("epoch", 1.5),
            ("epoch", 2_001), ("epoch", 1_999), ("epoch_expires_at", 1_800_901), ("epoch_expires_at", 1_800_000),
            ("workspace_beacon_key", String(repeating: "ab", count: 32)), ("extra", "unexpected")
        ]
        for (key, value) in changes {
            var changed = valid(); changed[key] = value; mutations.append(changed)
        }
        for mutation in mutations {
            XCTAssertThrowsError(try CoreProximityClient.decode(JSONSerialization.data(withJSONObject: mutation), workspaceId: workspace, nowUnixSeconds: 1_800_000))
        }
        XCTAssertThrowsError(try CoreProximityClient.decode(Data("{\"epoch\":1,\"epoch\":2}".utf8), workspaceId: workspace))
    }

    func testOversizePostIsRefusedBeforeAskingForAnyToken() async throws {
        let tokens = FakeTokens()
        let requester = try CoreRequester(coreApiOrigin: "https://core.test", loopback: .refuse, tokens: tokens,
            protocolClass: URLProtocolFixture.self, timeout: 2)
        let reply = await requester.post(path: "/api/v1/proximity/bootstrap", jsonBody: Data(repeating: 0, count: 65_537))
        XCTAssertEqual(reply, .tooLarge)
        let count = await tokens.requested
        XCTAssertEqual(count, 0)
        requester.invalidate()
    }
}
