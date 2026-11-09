import Foundation

/// A Keychain item outlives the app: deleting and reinstalling it leaves the item in place, while the
/// app's UserDefaults are removed with it. A marker in UserDefaults therefore tells a first launch after
/// an install from a relaunch, and the first launch wipes whatever session a previous install left.
public enum FirstLaunch {
    public static let markerKey = "io.kodera.app.session.installed"

    /// Run before `restore()`. Wipes the stored session unless this install has launched before, then sets
    /// the marker. A wipe that fails throws and leaves the marker unset, so the next launch tries again; the
    /// caller must not restore a session after a failure.
    public static func wipeIfNewInstall(store: any TokenStore, defaults: UserDefaults) throws(TokenStoreFailure) {
        guard !defaults.bool(forKey: markerKey) else { return }
        try store.wipe()
        defaults.set(true, forKey: markerKey)
    }

    /// After a wipe that failed: the next launch wipes again before it restores anything, and restores
    /// nothing if that wipe fails too.
    public static func requireWipe(defaults: UserDefaults) {
        defaults.removeObject(forKey: markerKey)
    }
}
