import SwiftUI

@main
@MainActor
struct KoderaApp: App {
    @StateObject private var session = AppSessionModel(configuration: .bundled())

    var body: some Scene {
        WindowGroup {
            RootView(session: session)
        }
    }
}

/// Organisation entry while signed out, the member screen while signed in.
@MainActor
struct RootView: View {
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var session: AppSessionModel

    var body: some View {
        ZStack {
            switch session.phase {
            case .signedIn: SignedInView(session: session)
            // Launch resumes the session with a silent refresh, which can take a moment.
            case .restoring: RestoringView()
            case .signedOut, .signingIn: OrganisationEntryView(session: session)
            }
        }
        .onAppear { session.setForeground(scenePhase == .active) }
        .onChange(of: scenePhase) { phase in session.setForeground(phase == .active) }
        .onDisappear { session.setForeground(false) }
        .task { await session.start() }
    }
}

/// Shown while the stored session is resumed at launch, instead of an entry screen that would flash.
@MainActor
struct RestoringView: View {
    @Environment(\.colorScheme) private var colorScheme

    private var palette: KoderaTokens.Palette {
        KoderaTokens.cielPalette(for: colorScheme)
    }

    var body: some View {
        VStack(spacing: KoderaTokens.Space.s4) {
            Text("brand.name")
                .font(NativeTypography.wordmark)
                .foregroundStyle(palette.action)
                .accessibilityHidden(true)
            ProgressView("session.restoring")
                .font(NativeTypography.body)
                .foregroundStyle(palette.ink2)
                .tint(palette.action)
                .accessibilityLabel(Text("session.restoring"))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.page.ignoresSafeArea())
    }
}
