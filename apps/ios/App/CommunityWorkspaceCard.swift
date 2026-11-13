import SwiftUI
import KoderaClient
import KoderaDomain

/// Maps canonical community categories and topics to localized catalogue keys.
enum CommunityCategoryPresentation {
    static func audienceKey(for audience: CommunityAudience) -> String {
        switch audience {
        case .publicOpen: "community.audience_public"
        case .coreTeam: "community.audience_core"
        case .federatedPartners: "community.audience_partners"
        }
    }

    static func topicKey(for topic: CommunityChannelTopic) -> String {
        switch topic {
        case .releases: "community.topic_releases"
        case .developers: "community.topic_developers"
        case .support: "community.topic_support"
        case .extensions: "community.topic_extensions"
        case .selfHost: "community.topic_self_host"
        case .showTell: "community.topic_show_tell"
        case .office: "community.topic_office"
        case .engineering: "community.topic_engineering"
        case .strategy: "community.topic_strategy"
        case .operations: "community.topic_operations"
        case .partnerOnboarding: "community.topic_partner_onboarding"
        case .partnerFeedback: "community.topic_partner_feedback"
        }
    }

    static func makeInviteScope(
        organisationId: String?,
        channelId: String,
        channelName: String,
        serverHost: String = CommunityWorkspaceBlueprint.canonicalDomain
    ) -> ChannelInviteScope? {
        guard let organisationId,
              let server = try? MatrixServerName(serverHost) else {
            return nil
        }
        return try? ChannelInviteScope(
            organisationId: organisationId,
            channelId: channelId,
            channelName: channelName,
            serverName: server
        )
    }
}

/// Renders the canonical 3-category community structure (`Community`, `Core Kodera`, `Design Partners`)
/// with localized audience subtitles, federated partner badges, and universal Matrix invite sheets.
@MainActor
struct CommunityWorkspaceCard: View {
    let organisationId: String?

    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var inviteCoordinator = ChannelInviteCoordinator()
    @State private var activeInviteScope: ChannelInviteScope?
    @State private var activeInviteContext: ChannelInviteContext?
    @State private var isPresentingInvite = false

    private var palette: KoderaTokens.Palette {
        KoderaTokens.cielPalette(for: colorScheme)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s5) {
            VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
                Text("community.title")
                    .font(NativeTypography.heading)
                    .accessibilityAddTraits(.isHeader)
                Text(verbatim: CommunityWorkspaceBlueprint.canonicalDomain)
                    .font(NativeTypography.monoCaption)
                    .foregroundStyle(palette.accentInk)
                Text("community.subtitle")
                    .font(NativeTypography.caption)
                    .foregroundStyle(palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            ForEach(CommunityWorkspaceBlueprint.categories) { category in
                categorySection(category)
            }
        }
        .foregroundStyle(palette.ink)
        .padding(KoderaTokens.Space.s5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.lg))
        .sheet(isPresented: $isPresentingInvite, onDismiss: closeInviteSheet) {
            if let activeInviteScope {
                ChannelInviteSheet(
                    scope: activeInviteScope,
                    coordinator: inviteCoordinator,
                    context: activeInviteContext,
                    onDismiss: { isPresentingInvite = false }
                )
            }
        }
        .onChange(of: organisationId) { _ in
            isPresentingInvite = false
            closeInviteSheet()
        }
        .onDisappear {
            isPresentingInvite = false
            closeInviteSheet()
        }
    }

    private func categorySection(_ category: CommunityCategoryBlueprint) -> some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s3) {
            HStack(alignment: .firstTextBaseline, spacing: KoderaTokens.Space.s2) {
                Text(verbatim: category.name)
                    .font(NativeTypography.emphasis)
                    .accessibilityAddTraits(.isHeader)
                if category.showsFederatedPartnerBadge {
                    federatedPartnerBadge
                }
            }
            Text(LocalizedStringKey(CommunityCategoryPresentation.audienceKey(for: category.audience)))
                .font(NativeTypography.caption)
                .foregroundStyle(palette.ink3)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
                ForEach(category.channels) { channel in
                    channelRow(channel)
                }
            }
        }
        .padding(KoderaTokens.Space.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.sunken, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.md))
    }

    private func channelRow(_ channel: CommunityChannelBlueprint) -> some View {
        let scope = CommunityCategoryPresentation.makeInviteScope(
            organisationId: organisationId,
            channelId: channel.id,
            channelName: channel.name
        )
        return VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
            HStack(alignment: .center, spacing: KoderaTokens.Space.s2) {
                Label {
                    Text(verbatim: channel.name)
                        .font(NativeTypography.emphasis)
                } icon: {
                    Image(systemName: channel.isVoice ? "speaker.wave.2" : "number")
                        .foregroundStyle(palette.ink2)
                }
                if channel.isFederatedPartnerRoom {
                    federatedPartnerBadge
                }
                Spacer(minLength: KoderaTokens.Space.s2)
                if let scope {
                    Button {
                        presentInviteSheet(scope: scope)
                    } label: {
                        Label("invite.open_button", systemImage: "person.badge.plus")
                            .font(NativeTypography.caption)
                            .foregroundStyle(palette.accentInk)
                    }
                    .buttonStyle(.bordered)
                }
            }
            Text(LocalizedStringKey(CommunityCategoryPresentation.topicKey(for: channel.topic)))
                .font(NativeTypography.caption)
                .foregroundStyle(palette.ink2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, KoderaTokens.Space.s1)
    }

    private var federatedPartnerBadge: some View {
        Text("community.federated_badge")
            .font(NativeTypography.caption)
            .foregroundStyle(palette.tag1Fg)
            .padding(.horizontal, KoderaTokens.Space.s2)
            .padding(.vertical, KoderaTokens.Space.s1)
            .background(palette.tag1Bg, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.full))
    }

    private func presentInviteSheet(scope: ChannelInviteScope) {
        guard let context = try? inviteCoordinator.openSheet(scope: scope) else { return }
        activeInviteScope = scope
        activeInviteContext = context
        isPresentingInvite = true
    }

    private func closeInviteSheet() {
        inviteCoordinator.dismissSheet(context: activeInviteContext)
        activeInviteContext = nil
        activeInviteScope = nil
    }
}
