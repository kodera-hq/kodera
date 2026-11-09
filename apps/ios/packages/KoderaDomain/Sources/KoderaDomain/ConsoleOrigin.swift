import Foundation

/// Where a signed-in member with no organisation yet is sent: the Console, opened in the system browser at
/// exactly its configured origin. An owner finishes setting up their organisation there; the app never
/// consumes an owner claim itself.
public enum ConsoleOrigin {
    /// The configured origin as a URL, unchanged, when it passes `IssuerAdmission.validateOrigin`, the
    /// validator of every other configured origin: HTTPS, or plain-HTTP loopback with `.admitForDevelopment`
    /// only. Nil when it is unset or refused, and then the app offers no Console action.
    public static func admit(_ configured: String, loopback: LoopbackPolicy) -> URL? {
        guard !configured.isEmpty, (try? IssuerAdmission.validateOrigin(configured, loopback: loopback)) != nil,
              let url = URL(string: configured), url.absoluteString == configured else { return nil }
        return url
    }
}
