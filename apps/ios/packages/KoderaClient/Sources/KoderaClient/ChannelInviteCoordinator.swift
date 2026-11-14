import Foundation
import KoderaDomain

public enum ChannelInviteError: Error, Equatable, Sendable {
    case invalidScope
    case staleContext
    case stopped
    case transportUnprovisioned
    case invalidRecipient(MatrixInvitationError)
    case transportFailed
}

public enum ChannelInviteShareFormat: String, CaseIterable, Equatable, Sendable {
    case matrixToURL
    case matrixURI
    case canonicalAlias
}

public enum ChannelInviteStatus: Equatable, Sendable {
    case idle
    case sending(MatrixUserId)
    case sent(MatrixUserId)
    case unprovisioned(MatrixUserId)
    case failed(ChannelInviteError)
}

/// Scoped channel metadata used to construct universal Matrix links and validate direct invitations.
public struct ChannelInviteScope: Equatable, Sendable {
    public let organisationId: String
    public let channelId: String
    public let channelName: String
    public let serverName: MatrixServerName
    public let canonicalAlias: MatrixRoomAlias?
    public let roomId: MatrixRoomId?
    public let invitation: UniversalMatrixInvitation

    public var hasProvisionedRoomTarget: Bool {
        canonicalAlias != nil || roomId != nil
    }

    public var roomTargetIdentifier: String? {
        roomId?.rawValue ?? canonicalAlias?.rawValue
    }

    public init(
        organisationId: String,
        channelId: String,
        channelName: String,
        serverName: MatrixServerName,
        canonicalAlias: MatrixRoomAlias? = nil,
        roomId: MatrixRoomId? = nil
    ) throws {
        guard TrustPolicy.canonicalNonNilUUID(organisationId),
              VoiceCallScope.boundedText(channelId),
              VoiceCallScope.boundedText(channelName) else {
            throw ChannelInviteError.invalidScope
        }
        self.organisationId = organisationId
        self.channelId = channelId
        self.channelName = channelName
        self.serverName = serverName
        self.canonicalAlias = canonicalAlias
        self.roomId = roomId

        do {
            if let roomId {
                self.invitation = try UniversalMatrixInvitation.forRoom(
                    roomId: roomId,
                    canonicalAlias: canonicalAlias,
                    channelSlug: channelName,
                    serverName: serverName
                )
            } else if let canonicalAlias {
                self.invitation = UniversalMatrixInvitation.forRoomAlias(canonicalAlias, via: [serverName])
            } else {
                let suggested = try MatrixRoomAlias.suggested(channelSlug: channelName, serverName: serverName)
                self.invitation = UniversalMatrixInvitation.forRoomAlias(suggested, via: [serverName])
            }
        } catch {
            throw ChannelInviteError.invalidScope
        }
    }
}

/// Opaque operation fence preventing stale invite sheets from mutating newer channel or organisation scopes.
public struct ChannelInviteContext: Sendable {
    fileprivate let owner: UUID
    fileprivate let generation: UInt64
    fileprivate let scope: ChannelInviteScope
}

/// Authenticated Matrix room invitation transport supplied only when a live Matrix client is provisioned.
public protocol MatrixRoomInviteTransport: Sendable {
    func sendRoomInvite(
        organisationId: String,
        roomIdentifier: String,
        recipient: MatrixUserId
    ) async throws
}

/// Coordinates universal Matrix share links and validated `@user:domain` direct invitations.
/// When no live Matrix transport or room target is provisioned, direct sends report `.unprovisioned`
/// honestly rather than fabricating remote delivery.
@MainActor
public final class ChannelInviteCoordinator: WorkspacePreferencesObservable {
    @WorkspacePublished public private(set) var scope: ChannelInviteScope?
    @WorkspacePublished public private(set) var status: ChannelInviteStatus = .idle
    @WorkspacePublished public private(set) var lastCopiedFormat: ChannelInviteShareFormat?
    public private(set) var isStopped = false

    private let owner = UUID()
    private var generation: UInt64 = 1

    public init() {}

    public func configure(_ incomingScope: ChannelInviteScope?) {
        guard !isStopped else { return }
        scope = incomingScope
        status = .idle
        lastCopiedFormat = nil
        advanceGeneration()
    }

    public func openSheet(scope incomingScope: ChannelInviteScope) throws -> ChannelInviteContext {
        guard !isStopped, generation != 0 else { throw ChannelInviteError.stopped }
        scope = incomingScope
        status = .idle
        lastCopiedFormat = nil
        advanceGeneration()
        guard generation != 0 else { throw ChannelInviteError.stopped }
        return ChannelInviteContext(owner: owner, generation: generation, scope: incomingScope)
    }

    public func validateRecipient(_ rawInput: String) -> Result<MatrixUserId, MatrixInvitationError> {
        let trimmed = rawInput.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            return .success(try MatrixUserId(trimmed))
        } catch let error as MatrixInvitationError {
            return .failure(error)
        } catch {
            return .failure(.invalidCharacter)
        }
    }

    public func recordCopiedFormat(_ format: ChannelInviteShareFormat, context: ChannelInviteContext?) throws {
        guard valid(context) else { throw ChannelInviteError.staleContext }
        lastCopiedFormat = format
    }

    @discardableResult
    public func sendDirectInvite(
        rawInput: String,
        context: ChannelInviteContext?,
        transport: (any MatrixRoomInviteTransport)? = nil
    ) async -> ChannelInviteStatus {
        guard !isStopped, generation != 0 else { return .failed(.stopped) }
        guard valid(context), let activeScope = scope else {
            return .failed(.staleContext)
        }

        let recipient: MatrixUserId
        switch validateRecipient(rawInput) {
        case let .success(parsed):
            recipient = parsed
        case let .failure(validationError):
            let failedStatus: ChannelInviteStatus = .failed(.invalidRecipient(validationError))
            status = failedStatus
            return failedStatus
        }

        guard let transport, let roomTarget = activeScope.roomTargetIdentifier else {
            let unprovisionedStatus: ChannelInviteStatus = .unprovisioned(recipient)
            status = unprovisionedStatus
            return unprovisionedStatus
        }

        status = .sending(recipient)
        do {
            try await transport.sendRoomInvite(
                organisationId: activeScope.organisationId,
                roomIdentifier: roomTarget,
                recipient: recipient
            )
            guard !isStopped, valid(context) else {
                return .failed(.staleContext)
            }
            let sentStatus: ChannelInviteStatus = .sent(recipient)
            status = sentStatus
            return sentStatus
        } catch {
            guard !isStopped, valid(context) else {
                return .failed(.staleContext)
            }
            let failedStatus: ChannelInviteStatus = .failed(.transportFailed)
            status = failedStatus
            return failedStatus
        }
    }

    public func dismissSheet(context: ChannelInviteContext?) {
        guard valid(context) else { return }
        clear()
    }

    public func clear() {
        scope = nil
        status = .idle
        lastCopiedFormat = nil
        advanceGeneration()
    }

    public func stop() {
        isStopped = true
        generation = 0
        scope = nil
        status = .idle
        lastCopiedFormat = nil
    }

    private func valid(_ context: ChannelInviteContext?) -> Bool {
        guard let context, !isStopped, generation != 0 else { return false }
        return context.owner == owner && context.generation == generation && context.scope == scope
    }

    private func advanceGeneration() {
        if generation == 0 || generation == UInt64.max {
            stop()
        } else {
            generation += 1
        }
    }
}
