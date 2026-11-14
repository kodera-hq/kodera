import SwiftUI
import KoderaClient
import KoderaDomain

enum ProximityVoluntaryPresentation {
    static func durationKey(for duration: ProximitySessionDuration) -> String {
        switch duration {
        case .minutes15:
            "proximity.voluntary_duration_15m"
        case .minutes30:
            "proximity.voluntary_duration_30m"
        case .hour1:
            "proximity.voluntary_duration_1h"
        case .hours2:
            "proximity.voluntary_duration_2h"
        }
    }

    static func distanceBandKey(for band: ProximityRadioDistanceBand) -> String {
        switch band {
        case .immediate:
            "proximity.voluntary_band_immediate"
        case .near:
            "proximity.voluntary_band_near"
        case .ambient:
            "proximity.voluntary_band_ambient"
        }
    }

    static func badgeKey(isSessionActive: Bool) -> String {
        isSessionActive ? "proximity.voluntary_active_badge" : "proximity.voluntary_inactive_badge"
    }
}

/// Wave 9 voluntary `#proximity` check-in and nearby peer radar view backed by
/// `CoreBluetoothGattRadioDriver` and `NetworkBonjourProximityDriver`.
/// Strictly foreground opt-in, rotating 15-minute HKDF-SHA256 token, zero GPS coordinates,
/// automatic expiry (`<= 2 h`), and one-tap kill-switch (`leaveProximity()`).
@MainActor
struct ProximityVoluntaryCheckInView: View {
    @ObservedObject var session: VoluntaryProximityRadioSession
    var onPrepare: (() -> Void)? = nil
    var isPreparing = false
    var canPrepare = false
    var preparationErrorKey: String? = nil
    var statusNoteIsShared = false
    var onOpenEphemeralThread: ((DiscoveredProximityPeer) -> Void)?
    var onStartDirectCall: ((DiscoveredProximityPeer) -> Void)?

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase

