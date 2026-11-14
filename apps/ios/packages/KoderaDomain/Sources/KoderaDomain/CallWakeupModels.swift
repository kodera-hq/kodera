import Foundation

public enum CallWakeupError: Error, Equatable, Sendable {
    case invalidPayloadFormat
    case cleartextPayloadForbidden(field: String)
    case unexpectedPushField(field: String)
    case invalidWakeupId
    case invalidOrganisationId
    case invalidSyncHint
    case invalidCallDescriptor
    case replayWakeup
    case organisationMismatch
    case invalidTransition
    case stopped
}

public enum CallPushAdmissionPolicy: Equatable, Sendable {
    /// Rejects the push outright if any cleartext room/sender/message field or unknown field appears.
    case rejectCleartext
    /// Strips untrusted/cleartext relay fields while admitting only validated opaque sync identifiers.
    case stripUntrustedRelayFields
}

public struct PayloadFreePushResult: Equatable, Sendable {
    public let envelope: PayloadFreePushEnvelope
    public let strippedFieldNames: Set<String>

    public init(envelope: PayloadFreePushEnvelope, strippedFieldNames: Set<String>) {
        self.envelope = envelope
        self.strippedFieldNames = strippedFieldNames
    }
}

/// Core's payload-free VoIP/APNs wakeup envelope.
/// Zero room titles, sender display names, message plaintext, or media tokens may traverse push relays.
public struct PayloadFreePushEnvelope: Equatable, Hashable, Sendable {
    public static let maximumSyncHintBytes = 128

    private static let admittedTopLevelFields: Set<String> = [
        "wakeup_id", "organisation_id", "sync_hint", "aps",
    ]
    private static let admittedAPSFields: Set<String> = [
        "content-available",
    ]
    private static let forbiddenCleartextMarkers: Set<String> = [
        "room_title", "roomtitle", "room_name", "roomname", "channel_name", "channelname",
        "sender_name", "sendername", "sender_display_name", "caller_name", "callername",
        "display_name", "displayname", "message", "body", "plaintext", "text", "content",
        "topic", "subject", "title", "subtitle", "alert", "avatar_url", "matrix_event",
        "sdp", "livekit_token", "access_token",
    ]

    public let wakeupId: String
    public let organisationId: String
    public let syncHint: String

    public init(wakeupId: String, organisationId: String, syncHint: String) throws {
        guard TrustPolicy.canonicalNonNilUUID(wakeupId) else {
            throw CallWakeupError.invalidWakeupId
        }
        guard TrustPolicy.canonicalNonNilUUID(organisationId) else {
            throw CallWakeupError.invalidOrganisationId
        }
        guard Self.isValidSyncHint(syncHint) else {
            throw CallWakeupError.invalidSyncHint
        }
        self.wakeupId = wakeupId
        self.organisationId = organisationId
        self.syncHint = syncHint
    }

    public static func admit(
        jsonData: Data,
        policy: CallPushAdmissionPolicy = .rejectCleartext
    ) throws -> PayloadFreePushResult {
        guard jsonData.count <= 4096,
              let rawObject = try? JSONSerialization.jsonObject(with: jsonData, options: []),
              let dictionary = rawObject as? [String: Any] else {
            throw CallWakeupError.invalidPayloadFormat
        }
        return try admit(jsonObject: dictionary, policy: policy)
    }

