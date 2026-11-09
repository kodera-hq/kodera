import SwiftUI
import KoderaClient
import KoderaDomain

/// No transport is provisioned by this app composition. Controls never start microphone capture.
struct VoiceCallDockCard: View {
    let scope: VoiceCallScope?
    @Environment(\.colorScheme) private var colorScheme
    @State private var coordinator = VoiceCallCoordinator()

    private var palette: KoderaTokens.Palette {
        colorScheme == .dark ? KoderaTokens.dark : KoderaTokens.light
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
        .onAppear { try? coordinator.configure(scope) }
        .onChange(of: scope) { value in try? coordinator.configure(value) }
        .onDisappear { coordinator.leave() }
    }
}
