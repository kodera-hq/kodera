import SwiftUI
import CoreGraphics
import KoderaClient
import KoderaDomain

/// Explicit volatile drafts. No selected role, palette or Markdown is sent to a service.
@MainActor
struct WorkspacePreferencesCard: View {
    let scope: WorkspacePreferencesScope?
    @StateObject private var controller = WorkspacePreferencesController()
    @State private var context: WorkspacePreferencesContext?
    @State private var importCode = ""
    @State private var displayName = ""
    @State private var handle = ""
    @State private var roleTitle = ""
    @State private var presence = KoderaPresenceStatus.offline
    @State private var rank = KoderaRoleRank.guest
    @State private var docTitle = ""
    @State private var markdown = ""
    private var preview: Bool { controller.previewMatches(context, scope: scope) }
    private var palette: KoderaTokens.Palette { controller.themeMode == .light ? KoderaTokens.light : KoderaTokens.dark }
    var body: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s5) {
            HStack(spacing: KoderaTokens.Space.s3) {
                // The requested monogram invariant is pure black in every appearance.
                KoderaMonogram().fill(KoderaTokens.light.surface).padding(KoderaTokens.Space.s3)
                    .frame(width: KoderaTokens.Space.s12, height: KoderaTokens.Space.s12)
                    .background(Color.black, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.sm))
                    .accessibilityHidden(true)
                Text("preferences.title").font(NativeTypography.heading).accessibilityAddTraits(.isHeader)
            }
            Text("preferences.disclosure").font(NativeTypography.caption).foregroundStyle(palette.ink2)
            if preview {
                themeSection
                profileSection
                docsSection
                if controller.lastError != nil { Text("preferences.invalid").font(NativeTypography.caption).foregroundStyle(palette.ink2) }
                Button("preferences.leave") { reset() }.buttonStyle(.bordered)
            } else {
                Text("preferences.unavailable").font(NativeTypography.body)
                Button("preferences.begin") { beginPreview() }.buttonStyle(.bordered).disabled(scope == nil)
            }
        }
        .foregroundStyle(palette.ink).padding(KoderaTokens.Space.s5).frame(maxWidth: .infinity, alignment: .leading)
        .background(controller.themeMode == .black ? Color.black : palette.surface,
                    in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.lg))
        .environment(\.colorScheme, controller.themeMode == .light ? .light : .dark)
        .onChange(of: scope) { _ in reset() }.onDisappear { reset() }
    }
    private var themeSection: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s3) {
            Text("preferences.theme").font(NativeTypography.emphasis).accessibilityAddTraits(.isHeader)
            ForEach(KoderaThemeMode.allCases, id: \.rawValue) { mode in
                Button { try? controller.selectThemeMode(mode, context: context) } label: {
                    Text(LocalizedStringKey(mode.preferenceKey)).font(NativeTypography.body)
                        .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12, alignment: .leading)
                }.buttonStyle(.bordered).accessibilityAddTraits(controller.themeMode == mode ? .isSelected : [])
            }
            ForEach(ShareableThemeCodec.curatedPresets, id: \.id) { preset in
                Button { try? controller.applyPreset(id: preset.id, context: context) } label: {
                    Text(LocalizedStringKey(preset.preferenceKey)).font(NativeTypography.body)
                }.buttonStyle(.bordered).accessibilityAddTraits(controller.activeThemeSpec.id == preset.id ? .isSelected : [])
            }
            palettePreview
            Text("preferences.palette_disclosure").font(NativeTypography.caption)
            Text("preferences.share").font(NativeTypography.caption)
            Text(verbatim: controller.shareCode).font(NativeTypography.caption).textSelection(.enabled)
                .lineLimit(4).accessibilityLabel(Text("preferences.share"))
            TextField("preferences.import", text: $importCode).textInputAutocapitalization(.never).autocorrectionDisabled()
                .byteBound($importCode, ShareableThemeCodec.maxCodeBytes)
            Button("preferences.apply_import") { try? controller.importShareCode(importCode, context: context) }.buttonStyle(.bordered)
        }
    }
    private var palettePreview: some View {
        let tokens = controller.activeThemeSpec.tokens
        return VStack(alignment: .leading, spacing: KoderaTokens.Space.s3) {
            Text("preferences.palette_sample").font(NativeTypography.emphasis)
            Text(verbatim: controller.activeThemeSpec.name).font(NativeTypography.body)
            HStack(spacing: KoderaTokens.Space.s3) {
                Text("preferences.palette_surface").padding(KoderaTokens.Space.s3).background(previewColor(tokens.surfaceRGB))
                Text("preferences.palette_action").padding(KoderaTokens.Space.s3).background(previewColor(tokens.actionRGB))
            }.padding(KoderaTokens.Space.s3).background(previewColor(tokens.sunkenRGB))
        }
        .foregroundStyle(previewColor(tokens.inkRGB)).padding(KoderaTokens.Space.s4).frame(maxWidth: .infinity, alignment: .leading)
        .background(previewColor(tokens.pageRGB), in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.sm))
        .accessibilityElement(children: .combine)
    }
    /// Components come exclusively from immutable validated share tokens, never a UI palette literal.
    private func previewColor(_ rgb: ThemeRGB) -> Color {
        let components = [CGFloat(rgb.red) / 255, CGFloat(rgb.green) / 255, CGFloat(rgb.blue) / 255, CGFloat(1)]
        guard let value = CGColor(colorSpace: CGColorSpaceCreateDeviceRGB(), components: components) else { return palette.surface }
        return Color(cgColor: value)
    }
    private var profileSection: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s3) {
            Text("preferences.profile").font(NativeTypography.emphasis).accessibilityAddTraits(.isHeader)
            TextField("preferences.display_name", text: $displayName).byteBound($displayName, 64)
            TextField("preferences.handle", text: $handle).textInputAutocapitalization(.never).autocorrectionDisabled()
                .byteBound($handle, 32)
            TextField("preferences.role_title", text: $roleTitle).byteBound($roleTitle, 64)
            Picker("preferences.presence", selection: $presence) {
                ForEach(KoderaPresenceStatus.allCases, id: \.rawValue) { value in Text(LocalizedStringKey(value.preferenceKey)).tag(value) }
            }
            Picker("preferences.rank", selection: $rank) {
                ForEach(KoderaRoleRank.allCases, id: \.rawValue) { value in Text(LocalizedStringKey(value.preferenceKey)).tag(value) }
            }
            Button("preferences.save_profile") {
                try? controller.updateProfile(displayName: displayName, handle: handle, roleTitle: roleTitle,
                                               presence: presence, rank: rank, context: context)
            }.buttonStyle(.bordered)
            if let profile = controller.profile {
                Text(verbatim: "@" + profile.handle).font(NativeTypography.body)
                Text(String(format: NSLocalizedString("preferences.saved_rank", comment: ""), profile.rank.rawValue)).font(NativeTypography.caption)
            }
            permissionSummary
        }
    }
    @ViewBuilder private var permissionSummary: some View {
        if let scope, let policy = try? ChannelIamPolicy(channelId: scope.channelId, categoryId: "local-preview", isVoice: false,
            minReadRank: .member, minWriteRank: .member, minManageRank: .admin, allowPolls: true, allowConnectors: true) {
            let decision = controller.evaluateAccess(for: policy, context: context)
            Text("preferences.policy_preview").font(NativeTypography.caption)
            permission("preferences.read", decision.canRead)
            permission("preferences.write", decision.canWrite)
            permission("preferences.poll", decision.canCreatePoll)
            permission("preferences.manage", decision.canManage)
        }
    }
    private func permission(_ key: String, _ allowed: Bool) -> some View {
        HStack { Text(LocalizedStringKey(key)); Text(LocalizedStringKey(allowed ? "preferences.allowed" : "preferences.denied")) }
            .font(NativeTypography.caption).accessibilityElement(children: .combine)
    }
    private var docsSection: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s3) {
            Text("preferences.docs").font(NativeTypography.emphasis).accessibilityAddTraits(.isHeader)
            TextField("preferences.doc_title", text: $docTitle).byteBound($docTitle, 120)
            TextEditor(text: $markdown).frame(minHeight: KoderaTokens.Space.s12 * 3).accessibilityLabel(Text("preferences.markdown"))
                .byteBound($markdown, DocsPadDraft.maximumBodyBytes)
            Button("preferences.save_docs") { try? controller.updateDocsPad(title: docTitle, markdownBody: markdown, context: context) }.buttonStyle(.bordered)
            if let draft = controller.activeDocsPad {
                Text(String(format: NSLocalizedString("preferences.revision", comment: ""), draft.revision)).font(NativeTypography.caption)
                Text(verbatim: draft.markdownBody).font(NativeTypography.body).lineLimit(8)
                Text("preferences.export").font(NativeTypography.caption)
                Text(verbatim: draft.exportMarkdown()).font(NativeTypography.caption).lineLimit(6).textSelection(.enabled)
            }
        }
    }
    private func beginPreview() {
        guard let scope else { return }
        displayName = NSLocalizedString("preferences.preview_name", comment: ""); handle = "local-preview"
        roleTitle = NSLocalizedString("preferences.preview_role", comment: ""); docTitle = NSLocalizedString("preferences.preview_title", comment: "")
        rank = .guest; presence = .offline
        // Synthetic correlation ID; the explicit preview never uses it as service authority.
        guard let profile = try? KoderaUserProfile(userId: "00000000-0000-4000-8000-000000000001", displayName: displayName,
            handle: handle, roleTitle: roleTitle, presence: presence, rank: rank) else { return }
        context = try? controller.beginLocalPreview(scope: scope, profile: profile, title: docTitle)
    }
    private func reset() {
        controller.clear(); context = nil; importCode = ""; displayName = ""; handle = ""; roleTitle = ""; docTitle = ""; markdown = ""
        rank = .guest; presence = .offline
    }
}

