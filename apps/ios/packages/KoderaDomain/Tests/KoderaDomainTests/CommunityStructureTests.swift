import XCTest
@testable import KoderaDomain

final class CommunityStructureTests: XCTestCase {
    func testCanonicalThreeCategoryBlueprintMatchesCommunityWorkspaceModel() {
        let categories = CommunityWorkspaceBlueprint.categories
        XCTAssertEqual(categories.map(\.id), ["community", "core-kodera", "design-partners"])
        XCTAssertEqual(categories.map(\.name), ["Community", "Core Kodera", "Design Partners"])
        XCTAssertEqual(
            categories.map(\.audience),
            [.publicOpen, .coreTeam, .federatedPartners]
        )
        XCTAssertEqual(
            categories.map(\.showsFederatedPartnerBadge),
            [false, false, true]
        )

        XCTAssertEqual(
            categories[0].channels.map(\.name),
            [
                "announcements",
                "developers-community",
                "support",
                "extensions",
                "self-hosting",
                "show-and-tell",
                "office-hours",
            ]
        )
        XCTAssertEqual(
            categories[0].channels.filter(\.isVoice).map(\.name),
            ["office-hours"]
        )
        XCTAssertEqual(
            categories[1].channels.map(\.name),
            ["dev", "strategy", "ops-oncall"]
        )
        XCTAssertEqual(
            categories[2].channels.map(\.name),
            ["partner-onboarding", "partner-feedback"]
        )
        XCTAssertTrue(categories[2].channels.allSatisfy(\.isFederatedPartnerRoom))
        XCTAssertFalse(categories[0].channels.contains(where: \.isFederatedPartnerRoom))
        XCTAssertEqual(CommunityWorkspaceBlueprint.channels.count, 12)
        XCTAssertEqual(CommunityWorkspaceBlueprint.canonicalDomain, "community.kodera.io")
    }

    func testCategoryAndChannelMatchingHandlesNormalizedWorkspaceMetadata() {
        XCTAssertEqual(
            CommunityWorkspaceBlueprint.matchCategory(name: "Design Partners")?.categoryId,
            .designPartners
        )
        XCTAssertEqual(
            CommunityWorkspaceBlueprint.matchCategory(name: "core_kodera")?.categoryId,
            .coreKodera
        )
        XCTAssertEqual(
            CommunityWorkspaceBlueprint.matchCategory(name: "Custom", templateKey: "design_partners")?.categoryId,
            .designPartners
        )
        XCTAssertNil(CommunityWorkspaceBlueprint.matchCategory(name: "Unrelated Section"))

        let onboarding = CommunityWorkspaceBlueprint.matchChannel(name: "partner-onboarding")
        XCTAssertEqual(onboarding?.topic, .partnerOnboarding)
        XCTAssertEqual(onboarding?.isFederatedPartnerRoom, true)
    }
}
