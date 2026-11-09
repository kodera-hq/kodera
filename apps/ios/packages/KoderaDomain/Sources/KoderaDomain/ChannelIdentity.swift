import Foundation

public enum ChannelKind: Sendable { case text, audio }
public enum ChannelRoomState: Sendable { case pending, ready, failed }
public struct ChannelReference: Sendable {
    public let organisationId: String
    public let channelId: String
    public let kind: ChannelKind
    public let roomState: ChannelRoomState
    public init(organisationId: String, channelId: String, kind: ChannelKind, roomState: ChannelRoomState) {
        self.organisationId = organisationId; self.channelId = channelId; self.kind = kind; self.roomState = roomState
    }
}
public enum ChannelIdentity {
    public static func alias(for reference: ChannelReference, descriptor: ValidatedDescriptor) throws -> String {
        guard reference.organisationId == descriptor.coreIdentity.organisationId else {
            throw DomainError.mismatchedOrganisation
        }
        guard TrustPolicy.canonicalNonNilUUID(reference.channelId) else { throw DomainError.invalidChannel }
        return "#kodera-ch-" + reference.channelId + ":" + descriptor.descriptor.matrixServerName
    }
    public static func matchesResolvedAlias(_ value: String, reference: ChannelReference,
                                           descriptor: ValidatedDescriptor) throws -> Bool {
        value == (try alias(for: reference, descriptor: descriptor))
    }
}