    public static func admit(
        jsonObject: [String: Any],
        policy: CallPushAdmissionPolicy = .rejectCleartext
    ) throws -> PayloadFreePushResult {
        var stripped = Set<String>()

        for (key, value) in jsonObject {
            if isForbiddenCleartextKey(key) {
                switch policy {
                case .rejectCleartext:
                    throw CallWakeupError.cleartextPayloadForbidden(field: key)
                case .stripUntrustedRelayFields:
                    stripped.insert(key)
                    continue
                }
            }
            if !admittedTopLevelFields.contains(key) {
                if let nested = value as? [String: Any], let leaked = firstForbiddenNestedKey(in: nested) {
                    switch policy {
                    case .rejectCleartext:
                        throw CallWakeupError.cleartextPayloadForbidden(field: "\(key).\(leaked)")
                    case .stripUntrustedRelayFields:
                        stripped.insert("\(key).\(leaked)")
                        stripped.insert(key)
                        continue
                    }
                }
                switch policy {
                case .rejectCleartext:
                    throw CallWakeupError.unexpectedPushField(field: key)
                case .stripUntrustedRelayFields:
                    stripped.insert(key)
                    continue
                }
            }
            if key == "aps" {
                guard let aps = value as? [String: Any] else {
                    throw CallWakeupError.invalidPayloadFormat
                }
                for (apsKey, _) in aps {
                    if isForbiddenCleartextKey(apsKey) {
                        switch policy {
                        case .rejectCleartext:
                            throw CallWakeupError.cleartextPayloadForbidden(field: "aps.\(apsKey)")
                        case .stripUntrustedRelayFields:
                            stripped.insert("aps.\(apsKey)")
                        }
                    } else if !admittedAPSFields.contains(apsKey) {
                        switch policy {
                        case .rejectCleartext:
                            throw CallWakeupError.unexpectedPushField(field: "aps.\(apsKey)")
                        case .stripUntrustedRelayFields:
                            stripped.insert("aps.\(apsKey)")
                        }
                    }
                }
            }
        }

        guard let wakeupId = jsonObject["wakeup_id"] as? String else {
            throw CallWakeupError.invalidWakeupId
        }
        guard let organisationId = jsonObject["organisation_id"] as? String else {
            throw CallWakeupError.invalidOrganisationId
        }
        guard let syncHint = jsonObject["sync_hint"] as? String else {
            throw CallWakeupError.invalidSyncHint
        }

        let envelope = try PayloadFreePushEnvelope(
            wakeupId: wakeupId,
            organisationId: organisationId,
            syncHint: syncHint
        )
        return PayloadFreePushResult(envelope: envelope, strippedFieldNames: stripped)
    }

    private static func isForbiddenCleartextKey(_ key: String) -> Bool {
        let normalized = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return forbiddenCleartextMarkers.contains(normalized)
    }

    private static func firstForbiddenNestedKey(in dictionary: [String: Any]) -> String? {
        for key in dictionary.keys.sorted() {
            if isForbiddenCleartextKey(key) { return key }
            if let child = dictionary[key] as? [String: Any], let found = firstForbiddenNestedKey(in: child) {
                return "\(key).\(found)"
            }
        }
        return nil
    }

    private static func isValidSyncHint(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard (1...maximumSyncHintBytes).contains(bytes.count) else { return false }
        return bytes.allSatisfy { byte in
            (byte >= 0x30 && byte <= 0x39)
                || (byte >= 0x41 && byte <= 0x5A)
                || (byte >= 0x61 && byte <= 0x7A)
                || byte == 0x2D || byte == 0x2E || byte == 0x5F || byte == 0x3A
        }
    }
}

/// Validated incoming wakeup correlated to a CallKit `UUID`. Holds zero cleartext room or caller strings.
public struct IncomingCallWakeup: Equatable, Sendable {
    public let callUUID: UUID
    public let envelope: PayloadFreePushEnvelope

    public var wakeupId: String { envelope.wakeupId }
    public var organisationId: String { envelope.organisationId }
    public var syncHint: String { envelope.syncHint }

    public init(envelope: PayloadFreePushEnvelope, callUUID: UUID? = nil) {
        self.envelope = envelope
        self.callUUID = callUUID ?? UUID(uuidString: envelope.wakeupId) ?? UUID()
    }
}

/// Encrypted call metadata resolved strictly over the authenticated Core / MatrixRTC session.
public struct VerifiedCallDescriptor: Equatable, Sendable {
    public let wakeupId: String
    public let organisationId: String
    public let roomId: String
    public let liveKitRoomName: String
    public let callerLabel: String
    public let hasVideo: Bool

