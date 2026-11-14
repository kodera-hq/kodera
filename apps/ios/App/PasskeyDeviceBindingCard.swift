import SwiftUI
import KoderaAuth
import KoderaDomain

/// Surfaces the unprovisioned Passkey ES256 UP+UV (`0x05`, `0x0D`, `0x1D`) policy preview card
/// aligned with `kodera-rs` `passkey_binding`, before `AuthenticationServices` / `webcredentials:`
/// Associated Domains entitlement provisioning at Gate G6.
@MainActor
struct PasskeyDeviceBindingCard: View {
    let organisationId: String?

    @Environment(\.colorScheme) private var colorScheme

    private var palette: KoderaTokens.Palette {
        KoderaTokens.cielPalette(for: colorScheme)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s4) {
            Label("passkey.title", systemImage: "person.badge.key")
                .font(NativeTypography.heading)
                .accessibilityAddTraits(.isHeader)
            Label("passkey.unprovisioned", systemImage: "checkmark.shield")
                .font(NativeTypography.emphasis)
                .foregroundStyle(palette.ink2)
            Text("passkey.description")
                .font(NativeTypography.body)
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
                Text("passkey.policy_summary")
                    .font(NativeTypography.caption)
                    .foregroundStyle(palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
                if let organisationId {
                    Text(verbatim: organisationId)
                        .font(NativeTypography.monoCaption)
                        .foregroundStyle(palette.ink3)
                } else {
                    Text("passkey.organisation_required")
                        .font(NativeTypography.caption)
                        .foregroundStyle(palette.ink3)
                }
            }
            .padding(KoderaTokens.Space.s3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.sunken, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.md))
        }
        .foregroundStyle(palette.ink)
        .padding(KoderaTokens.Space.s5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.lg))
    }
}
