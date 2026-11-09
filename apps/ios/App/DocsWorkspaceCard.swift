import SwiftUI
import KoderaClient
import KoderaDomain

/// Read-only local metadata. This composition neither provisions Docs nor opens document URLs.
struct DocsWorkspaceCard: View {
    let scope: DocsWorkspaceScope?
    @Environment(\.colorScheme) private var colorScheme
    @State private var coordinator = DocsWorkspaceCoordinator()

    private var palette: KoderaTokens.Palette {
        colorScheme == .dark ? KoderaTokens.dark : KoderaTokens.light
    }
    // Hide obsolete metadata synchronously before onChange clears the previous reducer state.
    private var preview: Bool {
        scope != nil && coordinator.state.scope == scope && coordinator.state.availability == .localPreviewOnly
    }
    var body: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s4) {
            Text("docs.title").font(NativeTypography.heading).accessibilityAddTraits(.isHeader)
            Label(LocalizedStringKey(preview ? "docs.local_preview" : "docs.unprovisioned"),
                  systemImage: "doc.text")
                .font(NativeTypography.emphasis).foregroundStyle(palette.ink2)
            Text("docs.disclosure").font(NativeTypography.body)
                .fixedSize(horizontal: false, vertical: true)
            if scope == nil {
                Text("docs.channel_unavailable").font(NativeTypography.caption).foregroundStyle(palette.ink2)
            }
            if preview {
                Text("docs.preview_pads").font(NativeTypography.caption).foregroundStyle(palette.ink2)
                ForEach(coordinator.state.pads, id: \.id) { pad in
                    VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
                        Text(verbatim: pad.title).font(NativeTypography.emphasis)
                        Text(verbatim: (pad.padURL.host ?? "") + pad.padURL.path)
                            .font(NativeTypography.caption).foregroundStyle(palette.ink2)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .foregroundStyle(palette.ink)
        .padding(KoderaTokens.Space.s5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.lg))
        .onAppear { try? coordinator.configure(scope) }
        .onChange(of: scope) { value in try? coordinator.configure(value) }
        .onDisappear { coordinator.leave() }
    }
}