    public init(
        wakeupId: String,
        organisationId: String,
        roomId: String,
        liveKitRoomName: String,
        callerLabel: String,
        hasVideo: Bool
    ) throws {
        guard TrustPolicy.canonicalNonNilUUID(wakeupId),
              TrustPolicy.canonicalNonNilUUID(organisationId),
              VoiceCallScope.boundedText(roomId),
              Self.isOpaqueRoomName(liveKitRoomName),
              VoiceCallScope.boundedText(callerLabel) else {
            throw CallWakeupError.invalidCallDescriptor
        }
        self.wakeupId = wakeupId
        self.organisationId = organisationId
        self.roomId = roomId
        self.liveKitRoomName = liveKitRoomName
        self.callerLabel = callerLabel
        self.hasVideo = hasVideo
    }

    private static func isOpaqueRoomName(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard (1...128).contains(bytes.count) else { return false }
        return bytes.allSatisfy { byte in
            (byte >= 0x30 && byte <= 0x39)
                || (byte >= 0x41 && byte <= 0x5A)
                || (byte >= 0x61 && byte <= 0x7A)
                || byte == 0x2D || byte == 0x2E || byte == 0x5F || byte == 0x3A
        }
    }
}

public enum CallEndReason: String, Equatable, Sendable {
    case localHangup
    case remoteEnded
    case declined
    case unansweredTimeout
    case organisationChanged
}

public enum CallFailureReason: Equatable, Sendable {
    case untrustedPushPayload
    case replayWakeup
    case organisationMismatch
    case unauthenticatedSession
    case callResolutionFailed
    case transportDisconnected
    case callKitRejected
}

public enum CallSessionPhase: Equatable, Sendable {
    case idle
    case ringing(IncomingCallWakeup, VerifiedCallDescriptor)
    case connecting(IncomingCallWakeup, VerifiedCallDescriptor)
    case active(IncomingCallWakeup, VerifiedCallDescriptor, isMuted: Bool, isHeld: Bool, isVideoEnabled: Bool)
    case ended(CallEndReason)
    case failed(CallFailureReason)
}

/// Deterministic OS call state machine (`idle -> ringing -> connecting -> active -> muted/held -> ended/failed`).
public struct CallSessionState: Equatable, Sendable {
    public static let maximumTrackedWakeups = 128

    public private(set) var organisationId: String?
    public private(set) var phase: CallSessionPhase = .idle
    private var seenWakeupIds: [String] = []
    private var seenWakeupSet: Set<String> = []

    public init(organisationId: String? = nil) throws {
        if let organisationId {
            guard TrustPolicy.canonicalNonNilUUID(organisationId) else {
                throw CallWakeupError.invalidOrganisationId
            }
        }
        self.organisationId = organisationId
    }

    public var activeCallUUID: UUID? {
        switch phase {
        case let .ringing(wakeup, _),
             let .connecting(wakeup, _),
             let .active(wakeup, _, _, _, _):
            return wakeup.callUUID
        case .idle, .ended, .failed:
            return nil
        }
    }

    public var isMuted: Bool {
        if case let .active(_, _, muted, _, _) = phase { return muted }
        return false
    }

    public var isHeld: Bool {
        if case let .active(_, _, _, held, _) = phase { return held }
        return false
    }

    public var isVideoEnabled: Bool {
        switch phase {
        case let .ringing(_, descriptor), let .connecting(_, descriptor):
            return descriptor.hasVideo
        case let .active(_, _, _, _, video):
            return video
        case .idle, .ended, .failed:
            return false
        }
    }

