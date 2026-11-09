import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import KoderaClient

/// Core's `/me` from a script, in order, counting every fetch. While held, a fetch waits (bounded) before it
/// answers, so a test can act while that fetch is in flight.
private actor ScriptedMe {
    private var answers: [MeOutcome]
    private(set) var fetches = 0
    private var held = false

    init(_ answers: [MeOutcome]) { self.answers = answers }

    func hold() { held = true }
    func release() { held = false }

    func fetch() async -> MeOutcome {
        fetches += 1
        for _ in 0..<1000 where held { try? await Task.sleep(for: .milliseconds(5)) }
        return answers.isEmpty ? .unavailable(.protocolViolation) : answers.removeFirst()
    }
}

/// Every answer `onAnswer` was given, in order.
@MainActor
private final class Answers {
    var all: [MeOutcome] = []
}

private struct DeadlinePassed: Error {}

/// The signed-in screen's `/me` fetches: the way back from "no organisation yet" after the Console.
@MainActor
final class MemberLoaderTests: XCTestCase {
    private let forbidden = MeOutcome.unavailable(.forbidden)

    /// Bounded: a regression fails the test by name, it never hangs the suite.
    private func until(_ what: String, within limit: Duration = .seconds(5), file: StaticString = #filePath,
                       line: UInt = #line, _ condition: @MainActor () async -> Bool) async throws {
        let clock = ContinuousClock()
        let end = clock.now + limit
        while !(await condition()) {
            guard clock.now < end else {
                XCTFail("\(what) did not happen within \(limit)", file: file, line: line)
                throw DeadlinePassed()
            }
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    private func settled(_ loader: MemberLoader, file: StaticString = #filePath, line: UInt = #line) async throws {
        try await until("the fetch to settle", file: file, line: line) { loader.state != .loading }
    }

    /// Owned by `checkAgain()`: an owner who finished their claim in the Console comes back, Core now answers
    /// 200, and the member is shown. Through the real `CoreMeClient` and `CoreRequester`, with the session kept.
    func testA403ThenA200OnCheckingAgainReachesTheMember() async throws {
        let member: [String: Any] = [
            "id": "11111111-2222-4333-8444-555555555555",
            "email": "member@example.test",
            "display_name": "Synthetic Member",
            "organisations": [[
                "organisation": ["id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f", "slug": "kodera-dev",
                                 "name": "Synthetic organisation", "realm": "kodera-dev"],
                "role": "org_owner",
                "state": "active",
            ]],
        ]
        URLProtocolFixture.install(sequence: [
            .body(status: 403, headers: ["Content-Type": "application/problem+json"],
                  chunks: [Data(#"{"type":"https://kodera.io/problems/forbidden","title":"Access refused","status":403}"#.utf8)]),
            .body(status: 200, headers: ["Content-Type": "application/json", "Cache-Control": "no-store"],
                  chunks: [try DiscoveryFixtures.json(member)]),
        ])
        let tokens = FakeTokens()
        let me = CoreMeClient(requester: try CoreRequester(coreApiOrigin: "https://core.test", loopback: .refuse,
            tokens: tokens, protocolClass: URLProtocolFixture.self, timeout: 2))
        let answers = Answers()
        let loader = MemberLoader(fetch: { await me.fetch() }, onAnswer: { answers.all.append($0) })

        loader.load()
        try await settled(loader)
        XCTAssertEqual(loader.state, .answered(forbidden))

        XCTAssertTrue(loader.checkAgain(), "checking again from the 403 state fetched nothing")
        XCTAssertEqual(loader.state, .loading)
        try await settled(loader)
        guard case let .answered(.member(profile)) = loader.state else {
            return XCTFail("checking again did not reach the member: \(loader.state)")
        }
        XCTAssertEqual(profile.displayName, "Synthetic Member")
        XCTAssertEqual(profile.organisation(realm: "kodera-dev")?.name, "Synthetic organisation")
        XCTAssertEqual(answers.all.count, 2)
        XCTAssertEqual(answers.all.first, forbidden)
        XCTAssertEqual(URLProtocolFixture.requests.count, 2)
        let localEnds = await tokens.localEnds
        let signOuts = await tokens.signOuts
        XCTAssertEqual(localEnds, 0, "the 403 or the re-fetch ended the session")
        XCTAssertEqual(signOuts, 0)

        // Only from the 403 state: once the member is shown, a return to the foreground fetches nothing.
        XCTAssertFalse(loader.checkAgain())
        XCTAssertEqual(URLProtocolFixture.requests.count, 2, "checking again outside the 403 state fetched")
    }

    /// Owned by the guard in `checkAgain()`: a return to the foreground and taps while a fetch is in flight send
    /// no second request, and a 403 answer does not fetch again on its own.
    func testCheckingAgainWhileAFetchIsInFlightSendsNoSecondRequest() async throws {
        let me = ScriptedMe(Array(repeating: forbidden, count: 5))
        let answers = Answers()
        let loader = MemberLoader(fetch: { await me.fetch() }, onAnswer: { answers.all.append($0) })
        loader.load()
        try await settled(loader)
        XCTAssertEqual(loader.state, .answered(forbidden))

        await me.hold()
        XCTAssertTrue(loader.checkAgain())
        try await until("the second fetch to start") { await me.fetches == 2 }
        // In flight: the app comes back to the foreground, and the member taps Check again twice.
        let resumed = loader.checkAgain()
        let tapped = loader.checkAgain()
        let tappedAgain = loader.checkAgain()
        await me.release()
        // The latest fetch's answer is the one kept, so every fetch started has run by now.
        try await settled(loader)
        XCTAssertFalse(resumed || tapped || tappedAgain, "a call during a fetch in flight fetched")
        let fetches = await me.fetches
        XCTAssertEqual(fetches, 2, "a fetch in flight was doubled, or a 403 fetched again on its own")
        XCTAssertEqual(loader.state, .answered(forbidden))
        XCTAssertEqual(answers.all.count, 2)
        loader.cancel()
    }

    /// Every other state is left alone: nothing fetched, nothing changed.
    func testCheckingAgainFromAnyOtherStateFetchesNothing() async throws {
        for outcome in [MeOutcome.unavailable(.serviceUnavailable), .unavailable(.transport(.timeout)), .signedOut,
                        .signedOutNotWiped] {
            let me = ScriptedMe([outcome])
            let loader = MemberLoader(fetch: { await me.fetch() }, onAnswer: { _ in })
            XCTAssertFalse(loader.checkAgain(), "idle")
            loader.load()
            try await settled(loader)
            XCTAssertFalse(loader.checkAgain(), "\(outcome)")
            XCTAssertEqual(loader.state, .answered(outcome))
            let fetches = await me.fetches
            XCTAssertEqual(fetches, 1, "\(outcome)")
        }
    }

    /// A cancelled fetch (the member signed out) hands no answer to the app.
    func testACancelledFetchIsDropped() async throws {
        let me = ScriptedMe([forbidden])
        let answers = Answers()
        let loader = MemberLoader(fetch: { await me.fetch() }, onAnswer: { answers.all.append($0) })
        await me.hold()
        loader.load()
        try await until("the fetch to start") { await me.fetches == 1 }
        loader.cancel()
        await me.release()
        // The held fetch answers within one poll of its release; give it ample time to land, then look.
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(loader.state, .idle)
        XCTAssertTrue(answers.all.isEmpty, "a cancelled fetch reached the app")
        XCTAssertFalse(loader.checkAgain())
    }
}
