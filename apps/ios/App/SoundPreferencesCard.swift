import SwiftUI
import KoderaClient
import KoderaDomain

/// Local preferences only. This composition does not start a preview or activate audio hardware.
struct SoundPreferencesCard: View {
    let scope: SoundPreferencesScope?
    @Environment(\.colorScheme) private var colorScheme
    @State private var coordinator = SoundPreferencesCoordinator()
    @State private var context: SoundPreferencesContext?

    private var palette: KoderaTokens.Palette {
        colorScheme == .dark ? KoderaTokens.dark : KoderaTokens.light
    }
    private var preview: Bool {
        scope != nil && coordinator.state.scope == scope
            && coordinator.state.availability == .localPreviewOnly && context != nil
    }
    // No previous organisation's selection or control state is shown before onChange resets it.
    private var displayedState: SoundPreferencesState {
        scope != nil && coordinator.state.scope == scope ? coordinator.state : SoundPreferencesState()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s4) {
            Text("sound.title").font(NativeTypography.heading).accessibilityAddTraits(.isHeader)
            Text(LocalizedStringKey(preview ? "sound.local_preview" : "sound.unprovisioned"))
                .font(NativeTypography.emphasis).foregroundStyle(palette.ink2)
            Text("sound.disclosure").font(NativeTypography.body)
                .fixedSize(horizontal: false, vertical: true)
            if scope == nil {
                Text("sound.scope_unavailable").font(NativeTypography.caption).foregroundStyle(palette.ink2)
            }
            VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
                ForEach(SoundPackId.allCases, id: \.rawValue) { pack in
                    Button {
                        try? coordinator.selectPack(pack, context: context)
                    } label: {
                        Text(LocalizedStringKey(pack.catalogueKey)).font(NativeTypography.emphasis)
                            .foregroundStyle(palette.accentInk)
                            .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12, alignment: .leading)
                    }
                    .accessibilityHint(Text("sound.pack_hint"))
                    .accessibilityAddTraits(displayedState.activePack == pack ? .isSelected : [])
                }
                Button {
                    try? coordinator.setMuted(!displayedState.isManuallyMuted, context: context)
                } label: {
                    Text(LocalizedStringKey(displayedState.isManuallyMuted ? "sound.manual_unmute" : "sound.manual_mute"))
                        .font(NativeTypography.emphasis).foregroundStyle(palette.accentInk)
                        .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                }
                .accessibilityHint(Text("sound.mute_hint"))
                Button {
                    try? coordinator.setCallDuckingActive(!displayedState.isCallDuckingActive, context: context)
                } label: {
                    Text(LocalizedStringKey(displayedState.isCallDuckingActive ? "sound.duck_off" : "sound.duck_on"))
                        .font(NativeTypography.emphasis).foregroundStyle(palette.accentInk)
                        .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                }
                .accessibilityHint(Text("sound.duck_hint"))
                Button {
                    try? coordinator.setVolumePercent(max(0, displayedState.volumePercent - 10), context: context)
                } label: {
                    Text("sound.volume_down").font(NativeTypography.emphasis).foregroundStyle(palette.accentInk)
                        .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                }
                .disabled(displayedState.volumePercent == 0)
                .accessibilityValue(Text(String(format: NSLocalizedString("sound.volume", comment: ""), displayedState.volumePercent)))
                Button {
                    try? coordinator.setVolumePercent(min(100, displayedState.volumePercent + 10), context: context)
                } label: {
                    Text("sound.volume_up").font(NativeTypography.emphasis).foregroundStyle(palette.accentInk)
                        .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                }
                .disabled(displayedState.volumePercent == 100)
                .accessibilityValue(Text(String(format: NSLocalizedString("sound.volume", comment: ""), displayedState.volumePercent)))
            }
            .buttonStyle(.bordered)
            .disabled(!preview)
            if preview {
                Text(LocalizedStringKey(displayedState.isMuted ? "sound.output_muted" : "sound.output_enabled"))
                    .font(NativeTypography.caption).foregroundStyle(palette.ink2)
                Text(String(format: NSLocalizedString("sound.gain", comment: ""), displayedState.effectiveGainPercent))
                    .font(NativeTypography.caption).foregroundStyle(palette.ink2)
            }
        }
        .foregroundStyle(palette.ink)
        .padding(KoderaTokens.Space.s5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.lg))
        .onAppear { context = nil; try? coordinator.configure(scope) }
        .onChange(of: scope) { value in context = nil; try? coordinator.configure(value) }
        .onDisappear { context = nil; coordinator.leave() }
    }
}

private extension SoundPackId {
    var catalogueKey: String {
        switch self {
        case .givre: "sound.pack.givre"
        case .cristal: "sound.pack.cristal"
        case .atelier: "sound.pack.atelier"
        case .arcade8Bit: "sound.pack.8bit"
        case .glitch404: "sound.pack.404"
        case .silent: "sound.pack.silent"
        }
    }
}