    public mutating func configureOrganisation(_ incomingOrganisationId: String?) throws {
        if let incomingOrganisationId {
            guard TrustPolicy.canonicalNonNilUUID(incomingOrganisationId) else {
                throw CallWakeupError.invalidOrganisationId
            }
        }
        if organisationId != incomingOrganisationId {
            switch phase {
            case .ringing, .connecting, .active:
                phase = .ended(.organisationChanged)
            case .idle, .ended, .failed:
                phase = .idle
            }
            seenWakeupIds.removeAll()
            seenWakeupSet.removeAll()
            organisationId = incomingOrganisationId
        }
    }

    public mutating func beginRinging(
        wakeup: IncomingCallWakeup,
        descriptor: VerifiedCallDescriptor
    ) throws {
        switch phase {
        case .idle, .ended, .failed:
            break
        case .ringing, .connecting, .active:
            throw CallWakeupError.invalidTransition
        }
        guard let currentOrg = organisationId,
              wakeup.organisationId == currentOrg,
              descriptor.organisationId == currentOrg,
              descriptor.wakeupId == wakeup.wakeupId else {
            phase = .failed(.organisationMismatch)
            throw CallWakeupError.organisationMismatch
        }
        guard !seenWakeupSet.contains(wakeup.wakeupId) else {
            phase = .failed(.replayWakeup)
            throw CallWakeupError.replayWakeup
        }
        recordWakeup(wakeup.wakeupId)
        phase = .ringing(wakeup, descriptor)
    }

    public mutating func acceptAnswer() throws {
        guard case let .ringing(wakeup, descriptor) = phase else {
            throw CallWakeupError.invalidTransition
        }
        phase = .connecting(wakeup, descriptor)
    }

    public mutating func declineIncoming() throws {
        guard case .ringing = phase else {
            throw CallWakeupError.invalidTransition
        }
        phase = .ended(.declined)
    }

    public mutating func markConnected() throws {
        guard case let .connecting(wakeup, descriptor) = phase else {
            throw CallWakeupError.invalidTransition
        }
        phase = .active(
            wakeup,
            descriptor,
            isMuted: false,
            isHeld: false,
            isVideoEnabled: descriptor.hasVideo
        )
    }

    public mutating func setMuted(_ muted: Bool) throws {
        guard case let .active(wakeup, descriptor, _, isHeld, video) = phase else {
            throw CallWakeupError.invalidTransition
        }
        phase = .active(wakeup, descriptor, isMuted: muted, isHeld: isHeld, isVideoEnabled: video)
    }

    public mutating func setHeld(_ held: Bool) throws {
        guard case let .active(wakeup, descriptor, isMuted, _, video) = phase else {
            throw CallWakeupError.invalidTransition
        }
        phase = .active(wakeup, descriptor, isMuted: isMuted, isHeld: held, isVideoEnabled: video)
    }

    public mutating func setVideoEnabled(_ enabled: Bool) throws {
        guard case let .active(wakeup, descriptor, isMuted, isHeld, _) = phase else {
            throw CallWakeupError.invalidTransition
        }
        phase = .active(wakeup, descriptor, isMuted: isMuted, isHeld: isHeld, isVideoEnabled: enabled)
    }

    public mutating func endCall(reason: CallEndReason) throws {
        switch phase {
        case .ringing, .connecting, .active:
            phase = .ended(reason)
        case .idle, .ended, .failed:
            throw CallWakeupError.invalidTransition
        }
    }

    public mutating func recordFailure(_ reason: CallFailureReason) {
        phase = .failed(reason)
    }

    public mutating func resetToIdle() throws {
        switch phase {
        case .idle, .ended, .failed:
            phase = .idle
        case .ringing, .connecting, .active:
            throw CallWakeupError.invalidTransition
        }
    }

    private mutating func recordWakeup(_ id: String) {
        if seenWakeupIds.count == Self.maximumTrackedWakeups {
            let evicted = seenWakeupIds.removeFirst()
            seenWakeupSet.remove(evicted)
        }
        seenWakeupIds.append(id)
        seenWakeupSet.insert(id)
    }
}