    private var palette: KoderaTokens.Palette {
        KoderaTokens.cielPalette(for: colorScheme)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s4) {
            headerRow
            privacyPledgeBanner
            durationSelector
            if statusNoteIsShared { statusNoteField }
            sessionControls
            if isPreparing {
                ProgressView().accessibilityLabel(Text("proximity.voluntary_preparing"))
            }
            if let preparationErrorKey {
                Text(LocalizedStringKey(preparationErrorKey)).font(NativeTypography.caption).foregroundStyle(palette.warnInk)
            }
            if session.lastError != nil {
                Text("proximity.voluntary_unavailable").font(NativeTypography.caption).foregroundStyle(palette.warnInk)
            }
            peerRadarList
        }
        .foregroundStyle(palette.ink)
        .padding(KoderaTokens.Space.s5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.lg))
        .onAppear {
            session.handleSceneForegroundChange(isActive: scenePhase == .active)
        }
        .onChange(of: scenePhase) { phase in
            session.handleSceneForegroundChange(isActive: phase == .active)
        }
        .onDisappear { session.clearProvisioning() }
    }

    private var headerRow: some View {
        HStack(alignment: .center, spacing: KoderaTokens.Space.s3) {
            Label("proximity.voluntary_title", systemImage: "dot.radiowaves.left.and.right")
                .font(NativeTypography.heading)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: KoderaTokens.Space.s2)
            Text(LocalizedStringKey(ProximityVoluntaryPresentation.badgeKey(isSessionActive: session.isSessionActive)))
                .font(NativeTypography.caption)
                .foregroundStyle(session.isSessionActive ? palette.okInk : palette.ink2)
                .padding(.horizontal, KoderaTokens.Space.s2)
                .padding(.vertical, KoderaTokens.Space.s1)
                .background(
                    session.isSessionActive ? palette.okSoft : palette.muted,
                    in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.full)
                )
        }
    }

    private var privacyPledgeBanner: some View {
        Label("proximity.voluntary_pledge", systemImage: "lock.shield")
            .font(NativeTypography.caption)
            .foregroundStyle(palette.ink2)
            .fixedSize(horizontal: false, vertical: true)
            .padding(KoderaTokens.Space.s3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.sunken, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.md))
    }

    private var durationSelector: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
            Text("proximity.voluntary_duration_label")
                .font(NativeTypography.caption)
                .foregroundStyle(palette.ink3)
            HStack(spacing: KoderaTokens.Space.s2) {
                ForEach(ProximitySessionDuration.allCases, id: \.rawValue) { preset in
                    let isSelected = session.selectedDuration == preset
                    Button {
                        session.selectedDuration = preset
                    } label: {
                        Text(LocalizedStringKey(ProximityVoluntaryPresentation.durationKey(for: preset)))
                            .font(NativeTypography.caption)
                            .foregroundStyle(isSelected ? palette.onInverse : palette.accentInk)
                            .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s10)
                            .background(
                                isSelected ? palette.action : palette.muted,
                                in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.sm)
                            )
                    }
                    .buttonStyle(.plain)
                    .disabled(session.isSessionActive)
                }
            }
        }
    }

    private var statusNoteField: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
            Text("proximity.voluntary_note_label")
                .font(NativeTypography.caption)
                .foregroundStyle(palette.ink3)
            TextField(
                LocalizedStringKey("proximity.voluntary_note_placeholder"),
                text: $session.statusNote
            )
            .font(NativeTypography.body)
            .padding(KoderaTokens.Space.s3)
            .background(palette.sunken, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.sm))
            .disabled(session.isSessionActive)
        }
    }

    @ViewBuilder
    private var sessionControls: some View {
        if session.isSessionActive {
            Button(role: .destructive) {
                session.leaveProximity()
            } label: {
                Label("proximity.voluntary_leave", systemImage: "xmark.circle")
                    .font(NativeTypography.emphasis)
                    .foregroundStyle(palette.badInk)
                    .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.bordered)
        } else if !session.hasForegroundConsent {
            Button {
                if let onPrepare { onPrepare() }
                else { try? session.grantForegroundConsent() }
            } label: {
                Text("proximity.voluntary_consent_grant")
                    .font(NativeTypography.emphasis)
                    .foregroundStyle(palette.accentInk)
                    .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.bordered)
            .disabled(isPreparing || !session.isForegroundActive || (session.organisationId == nil && !canPrepare))
        } else {
            Button {
                try? session.startVoluntarySession()
            } label: {
                Label("proximity.voluntary_start", systemImage: "antenna.radiowaves.left.and.right")
                    .font(NativeTypography.emphasis)
                    .foregroundStyle(palette.accentInk)
                    .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.bordered)
            .disabled(!session.isForegroundActive)
        }
    }

    private var peerRadarList: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s3) {
            Text("proximity.voluntary_peers_heading")
                .font(NativeTypography.emphasis)
                .accessibilityAddTraits(.isHeader)
            if session.peers.isEmpty {
                Text("proximity.voluntary_peers_empty")
                    .font(NativeTypography.caption)
                    .foregroundStyle(palette.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(session.peers) { peer in
                    peerCard(peer)
                }
            }
        }
    }

    private func peerCard(_ peer: DiscoveredProximityPeer) -> some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
            HStack(alignment: .center, spacing: KoderaTokens.Space.s2) {
                Text(verbatim: peer.handle)
                    .font(NativeTypography.monoBody)
                Spacer(minLength: KoderaTokens.Space.s2)
                Text(LocalizedStringKey(ProximityVoluntaryPresentation.distanceBandKey(for: peer.distanceBand)))
                    .font(NativeTypography.caption)
                    .foregroundStyle(palette.accentInk)
                    .padding(.horizontal, KoderaTokens.Space.s2)
                    .padding(.vertical, KoderaTokens.Space.s1)
                    .background(palette.accentSoft, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.full))
                if peer.viaBonjourLan {
                    Text("proximity.voluntary_lan_badge")
                        .font(NativeTypography.monoCaption)
                        .foregroundStyle(palette.tag1Fg)
                        .padding(.horizontal, KoderaTokens.Space.s2)
                        .padding(.vertical, KoderaTokens.Space.s1)
                        .background(palette.tag1Bg, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.full))
                }
            }
            if !peer.statusNote.isEmpty {
                Text(verbatim: peer.statusNote)
                    .font(NativeTypography.body)
                    .foregroundStyle(palette.ink2)
            }
            HStack(spacing: KoderaTokens.Space.s2) {
                Button {
                    onOpenEphemeralThread?(peer)
                } label: {
                    Label("proximity.voluntary_open_thread", systemImage: "bubble.left.and.bubble.right")
                        .font(NativeTypography.caption)
                        .foregroundStyle(palette.accentInk)
                        .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s10)
                }
                .buttonStyle(.bordered)
                .disabled(onOpenEphemeralThread == nil)

                Button {
                    onStartDirectCall?(peer)
                } label: {
                    Label("proximity.voluntary_start_call", systemImage: "waveform")
                        .font(NativeTypography.caption)
                        .foregroundStyle(palette.accentInk)
                        .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s10)
                }
                .buttonStyle(.bordered)
                .disabled(onStartDirectCall == nil)
            }
        }
        .padding(KoderaTokens.Space.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.muted, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.md))
    }
}
