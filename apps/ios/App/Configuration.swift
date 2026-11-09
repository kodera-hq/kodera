import Foundation
import KoderaAuth
import KoderaDomain

/// Deployment values come only from build settings substituted into Info.plist
/// (`Config/Kodera.xcconfig`, overridden by an untracked `Config/Local.xcconfig`), never from form
/// values, deep links or responses. A build without them is unconfigured and says so. The reading itself
/// is `AppConfiguration.read` (KoderaAuth), where host tests reach it; this build passes it its own policies.
extension AppConfiguration {
    /// Plain-HTTP loopback origins are a development convenience compiled out of release builds.
    static let loopback: LoopbackPolicy = {
        #if DEBUG
        .admitForDevelopment
        #else
        .refuse
        #endif
    }()

    /// The development realm entry is offered by Debug builds only.
    private static let admitsDevelopmentIssuer: Bool = {
        #if DEBUG
        true
        #else
        false
        #endif
    }()

    static func bundled(in bundle: Bundle = .main) -> AppConfiguration {
        read({ key in
            (bundle.object(forInfoDictionaryKey: key) as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
        }, loopback: loopback, admitsDevelopmentIssuer: admitsDevelopmentIssuer)
    }
}
