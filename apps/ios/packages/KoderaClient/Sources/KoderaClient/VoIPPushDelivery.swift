import Foundation
import KoderaDomain

@MainActor
public protocol ImmediateVoIPReporting: AnyObject {
    /// Must invoke CXProvider.reportNewIncomingCall before returning, without an async hop.
    func report(uuid: UUID, completion: @escaping @MainActor (Bool) -> Void)
    func end(uuid: UUID, reason: NativeRingPhase)
}

/// Every delivery is reported, even malformed, stale, duplicate, or signed-out deliveries.
/// Push completion waits for the OS report only; it never waits for metadata or media networking.
@MainActor
public final class VoIPPushDelivery {
    private weak var reporter: (any ImmediateVoIPReporting)?
    private let coordinator: NativeCallCoordinator
    private var reported: [String: UUID] = [:]
    public init(reporter: any ImmediateVoIPReporting, coordinator: NativeCallCoordinator) {
        self.reporter = reporter; self.coordinator = coordinator
    }
    public func receive(_ data: Data, now: UInt64, completion: @escaping @MainActor () -> Void) {
        guard let reporter else { completion(); return }
        let wake = try? NativeCallWake.admit(data, now: now)
        let isNewRing = wake?.state == .ringing && reported[wake!.callId] == nil
        let uuid = isNewRing ? UUID(uuidString: wake!.callId)! : UUID()
        if isNewRing, let wake { reported[wake.callId] = uuid }
        var didComplete = false
        reporter.report(uuid: uuid) { [self] accepted in
            guard !didComplete else { return }; didComplete = true
            completion()
            guard accepted || wake?.state == .answeredElsewhere || wake?.state == .ended else {
                if isNewRing, let wake { reported.removeValue(forKey: wake.callId); coordinator.end(callId: wake.callId) }
                return
            }
            guard let wake else { reporter.end(uuid: uuid, reason: .expired); return }
            if accepted && !isNewRing { reporter.end(uuid: uuid, reason: wake.state == .answeredElsewhere ? .answeredElsewhere : .ended) }
            // A duplicate live ring is reported and ended independently of the original call.
            if wake.state == .ringing && !isNewRing { return }
            Task { @MainActor [self] in
                do { try await coordinator.receive(wake) }
                catch { if isNewRing { ended(callId: wake.callId, reason: .revoked) } }
            }
        }
    }
    public func ended(callId: String, reason: NativeRingPhase) {
        if let uuid = reported.removeValue(forKey: callId) { reporter?.end(uuid: uuid, reason: reason) }
    }
}
