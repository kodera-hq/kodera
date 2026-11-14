import SwiftUI
import KoderaClient
import KoderaDomain

enum ProximitySurfacePresentation {
    static func localRadioStatusKey(for status: LocalBLERadioStatus) -> String {
        switch status {
        case .unprovisioned:
            "proximity.ble_status_unprovisioned"
        case .awaitingForegroundConsent:
            "proximity.ble_status_awaiting_consent"
        case .suspendedInBackground:
            "proximity.ble_status_suspended_background"
        case .throttled(.batteryBudgetExceeded):
            "proximity.ble_status_battery_paused"
        case .throttled:
            "proximity.ble_status_duty_throttled"
        case .scanningWindowActive:
            "proximity.ble_status_scanning"
        case .readyForLocalRadio:
            "proximity.ble_status_ready"
        }
    }

    static func onlineRelayStatusKey(for status: OnlineMatrixRelayStatus) -> String {
        switch status {
        case .disconnected:
            "proximity.online_disconnected"
        case .connectedRoom:
            "proximity.online_connected"
        }
    }
}

/// The `#proximity` card: an everyday presence check-in, voluntary and pseudonymous. It is not an
/// emergency service and says so. Maintains strict visual and copy separation between online Matrix
/// room relays and foreground opt-in local BLE v2 rotating-beacon check-ins, never claiming offline
/// delivery without a verified local radio frame.
@MainActor
struct ProximityCheckInCard: View {
    let organisationId: String?
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var controller = ProximityV2CheckInController()
    @State private var preparing = false
    @State private var preparationContext: ProximityCheckInContext?

    private var palette: KoderaTokens.Palette {
        KoderaTokens.cielPalette(for: colorScheme)
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

            onlineMatrixRelayLane
            localBLERadioLane

            if organisationId != nil,
               controller.draft.organisationId == organisationId,
               let status = controller.draft.status {
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
                preparationContext = controller.draft.preparationContext(forOrganisationId: organisationId)
                preparing = preparationContext != nil
            } label: {
                Text("proximity.prepare").font(NativeTypography.emphasis)
                    .foregroundStyle(palette.accentInk)
                    .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.bordered)
            .disabled(controller.draft.preparationContext(forOrganisationId: organisationId) == nil)
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
                                if controller.draft.preparationContext(forOrganisationId: organisationId) != nil,
                                   preparationContext != nil {
                                    _ = controller.prepareDraft(status)
                                }
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
        .onAppear {
            controller.setForegroundActive(scenePhase == .active)
            reset(for: organisationId)
        }
        .onChange(of: scenePhase) { phase in
            controller.setForegroundActive(phase == .active)
        }
        .onChange(of: organisationId) { reset(for: $0) }
        .onDisappear { reset(for: nil) }
    }

    private var onlineMatrixRelayLane: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
            Label("proximity.online_lane_title", systemImage: "network")
                .font(NativeTypography.emphasis)
                .foregroundStyle(palette.ink)
            Text(LocalizedStringKey(ProximitySurfacePresentation.onlineRelayStatusKey(for: controller.onlineMatrixRelayStatus)))
                .font(NativeTypography.caption)
                .foregroundStyle(palette.ink2)
            Text("proximity.online_lane_note")
                .font(NativeTypography.caption)
                .foregroundStyle(palette.ink3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(KoderaTokens.Space.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.sunken, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.md))
    }

    private var localBLERadioLane: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
            Label("proximity.ble_lane_title", systemImage: "dot.radiowaves.left.and.right")
                .font(NativeTypography.emphasis)
                .foregroundStyle(palette.ink)
            Text(LocalizedStringKey(ProximitySurfacePresentation.localRadioStatusKey(for: controller.localRadioStatus)))
                .font(NativeTypography.caption)
                .foregroundStyle(palette.accentInk)
            Text("proximity.duty_cycle_disclosure")
                .font(NativeTypography.caption)
                .foregroundStyle(palette.ink2)
                .fixedSize(horizontal: false, vertical: true)
            if !controller.hasVerifiedLocalRadioDelivery {
                Text("proximity.ble_no_verified_delivery")
                    .font(NativeTypography.caption)
                    .foregroundStyle(palette.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if organisationId != nil {
                if controller.hasForegroundConsent {
                    Button {
                        controller.revokeConsent()
                    } label: {
                        Text("proximity.consent_revoke")
                            .font(NativeTypography.emphasis)
                            .foregroundStyle(palette.ink)
                            .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s10)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.bordered)
                } else {
                    Button {
                        try? controller.grantForegroundConsent(forOrganisationId: organisationId)
                    } label: {
                        Text("proximity.consent_opt_in")
                            .font(NativeTypography.emphasis)
                            .foregroundStyle(palette.accentInk)
                            .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s10)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.bordered)
                    .disabled(!controller.isForegroundActive)
                }
            }
        }
        .padding(KoderaTokens.Space.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.muted, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.md))
    }

    private func reset(for organisationId: String?) {
        preparing = false
        preparationContext = nil
        controller.configure(organisationId: organisationId)
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
