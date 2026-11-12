import Foundation

/// The Console's configured origin, validated and held. The app does not open it: the Console is where
/// the organisation's commercial pages live, and this companion app links to no page outside sign-in. An owner finishes
/// setting up their organisation on the web on their own; the app never consumes an owner claim itself.
public enum ConsoleOrigin {
    /// The configured origin as a URL, unchanged, when it passes `IssuerAdmission.validateOrigin`, the
    /// validator of every other configured origin: HTTPS, or plain-HTTP loopback with `.admitForDevelopment`
    /// only. Nil when it is unset or refused. No screen offers a Console action either way.
    public static func admit(_ configured: String, loopback: LoopbackPolicy) -> URL? {
        guard !configured.isEmpty, (try? IssuerAdmission.validateOrigin(configured, loopback: loopback)) != nil,
              let url = URL(string: configured), url.absoluteString == configured else { return nil }
        return url
    }
}
