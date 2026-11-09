import Foundation
import KoderaDomain
#if canImport(Combine)
import Combine
public typealias WorkspacePreferencesObservable = ObservableObject
public typealias WorkspacePublished<Value> = Published<Value>
#else
public protocol WorkspacePreferencesObservable: AnyObject {}
@propertyWrapper public struct WorkspacePublished<Value> {
    public var wrappedValue: Value
    public init(wrappedValue: Value) { self.wrappedValue = wrappedValue }
}
#endif

/// A local draft lifetime only, never authenticated membership or remote editing authority.
public struct WorkspacePreferencesScope: Equatable, Sendable {
    public let organisationId: String, channelId: String
    public init(organisationId: String, channelId: String) throws {
        guard organisationId.utf8.count == 36, organisationId != "00000000-0000-0000-0000-000000000000" else {
            throw WorkspacePreferencesError.unavailable
        }
        let checked = try ChannelPollScope(organisationId: organisationId, channelId: channelId)
        self.organisationId = checked.organisationId; self.channelId = checked.channelId
    }
    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.organisationId == rhs.organisationId && lhs.channelId.utf8.elementsEqual(rhs.channelId.utf8)
    }
}
public struct WorkspacePreferencesContext: Sendable {
    fileprivate let owner: UUID, generation: UUID
    fileprivate let scope: WorkspacePreferencesScope
}

/// Explicit local preview edits; a selected role is never sent to an authorization service.
@MainActor public final class WorkspacePreferencesController: WorkspacePreferencesObservable {
    @WorkspacePublished public private(set) var themeMode: KoderaThemeMode = .black
    @WorkspacePublished public private(set) var activeThemeSpec = ShareableThemeCodec.curatedPresets[0]
    @WorkspacePublished public private(set) var shareCode = ""
    @WorkspacePublished public private(set) var profile: KoderaUserProfile?
    @WorkspacePublished public private(set) var activeDocsPad: DocsPadDraft?
    @WorkspacePublished public private(set) var lastError: WorkspacePreferencesError?
    @WorkspacePublished public private(set) var scope: WorkspacePreferencesScope?
    @WorkspacePublished public private(set) var isPreviewing = false
    public private(set) var isStopped = false
    private let owner = UUID()
    private var generation = UUID()
    public init() {}

    public func beginLocalPreview(scope: WorkspacePreferencesScope, profile: KoderaUserProfile, title: String) throws -> WorkspacePreferencesContext {
        guard !isStopped else { throw WorkspacePreferencesError.stopped }
        let draft = try DocsPadDraft(padId: "local-preview", channelId: scope.channelId, title: title, markdownBody: "", updatedBy: profile.userId)
        let theme = ShareableThemeCodec.curatedPresets[0]
        let code = try ShareableThemeCodec.encode(theme)
        generation = UUID(); self.scope = scope; self.profile = profile; activeDocsPad = draft
        themeMode = .black; activeThemeSpec = theme; shareCode = code; lastError = nil; isPreviewing = true
        return WorkspacePreferencesContext(owner: owner, generation: generation, scope: scope)
    }
    public func selectThemeMode(_ mode: KoderaThemeMode, context: WorkspacePreferencesContext?) throws {
        try checked(context) {
            guard let next = ShareableThemeCodec.curatedPresets.first(where: { $0.baseMode == mode }) else {
                throw WorkspacePreferencesError.invalidTheme
            }
            let code = try ShareableThemeCodec.encode(next)
            activeThemeSpec = next; shareCode = code; themeMode = mode
        }
    }
    public func applyPreset(id: String, context: WorkspacePreferencesContext?) throws {
        try checked(context) {
            guard let next = ShareableThemeCodec.curatedPresets.first(where: { $0.id == id }) else { throw WorkspacePreferencesError.invalidTheme }
            let code = try ShareableThemeCodec.encode(next)
            activeThemeSpec = next; shareCode = code; themeMode = next.baseMode
        }
    }
    public func importShareCode(_ code: String, context: WorkspacePreferencesContext?) throws {
        try checked(context) {
            let next = try ShareableThemeCodec.decode(code)
            let canonical = try ShareableThemeCodec.encode(next)
            activeThemeSpec = next; shareCode = canonical; themeMode = next.baseMode
        }
    }
    public func updateProfile(displayName: String, handle: String, roleTitle: String, presence: KoderaPresenceStatus, rank: KoderaRoleRank, context: WorkspacePreferencesContext?) throws {
        try checked(context) {
            guard let profile else { throw WorkspacePreferencesError.unavailable }
            self.profile = try KoderaUserProfile(userId: profile.userId, displayName: displayName, handle: handle, roleTitle: roleTitle, presence: presence, rank: rank)
        }
    }
    public func updateDocsPad(title: String, markdownBody: String, context: WorkspacePreferencesContext?) throws {
        try checked(context) {
            guard let activeDocsPad, let profile else { throw WorkspacePreferencesError.unavailable }
            self.activeDocsPad = try activeDocsPad.updating(title: title, markdownBody: markdownBody, actor: profile.userId)
        }
    }
    public func evaluateAccess(for policy: ChannelIamPolicy, context: WorkspacePreferencesContext?) -> ChannelIamDecision {
        guard valid(context), policy.channelId.utf8.elementsEqual(scope!.channelId.utf8), let profile else { return .denied }
        return policy.evaluate(rank: profile.rank)
    }
    public func previewMatches(_ context: WorkspacePreferencesContext?, scope: WorkspacePreferencesScope?) -> Bool {
        scope == self.scope && valid(context)
    }
    public func leavePreview(context: WorkspacePreferencesContext?) { if valid(context) { clear() } }
    /// Owner teardown is always available. A stopped controller cannot be re-provisioned.
    public func clear() {
        generation = UUID(); scope = nil; profile = nil; activeDocsPad = nil; isPreviewing = false
        shareCode = ""; activeThemeSpec = ShareableThemeCodec.curatedPresets[0]; themeMode = .black; lastError = nil
    }
    public func stop() { clear(); isStopped = true }
    private func valid(_ context: WorkspacePreferencesContext?) -> Bool {
        guard let context else { return false }
        return !isStopped && isPreviewing && context.owner == owner && context.generation == generation && context.scope == scope
    }
    private func checked(_ context: WorkspacePreferencesContext?, action: () throws -> Void) throws {
        guard valid(context) else { throw WorkspacePreferencesError.staleContext }
        do { try action(); lastError = nil }
        catch let error as WorkspacePreferencesError { lastError = error; throw error }
        catch { lastError = .unavailable; throw WorkspacePreferencesError.unavailable }
    }
}
