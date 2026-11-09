import Foundation

public struct MediaAttempt: Equatable, Sendable {
    public let attemptId: String
    public let generation: UInt64
    public let organisationId: String
    public let matrixRoomId: String
    public init(attemptId: String, generation: UInt64, organisationId: String, matrixRoomId: String) {
        self.attemptId = attemptId; self.generation = generation
        self.organisationId = organisationId; self.matrixRoomId = matrixRoomId
    }
}
public enum MediaPhase: Equatable, Sendable {
    case unavailable(UnavailabilityReason), idle, joining, joined, reconnecting, ended
}
/// Local reducer events are not a media SDK, token verifier or transport proof.
public enum MediaEvent: Equatable, Sendable {
    case requestJoin(MediaAttempt), grantReceived(MediaAttempt), transportConnected(MediaAttempt)
    case transportLost(MediaAttempt), transportFailed(MediaAttempt)
    case cameraIntent(Bool), cameraPermission(Bool), cameraPublication(MediaAttempt, active: Bool)
    case leave, revoke, signOut
}
public struct MediaState: Equatable, Sendable {
    public private(set) var phase: MediaPhase = .unavailable(.notConfigured)
    public private(set) var attempt: MediaAttempt?
    public private(set) var cameraIntent = false
    public private(set) var cameraPublished = false
    private let generation: UInt64
    private let organisationId: String
    private var cameraPermission = false
    public init(generation: UInt64, organisationId: String, readiness: ServiceReadiness, adapterAvailable: Bool) {
        self.generation = generation; self.organisationId = organisationId
        guard adapterAvailable else { return }
        guard generation > 0, TrustPolicy.canonicalNonNilUUID(organisationId) else {
            phase = .unavailable(.identityRequired)
            return
        }
        switch readiness {
        case .ready: phase = .idle
        case .pending: phase = .unavailable(.serviceUnavailable)
        case .unknown: phase = .unavailable(.unsupportedContract)
        case let .unavailable(reason): phase = .unavailable(reason)
        }
    }

    /// Records local adapter observations. A joined transport is not cross-device media proof.
    public func applying(_ event: MediaEvent) -> MediaState {
        guard phase != .ended else { return self }
        var next = self
        switch event {
        case let .requestJoin(candidate):
            guard phase == .idle, candidate.generation == generation,
                  candidate.organisationId == organisationId, !candidate.attemptId.isEmpty,
                  !candidate.matrixRoomId.isEmpty else { return self }
            next.attempt = candidate
            next.phase = .joining
            next.cameraIntent = false
            next.cameraPermission = false
            next.cameraPublished = false
        case .grantReceived:
            // A token/grant response never establishes transport or media publication.
            return self
        case let .transportConnected(candidate):
            guard attempt == candidate, phase == .joining || phase == .reconnecting else { return self }
            next.phase = .joined
        case let .transportLost(candidate):
            guard attempt == candidate, phase == .joined else { return self }
            next.phase = .reconnecting
            next.cameraPublished = false
        case let .transportFailed(candidate):
            guard attempt == candidate else { return self }
            next.end()
        case let .cameraIntent(enabled):
            guard attempt != nil else { return self }
            next.cameraIntent = enabled
            if !enabled { next.cameraPublished = false }
        case let .cameraPermission(granted):
            guard attempt != nil else { return self }
            next.cameraPermission = granted
            if !granted { next.cameraPublished = false }
        case let .cameraPublication(candidate, active):
            guard attempt == candidate, phase == .joined else { return self }
            next.cameraPublished = active && cameraIntent && cameraPermission
        case .leave, .revoke, .signOut:
            next.end()
        }
        return next
    }

    private mutating func end() {
        phase = .ended
        attempt = nil
        cameraIntent = false
        cameraPermission = false
        cameraPublished = false
    }
}
