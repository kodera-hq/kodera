import XCTest
import KoderaDomain
@testable import KoderaClient

final class SoundPreferencesCoordinatorTests: XCTestCase {
    private func scope(_ org: String = "019a5e62-6ca0-7303-8303-030303030303") throws -> SoundPreferencesScope {
        try SoundPreferencesScope(organisationId: org)
    }
    private typealias Mutation = (inout SoundPreferencesCoordinator, SoundPreferencesContext?) throws -> Void
    private var mutations: [Mutation] { [
        { try $0.selectPack(.silent, context: $1) },
        { try $0.setVolumePercent(0, context: $1) },
        { try $0.setMuted(true, context: $1) },
        { try $0.setCallDuckingActive(true, context: $1) },
    ] }
    func testOnlyExplicitPreviewCanChangeLocalPolicyWithoutHardware() throws {
        var preferences = SoundPreferencesCoordinator()
        try preferences.configure(scope())
        XCTAssertEqual(preferences.state.availability, .unprovisioned)
        for mutate in mutations { XCTAssertThrowsError(try mutate(&preferences, nil)) }
        let context = try preferences.beginLocalPreview(scope: scope())
        try preferences.selectPack(.arcade8Bit, context: context)
        try preferences.setVolumePercent(81, context: context)
        try preferences.setCallDuckingActive(true, context: context)
        XCTAssertEqual(preferences.state.effectiveGainPercent, 41)
        XCTAssertEqual(preferences.state.activeDuckingDecibels, -6)
        XCTAssertEqual(preferences.state.activePack, .arcade8Bit)
        XCTAssertFalse(preferences.state.isAudioHardwareActive)
    }
    func testNilForeignAndOldScopeContextsCannotMutateAnyPreference() throws {
        var preferences = SoundPreferencesCoordinator()
        let old = try preferences.beginLocalPreview(scope: scope())
        var foreign = SoundPreferencesCoordinator()
        let wrongOwner = try foreign.beginLocalPreview(scope: scope())
        let current = try preferences.beginLocalPreview(scope: scope("019a5e62-6ca0-7303-8303-030303030304"))
        let expected = preferences.state
        for context in [nil, wrongOwner, old] {
            for mutate in mutations {
                XCTAssertThrowsError(try mutate(&preferences, context))
                XCTAssertEqual(preferences.state, expected)
            }
        }
        try preferences.selectPack(.cristal, context: current)
    }
    func testSameScopeReplacementInvalidatesEarlierContextAndResetsPolicy() throws {
        var preferences = SoundPreferencesCoordinator()
        let old = try preferences.beginLocalPreview(scope: scope())
        try preferences.selectPack(.silent, context: old)
        try preferences.setMuted(true, context: old)
        let current = try preferences.beginLocalPreview(scope: scope())
        XCTAssertFalse(preferences.state.isMuted)
        XCTAssertEqual(preferences.state.activePack, .givre)
        for mutate in mutations { XCTAssertThrowsError(try mutate(&preferences, old)) }
        try preferences.setCallDuckingActive(true, context: current)
    }
    func testInvalidVolumePreservesStateAndWorkingContext() throws {
        var preferences = SoundPreferencesCoordinator()
        let context = try preferences.beginLocalPreview(scope: scope())
        try preferences.selectPack(.atelier, context: context)
        let expected = preferences.state
        for invalid in [Int.min, -1, 101, Int.max] {
            XCTAssertThrowsError(try preferences.setVolumePercent(invalid, context: context))
            XCTAssertEqual(preferences.state, expected)
        }
        try preferences.setVolumePercent(25, context: context)
        XCTAssertEqual(preferences.state.volumePercent, 25)
    }
    func testClearAndLeaveFenceOldCallbacksAfterSameScopeRejoin() throws {
        for leave in [false, true] {
            var preferences = SoundPreferencesCoordinator()
            let old = try preferences.beginLocalPreview(scope: scope())
            try preferences.setMuted(true, context: old)
            if leave { preferences.leave() } else { preferences.clear() }
            XCTAssertEqual(preferences.state, SoundPreferencesState())
            _ = try preferences.beginLocalPreview(scope: scope())
            let expected = preferences.state
            for mutate in mutations {
                XCTAssertThrowsError(try mutate(&preferences, old))
                XCTAssertEqual(preferences.state, expected)
            }
        }
    }
    func testSwitchAwayAndBackFencesEarlierOrganisationGeneration() throws {
        var preferences = SoundPreferencesCoordinator()
        let old = try preferences.beginLocalPreview(scope: scope())
        try preferences.setCallDuckingActive(true, context: old)
        try preferences.switchOrganisation(to: scope("019a5e62-6ca0-7303-8303-030303030304"))
        XCTAssertEqual(preferences.state.availability, .unprovisioned)
        XCTAssertFalse(preferences.state.isCallDuckingActive)
        try preferences.switchOrganisation(to: scope())
        _ = try preferences.beginLocalPreview(scope: scope())
        for mutate in mutations { XCTAssertThrowsError(try mutate(&preferences, old)) }
    }
    func testStopRemainsTerminalAfterClearAndLeave() throws {
        var preferences = SoundPreferencesCoordinator()
        let old = try preferences.beginLocalPreview(scope: scope())
        try preferences.selectPack(.silent, context: old)
        preferences.stop(); preferences.clear(); preferences.leave()
        XCTAssertNil(preferences.state.scope)
        XCTAssertEqual(preferences.state.availability, .stopped)
        XCTAssertEqual(preferences.state.activePack, .givre)
        for mutate in mutations { XCTAssertThrowsError(try mutate(&preferences, old)) }
        XCTAssertThrowsError(try preferences.configure(scope()))
        XCTAssertThrowsError(try preferences.beginLocalPreview(scope: scope()))
    }
}
