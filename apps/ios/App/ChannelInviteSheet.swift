import SwiftUI
import UIKit
import KoderaClient
import KoderaDomain

/// Universal Matrix invitation sheet consuming `KoderaTokens` (`ciel` / `cielNuit`).
/// Copies canonical `matrix.to`, `matrix:` URI, and `#alias:domain` targets to the clipboard
/// without opening external web pages, and validates `@user:domain` MXIDs locally.
@MainActor
struct ChannelInviteSheet: View {
    let scope: ChannelInviteScope
    @ObservedObject var coordinator: ChannelInviteCoordinator
    let context: ChannelInviteContext?
    let onDismiss: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var recipientInput = ""

    private var palette: KoderaTokens.Palette {
        KoderaTokens.cielPalette(for: colorScheme)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: KoderaTokens.Space.s5) {
                    headerSection
                    shareLinksSection
                    directInviteSection
                }
                .font(NativeTypography.body)
                .foregroundStyle(palette.ink)
                .padding(KoderaTokens.Space.s6)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(palette.page.ignoresSafeArea())
            .tint(palette.action)
            .navigationTitle(Text("invite.title"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(action: onDismiss) {
                        Text("invite.close")
                    }
                }
            }
        }
    }

    private var headerSection: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
            Text(verbatim: "#\(scope.channelName)")
                .font(NativeTypography.heading)
                .accessibilityAddTraits(.isHeader)
            Text("invite.description")
                .font(NativeTypography.body)
                .foregroundStyle(palette.ink2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var shareLinksSection: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s4) {
            Text("invite.links_section")
                .font(NativeTypography.emphasis)
                .accessibilityAddTraits(.isHeader)

            copyableLinkRow(
                labelKey: "invite.format_matrix_to",
                value: scope.invitation.matrixToURLString,
                format: .matrixToURL
            )

            copyableLinkRow(
                labelKey: "invite.format_matrix_uri",
                value: scope.invitation.matrixURIString,
                format: .matrixURI
            )

            if let displayAlias = scope.invitation.displayAlias {
                copyableLinkRow(
                    labelKey: "invite.format_alias",
                    value: displayAlias,
                    format: .canonicalAlias
                )
                if !scope.hasProvisionedRoomTarget || scope.invitation.isSuggestedAlias {
                    Text("invite.suggested_alias_hint")
                        .font(NativeTypography.caption)
                        .foregroundStyle(palette.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(KoderaTokens.Space.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.lg))
    }

    private func copyableLinkRow(
        labelKey: String,
        value: String,
        format: ChannelInviteShareFormat
    ) -> some View {
        let isCopied = coordinator.lastCopiedFormat == format
        return VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
            Text(LocalizedStringKey(labelKey))
                .font(NativeTypography.caption)
                .foregroundStyle(palette.ink2)
            Text(verbatim: value)
                .font(NativeTypography.monoCaption)
                .foregroundStyle(palette.ink)
                .padding(KoderaTokens.Space.s3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.sunken, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.md))
                .fixedSize(horizontal: false, vertical: true)
            Button {
                UIPasteboard.general.string = value
                try? coordinator.recordCopiedFormat(format, context: context)
            } label: {
                Label(
                    LocalizedStringKey(isCopied ? "invite.copied" : "invite.copy"),
                    systemImage: isCopied ? "checkmark" : "doc.on.doc"
                )
                .font(NativeTypography.emphasis)
                .foregroundStyle(isCopied ? palette.okInk : palette.accentInk)
                .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.bordered)
        }
    }

    private var directInviteSection: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s4) {
            Text("invite.direct_section")
                .font(NativeTypography.emphasis)
                .accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
                Text("invite.direct_label")
                    .font(NativeTypography.caption)
                    .foregroundStyle(palette.ink2)
                TextField("invite.direct_placeholder", text: $recipientInput)
                    .font(NativeTypography.monoBody)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                    .padding(KoderaTokens.Space.s3)
                    .frame(minHeight: KoderaTokens.Space.s12)
                    .background(palette.sunken, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.md))
                    .accessibilityLabel(Text("invite.direct_label"))
                    .accessibilityHint(Text("invite.direct_hint"))
                Text("invite.direct_hint")
                    .font(NativeTypography.caption)
                    .foregroundStyle(palette.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }

            statusFeedback

            Button {
                let targetInput = recipientInput
                Task {
                    _ = await coordinator.sendDirectInvite(
                        rawInput: targetInput,
                        context: context
                    )
                }
            } label: {
                Text("invite.send_action")
                    .font(NativeTypography.emphasis)
                    .foregroundStyle(palette.onInverse)
                    .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderedProminent)
            .disabled(recipientInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(KoderaTokens.Space.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.lg))
    }

    @ViewBuilder
    private var statusFeedback: some View {
        switch coordinator.status {
        case .idle:
            EmptyView()
        case .sending:
            ProgressView("invite.status_sending")
                .font(NativeTypography.caption)
        case let .sent(userId):
            VStack(alignment: .leading, spacing: KoderaTokens.Space.s1) {
                Label("invite.status_sent", systemImage: "checkmark.circle")
                    .font(NativeTypography.emphasis)
                    .foregroundStyle(palette.okInk)
                Text(verbatim: userId.rawValue)
                    .font(NativeTypography.monoCaption)
                    .foregroundStyle(palette.ink2)
            }
            .padding(KoderaTokens.Space.s3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.okSoft, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.md))
        case let .unprovisioned(userId):
            VStack(alignment: .leading, spacing: KoderaTokens.Space.s1) {
                Label("invite.status_unprovisioned", systemImage: "info.circle")
                    .font(NativeTypography.emphasis)
                    .foregroundStyle(palette.warnInk)
                Text(verbatim: userId.rawValue)
                    .font(NativeTypography.monoCaption)
                    .foregroundStyle(palette.ink2)
            }
            .padding(KoderaTokens.Space.s3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.warnSoft, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.md))
        case .failed(.invalidRecipient):
            Label("invite.error_invalid_mxid", systemImage: "exclamationmark.triangle")
                .font(NativeTypography.caption)
                .foregroundStyle(palette.badInk)
                .padding(KoderaTokens.Space.s3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.badSoft, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.md))
        case .failed:
            Label("invite.error_send_failed", systemImage: "exclamationmark.triangle")
                .font(NativeTypography.caption)
                .foregroundStyle(palette.badInk)
                .padding(KoderaTokens.Space.s3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.badSoft, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.md))
        }
    }
}
