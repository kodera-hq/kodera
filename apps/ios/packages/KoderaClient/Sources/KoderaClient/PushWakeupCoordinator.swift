import Foundation
import KoderaDomain

public enum InboxNotificationKind: String, Equatable, Sendable {
    case mention
    case invitation
    case moderation
    case document
}

public struct InboxNotificationItem: Equatable, Identifiable, Sendable {
    public let id: String
    public let kind: InboxNotificationKind
    public let resourceId: String
    public let createdAt: String
    public let readAt: String?

    public init(
        id: String,
        kind: InboxNotificationKind,
        resourceId: String,
        createdAt: String,
        readAt: String?
    ) {
        self.id = id
        self.kind = kind
        self.resourceId = resourceId
        self.createdAt = createdAt
        self.readAt = readAt
    }
}

public struct InboxNotificationPage: Equatable, Sendable {
    public let items: [InboxNotificationItem]
    public let hasMore: Bool
    public let nextCursor: String?

    public init(items: [InboxNotificationItem], hasMore: Bool, nextCursor: String?) {
        self.items = items
        self.hasMore = hasMore
        self.nextCursor = nextCursor
    }
}

public enum PushWakeupFailure: Error, Equatable, Sendable {
    case invalidInput
    case payloadRejected(CallWakeupError)
    case organisationMismatch
    case protocolViolation
    case forbidden
    case rateLimited
    case serviceUnavailable
    case signedOut
    case signedOutNotWiped
    case identityUnavailable
    case transport(TransportFailure)
}

