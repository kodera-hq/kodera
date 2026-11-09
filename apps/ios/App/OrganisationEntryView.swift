import SwiftUI
import UIKit

@MainActor
struct OrganisationEntryView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var session: AppSessionModel
    @StateObject private var model: OrganisationEntryModel
    @FocusState private var isOrganisationFocused: Bool

    init(session: AppSessionModel) {
        self.session = session
        _model = StateObject(wrappedValue: OrganisationEntryModel(configuration: session.configuration))
    }

    private var palette: KoderaTokens.Palette {
        colorScheme == .dark ? KoderaTokens.dark : KoderaTokens.light
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                contents
            }
            .scrollDismissesKeyboard(.interactively)
            .background(palette.page.ignoresSafeArea())
            .tint(palette.action)
            .toolbar(.hidden, for: .navigationBar)
        }
        .onAppear { model.activate() }
        .onDisappear { model.deactivate() }
        .onChange(of: scenePhase) { phase in
            if phase == .background { model.deactivate() }
            else if phase == .active { model.activate() }
        }
        .onChange(of: model.state) { _ in
            UIAccessibility.post(notification: .announcement,
                argument: NSLocalizedString(model.messageKey, comment: "Discovery status"))
        }
    }

    private var contents: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s8) {
            introduction
            organisationCard
            availability
            signIn
        }
        .font(NativeTypography.body)
        .foregroundStyle(palette.ink)
        .frame(maxWidth: KoderaTokens.Space.shellDocumentMinWidth)
        .padding(.horizontal, KoderaTokens.Space.s6)
        .padding(.vertical, KoderaTokens.Space.s8)
        .frame(maxWidth: .infinity)
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s4) {
            Text("brand.name")
                .font(NativeTypography.wordmark)
                .foregroundStyle(palette.action)
                .accessibilityAddTraits(.isHeader)
            Text("welcome.title")
                .font(NativeTypography.title)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text("welcome.description")
                .foregroundStyle(palette.ink2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var organisationCard: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s5) {
            Text("organisation.title")
                .font(NativeTypography.heading)
                .accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
                Text("organisation.label")
                    .font(NativeTypography.emphasis)
                TextField("organisation.placeholder", text: $model.slugInput)
                    .font(NativeTypography.body)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                    .submitLabel(.search)
                    .focused($isOrganisationFocused)
                    .onSubmit {
                        if model.canLookup { isOrganisationFocused = false }
                        model.lookup()
                    }
                    .padding(KoderaTokens.Space.s3)
                    .frame(minHeight: KoderaTokens.Space.s12)
                    .background(palette.sunken, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.md))
                    .accessibilityLabel(Text("organisation.label"))
                    .accessibilityHint(Text("organisation.hint"))
                Text("organisation.hint")
                    .font(NativeTypography.caption)
                    .foregroundStyle(palette.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if model.isLoading {
                ProgressView("discovery.loading")
                    .font(NativeTypography.body)
                    .accessibilityLabel(Text("discovery.loading"))
                Button(action: model.cancelLookup) {
                    // accentInk, not the action tint: action on surface is under 4.5:1 in the dark palettes.
                    Text("discovery.cancel")
                        .font(NativeTypography.emphasis)
                        .foregroundStyle(palette.accentInk)
                        .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.bordered)
            } else {
                Button {
                    isOrganisationFocused = false
                    model.lookup()
                } label: {
                    Text("discovery.action")
                        .font(NativeTypography.emphasis)
                        .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderedProminent)
                .disabled(!model.canLookup)
                .accessibilityHint(Text(LocalizedStringKey(model.messageKey)))
            }
            Button {
                model.reset()
                isOrganisationFocused = true
            } label: {
                Text("input.clear")
                    .font(NativeTypography.body)
                    .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                    .contentShape(Rectangle())
            }
            .disabled(model.organisationSlug.isEmpty)
        }
        .padding(KoderaTokens.Space.s5)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.lg))
    }

    private var availability: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s3) {
            VStack(alignment: .leading, spacing: KoderaTokens.Space.s3) {
                Label(LocalizedStringKey(model.titleKey), systemImage: "info.circle")
                    .font(NativeTypography.emphasis)
                Text(LocalizedStringKey(model.messageKey))
                    .foregroundStyle(palette.ink2)
                if session.configuration.signIn == nil {
                    Text("login.unavailable")
                        .font(NativeTypography.caption)
                        .foregroundStyle(palette.ink3)
                }
            }
            .accessibilityElement(children: .combine)
            choices
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private var choices: some View {
        if !model.candidates.isEmpty {
            ForEach(model.candidates, id: \.organisationId) { organisation in
                Button {
                    isOrganisationFocused = false
                    model.select(organisationId: organisation.organisationId)
                } label: {
                    VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
                        Text(verbatim: organisation.displayName).font(NativeTypography.emphasis)
                        Text(verbatim: organisation.organisationSlug).font(NativeTypography.caption)
                    }
                    .foregroundStyle(palette.ink)
                    .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.bordered)
                .accessibilityHint(Text("discovery.choose_hint"))
            }
        } else if let organisation = model.selected {
            VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
                Text(verbatim: organisation.displayName).font(NativeTypography.heading)
                Text(verbatim: organisation.organisationSlug)
                    .font(NativeTypography.caption)
                    .foregroundStyle(palette.ink2)
            }
            .padding(KoderaTokens.Space.s4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.surface, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.md))
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder
    private var signIn: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s3) {
            if session.phase == .signingIn {
                ProgressView("signin.in_progress")
                    .font(NativeTypography.body)
                    .accessibilityLabel(Text("signin.in_progress"))
            } else if session.canSignIn {
                if let organisation = model.selected {
                    signInButton("signin.action", hint: "signin.hint") {
                        session.signIn(issuer: organisation.issuer)
                    }
                }
                #if DEBUG
                if let issuer = session.configuration.developmentIssuer {
                    signInButton("signin.development", hint: "signin.development_hint") {
                        session.signIn(issuer: issuer)
                    }
                }
                #endif
            }
            if let notice = session.noticeKey {
                Text(LocalizedStringKey(notice))
                    .foregroundStyle(palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onChange(of: session.noticeKey) { notice in
            guard let notice else { return }
            UIAccessibility.post(notification: .announcement,
                argument: NSLocalizedString(notice, comment: "Sign-in status"))
        }
    }

    private func signInButton(_ title: LocalizedStringKey, hint: LocalizedStringKey,
                              action: @escaping () -> Void) -> some View {
        Button {
            isOrganisationFocused = false
            action()
        } label: {
            Text(title)
                .font(NativeTypography.emphasis)
                .foregroundStyle(palette.onInverse)
                .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderedProminent)
        .accessibilityLabel(Text(title))
        .accessibilityHint(Text(hint))
    }
}
