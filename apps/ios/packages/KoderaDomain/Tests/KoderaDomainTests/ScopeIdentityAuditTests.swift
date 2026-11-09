import XCTest
@testable import KoderaDomain

final class ScopeIdentityAuditTests: XCTestCase {
    func testEntityScopesRejectNilWhileTheFormatHelperRetainsItsNarrowContract() throws {
        let nilID = "00000000-0000-0000-0000-000000000000"
        XCTAssertTrue(TrustPolicy.canonicalUUID(nilID))
        XCTAssertFalse(TrustPolicy.canonicalNonNilUUID(nilID))
        XCTAssertThrowsError(try VoiceCallScope(organisationId: nilID, channelId: "voice"))
        XCTAssertThrowsError(try DocsWorkspaceScope(organisationId: nilID, channelId: "text"))
        XCTAssertThrowsError(try ChannelPollScope(organisationId: nilID, channelId: "text"))
        XCTAssertThrowsError(try SoundPreferencesScope(organisationId: nilID))
        XCTAssertTrue(TrustPolicy.canonicalNonNilUUID("11111111-1111-4111-8111-111111111111"))
    }

    func testUUIDFormatAdmissionRefusesLargeAndNoncanonicalInput() {
        for invalid in ["", String(repeating: "x", count: 100_000), String(repeating: "é", count: 36),
                        "11111111-1111-4111-8111-11111111111A", "11111111111141118111111111111111"] {
            XCTAssertFalse(TrustPolicy.canonicalUUID(invalid))
            XCTAssertFalse(TrustPolicy.canonicalNonNilUUID(invalid))
        }
    }

    func testNilChannelAndMediaIdentifiersCannotEnterAReadyLocalSession() throws {
        let nilID = "00000000-0000-0000-0000-000000000000"
        let reference = ChannelReference(organisationId: Fixtures.organisation, channelId: nilID, kind: .text, roomState: .ready)
        XCTAssertThrowsError(try ChannelIdentity.alias(for: reference, descriptor: Fixtures.validatedDescriptor()))
        let media = MediaState(generation: 1, organisationId: nilID, readiness: .ready, adapterAvailable: true)
        XCTAssertEqual(media.phase, .unavailable(.identityRequired))
        let metadata = DiscoverySelection(organisationId: nilID, organisationSlug: "atelier", realm: "atelier",
            issuer: "https://identity.test/realms/atelier", openidConfigurationUrl: "https://identity.test/realms/atelier/.well-known/openid-configuration")
        let trust = DiscoveryTrust(coreApiOrigin: "https://core.test", admittedIssuerOrigins: ["https://identity.test"])
        XCTAssertThrowsError(try TrustPolicy.validateDiscovery(metadata, trust: trust)) {
            XCTAssertEqual($0 as? DomainError, .invalidOrganisation)
        }
    }

    func testChannelMetadataRejectsInvisibleFormatsAndLineSeparators() {
        let org = "11111111-1111-4111-8111-111111111111"
        for channel in ["", " ", "bad\u{200b}", "bad\u{202e}", "bad\u{feff}", "line\u{2028}break", "line\u{2029}break", String(repeating: "é", count: 128)] {
            XCTAssertThrowsError(try VoiceCallScope(organisationId: org, channelId: channel))
            XCTAssertThrowsError(try DocsWorkspaceScope(organisationId: org, channelId: channel))
            XCTAssertThrowsError(try ChannelPollScope(organisationId: org, channelId: channel))
        }
    }
}
