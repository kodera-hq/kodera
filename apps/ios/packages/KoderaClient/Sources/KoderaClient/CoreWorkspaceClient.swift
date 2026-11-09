import Foundation
import KoderaDomain

public enum WorkspaceState: String, Equatable, Sendable { case notInitialised = "not_initialised", initialised }
public enum WorkspaceSetupState: String, Equatable, Sendable { case pending, running, ready, failed }
public enum WorkspaceSetupReason: String, Equatable, Sendable {
    case awaitingOwnerConfirmation = "awaiting_owner_confirmation"
    case issuerUntrusted = "issuer_untrusted"
    case realmJobFailed = "realm_job_failed"
}
public enum WorkspaceChannelKind: String, Equatable, Sendable { case text, audio }
public enum WorkspaceChannelLifecycle: String, Equatable, Sendable { case active, archived }
public enum WorkspaceChannelRoomState: String, Equatable, Sendable { case pending, ready, failed }

public struct WorkspaceSetup: Equatable, Sendable {
    public let state: WorkspaceSetupState
    public let reason: WorkspaceSetupReason?
}

/// Server-filtered metadata only. A ready room does not establish current Matrix access.
public struct WorkspaceChannel: Equatable, Sendable {
    public let id: String
    public let kind: WorkspaceChannelKind
    public let name: String
    public let templateKey: String?
    public let topic: String
    public let lifecycle: WorkspaceChannelLifecycle
    public let roomState: WorkspaceChannelRoomState
}

public struct WorkspaceCategory: Equatable, Sendable {
    public let id: String
    public let name: String
    public let templateKey: String?
    public let channels: [WorkspaceChannel]
}

/// One caller's ordered view; never messages, room identifiers, occupancy or provider authority.
public struct WorkspaceSnapshot: Equatable, Sendable {
    public let organisationId: String
    public let state: WorkspaceState
    public let setup: WorkspaceSetup
    public let canInitialise: Bool
    public let id: String?
    public let categories: [WorkspaceCategory]
    public let uncategorisedChannels: [WorkspaceChannel]
}

public enum WorkspaceFailure: Error, Equatable, Sendable {
    case protocolViolation, forbidden, notFound, serviceUnavailable, identityUnavailable
    case transport(TransportFailure)
}

public enum WorkspaceOutcome: Equatable, Sendable {
    case loaded(WorkspaceSnapshot)
    case signedOut
    /// The session ended, but its stored copy could not be wiped. Preserve the owner's warning.
    case signedOutNotWiped
    case unavailable(WorkspaceFailure)
}

