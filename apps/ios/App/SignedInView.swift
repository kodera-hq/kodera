import SwiftUI
import UIKit
import KoderaAuth
import KoderaClient
import KoderaDomain

/// The minimal signed-in screen: who Core says the member is, and a way out.
@MainActor
struct SignedInView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openURL) private var openURL
    @State private var lastAnnouncement: String? = nil
    @ObservedObject var session: AppSessionModel

    private var palette: KoderaTokens.Palette {
        colorScheme == .dark ? KoderaTokens.dark : KoderaTokens.light
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: KoderaTokens.Space.s8) {
                VStack(alignment: .leading, spacing: KoderaTokens.Space.s4) {
                    Text("brand.name")
                        .font(NativeTypography.wordmark)
                        .foregroundStyle(palette.action)
                        .accessibilityAddTraits(.isHeader)
                    Text("session.title")
                        .font(NativeTypography.title)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                }
                memberCard
                Button(role: .destructive, action: session.signOut) {
                    Text("session.sign_out")
                        .font(NativeTypography.emphasis)
                        .foregroundStyle(palette.ink)
                        .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.bordered)
                .accessibilityLabel(Text("session.sign_out"))
                .accessibilityHint(Text("session.sign_out_hint"))
                EmergencyCheckInCard(organisationId: soundScope?.organisationId)
                workspaceSection
                VoiceCallDockCard(scope: voiceScope)
                DocsWorkspaceCard(scope: docsScope)
                SoundPreferencesCard(scope: soundScope)
                ChannelPollCard(scope: pollScope)
                WorkspacePreferencesCard(scope: preferencesScope)
            }
            .font(NativeTypography.body)
            .foregroundStyle(palette.ink)
            .frame(maxWidth: KoderaTokens.Space.shellDocumentMinWidth)
            .padding(.horizontal, KoderaTokens.Space.s6)
            .padding(.vertical, KoderaTokens.Space.s8)
            .frame(maxWidth: .infinity)
        }
        .background(palette.page.ignoresSafeArea())
        .tint(palette.action)
        .onAppear { announceStatus() }
        .onChange(of: announcementKey) { _ in announceStatus() }
    }

    /// Current authenticated workspace metadata supplies context, never live-media authority.
    private var voiceScope: VoiceCallScope? {
        guard case .signedIn = session.phase, case .loaded = session.member,
              case let .loaded(snapshot) = session.workspace else { return nil }
        let channels = snapshot.categories.flatMap(\.channels) + snapshot.uncategorisedChannels
        guard let channel = channels.first(where: { $0.kind == .audio && $0.lifecycle == .active }) else { return nil }
        return try? VoiceCallScope(organisationId: snapshot.organisationId, channelId: channel.id)
    }

    /// Current workspace context is not a provisioned Docs session or document-access grant.
    private var docsScope: DocsWorkspaceScope? {
        guard case .signedIn = session.phase, case .loaded = session.member,
              case let .loaded(snapshot) = session.workspace else { return nil }
        let channels = snapshot.categories.flatMap(\.channels) + snapshot.uncategorisedChannels
        guard let channel = channels.first(where: { $0.kind == .text && $0.lifecycle == .active }) else { return nil }
        return try? DocsWorkspaceScope(organisationId: snapshot.organisationId, channelId: channel.id)
    }

    /// Current workspace metadata supplies local preference scope, never audio-hardware authority.
    private var soundScope: SoundPreferencesScope? {
        guard case .signedIn = session.phase, case .loaded = session.member,
              case let .loaded(snapshot) = session.workspace else { return nil }
        return try? SoundPreferencesScope(organisationId: snapshot.organisationId)
    }

    /// Active text-channel metadata supplies local context, not remote voting authority.
    private var pollScope: ChannelPollScope? {
        guard case .signedIn = session.phase, case .loaded = session.member,
              case let .loaded(snapshot) = session.workspace else { return nil }
        let channels = snapshot.categories.flatMap(\.channels) + snapshot.uncategorisedChannels
        guard let channel = channels.first(where: { $0.kind == .text && $0.lifecycle == .active }) else { return nil }
        return try? ChannelPollScope(organisationId: snapshot.organisationId, channelId: channel.id)
    }

    private var preferencesScope: WorkspacePreferencesScope? {
        guard let scope = pollScope else { return nil }
        return try? WorkspacePreferencesScope(organisationId: scope.organisationId, channelId: scope.channelId)
    }

    @ViewBuilder
    private var memberCard: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s4) {
            switch session.member {
            case .loading:
                ProgressView().accessibilityHidden(true)
                Text("session.loading").font(NativeTypography.body)
            case let .loaded(name, organisation):
                VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
                    Text("session.member")
                        .font(NativeTypography.caption)
                        .foregroundStyle(palette.ink3)
                    Text(verbatim: name).font(NativeTypography.heading)
                }
                .accessibilityElement(children: .combine)
                if let organisation {
                    VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
                        Text("session.organisation")
                            .font(NativeTypography.caption)
                            .foregroundStyle(palette.ink3)
                        Text(verbatim: organisation).font(NativeTypography.emphasis)
                    }
                    .accessibilityElement(children: .combine)
                }
            case .unavailable(.coreUnavailable):
                Label("session.core_unavailable", systemImage: "exclamationmark.triangle")
                    .font(NativeTypography.body)
                    .foregroundStyle(palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
                Button(action: session.reloadMember) {
                    // accentInk, not the action tint: action on surface is under 4.5:1 in the dark palettes.
                    Text("session.retry")
                        .font(NativeTypography.emphasis)
                        .foregroundStyle(palette.accentInk)
                        .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.bordered)
                .accessibilityLabel(Text("session.retry"))
            case .unavailable(.noOrganisationYet):
                // A 403 is an answer, not an outage, and never a dead end: the Console, when this build names one,
                // Check again, and sign-out below. An owner's claim is finished in the Console, never in the app;
                // that changes Core's answer, so returning to the foreground checks again too (see `body`).
                Label("session.no_organisation", systemImage: "person.crop.circle.badge.questionmark")
                    .font(NativeTypography.body)
                    .foregroundStyle(palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
                if let console = session.configuration.consoleOrigin {
                    Button { openURL(console) } label: {
                        // accentInk, not the action tint: action on surface is under 4.5:1 in the dark palettes.
                        Text("session.open_console")
                            .font(NativeTypography.emphasis)
                            .foregroundStyle(palette.accentInk)
                            .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel(Text("session.open_console"))
                    .accessibilityHint(Text("session.open_console_hint"))
                }
                Button(action: session.checkMemberAgain) {
                    // accentInk, not the action tint: action on surface is under 4.5:1 in the dark palettes.
                    Text("session.check_again")
                        .font(NativeTypography.emphasis)
                        .foregroundStyle(palette.accentInk)
                        .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.bordered)
                .accessibilityLabel(Text("session.check_again"))
                .accessibilityHint(Text("session.check_again_hint"))
            }
        }
        .padding(KoderaTokens.Space.s5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.lg))
    }

    private var workspaceStatusKey: String? {
        switch session.workspace {
        case .hidden: nil
        case .loading: "workspace.loading"
        case .targetUnavailable: "workspace.unavailable"
        case .loaded: "workspace.updated"
        case let .unavailable(failure):
            switch failure {
            case .forbidden, .notFound: "workspace.unavailable"
            case .protocolViolation: "workspace.invalid_response"
            case .serviceUnavailable, .identityUnavailable: "workspace.service_unavailable"
            case .transport: "workspace.connection_unavailable"
            }
        }
    }
    private var announcementKey: String? {
        switch session.member {
        case .loading: "session.loading"
        case .unavailable(.coreUnavailable): "session.core_unavailable"
        case .unavailable(.noOrganisationYet): "session.no_organisation"
        case .loaded: workspaceStatusKey
        }
    }
    /// The sole automatic status source: no list/spinner announcement or focus movement.
    private func announceStatus() {
        guard case .signedIn = session.phase, let key = announcementKey else { lastAnnouncement = nil; return }
        guard key != lastAnnouncement else { return }
        lastAnnouncement = key
        UIAccessibility.post(notification: .announcement, argument: NSLocalizedString(key, comment: ""))
    }

    private var workspaceSection: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s4) {
            Text("workspace.title").font(NativeTypography.heading).accessibilityAddTraits(.isHeader)
            Text("workspace.readonly_hint").font(NativeTypography.caption).foregroundStyle(palette.ink2)
            if session.workspace == .loading { ProgressView().accessibilityHidden(true) }
            if let key = workspaceStatusKey {
                Text(LocalizedStringKey(key)).foregroundStyle(palette.ink2)
            }
            // Stable identity through /me and workspace progress; never replaced by the spinner/list.
            Button(action: session.retryChannels) {
                Text("session.retry").font(NativeTypography.emphasis).foregroundStyle(palette.accentInk)
                    .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12).contentShape(Rectangle())
            }
            .buttonStyle(.bordered)
            .disabled(!session.canRetryChannels)
            .accessibilityHint(Text("workspace.retry_hint"))
            Text("workspace.retry_hint").font(NativeTypography.caption).foregroundStyle(palette.ink3)
            if case let .loaded(snapshot) = session.workspace {
                switch snapshot.setup.state {
                case .pending: Text("workspace.setup_pending")
                case .running: Text("workspace.setup_running")
                case .failed: Text("workspace.setup_failed")
                case .ready: EmptyView()
                }
                if snapshot.state == .notInitialised {
                    Text("workspace.not_initialised")
                } else {
                    if snapshot.categories.allSatisfy({ $0.channels.isEmpty }) && snapshot.uncategorisedChannels.isEmpty {
                        Text("workspace.empty")
                    }
                    ForEach(snapshot.categories, id: \.id) { category in
                        Text(verbatim: category.name).font(NativeTypography.emphasis).accessibilityAddTraits(.isHeader)
                        ForEach(category.channels, id: \.id) { channel in channelMetadata(channel) }
                    }
                    if !snapshot.uncategorisedChannels.isEmpty {
                        Text("workspace.uncategorised").font(NativeTypography.emphasis).accessibilityAddTraits(.isHeader)
                        ForEach(snapshot.uncategorisedChannels, id: \.id) { channel in channelMetadata(channel) }
                    }
                }
            }
        }
        .padding(KoderaTokens.Space.s5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.lg))
    }

    private func channelMetadata(_ channel: WorkspaceChannel) -> some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
            Text(verbatim: channel.name).font(NativeTypography.body)
            Text(LocalizedStringKey(channel.kind == .text ? "workspace.channel_text" : "workspace.channel_audio"))
                .font(NativeTypography.caption).foregroundStyle(palette.ink2)
            Text(LocalizedStringKey(roomKey(channel.roomState))).font(NativeTypography.caption).foregroundStyle(palette.ink2)
            if channel.lifecycle == .archived { Text("workspace.channel_archived").font(NativeTypography.caption).foregroundStyle(palette.ink3) }
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }
    private func roomKey(_ state: WorkspaceChannelRoomState) -> String {
        switch state {
        case .pending: "workspace.room_pending"
        case .ready: "workspace.room_ready"
        case .failed: "workspace.room_failed"
        }
    }
}