private extension KoderaThemeMode {
    var preferenceKey: String {
        switch self { case .light: "preferences.mode.light"; case .dark: "preferences.mode.dark"; case .black: "preferences.mode.black" }
    }
}
private extension KoderaPresenceStatus {
    var preferenceKey: String {
        switch self { case .online: "preferences.presence.online"; case .idle: "preferences.presence.idle"; case .dnd: "preferences.presence.dnd"; case .offline: "preferences.presence.offline" }
    }
}
private extension KoderaRoleRank {
    var preferenceKey: String {
        switch self { case .guest: "preferences.rank.0"; case .member: "preferences.rank.10"; case .moderator: "preferences.rank.50"; case .admin: "preferences.rank.80"; case .owner: "preferences.rank.100" }
    }
}
private extension ShareableThemeSpec {
    var preferenceKey: String {
        switch id {
        case "preset-real-black-oled": "preferences.preset-real-black-oled"
        case "preset-cobalt-polaire": "preferences.preset-cobalt-polaire"
        case "preset-terminal-ambre": "preferences.preset-terminal-ambre"
        default: "preferences.preset-foret-souveraine"
        }
    }
}

/// Refuses an edit that would exceed the field's byte bound and keeps what was already typed,
/// instead of erasing the field (`BoundedTextInput` holds the rule and its tests).
private struct ByteBound: ViewModifier {
    @Binding var text: String
    let maximumBytes: Int
    @State private var accepted = ""
    func body(content: Content) -> some View {
        content
            .onAppear { accepted = text }
            .onChange(of: text) { proposed in
                let admitted = BoundedTextInput.admitting(proposed, previous: accepted, maximumBytes: maximumBytes)
                if admitted != proposed { text = admitted }
                accepted = admitted
            }
    }
}

private extension View {
    func byteBound(_ text: Binding<String>, _ maximumBytes: Int) -> some View {
        modifier(ByteBound(text: text, maximumBytes: maximumBytes))
    }
}
