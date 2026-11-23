#if os(iOS)
import Foundation
@preconcurrency import PushKit
@preconcurrency import CallKit
import AVFAudio
import Network
import KoderaDomain

@MainActor
public protocol VoIPTokenRegistering: AnyObject {
    /// Authenticated device registration only. Nil invalidates the previous token.
    func updateVoIPToken(_ token: Data?)
}

@MainActor
private final class VoIPPushCompletion {
    private var callback: (() -> Void)?
    init(_ callback: @escaping () -> Void) { self.callback = callback }
    func finish() { let callback = callback; self.callback = nil; callback?() }
}

/// Retained by the authenticated app session only after its media and push adapters are provisioned.
@MainActor
public final class NativeVoIPRuntime: NSObject, @preconcurrency PKPushRegistryDelegate,
    @preconcurrency CXProviderDelegate, ImmediateVoIPReporting, NativeCallPresenting {
    private let provider: CXProvider
    private let controller = CXCallController()
    public let coordinator: NativeCallCoordinator
    private let tokens: any VoIPTokenRegistering
    private var registry: PKPushRegistry?
    private var delivery: VoIPPushDelivery!
    private var timer: Timer?
    private let monitor = NWPathMonitor()

    public init(coordinator: NativeCallCoordinator, tokens: any VoIPTokenRegistering) {
        let configuration = CXProviderConfiguration()
        configuration.includesCallsInRecents = false
        configuration.maximumCallsPerCallGroup = 1
        configuration.maximumCallGroups = 1
        configuration.supportedHandleTypes = [.generic]
        configuration.supportsVideo = false
        provider = CXProvider(configuration: configuration)
        self.coordinator = coordinator; self.tokens = tokens
        super.init()
        provider.setDelegate(self, queue: .main)
        delivery = VoIPPushDelivery(reporter: self, coordinator: coordinator)
        coordinator.bind(self)
    }
    public func start() {
        guard registry == nil else { return }
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self; registry.desiredPushTypes = [.voIP]; self.registry = registry
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.coordinator.tick()
                await self.coordinator.pollCompanionTimeline()
            }
        }
        monitor.pathUpdateHandler = { [weak self] _ in
            Task { @MainActor in await self?.coordinator.networkPathChanged() }
        }
        monitor.start(queue: DispatchQueue(label: "io.kodera.calls.network"))
    }
    public func stop() {
        coordinator.revoke(); tokens.updateVoIPToken(nil)
        registry?.desiredPushTypes = []; registry?.delegate = nil; registry = nil
        timer?.invalidate(); timer = nil; monitor.cancel(); provider.invalidate()
    }
    public func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        if type == .voIP { tokens.updateVoIPToken(pushCredentials.token) }
    }
    public func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        if type == .voIP { tokens.updateVoIPToken(nil) }
    }
    public func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload,
                             for type: PKPushType, completion: @escaping () -> Void) {
        guard type == .voIP else { completion(); return }
        let raw = (try? JSONSerialization.data(withJSONObject: payload.dictionaryPayload)) ?? Data()
        let completionBox = VoIPPushCompletion(completion)
        delivery.receive(raw, now: NativeCallClock.timestamp()) { completionBox.finish() }
    }
    public func report(uuid: UUID, completion: @escaping @MainActor (Bool) -> Void) {
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: uuid.uuidString.lowercased())
        update.hasVideo = false; update.supportsGrouping = false; update.supportsUngrouping = false
        update.supportsHolding = false; update.supportsDTMF = false
        // This invocation is synchronous in the PushKit delegate callback, before any Task or network work.
        provider.reportNewIncomingCall(with: uuid, update: update) { error in
            let accepted = error == nil
            Task { @MainActor in completion(accepted) }
        }
    }
    public func end(uuid: UUID, reason: NativeRingPhase) {
        let ended: CXCallEndedReason = reason == .answeredElsewhere ? .answeredElsewhere :
            (reason == .expired ? .unanswered : (reason == .revoked ? .failed : .remoteEnded))
        provider.reportCall(with: uuid, endedAt: Date(), reason: ended)
    }
    public func metadata(_ call: AuthenticatedNativeCall) {
        guard let uuid = UUID(uuidString: call.wake.callId) else { return }
        let update = CXCallUpdate(); update.localizedCallerName = call.callerLabel
        provider.reportCall(with: uuid, updated: update)
    }
    public func connected(callId: String) {}
    public func ended(callId: String, reason: NativeRingPhase) { delivery.ended(callId: callId, reason: reason) }
    public func requestEnd(callId: String) async throws {
        guard let uuid = UUID(uuidString: callId) else { return }
        try await controller.request(CXTransaction(action: CXEndCallAction(call: uuid)))
    }
    public func providerDidReset(_ provider: CXProvider) { coordinator.revoke() }
    public func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        Task { @MainActor in
            do { try await coordinator.answer(callId: action.callUUID.uuidString.lowercased()); action.fulfill() }
            catch { action.fail() }
        }
    }
    public func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let id = action.callUUID.uuidString.lowercased()
        coordinator.end(callId: id, declined: coordinator.ring.records[id]?.phase == .ringing); action.fulfill()
    }
    public func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        Task { @MainActor in
            guard coordinator.call?.wake.callId == action.callUUID.uuidString.lowercased() else { action.fail(); return }
            do { try await coordinator.setMuted(action.isMuted); action.fulfill() } catch { action.fail() }
        }
    }
    public func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        do {
            try audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
            Task { @MainActor in await coordinator.audioSession(active: true) }
        } catch { coordinator.revoke() }
    }
    public func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        Task { @MainActor in await coordinator.audioSession(active: false) }
    }
}
#endif