/// An unconditional, uncached `getWorkspace` read through the session's `CoreRequester`.
/// The caller supplies an organisation from its current membership; Core authorises it again.
/// Owns no requester lifecycle, token, cache or provider connection. A consumer must fence an
/// already-sent answer against its session before presenting it.
public actor CoreWorkspaceClient {
    private let requester: CoreRequester

    public init(requester: CoreRequester) { self.requester = requester }

    public func fetch(organisationId: String) async -> WorkspaceOutcome {
        guard TrustPolicy.canonicalNonNilUUID(organisationId) else { return .unavailable(.protocolViolation) }
        switch await requester.get(path: "/api/v1/organisations/\(organisationId)/workspace") {
        case let .answered(status, body):
            switch status {
            case 200:
                guard let workspace = try? Self.decode(body, organisationId: organisationId) else {
                    return .unavailable(.protocolViolation)
                }
                return .loaded(workspace)
            case 404: return .unavailable(.notFound)
            case 429, 500...599: return .unavailable(.serviceUnavailable)
            // No conditional request or cached view: an unsolicited 304 is not an empty workspace.
            default: return .unavailable(.protocolViolation)
            }
        case .forbidden: return .unavailable(.forbidden)
        case .signedOut: return .signedOut
        case .signedOutNotWiped: return .signedOutNotWiped
        case .identityUnavailable: return .unavailable(.identityUnavailable)
        case .redirected, .tooLarge, .pathRefused: return .unavailable(.protocolViolation)
        case let .transport(reason): return .unavailable(.transport(reason))
        }
    }

    static func decode(_ data: Data, organisationId: String) throws -> WorkspaceSnapshot {
        let root = try object(StrictJSON.parse(data), fields: ["organisation_id", "state", "setup", "can_initialise", "id", "categories", "uncategorised_channels"])
        let returnedOrganisation = try uuid(root["organisation_id"])
        guard TrustPolicy.canonicalNonNilUUID(organisationId), returnedOrganisation == organisationId,
              let state = WorkspaceState(rawValue: try text(root["state"])),
              let canInitialiseValue = root["can_initialise"], case let .boolean(canInitialise) = canInitialiseValue,
              let categoryValues = root["categories"]?.array,
              let uncategorisedValues = root["uncategorised_channels"]?.array else {
            throw WorkspaceFailure.protocolViolation
        }
        let setup = try setup(root["setup"])
        let id = try optionalText(root["id"])
        if let id, !TrustPolicy.canonicalNonNilUUID(id) { throw WorkspaceFailure.protocolViolation }
        let categories = try categoryValues.map(category)
        let uncategorised = try uncategorisedValues.map(channel)
        switch state {
        case .notInitialised:
            guard id == nil, categories.isEmpty, uncategorised.isEmpty else { throw WorkspaceFailure.protocolViolation }
        case .initialised:
            guard id != nil, !canInitialise else { throw WorkspaceFailure.protocolViolation }
        }
        guard !canInitialise || setup.state == .ready else { throw WorkspaceFailure.protocolViolation }
        return WorkspaceSnapshot(organisationId: returnedOrganisation, state: state, setup: setup,
            canInitialise: canInitialise, id: id, categories: categories, uncategorisedChannels: uncategorised)
    }

    private static func setup(_ value: StrictJSONValue?) throws -> WorkspaceSetup {
        let fields = try object(value, fields: ["state", "reason"])
        guard let state = WorkspaceSetupState(rawValue: try text(fields["state"])) else { throw WorkspaceFailure.protocolViolation }
        let rawReason = try optionalText(fields["reason"])
        let reason: WorkspaceSetupReason?
        if let rawReason {
            guard let decoded = WorkspaceSetupReason(rawValue: rawReason) else { throw WorkspaceFailure.protocolViolation }
            reason = decoded
        } else { reason = nil }
        switch reason {
        case .awaitingOwnerConfirmation:
            guard state == .pending else { throw WorkspaceFailure.protocolViolation }
        case .issuerUntrusted, .realmJobFailed:
            guard state == .failed else { throw WorkspaceFailure.protocolViolation }
        case nil: break
        }
        return WorkspaceSetup(state: state, reason: reason)
    }

    private static func category(_ value: StrictJSONValue) throws -> WorkspaceCategory {
        let fields = try object(value, fields: ["id", "name", "template_key", "channels"])
        guard let channels = fields["channels"]?.array else { throw WorkspaceFailure.protocolViolation }
        return try WorkspaceCategory(id: uuid(fields["id"]), name: name(fields["name"]),
            templateKey: templateKey(fields["template_key"]), channels: channels.map(channel))
    }

    private static func channel(_ value: StrictJSONValue) throws -> WorkspaceChannel {
        let fields = try object(value, fields: ["id", "kind", "name", "template_key", "topic", "lifecycle", "room_state"])
        guard let kind = WorkspaceChannelKind(rawValue: try text(fields["kind"])),
              let lifecycle = WorkspaceChannelLifecycle(rawValue: try text(fields["lifecycle"])),
              let roomState = WorkspaceChannelRoomState(rawValue: try text(fields["room_state"])) else {
            throw WorkspaceFailure.protocolViolation
        }
        let topic = try text(fields["topic"])
        guard topic.unicodeScalars.count <= 1024 else { throw WorkspaceFailure.protocolViolation }
        return try WorkspaceChannel(id: uuid(fields["id"]), kind: kind, name: name(fields["name"]),
            templateKey: templateKey(fields["template_key"]), topic: topic, lifecycle: lifecycle, roomState: roomState)
    }

    private static func object(_ value: StrictJSONValue?, fields: Set<String>) throws -> [String: StrictJSONValue] {
        guard let object = value?.object, Set(object.keys) == fields else { throw WorkspaceFailure.protocolViolation }
        return object
    }

    private static func text(_ value: StrictJSONValue?) throws -> String {
        guard let text = value?.string else { throw WorkspaceFailure.protocolViolation }
        return text
    }

    private static func optionalText(_ value: StrictJSONValue?) throws -> String? {
        guard let value else { throw WorkspaceFailure.protocolViolation }
        if value.isNull { return nil }
        return try text(value)
    }

    private static func uuid(_ value: StrictJSONValue?) throws -> String {
        let id = try text(value)
        guard TrustPolicy.canonicalNonNilUUID(id) else { throw WorkspaceFailure.protocolViolation }
        return id
    }

    private static func name(_ value: StrictJSONValue?) throws -> String {
        let name = try text(value)
        guard (1...100).contains(name.unicodeScalars.count),
              !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw WorkspaceFailure.protocolViolation }
        return name
    }

    private static func templateKey(_ value: StrictJSONValue?) throws -> String? {
        guard let key = try optionalText(value) else { return nil }
        let bytes = Array(key.utf8)
        guard (1...32).contains(bytes.count), let first = bytes.first, (97...122).contains(first),
              bytes.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 95 }) else {
            throw WorkspaceFailure.protocolViolation
        }
        return key
    }
}
