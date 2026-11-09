import SwiftUI
import KoderaClient
import KoderaDomain

/// No poll service or preview is provisioned by this composition. No vote leaves the device.
struct ChannelPollCard: View {
    let scope: ChannelPollScope?
    @Environment(\.colorScheme) private var colorScheme
    @State private var coordinator = ChannelPollCoordinator()
    @State private var context: ChannelPollContext?

    private var palette: KoderaTokens.Palette {
        colorScheme == .dark ? KoderaTokens.dark : KoderaTokens.light
    }
    // Old scope data is hidden synchronously, before the lifecycle callback clears its reducer.
    private var preview: Bool {
        scope != nil && coordinator.state.scope == scope && context != nil
            && coordinator.state.availability == .localPreviewOnly
    }
    var body: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s4) {
            Text("poll.title").font(NativeTypography.heading).accessibilityAddTraits(.isHeader)
            Text(LocalizedStringKey(preview ? "poll.local_preview" : "poll.unprovisioned"))
                .font(NativeTypography.emphasis).foregroundStyle(palette.ink2)
            Text("poll.disclosure").font(NativeTypography.body)
                .fixedSize(horizontal: false, vertical: true)
            if scope == nil {
                Text("poll.channel_unavailable").font(NativeTypography.caption).foregroundStyle(palette.ink2)
            }
            if preview {
                Text(verbatim: coordinator.state.question).font(NativeTypography.heading)
                    .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                Text(LocalizedStringKey(coordinator.state.allowsMultipleChoices ? "poll.multiple" : "poll.single"))
                    .font(NativeTypography.caption).foregroundStyle(palette.ink2)
                ForEach(coordinator.state.options, id: \.id) { option in
                    Button { try? coordinator.toggleOption(option.id, context: context) } label: {
                        VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
                            Text(verbatim: option.label).font(NativeTypography.emphasis)
                            Text(String(format: NSLocalizedString("poll.option_result", comment: ""),
                                        option.voteCount, option.percentage)).font(NativeTypography.caption)
                        }
                        .foregroundStyle(palette.accentInk)
                        .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.bordered)
                    .disabled(coordinator.state.isClosed)
                    .accessibilityAddTraits(option.isSelectedByCurrentUser ? .isSelected : [])
                    .accessibilityHint(Text("poll.vote_hint"))
                }
                Text(String(format: NSLocalizedString("poll.total_votes", comment: ""), coordinator.state.totalVotes))
                    .font(NativeTypography.caption).foregroundStyle(palette.ink2)
                Text(LocalizedStringKey(coordinator.state.isClosed ? "poll.closed" : "poll.open"))
                    .font(NativeTypography.emphasis).foregroundStyle(palette.ink2)
                Button { try? coordinator.closePoll(context: context) } label: {
                    Text("poll.close").font(NativeTypography.emphasis).foregroundStyle(palette.accentInk)
                        .frame(maxWidth: .infinity, minHeight: KoderaTokens.Space.s12)
                }
                .buttonStyle(.bordered)
                .disabled(coordinator.state.isClosed)
                .accessibilityHint(Text("poll.close_hint"))
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
