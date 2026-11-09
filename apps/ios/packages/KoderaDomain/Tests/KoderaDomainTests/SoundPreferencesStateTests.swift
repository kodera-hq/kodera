import Foundation
import XCTest
@testable import KoderaDomain

final class SoundPreferencesStateTests: XCTestCase {
    private let org = "019a5e62-6ca0-7303-8303-030303030303"
    private func scope() throws -> SoundPreferencesScope { try SoundPreferencesScope(organisationId: org) }
    private func preview() throws -> SoundPreferencesState {
        var state = SoundPreferencesState()
        try state.beginLocalPreview(scope: scope())
        return state
    }
    func testAllCanonicalPacksRoundTripAndLegacyOrMalformedSlugsAreRefused() throws {
        let expected = ["givre", "cristal", "atelier", "8bit", "404", "silent"]
        XCTAssertEqual(SoundPackId.allCases.map(\.rawValue), expected)
        for pack in SoundPackId.allCases {
            XCTAssertEqual(try SoundPackId.parse(pack.rawValue), pack)
            XCTAssertEqual(pack.isSilent, pack == .silent)
        }
        for invalid in ["", "Givre", "givre ", " silent", "givre\n", "kodera-givre", "feutre", "impulsion", "8bit-atelier", "silencieux"] {
            XCTAssertThrowsError(try SoundPackId.parse(invalid))
            XCTAssertNil(SoundPackId(rawValue: invalid))
        }
    }
    func testScopeRequiresCanonicalOrganisationUUID() throws {
        XCTAssertEqual(try scope().organisationId, org)
        for invalid in ["", "org", org.uppercased(), " " + org, org + "\n"] {
            XCTAssertThrowsError(try SoundPreferencesScope(organisationId: invalid))
        }
    }
    func testUnprovisionedDefaultsDoNotPermitPreferenceMutationOrClaimHardware() throws {
        var state = SoundPreferencesState()
        try state.configure(scope())
        let expected = state
        XCTAssertEqual(state.activePack, .givre)
        XCTAssertEqual(state.volumePercent, 80)
        XCTAssertFalse(state.isMuted || state.isCallDuckingActive || state.isAudioHardwareActive)
        XCTAssertEqual(state.effectiveGainPercent, 80)
        XCTAssertEqual(state.activeDuckingDecibels, 0)
        XCTAssertThrowsError(try state.selectPack(.silent))
        XCTAssertThrowsError(try state.setVolumePercent(0))
        XCTAssertThrowsError(try state.setMuted(true))
        XCTAssertThrowsError(try state.setCallDuckingActive(true))
        XCTAssertEqual(state, expected)
    }
    func testMuteAndDuckingPolicyAcrossEveryPackAndVolume() throws {
        for pack in SoundPackId.allCases {
            for volume in 0...100 {
                for manual in [false, true] {
                    for duck in [false, true] {
                        var state = try preview()
                        try state.selectPack(pack)
                        try state.setVolumePercent(volume)
                        try state.setMuted(manual)
                        try state.setCallDuckingActive(duck)
                        let muted = manual || pack.isSilent || volume == 0
                        XCTAssertEqual(state.isMuted, muted)
                        XCTAssertEqual(state.isManuallyMuted, manual)
                        XCTAssertEqual(state.isCallDuckingActive, duck)
                        XCTAssertEqual(state.activeDuckingDecibels, duck && !muted ? -6 : 0)
                        let expectedGain = muted ? 0 : Int((Double(volume) * (duck ? pow(10, -6.0 / 20) : 1)).rounded())
                        XCTAssertEqual(state.effectiveGainPercent, expectedGain)
                        XCTAssertFalse(state.isAudioHardwareActive)
                    }
                }
            }
        }
    }
    func testSelectingNonSilentAtZeroRestoresVolumeWithoutClearingManualMute() throws {
        var state = try preview()
        try state.setMuted(true)
        try state.setVolumePercent(0)
        try state.selectPack(.silent)
        XCTAssertEqual(state.volumePercent, 0)
        try state.selectPack(.atelier)
        XCTAssertEqual(state.volumePercent, 80)
        XCTAssertTrue(state.isManuallyMuted && state.isMuted)
        try state.setMuted(false)
        XCTAssertFalse(state.isMuted)
        try state.selectPack(.silent)
        try state.setMuted(false)
        XCTAssertTrue(state.isMuted)
        try state.selectPack(.cristal)
        try state.setVolumePercent(0)
        try state.setMuted(false)
        XCTAssertTrue(state.isMuted)
    }
    func testOutOfRangeVolumeIsTransactionalAndExtremeIntegersDoNotOverflow() throws {
        var state = try preview()
        try state.selectPack(.glitch404)
        try state.setCallDuckingActive(true)
        let expected = state
        for invalid in [Int.min, -1, 101, Int.max] {
            XCTAssertThrowsError(try state.setVolumePercent(invalid))
            XCTAssertEqual(state, expected)
        }
        try state.setVolumePercent(1)
        XCTAssertEqual(state.effectiveGainPercent, 1)
        try state.setVolumePercent(100)
        XCTAssertEqual(state.effectiveGainPercent, 50)
    }
    func testClearLeaveAndScopeReplacementEraseAllPreferences() throws {
        for leave in [false, true] {
            var state = try preview()
            try state.selectPack(.silent)
            try state.setVolumePercent(0)
            try state.setMuted(true)
            try state.setCallDuckingActive(true)
            if leave { state.leave() } else { state.clear() }
            XCTAssertEqual(state, SoundPreferencesState())
        }
        var state = try preview()
        try state.selectPack(.silent)
        let next = try SoundPreferencesScope(organisationId: "019a5e62-6ca0-7303-8303-030303030304")
        try state.configure(next)
        XCTAssertEqual(state.scope, next)
        XCTAssertEqual(state.availability, .unprovisioned)
        XCTAssertEqual(state.activePack, .givre)
        XCTAssertEqual(state.volumePercent, 80)
        XCTAssertFalse(state.isMuted || state.isCallDuckingActive)
    }
    func testStopIsTerminalAndClearsScopeAndPreferences() throws {
        var state = try preview()
        try state.selectPack(.silent)
        try state.setMuted(true)
        try state.setCallDuckingActive(true)
        state.stop(); state.clear(); state.leave()
        XCTAssertEqual(state.availability, .stopped)
        XCTAssertNil(state.scope)
        XCTAssertEqual(state.activePack, .givre)
        XCTAssertEqual(state.volumePercent, 80)
        XCTAssertFalse(state.isMuted || state.isCallDuckingActive || state.isAudioHardwareActive)
        XCTAssertThrowsError(try state.configure(scope()))
        XCTAssertThrowsError(try state.beginLocalPreview(scope: scope()))
    }
}
