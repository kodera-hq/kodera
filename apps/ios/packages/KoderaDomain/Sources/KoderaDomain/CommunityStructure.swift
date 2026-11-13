import Foundation

public enum CommunityAudience: String, CaseIterable, Equatable, Sendable {
    case publicOpen = "audiencePublic"
    case coreTeam = "audienceCore"
    case federatedPartners = "audiencePartners"
}

public enum CommunityCategoryId: String, CaseIterable, Equatable, Sendable {
    case community = "community"
    case coreKodera = "core-kodera"
    case designPartners = "design-partners"
}

public enum CommunityChannelKind: String, Equatable, Sendable {
    case text
    case audio
}

public enum CommunityChannelTopic: String, CaseIterable, Equatable, Sendable {
    case releases
    case developers
    case support
    case extensions
    case selfHost
    case showTell
    case office
    case engineering
    case strategy
    case operations
    case partnerOnboarding
    case partnerFeedback
}

/// Canonical channel definition aligned with Web's `communityStructure.ts`.
/// Local blueprint metadata never grants live Matrix room access on its own.
public struct CommunityChannelBlueprint: Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let kind: CommunityChannelKind
    public let topic: CommunityChannelTopic
    public let categoryId: CommunityCategoryId
    public var isVoice: Bool { kind == .audio }
    public var isFederatedPartnerRoom: Bool { categoryId == .designPartners }

    public init(
        id: String,
        name: String,
        kind: CommunityChannelKind,
        topic: CommunityChannelTopic,
        categoryId: CommunityCategoryId
    ) {
        self.id = id
        self.name = name
        self.kind = kind
        self.topic = topic
        self.categoryId = categoryId
    }
}

/// Canonical category definition for the 3-category `community.kodera.io` workspace structure.
public struct CommunityCategoryBlueprint: Equatable, Identifiable, Sendable {
    public let categoryId: CommunityCategoryId
    public var id: String { categoryId.rawValue }
    public let name: String
    public let audience: CommunityAudience
    public let showsFederatedPartnerBadge: Bool
    public let channels: [CommunityChannelBlueprint]

    public init(
        categoryId: CommunityCategoryId,
        name: String,
        audience: CommunityAudience,
        showsFederatedPartnerBadge: Bool,
        channels: [CommunityChannelBlueprint]
    ) {
        self.categoryId = categoryId
        self.name = name
        self.audience = audience
        self.showsFederatedPartnerBadge = showsFederatedPartnerBadge
        self.channels = channels
    }
}

public enum CommunityWorkspaceBlueprint {
    public static let canonicalSlug = "community"
    public static let canonicalDomain = "community.kodera.io"

    public static let categories: [CommunityCategoryBlueprint] = [
        CommunityCategoryBlueprint(
            categoryId: .community,
            name: "Community",
            audience: .publicOpen,
            showsFederatedPartnerBadge: false,
            channels: [
                CommunityChannelBlueprint(id: "announcements", name: "announcements", kind: .text, topic: .releases, categoryId: .community),
                CommunityChannelBlueprint(id: "developers-community", name: "developers-community", kind: .text, topic: .developers, categoryId: .community),
                CommunityChannelBlueprint(id: "support", name: "support", kind: .text, topic: .support, categoryId: .community),
                CommunityChannelBlueprint(id: "extensions", name: "extensions", kind: .text, topic: .extensions, categoryId: .community),
                CommunityChannelBlueprint(id: "self-hosting", name: "self-hosting", kind: .text, topic: .selfHost, categoryId: .community),
                CommunityChannelBlueprint(id: "show-and-tell", name: "show-and-tell", kind: .text, topic: .showTell, categoryId: .community),
                CommunityChannelBlueprint(id: "office-hours", name: "office-hours", kind: .audio, topic: .office, categoryId: .community),
            ]
        ),
        CommunityCategoryBlueprint(
            categoryId: .coreKodera,
            name: "Core Kodera",
            audience: .coreTeam,
            showsFederatedPartnerBadge: false,
            channels: [
                CommunityChannelBlueprint(id: "dev", name: "dev", kind: .text, topic: .engineering, categoryId: .coreKodera),
                CommunityChannelBlueprint(id: "strategy", name: "strategy", kind: .text, topic: .strategy, categoryId: .coreKodera),
                CommunityChannelBlueprint(id: "ops-oncall", name: "ops-oncall", kind: .text, topic: .operations, categoryId: .coreKodera),
            ]
        ),
        CommunityCategoryBlueprint(
            categoryId: .designPartners,
            name: "Design Partners",
            audience: .federatedPartners,
            showsFederatedPartnerBadge: true,
            channels: [
                CommunityChannelBlueprint(id: "partner-onboarding", name: "partner-onboarding", kind: .text, topic: .partnerOnboarding, categoryId: .designPartners),
                CommunityChannelBlueprint(id: "partner-feedback", name: "partner-feedback", kind: .text, topic: .partnerFeedback, categoryId: .designPartners),
            ]
        ),
    ]

    public static let channels: [CommunityChannelBlueprint] = categories.flatMap(\.channels)

    public static func matchCategory(id: String? = nil, name: String, templateKey: String? = nil) -> CommunityCategoryBlueprint? {
        if let id, let matched = categories.first(where: { $0.id == normalizeIdentifier(id) }) {
            return matched
        }
        if let templateKey, let matched = categories.first(where: { $0.id == normalizeIdentifier(templateKey) }) {
            return matched
        }
        let normalizedName = normalizeIdentifier(name)
        return categories.first { $0.id == normalizedName || normalizeIdentifier($0.name) == normalizedName }
    }

    public static func matchChannel(name: String) -> CommunityChannelBlueprint? {
        let normalized = normalizeIdentifier(name)
        return channels.first { $0.id == normalized }
    }

    private static func normalizeIdentifier(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "_", with: "-")
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: "-")
    }
}
