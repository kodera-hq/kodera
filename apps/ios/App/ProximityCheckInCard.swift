import SwiftUI
import KoderaClient
import KoderaDomain

/// The unprovisioned app can prepare a local draft, never fabricate a trusted radio session.
struct EmergencyCheckInCard: View {
    let organisationId: String?
    @Environment(\.colorScheme) private var colorScheme
    @State private var draft = EmergencyCheckInDraft()
    @State private var preparing = false
    @State private var preparationContext: EmergencyCheckInContext?

    private var palette: KoderaTokens.Palette {
        colorScheme == .dark ? KoderaTokens.dark : KoderaTokens.light
    }
    var body: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s4) {
            Label("emergency.title", systemImage: "antenna.radiowaves.left.and.right")
                .font(NativeTypography.heading).accessibilityAddTraits(.isHeader)
            Label("emergency.unprovisioned", systemImage: "antenna.radiowaves.left.and.right.slash")
                .font(NativeTypography.emphasis).foregroundStyle(palette.ink2)
            Text("emergency.description").font(NativeTypography.body)
                .fixedSize(horizontal: false, vertical: true)
            if organisationId != nil, draft.organisationId == organisationId, let status = draft.status {
                VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
                    Text("emergency.local_draft").font(NativeTypography.caption).foregroundStyle(palette.ink3)
                    Label(LocalizedStringKey(status.emergencyCatalogueKey), systemImage: status.emergencySymbol)
                        .font(NativeTypography.emphasis)
                    Text("emergency.not_sent").font(NativeTypography.caption).foregroundStyle(palette.ink2)
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.updatesFrequently)
            }
            Button {
                preparationContext = draft.preparationContext(forOrganisationId: organisationId)
                preparing = preparationContext != nil
            } label: {
                Text("emergency.prepare").font(NativeTypography.emphasis)
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
                        Text("emergency.not_sent").font(NativeTypography.body)
                            .fixedSize(horizontal: false, vertical: true)
                        ForEach([EmergencySafetyStatus.safe, .needAssistance, .musterPoint], id: \.rawValue) { status in
                            Button {
                                _ = draft.prepare(status, context: preparationContext)
                                preparationContext = nil
                                preparing = false
                            } label: {
                                Label(LocalizedStringKey(status.emergencyCatalogueKey), systemImage: status.emergencySymbol)
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
                .navigationTitle(Text("emergency.prepare"))
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button { preparing = false; preparationContext = nil } label: { Text("emergency.cancel") }
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

private extension EmergencySafetyStatus {
    var emergencyCatalogueKey: String {
        switch self {
        case .messageOnly: "emergency.local_draft"
        case .safe: "emergency.safe"
        case .needAssistance: "emergency.need_assistance"
        case .musterPoint: "emergency.muster_point"
        }
    }
    var emergencySymbol: String {
        switch self {
        case .messageOnly: "square.and.pencil"
        case .safe: "checkmark.shield"
        case .needAssistance: "hand.raised"
        case .musterPoint: "mappin.and.ellipse"
        }
    }
}
