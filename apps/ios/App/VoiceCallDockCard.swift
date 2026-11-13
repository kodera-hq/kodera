import SwiftUI
import KoderaClient
import KoderaDomain

enum CallSessionPhasePresentation {
    static func phaseKey(for phase: CallSessionPhase) -> String {
        switch phase {
        case .idle:
            "callkit.phase_idle"
        case .ringing:
            "callkit.phase_ringing"
        case .connecting:
            "callkit.phase_connecting"
        case let .active(_, _, isMuted, isHeld, _):
            if isHeld {
                "callkit.phase_held"
            } else if isMuted {
                "callkit.phase_muted"
            } else {
                "callkit.phase_active"
            }
        case .ended:
            "callkit.phase_ended"
        case .failed:
            "callkit.phase_failed"
        }
    }
}

/// No transport is provisioned by this app composition. Controls never start microphone capture,
/// and PushKit/CallKit wakeup relays enforce Core's payload-free invariant.
@MainActor
struct VoiceCallDockCard: View {
    let scope: VoiceCallScope?
    @Environment(\.colorScheme) private var colorScheme
    @State private var coordinator = VoiceCallCoordinator()
    @StateObject private var callKitCoordinator = try! CallKitPushCoordinator()

    private var palette: KoderaTokens.Palette {
        KoderaTokens.cielPalette(for: colorScheme)
    }
    // Hide old metadata synchronously, before onChange clears the previous scope's reducer.
    private var preview: Bool {
        scope != nil && coordinator.state.scope == scope && coordinator.state.availability == .localPreviewOnly
    }
    var body: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s4) {
            Text("voice.title").font(NativeTypography.heading).accessibilityAddTraits(.isHeader)
            Label(LocalizedStringKey(preview ? "voice.local_preview" : "voice.unprovisioned"),
                  systemImage: "headphones")
                .font(NativeTypography.emphasis).foregroundStyle(palette.ink2)
            Text("voice.disclosure").font(NativeTypography.body)
                .fixedSize(horizontal: false, vertical: true)
            if scope == nil {
                Text("voice.channel_unavailable").font(NativeTypography.caption).foregroundStyle(palette.ink2)
            }

            callKitWakeupSection

            VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
                Button {
                    try? coordinator.setMuted(!coordinator.state.isMuted)
                } label: {
                    Text(LocalizedStringKey(coordinator.state.isMuted ? "voice.unmute" : "voice.mute"))
                        .font(NativeTypography.emphasis).foregroundStyle(palette.accentInk)
                        .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                }
                .accessibilityHint(Text("voice.mute_hint"))
                Button {
                    try? coordinator.setDeafened(!coordinator.state.isDeafened)
                } label: {
                    Text(LocalizedStringKey(coordinator.state.isDeafened ? "voice.undeafen" : "voice.deafen"))
                        .font(NativeTypography.emphasis).foregroundStyle(palette.accentInk)
                        .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                }
                .accessibilityHint(Text("voice.deafen_hint"))
                Button { coordinator.leave() } label: {
                    Text("voice.leave").font(NativeTypography.emphasis).foregroundStyle(palette.accentInk)
                        .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                }
                .accessibilityHint(Text("voice.leave_hint"))
            }
            .buttonStyle(.bordered)
            .disabled(!preview)
            if preview {
                Text("voice.preview_roster").font(NativeTypography.caption).foregroundStyle(palette.ink2)
                ForEach(coordinator.state.participants, id: \.identityBytes) { participant in
                    VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
                        Text(verbatim: participant.displayName).font(NativeTypography.emphasis)
                        Label(LocalizedStringKey(participant.isMuted ? "voice.participant_muted" : "voice.participant_unmuted"),
                              systemImage: participant.isMuted ? "mic.slash" : "mic")
                        if participant.isSpeaking {
                            Label("voice.participant_speaking", systemImage: "waveform")
                        }
                    }
                    .font(NativeTypography.caption)
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .foregroundStyle(palette.ink)
        .padding(KoderaTokens.Space.s5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.lg))
        .onAppear { syncScope(scope) }
        .onChange(of: scope) { value in syncScope(value) }
        .onDisappear {
            coordinator.leave()
            Task { try? await callKitCoordinator.switchOrganisation(nil) }
        }
    }

    private var callKitWakeupSection: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
            HStack(alignment: .center, spacing: KoderaTokens.Space.s2) {
                Label("callkit.section_title", systemImage: "phone.badge.checkmark")
                    .font(NativeTypography.emphasis)
                Spacer(minLength: KoderaTokens.Space.s2)
                Text("callkit.payload_free_badge")
                    .font(NativeTypography.caption)
                    .foregroundStyle(palette.t1Fg)
                    .padding(.horizontal, KoderaTokens.Space.s2)
                    .padding(.vertical, KoderaTokens.Space.s1)
                    .background(palette.t1Bg, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.full))
            }
            Text("callkit.policy_description")
                .font(NativeTypography.caption)
                .foregroundStyle(palette.ink2)
                .fixedSize(horizontal: false, vertical: true)
            Text(LocalizedStringKey(CallSessionPhasePresentation.phaseKey(for: callKitCoordinator.state.phase)))
                .font(NativeTypography.monoCaption)
                .foregroundStyle(palette.accentInk)
            if !callKitCoordinator.isPushKitProvisioned {
                Text("callkit.unprovisioned_hint")
                    .font(NativeTypography.caption)
                    .foregroundStyle(palette.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(KoderaTokens.Space.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.sunken, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.md))
    }

    private func syncScope(_ nextScope: VoiceCallScope?) {
        try? coordinator.configure(nextScope)
        let orgId = nextScope?.organisationId
        Task { try? await callKitCoordinator.switchOrganisation(orgId) }
    }
}
