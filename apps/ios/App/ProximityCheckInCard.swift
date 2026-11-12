import SwiftUI
import KoderaClient
import KoderaDomain

/// The `#proximity` card: an everyday presence check-in, voluntary and pseudonymous. It is not an
/// emergency service and says so. The unprovisioned app can prepare a local draft, never fabricate
/// a trusted radio session.
struct ProximityCheckInCard: View {
    let organisationId: String?
    @Environment(\.colorScheme) private var colorScheme
    @State private var draft = ProximityCheckInDraft()
    @State private var preparing = false
    @State private var preparationContext: ProximityCheckInContext?

    private var palette: KoderaTokens.Palette {
        colorScheme == .dark ? KoderaTokens.dark : KoderaTokens.light
    }
    var body: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s4) {
            Label("proximity.title", systemImage: "antenna.radiowaves.left.and.right")
                .font(NativeTypography.heading).accessibilityAddTraits(.isHeader)
            Label("proximity.unprovisioned", systemImage: "antenna.radiowaves.left.and.right.slash")
                .font(NativeTypography.emphasis).foregroundStyle(palette.ink2)
            Text("proximity.description").font(NativeTypography.body)
                .fixedSize(horizontal: false, vertical: true)
            // The safety notice is always shown: this channel never reaches emergency services.
            Label("proximity.notice", systemImage: "exclamationmark.triangle")
                .font(NativeTypography.caption).foregroundStyle(palette.ink2)
                .fixedSize(horizontal: false, vertical: true)
            if organisationId != nil, draft.organisationId == organisationId, let status = draft.status {
                VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
                    Text("proximity.local_draft").font(NativeTypography.caption).foregroundStyle(palette.ink3)
                    Label(LocalizedStringKey(status.proximityCatalogueKey), systemImage: status.proximitySymbol)
                        .font(NativeTypography.emphasis)
                    Text("proximity.not_sent").font(NativeTypography.caption).foregroundStyle(palette.ink2)
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.updatesFrequently)
            }
            Button {
                preparationContext = draft.preparationContext(forOrganisationId: organisationId)
                preparing = preparationContext != nil
            } label: {
                Text("proximity.prepare").font(NativeTypography.emphasis)
                    .foregroundStyle(palette.accentInk)
                    .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.bordered)
            .disabled(draft.preparationContext(forOrganisationId: organisationId) == nil)
        }
        .foregroundStyle(palette.ink)
        .padding(KoderaTokens.Space.s5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.lg))
        .sheet(isPresented: $preparing) {
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: KoderaTokens.Space.s4) {
                        Text("proximity.not_sent").font(NativeTypography.body)
                            .fixedSize(horizontal: false, vertical: true)
                        ForEach([ProximitySafetyStatus.safe, .needAssistance, .musterPoint], id: \.rawValue) { status in
                            Button {
                                _ = draft.prepare(status, context: preparationContext)
                                preparationContext = nil
                                preparing = false
                            } label: {
                                Label(LocalizedStringKey(status.proximityCatalogueKey), systemImage: status.proximitySymbol)
                                    .font(NativeTypography.emphasis)
                                    .foregroundStyle(palette.accentInk)
                                    .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12, alignment: .leading)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .foregroundStyle(palette.ink)
                    .padding(KoderaTokens.Space.s6)
                }
                .background(palette.page.ignoresSafeArea())
                .navigationTitle(Text("proximity.prepare"))
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button { preparing = false; preparationContext = nil } label: { Text("proximity.cancel") }
                    }
                }
            }
        }
        .onAppear { reset(for: organisationId) }
        .onChange(of: organisationId) { reset(for: $0) }
        .onDisappear { reset(for: nil) }
    }
    private func reset(for organisationId: String?) {
        preparing = false; preparationContext = nil
        draft.configure(organisationId: organisationId)
    }
}

private extension ProximitySafetyStatus {
    var proximityCatalogueKey: String {
        switch self {
        case .messageOnly: "proximity.local_draft"
        case .safe: "proximity.safe"
        case .needAssistance: "proximity.need_assistance"
        case .musterPoint: "proximity.muster_point"
        }
    }
    var proximitySymbol: String {
        switch self {
        case .messageOnly: "square.and.pencil"
        case .safe: "checkmark.shield"
        case .needAssistance: "hand.raised"
        case .musterPoint: "mappin.and.ellipse"
        }
    }
}
