import Foundation
import KoderaClient
import KoderaDomain

/// The app's deployment values. The app reads them only from build settings substituted into Info.plist
/// (`AppConfiguration.bundled()` in the app target), never from form values, deep links or responses. A build
/// without them is unconfigured and says so. Here so that host tests reach the reading itself.
public struct AppConfiguration: Sendable {
    public let discoveryConfiguration: CoreDiscoveryConfiguration?
    public let signIn: SignInConfiguration?
    public let coreApiOrigin: String?
    /// Development builds only: a realm issuer to sign in to without Core discovery.
    public let developmentIssuer: String?
    /// The validated Console origin, or nil. Held only: no screen opens it (the app links to no commercial page).
    public let consoleOrigin: URL?

    public static let unconfigured = AppConfiguration(discoveryConfiguration: nil, signIn: nil, coreApiOrigin: nil,
                                                      developmentIssuer: nil, consoleOrigin: nil)

    /// Reads the deployment from `value`, a build setting by its Info.plist key (trimmed, empty when unset).
    /// `loopback` is the build's policy and every origin goes through the one validator with it, the Console's
    /// included: a Release build passes `.refuse`, and then a plain-HTTP origin is refused. `admitsDevelopmentIssuer`
    /// is the build's too, true in Debug builds only.
    public static func read(_ value: (String) -> String, loopback: LoopbackPolicy,
                            admitsDevelopmentIssuer: Bool) -> AppConfiguration {
        let core = value("KoderaCoreOrigin")
        let issuerList = value("KoderaIssuerOrigins").split(separator: " ").map(String.init)
        let issuers = Set(issuerList)
        guard !core.isEmpty, !issuers.isEmpty, issuers.count == issuerList.count else { return .unconfigured }

        // One origin validator for discovery and sign-in, so a Debug build discovers against a loopback Core.
        let discovery = try? CoreDiscoveryConfiguration(coreApiOrigin: core, admittedIssuerOrigins: issuers,
                                                        loopback: loopback)
        // Off unless the build setting says exactly YES: the organisation realms do not offer it yet (I-2b).
        let offlineAccess = value("KoderaOfflineAccess") == "YES"
        let signIn = try? SignInConfiguration(clientID: value("KoderaClientID"), admittedIssuerOrigins: issuers,
                                              loopback: loopback, offlineAccess: offlineAccess)
        let coreOrigin = (try? IssuerAdmission.validateOrigin(core, loopback: loopback)) == nil ? nil : core
        // The same origin validator: HTTPS, or loopback in a Debug build only.
        let console = ConsoleOrigin.admit(value("KoderaConsoleOrigin"), loopback: loopback)
        var development: String?
        if admitsDevelopmentIssuer {
            let candidate = value("KoderaDevelopmentIssuer")
            if !candidate.isEmpty,
               (try? IssuerAdmission.admit(issuer: candidate, admittedOrigins: issuers, loopback: loopback)) != nil {
                development = candidate
            }
        }
        return AppConfiguration(discoveryConfiguration: discovery, signIn: signIn, coreApiOrigin: coreOrigin,
                                developmentIssuer: development, consoleOrigin: console)
    }
}