/// Coordinates device wakeup registration, strict zero-cleartext push admission,
/// authenticated inbox catch-up, and sign-out endpoint revocation.
public actor PushWakeupCoordinator {
    public static let surfaceIdentifier = "ios"

    private let requester: CoreRequester

    public init(requester: CoreRequester) {
        self.requester = requester
    }

    /// Registers this device's wakeup endpoint with Core (`PUT /api/v1/push/subscriptions/{deviceId}`).
    public func registerDeviceWakeup(
        deviceId: String,
        endpoint: String,
        p256dh: String,
        auth: String
    ) async throws(PushWakeupFailure) {
        guard TrustPolicy.canonicalNonNilUUID(deviceId),
              Self.isValidHTTPSWakeupEndpoint(endpoint),
              Self.isValidBase64URL(p256dh, exactLength: 87),
              Self.isValidBase64URL(auth, exactLength: 22) else {
            throw .invalidInput
        }
        let bodyObject: [String: String] = [
            "endpoint": endpoint,
            "p256dh": p256dh,
            "auth": auth,
        ]
        guard let body = try? JSONSerialization.data(withJSONObject: bodyObject, options: [.sortedKeys]) else {
            throw .invalidInput
        }
        let path = Self.deviceWakeupPath(deviceId: deviceId)
        let reply = await requester.put(path: path, jsonBody: body)
        switch reply {
        case let .answered(status, _):
            guard status == 204 || status == 200 else {
                if status == 429 { throw .rateLimited }
                if (500...599).contains(status) { throw .serviceUnavailable }
                throw .protocolViolation
            }
        case .forbidden: throw .forbidden
        case .signedOut: throw .signedOut
        case .signedOutNotWiped: throw .signedOutNotWiped
        case .identityUnavailable: throw .identityUnavailable
        case .tooLarge, .pathRefused, .redirected: throw .protocolViolation
        case let .transport(reason): throw .transport(reason)
        }
    }

    /// Revokes this device's wakeup endpoint on explicit sign-out.
    public func revokeOnSignOut(deviceId: String) async throws(PushWakeupFailure) {
        guard TrustPolicy.canonicalNonNilUUID(deviceId) else {
            throw .invalidInput
        }
        let path = Self.deviceWakeupPath(deviceId: deviceId)
        let reply = await requester.delete(path: path)
        switch reply {
        case let .answered(status, _):
            guard status == 204 || status == 200 || status == 404 else {
                if status == 429 { throw .rateLimited }
                if (500...599).contains(status) { throw .serviceUnavailable }
                throw .protocolViolation
            }
        case .forbidden: throw .forbidden
        case .signedOut: throw .signedOut
        case .signedOutNotWiped: throw .signedOutNotWiped
        case .identityUnavailable: throw .identityUnavailable
        case .tooLarge, .pathRefused, .redirected: throw .protocolViolation
        case let .transport(reason): throw .transport(reason)
        }
    }

    /// Fetches a page from the authenticated notification inbox (`/api/v1/notifications`).
    public func fetchNotificationInbox(
        limit: Int = 50,
        cursor: String? = nil
    ) async throws(PushWakeupFailure) -> InboxNotificationPage {
        guard (1...200).contains(limit) else {
            throw .invalidInput
        }
        var query: [(String, String)] = [("limit", String(limit))]
        if let cursor {
            query.append(("cursor", cursor))
        }
        let reply = await requester.get(path: "/api/v1/notifications", query: query)
        switch reply {
        case let .answered(status, body):
            guard status == 200 else {
                if status == 429 { throw .rateLimited }
                if (500...599).contains(status) { throw .serviceUnavailable }
                throw .protocolViolation
            }
            return try Self.decodeInboxPage(body)
        case .forbidden: throw .forbidden
        case .signedOut: throw .signedOut
        case .signedOutNotWiped: throw .signedOutNotWiped
        case .identityUnavailable: throw .identityUnavailable
        case .tooLarge, .pathRefused, .redirected: throw .protocolViolation
        case let .transport(reason): throw .transport(reason)
        }
    }

    /// Admits an empty or strictly payload-free wakeup envelope, refusing any cleartext leak before
    /// running authenticated notification inbox + Matrix `/sync` catch-up.
    public func handleIncomingWakeup(
        rawPayload: Data,
        expectedOrganisationId: String? = nil,
        inboxLimit: Int = 50,
        onMatrixCatchUp: (@Sendable () async -> Void)? = nil
    ) async throws(PushWakeupFailure) -> InboxNotificationPage {
        if !rawPayload.isEmpty {
            let admitted: ZeroPayloadWakeupEnvelope
            do {
                admitted = try ZeroPayloadWakeupEnvelope.admit(jsonData: rawPayload)
            } catch let error as KoderaMobileFfiError {
                switch error {
                case let .cleartextForbidden(field):
                    throw .payloadRejected(.cleartextPayloadForbidden(field: field))
                case let .unexpectedField(field):
                    throw .payloadRejected(.unexpectedPushField(field: field))
                default:
                    throw .payloadRejected(.invalidPayloadFormat)
                }
            } catch {
                throw .payloadRejected(.invalidPayloadFormat)
            }
            if let expectedOrganisationId {
                guard TrustPolicy.canonicalNonNilUUID(expectedOrganisationId) else {
                    throw .invalidInput
                }
                guard admitted.organisationId == expectedOrganisationId else {
                    throw .organisationMismatch
                }
            }
        }
        let page = try await fetchNotificationInbox(limit: inboxLimit, cursor: nil)
        if let onMatrixCatchUp {
            await onMatrixCatchUp()
        }
        return page
    }

    private static func deviceWakeupPath(deviceId: String) -> String {
        "/api/v1/push/subscriptions/\(deviceId)"
    }

    private static func decodeInboxPage(_ data: Data) throws(PushWakeupFailure) -> InboxNotificationPage {
        guard let parsed = try? StrictJSON.parse(data, byteLimit: StrictJSON.byteLimit),
              let root = parsed.object,
              let rawItems = root["data"]?.array,
              let hasMoreVal = root["has_more"],
              case let .boolean(hasMore) = hasMoreVal else {
            throw .protocolViolation
        }
        let nextCursor: String?
        if let rawCursor = root["next_cursor"] {
            if rawCursor.isNull {
                nextCursor = nil
            } else if let str = rawCursor.string, !str.isEmpty, str.utf8.count <= 512 {
                nextCursor = str
            } else {
                throw .protocolViolation
            }
        } else {
            nextCursor = nil
        }

        var items: [InboxNotificationItem] = []
        items.reserveCapacity(rawItems.count)
        for entry in rawItems {
            guard let obj = entry.object,
                  let id = obj["id"]?.string,
                  TrustPolicy.canonicalNonNilUUID(id),
                  let rawKind = obj["kind"]?.string,
                  let kind = InboxNotificationKind(rawValue: rawKind),
                  let resourceId = obj["resourceId"]?.string,
                  TrustPolicy.canonicalNonNilUUID(resourceId),
                  let createdAt = obj["createdAt"]?.string,
                  !createdAt.isEmpty else {
                throw .protocolViolation
            }
            let readAt: String?
            if let readVal = obj["readAt"] {
                if readVal.isNull {
                    readAt = nil
                } else if let readStr = readVal.string, !readStr.isEmpty {
                    readAt = readStr
                } else {
                    throw .protocolViolation
                }
            } else {
                readAt = nil
            }
            items.append(InboxNotificationItem(
                id: id,
                kind: kind,
                resourceId: resourceId,
                createdAt: createdAt,
                readAt: readAt
            ))
        }
        return InboxNotificationPage(items: items, hasMore: hasMore, nextCursor: nextCursor)
    }

    private static func isValidHTTPSWakeupEndpoint(_ raw: String) -> Bool {
        guard raw.hasPrefix("https://"),
              raw.utf8.count <= 2048,
              raw.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7E }),
              let url = URL(string: raw),
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              comps.scheme?.lowercased() == "https",
              comps.user == nil,
              comps.password == nil,
              comps.fragment == nil,
              let host = comps.host,
              TrustPolicy.validDNSName(host.lowercased()) else {
            return false
        }
        return true
    }

    private static func isValidBase64URL(_ raw: String, exactLength: Int) -> Bool {
        let bytes = Array(raw.utf8)
        guard bytes.count == exactLength else { return false }
        return bytes.allSatisfy {
            ($0 >= UInt8(ascii: "A") && $0 <= UInt8(ascii: "Z"))
                || ($0 >= UInt8(ascii: "a") && $0 <= UInt8(ascii: "z"))
                || ($0 >= UInt8(ascii: "0") && $0 <= UInt8(ascii: "9"))
                || $0 == UInt8(ascii: "-")
                || $0 == UInt8(ascii: "_")
        }
    }
}
