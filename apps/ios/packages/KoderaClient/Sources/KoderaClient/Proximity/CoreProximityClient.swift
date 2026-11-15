import Foundation
import KoderaDomain

/// Volatile workspace-scoped radio material; never encoded for storage or logging.
public struct ProximityBootstrap: Sendable {
    public let workspaceId: String
    public let scopeTag: String
    public let epoch: UInt32
    public let epochMacKey: Data
    public let epochExpiresAtUnixSeconds: UInt64
}

public enum ProximityBootstrapFailure: Error, Equatable, Sendable {
    case unavailable, refused, malformed
}

/// Fetches radio material only through the accepted session's bounded Core requester.
public actor CoreProximityClient {
    private let requester: CoreRequester
    private let clock: @Sendable () -> UInt64
    public init(requester: CoreRequester, clock: @escaping @Sendable () -> UInt64 = { ProximityBounds.currentUnixSeconds() }) {
        self.requester = requester
        self.clock = clock
    }

    public func bootstrap(workspaceId: String) async throws -> ProximityBootstrap {
        guard TrustPolicy.canonicalNonNilUUID(workspaceId) else { throw ProximityBootstrapFailure.malformed }
        let body = try JSONSerialization.data(withJSONObject: ["workspace_id": workspaceId, "event_scope": "default"])
        switch await requester.post(path: "/api/v1/proximity/bootstrap", jsonBody: body) {
        case let .answered(status, body) where status == 200:
            return try Self.decode(body, workspaceId: workspaceId, nowUnixSeconds: clock())
        case .forbidden, .signedOut, .signedOutNotWiped:
            throw ProximityBootstrapFailure.refused
        default:
            throw ProximityBootstrapFailure.unavailable
        }
    }

    static func decode(_ data: Data, workspaceId: String, nowUnixSeconds: UInt64 = ProximityBounds.currentUnixSeconds()) throws -> ProximityBootstrap {
        guard let fields = try StrictJSON.parse(data).object,
              Set(fields.keys) == ["workspace_id", "event_scope", "epoch_mac_key", "epoch", "epoch_expires_at", "epoch_rotation_seconds"],
              fields["workspace_id"]?.string == workspaceId,
              TrustPolicy.canonicalNonNilUUID(workspaceId),
              fields["event_scope"]?.string == "default",
              let hex = fields["epoch_mac_key"]?.string,
              hex.utf8.count == 64, hex.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              fields["epoch_rotation_seconds"]?.integer == 900,
              let epoch = fields["epoch"]?.integer, epoch >= 0, epoch <= Int64(UInt32.max),
              UInt64(epoch) == nowUnixSeconds / 900,
              let expires = fields["epoch_expires_at"]?.integer,
              expires == (epoch + 1) * 900, UInt64(expires) > nowUnixSeconds else {
            throw ProximityBootstrapFailure.malformed
        }
        var key = Data(capacity: 32)
        let bytes = Array(hex.utf8)
        for index in stride(from: 0, to: bytes.count, by: 2) {
            guard let byte = UInt8(String(decoding: bytes[index..<(index + 2)], as: UTF8.self), radix: 16) else {
                throw ProximityBootstrapFailure.malformed
            }
            key.append(byte)
        }
        guard key.contains(where: { $0 != 0 }) else { throw ProximityBootstrapFailure.malformed }
        return ProximityBootstrap(workspaceId: workspaceId, scopeTag: "default", epoch: UInt32(epoch),
                                  epochMacKey: key, epochExpiresAtUnixSeconds: UInt64(expires))
    }
}
