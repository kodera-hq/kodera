import CryptoKit
import Foundation
import KoderaDomain
#if canImport(CoreBluetooth)
@preconcurrency import CoreBluetooth
#endif
#if canImport(Network)
import Network
#endif

/// Canonical radio constants matching `packages/kodera-rs/src/proximity.rs`.
public enum ProximityRadioConstants {
    public static let epochRotationSeconds: UInt64 = 15 * 60
    public static let epochClockSkewSeconds: UInt64 = 60
    public static let ephemeralTokenByteCount = 32
    public static let gattServiceUUIDString = "7B4E4B50-9A10-4F88-B310-6B6F64657261"
    public static let gattTokenCharacteristicUUIDString = "7B4E4B51-9A10-4F88-B310-6B6F64657261"
    public static let bonjourServiceType = "_kodera-prox._udp"
    public static let quicAlpn = "kodera-prox/1"
    public static let maxStatusNoteLength = 80
}

/// Voluntary check-in duration presets (`<= 2 hours`).
public enum ProximitySessionDuration: UInt64, CaseIterable, Equatable, Sendable {
    case minutes15 = 900
    case minutes30 = 1800
    case hour1 = 3600
    case hours2 = 7200

    public var durationSeconds: UInt64 { rawValue }
}

/// Coarse RSSI distance bands classified locally with dead-zone hysteresis (zero GPS).
public enum ProximityRadioDistanceBand: String, Equatable, Sendable {
    case immediate
    case near
    case ambient
}

/// Errors raised by the Wave 9 foreground `#proximity` radio adapter and token codec.
public enum ProximityRadioAdapterError: Error, Equatable, Sendable {
    case invalidOrganisation
    case invalidKeyMaterial
    case invalidStatusNote
    case foregroundConsentRequired
    case backgrounded
    case malformedToken
    case expiredToken
    case authenticationFailed
    case replayRejected
    case forbiddenCoordinateField
    case malformedTxtRecord
    case invalidRssi
    case bluetoothUnavailable
    case bonjourUnavailable
}

/// Stateful BLE RSSI distance-band classifier (`[-127, 20]` dBm, rejecting `127` unavailable sentinel).
public struct ProximityRssiHysteresisClassifier: Equatable, Sendable {
    public let immediateEnterDbm: Int
    public let immediateExitDbm: Int
    public let nearEnterDbm: Int
    public let nearExitDbm: Int
    public private(set) var currentBand: ProximityRadioDistanceBand?

    public init(
        immediateEnterDbm: Int = -55,
        immediateExitDbm: Int = -61,
        nearEnterDbm: Int = -75,
        nearExitDbm: Int = -81
    ) {
        self.immediateEnterDbm = immediateEnterDbm
        self.immediateExitDbm = immediateExitDbm
        self.nearEnterDbm = nearEnterDbm
        self.nearExitDbm = nearExitDbm
    }

    public mutating func observe(rssiDbm: Int) throws -> ProximityRadioDistanceBand {
        guard (-127...20).contains(rssiDbm) else {
            throw ProximityRadioAdapterError.invalidRssi
        }
        let nextBand: ProximityRadioDistanceBand
        switch currentBand {
        case .none:
            if rssiDbm >= immediateEnterDbm {
                nextBand = .immediate
            } else if rssiDbm >= nearEnterDbm {
                nextBand = .near
            } else {
                nextBand = .ambient
            }
        case .some(.immediate):
            if rssiDbm >= immediateExitDbm {
                nextBand = .immediate
            } else if rssiDbm >= nearExitDbm {
                nextBand = .near
            } else {
                nextBand = .ambient
            }
        case .some(.near):
            if rssiDbm >= immediateEnterDbm {
                nextBand = .immediate
            } else if rssiDbm >= nearExitDbm {
                nextBand = .near
            } else {
                nextBand = .ambient
            }
        case .some(.ambient):
            if rssiDbm >= immediateEnterDbm {
                nextBand = .immediate
            } else if rssiDbm >= nearEnterDbm {
                nextBand = .near
            } else {
                nextBand = .ambient
            }
        }
        currentBand = nextBand
        return nextBand
    }

    public mutating func reset() {
        currentBand = nil
    }
}

/// Wire-compatible 32-byte `KT\x01` HKDF-SHA256 rotating 15-minute proximity token codec.
public enum EphemeralHkdfTokenCodec {
    private static let magic = Data([0x4B, 0x54]) // "KT"
    private static let version: UInt8 = 1

    public struct DecodedToken: Equatable, Sendable {
        public let raw: Data
        public let epoch: UInt32
        public let counter: UInt32
        public let rollingPseudonym: Data

        public var tokenHex: String {
            raw.map { String(format: "%02x", $0) }.joined()
        }

        public var rollingPseudonymHex: String {
            rollingPseudonym.map { String(format: "%02x", $0) }.joined()
        }
    }

    public static func mint(
        organisationId: String,
        scopeTag: String = "default",
        workspaceMasterKey: Data,
        deviceSeed: Data,
        nowUnixSeconds: UInt64,
        counter: UInt32 = 0
    ) throws -> DecodedToken {
        guard TrustPolicy.canonicalNonNilUUID(organisationId) else {
            throw ProximityRadioAdapterError.invalidOrganisation
        }
        guard workspaceMasterKey.count == 32,
              deviceSeed.count == 32,
              !constantTimeEquals(workspaceMasterKey, deviceSeed) else {
            throw ProximityRadioAdapterError.invalidKeyMaterial
        }

        let epoch = UInt32(truncatingIfNeeded: nowUnixSeconds / ProximityRadioConstants.epochRotationSeconds)
        let pseudonym = deriveRollingPseudonym(
            deviceSeed: deviceSeed,
            organisationId: organisationId,
            scopeTag: scopeTag,
            epoch: epoch
        )

        var header = Data(capacity: 20)
        header.append(magic)
        header.append(version)
        header.append(0)
        header.append(contentsOf: withUnsafeBytes(of: epoch.bigEndian, Array.init))
        header.append(contentsOf: withUnsafeBytes(of: counter.bigEndian, Array.init))
        header.append(pseudonym)

        let epochKey = deriveEpochMacKey(
            workspaceMasterKey: workspaceMasterKey,
            organisationId: organisationId,
            scopeTag: scopeTag,
            epoch: epoch
        )
        let macTag = computeMac(
            epochMacKey: epochKey,
            organisationId: organisationId,
            scopeTag: scopeTag,
            headerAndBody: header
        )

        var raw = Data(capacity: 32)
        raw.append(header)
        raw.append(macTag)
        return DecodedToken(raw: raw, epoch: epoch, counter: counter, rollingPseudonym: pseudonym)
    }

    public static func verify(
        raw: Data,
        organisationId: String,
        scopeTag: String = "default",
        workspaceMasterKey: Data,
        nowUnixSeconds: UInt64
    ) throws -> DecodedToken {
        guard TrustPolicy.canonicalNonNilUUID(organisationId) else {
            throw ProximityRadioAdapterError.invalidOrganisation
        }
        guard workspaceMasterKey.count == 32 else {
            throw ProximityRadioAdapterError.invalidKeyMaterial
        }
        guard raw.count == ProximityRadioConstants.ephemeralTokenByteCount,
              raw.prefix(2) == magic,
              raw[2] == version,
              raw[3] == 0 else {
            throw ProximityRadioAdapterError.malformedToken
        }

        let epoch = raw.subdata(in: 4..<8).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).bigEndian }
        let counter = raw.subdata(in: 8..<12).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).bigEndian }
        let pseudonym = raw.subdata(in: 12..<20)
        let suppliedMac = raw.subdata(in: 20..<32)

        guard candidateEpochs(nowUnixSeconds: nowUnixSeconds).contains(epoch) else {
            throw ProximityRadioAdapterError.expiredToken
        }

        let epochKey = deriveEpochMacKey(
            workspaceMasterKey: workspaceMasterKey,
            organisationId: organisationId,
            scopeTag: scopeTag,
            epoch: epoch
        )
        let expectedMac = computeMac(
            epochMacKey: epochKey,
            organisationId: organisationId,
            scopeTag: scopeTag,
            headerAndBody: raw.subdata(in: 0..<20)
        )
        guard constantTimeEquals(expectedMac, suppliedMac) else {
            throw ProximityRadioAdapterError.authenticationFailed
        }

        return DecodedToken(raw: raw, epoch: epoch, counter: counter, rollingPseudonym: pseudonym)
    }

    private static func candidateEpochs(nowUnixSeconds: UInt64) -> [UInt32] {
        let current = UInt32(truncatingIfNeeded: nowUnixSeconds / ProximityRadioConstants.epochRotationSeconds)
        var allowed = [current]
        let offset = nowUnixSeconds % ProximityRadioConstants.epochRotationSeconds
        if offset < ProximityRadioConstants.epochClockSkewSeconds, current > 0 {
            allowed.append(current - 1)
        }
        if offset >= ProximityRadioConstants.epochRotationSeconds - ProximityRadioConstants.epochClockSkewSeconds,
           current < UInt32.max {
            allowed.append(current + 1)
        }
        return allowed
    }

    private static func deriveEpochMacKey(
        workspaceMasterKey: Data,
        organisationId: String,
        scopeTag: String,
        epoch: UInt32
    ) -> SymmetricKey {
        let salt = Data("\(organisationId):\(scopeTag)".utf8)
        var info = Data("kodera.proximity.w9.epoch-mac.v1:".utf8)
        info.append(contentsOf: withUnsafeBytes(of: epoch.bigEndian, Array.init))
        return HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: workspaceMasterKey),
            salt: salt,
            info: info,
            outputByteCount: 32
        )
    }

    private static func deriveRollingPseudonym(
        deviceSeed: Data,
        organisationId: String,
        scopeTag: String,
        epoch: UInt32
    ) -> Data {
        let salt = Data(withUnsafeBytes(of: epoch.bigEndian, Array.init))
        let info = Data("kodera.proximity.w9.pseudonym.v1:\(organisationId):\(scopeTag)".utf8)
        let derived = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: deviceSeed),
            salt: salt,
            info: info,
            outputByteCount: 8
        )
        return derived.withUnsafeBytes { Data($0) }
    }

    private static func computeMac(
        epochMacKey: SymmetricKey,
        organisationId: String,
        scopeTag: String,
        headerAndBody: Data
    ) -> Data {
        let orgBytes = Data(organisationId.utf8)
        let scopeBytes = Data(scopeTag.utf8)
        var transcript = Data("kodera.proximity.w9.token-mac.v1:".utf8)
        transcript.append(UInt8(clamping: orgBytes.count))
        transcript.append(orgBytes)
        transcript.append(UInt8(clamping: scopeBytes.count))
        transcript.append(scopeBytes)
        transcript.append(headerAndBody)
        let mac = HMAC<SHA256>.authenticationCode(for: transcript, using: epochMacKey)
        return Data(mac.prefix(12))
    }

    static func constantTimeEquals(_ lhs: Data, _ rhs: Data) -> Bool {
        guard lhs.count == rhs.count else { return false }
        var diff: UInt8 = 0
        for (a, b) in zip(lhs, rhs) {
            diff |= a ^ b
        }
        return diff == 0
    }
}

/// Bonjour `_kodera-prox._udp` TXT dictionary encoder/decoder with strict zero-GPS validation.
public enum BonjourProximityTxtCodec {
    private static let forbiddenCoordinateKeys: Set<String> = [
        "lat", "latitude", "lon", "lng", "long", "longitude", "gps",
        "coord", "coords", "coordinates", "geo", "geolocation", "alt", "altitude", "bssid", "mac"
    ]

    public struct Record: Equatable, Sendable {
        public let epoch: UInt32
        public let token: Data
        public let quicPort: UInt16

        public init(epoch: UInt32, token: Data, quicPort: UInt16) throws {
            guard token.count == ProximityRadioConstants.ephemeralTokenByteCount, quicPort > 0 else {
                throw ProximityRadioAdapterError.malformedTxtRecord
            }
            self.epoch = epoch
            self.token = token
            self.quicPort = quicPort
        }

        public func toDictionary() -> [String: String] {
            [
                "v": "1",
                "ep": String(epoch),
                "tok": token.map { String(format: "%02x", $0) }.joined(),
                "alpn": ProximityRadioConstants.quicAlpn,
                "port": String(quicPort),
            ]
        }
    }

    public static func decode(_ entries: [String: String]) throws -> Record {
        for rawKey in entries.keys {
            let normalized = rawKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if forbiddenCoordinateKeys.contains(normalized) {
                throw ProximityRadioAdapterError.forbiddenCoordinateField
            }
        }
        guard entries["v"] == "1",
              entries["alpn"] == ProximityRadioConstants.quicAlpn,
              let epText = entries["ep"],
              let epoch = UInt32(epText),
              let portText = entries["port"],
              let port = UInt16(portText),
              port > 0,
              let tokHex = entries["tok"],
              let tokenData = decodeHex(tokHex),
              tokenData.count == ProximityRadioConstants.ephemeralTokenByteCount else {
            throw ProximityRadioAdapterError.malformedTxtRecord
        }
        return try Record(epoch: epoch, token: tokenData, quicPort: port)
    }

    private static func decodeHex(_ hex: String) -> Data? {
        guard hex.count.isMultiple(of: 2) else { return nil }
        var out = Data(capacity: hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            out.append(byte)
            index = next
        }
        return out
    }
}

/// Discovered nearby peer surfaced to the voluntary check-in view.
public struct DiscoveredProximityPeer: Identifiable, Equatable, Sendable {
    public let id: String
    public let handle: String
    public let statusNote: String
    public let distanceBand: ProximityRadioDistanceBand
    public let viaBonjourLan: Bool
    public let rssiDbm: Int?
    public let observedAtUnixSeconds: UInt64

    public init(
        id: String,
        handle: String,
        statusNote: String,
        distanceBand: ProximityRadioDistanceBand,
        viaBonjourLan: Bool,
        rssiDbm: Int?,
        observedAtUnixSeconds: UInt64
    ) {
        self.id = id
        self.handle = handle
        self.statusNote = statusNote
        self.distanceBand = distanceBand
        self.viaBonjourLan = viaBonjourLan
        self.rssiDbm = rssiDbm
        self.observedAtUnixSeconds = observedAtUnixSeconds
    }
}

/// Protocol seam over `CoreBluetooth` (`CBPeripheralManager` + `CBCentralManager`).
@MainActor
public protocol ProximityGattRadioDriver: AnyObject {
    var onPeerTokenObserved: (@MainActor (Data, Int) -> Void)? { get set }
    func startAdvertisingAndScanning(ephemeralToken: Data) throws
    func stopAll()
}

/// Protocol seam over Bonjour `Network` (`NWListener` + `NWBrowser` on `_kodera-prox._udp`).
@MainActor
public protocol ProximityBonjourLanDriver: AnyObject {
    var onPeerTxtObserved: (@MainActor ([String: String]) -> Void)? { get set }
    func startAdvertisingAndBrowsing(txtRecord: [String: String], quicPort: UInt16) throws
    func stopAll()
}

#if canImport(CoreBluetooth)
/// Production `CoreBluetooth` GATT service UUID advertiser and foreground scanner.
@MainActor
public final class CoreBluetoothGattRadioDriver: NSObject, ProximityGattRadioDriver {
    public var onPeerTokenObserved: (@MainActor (Data, Int) -> Void)?

    private let serviceUUID = CBUUID(string: ProximityRadioConstants.gattServiceUUIDString)
    private let tokenCharUUID = CBUUID(string: ProximityRadioConstants.gattTokenCharacteristicUUIDString)
    private var peripheralManager: CBPeripheralManager?
    private var centralManager: CBCentralManager?
    private var pendingToken: Data?
    private var isActive = false

    public override init() {
        super.init()
    }

    public func startAdvertisingAndScanning(ephemeralToken: Data) throws {
        guard ephemeralToken.count == ProximityRadioConstants.ephemeralTokenByteCount else {
            throw ProximityRadioAdapterError.malformedToken
        }
        pendingToken = ephemeralToken
        isActive = true
        if peripheralManager == nil {
            peripheralManager = CBPeripheralManager(delegate: self, queue: .main)
        } else if peripheralManager?.state == .poweredOn {
            publishServiceAndAdvertise()
        }
        if centralManager == nil {
            centralManager = CBCentralManager(delegate: self, queue: .main)
        } else if centralManager?.state == .poweredOn {
            beginCentralScan()
        }
    }

    public func stopAll() {
        isActive = false
        pendingToken = nil
        peripheralManager?.stopAdvertising()
        peripheralManager?.removeAllServices()
        centralManager?.stopScan()
    }

    private func publishServiceAndAdvertise() {
        guard isActive, let peripheralManager, let token = pendingToken, peripheralManager.state == .poweredOn else {
            return
        }
        peripheralManager.removeAllServices()
        let characteristic = CBMutableCharacteristic(
            type: tokenCharUUID,
            properties: [.read],
            value: token,
            permissions: [.readable]
        )
        let service = CBMutableService(type: serviceUUID, primary: true)
        service.characteristics = [characteristic]
        peripheralManager.add(service)
        peripheralManager.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [serviceUUID],
        ])
    }

    private func beginCentralScan() {
        guard isActive, let centralManager, centralManager.state == .poweredOn else {
            return
        }
        centralManager.scanForPeripherals(
            withServices: [serviceUUID],
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
        )
    }
}

extension CoreBluetoothGattRadioDriver: CBPeripheralManagerDelegate {
    nonisolated public func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        Task { @MainActor [weak self] in
            self?.publishServiceAndAdvertise()
        }
    }
}

extension CoreBluetoothGattRadioDriver: CBCentralManagerDelegate {
    nonisolated public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        Task { @MainActor [weak self] in
            self?.beginCentralScan()
        }
    }

    nonisolated public func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        let rssiValue = RSSI.intValue
        let serviceData = advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data]
        let tokenBytes = serviceData?[CBUUID(string: ProximityRadioConstants.gattServiceUUIDString)]
        guard let tokenBytes else { return }
        Task { @MainActor [weak self] in
            self?.onPeerTokenObserved?(tokenBytes, rssiValue)
        }
    }
}
#endif

#if canImport(Network)
/// Production `NWListener` + `NWBrowser` Bonjour `_kodera-prox._udp` LAN discovery adapter.
@MainActor
public final class NetworkBonjourProximityDriver: ProximityBonjourLanDriver {
    public var onPeerTxtObserved: (@MainActor ([String: String]) -> Void)?

    private var browser: NWBrowser?
    private var listener: NWListener?

    public init() {}

    public func startAdvertisingAndBrowsing(txtRecord: [String: String], quicPort: UInt16) throws {
        stopAll()

        var nwTxt = NWTXTRecord()
        for (key, value) in txtRecord {
            nwTxt[key] = value
        }

        if let endpointPort = NWEndpoint.Port(rawValue: quicPort),
           let nwListener = try? NWListener(using: .udp, on: endpointPort) {
            nwListener.service = NWListener.Service(
                name: nil,
                type: ProximityRadioConstants.bonjourServiceType,
                domain: nil,
                txtRecord: nwTxt
            )
            nwListener.newConnectionHandler = { connection in
                connection.cancel()
            }
            nwListener.start(queue: .main)
            listener = nwListener
        }

        let descriptor = NWBrowser.Descriptor.bonjourWithTXTRecord(
            type: ProximityRadioConstants.bonjourServiceType,
            domain: nil
        )
        let nwBrowser = NWBrowser(for: descriptor, using: .udp)
        nwBrowser.browseResultsChangedHandler = { [weak self] results, _ in
            var snapshots: [[String: String]] = []
            for result in results {
                if case let .bonjour(record) = result.metadata {
                    snapshots.append(record.dictionary)
                }
            }
            Task { @MainActor [weak self] in
                guard let self else { return }
                for dict in snapshots {
                    self.onPeerTxtObserved?(dict)
                }
            }
        }
        nwBrowser.start(queue: .main)
        browser = nwBrowser
    }

    public func stopAll() {
        browser?.cancel()
        browser = nil
        listener?.cancel()
        listener = nil
    }
}
#endif

/// Foreground opt-in `#proximity` session coordinator combining CoreBluetooth GATT + Bonjour mDNS
/// with strict foreground consent, background auto-stop timer, session TTL, and instant kill-switch.
@MainActor
public final class VoluntaryProximityRadioSession: WorkspacePreferencesObservable {
    @WorkspacePublished public private(set) var organisationId: String?
    @WorkspacePublished public private(set) var hasForegroundConsent = false
    @WorkspacePublished public private(set) var isForegroundActive = true
    @WorkspacePublished public private(set) var isSessionActive = false
    @WorkspacePublished public var selectedDuration: ProximitySessionDuration = .minutes30
    @WorkspacePublished public var statusNote: String = ""
    @WorkspacePublished public private(set) var activeTokenHex: String?
    @WorkspacePublished public private(set) var expiresAtUnixSeconds: UInt64?
    @WorkspacePublished public private(set) var peers: [DiscoveredProximityPeer] = []
    @WorkspacePublished public private(set) var lastError: ProximityRadioAdapterError?

    private let gattDriver: any ProximityGattRadioDriver
    private let bonjourDriver: any ProximityBonjourLanDriver
    private let quicPort: UInt16
    private var workspaceMasterKey: Data?
    private var deviceSeed: Data?
    private var scopeTag = "default"
    private var emissionCounter: UInt32 = 0
    private var seenPeerCounters: [String: UInt32] = [:]
    private var rssiClassifiers: [String: ProximityRssiHysteresisClassifier] = [:]
    private var autoStopTask: Task<Void, Never>?
    private var backgroundAutoStopTask: Task<Void, Never>?

    public init(
        gattDriver: any ProximityGattRadioDriver,
        bonjourDriver: any ProximityBonjourLanDriver,
        quicPort: UInt16 = 48_443
    ) {
        self.gattDriver = gattDriver
        self.bonjourDriver = bonjourDriver
        self.quicPort = quicPort
        bindDriverCallbacks()
    }

    public func provision(
        organisationId: String,
        scopeTag: String = "default",
        workspaceMasterKey: Data,
        deviceSeed: Data
    ) throws {
        leaveProximity()
        guard TrustPolicy.canonicalNonNilUUID(organisationId) else {
            throw ProximityRadioAdapterError.invalidOrganisation
        }
        guard workspaceMasterKey.count == 32,
              deviceSeed.count == 32,
              !EphemeralHkdfTokenCodec.constantTimeEquals(workspaceMasterKey, deviceSeed) else {
            throw ProximityRadioAdapterError.invalidKeyMaterial
        }
        self.organisationId = organisationId
        self.scopeTag = scopeTag
        self.workspaceMasterKey = workspaceMasterKey
        self.deviceSeed = deviceSeed
    }

    public func grantForegroundConsent() throws {
        guard organisationId != nil else {
            throw ProximityRadioAdapterError.invalidOrganisation
        }
        guard isForegroundActive else {
            throw ProximityRadioAdapterError.foregroundConsentRequired
        }
        hasForegroundConsent = true
        lastError = nil
    }

    public func startVoluntarySession(
        nowUnixSeconds: UInt64 = ProximityBounds.currentUnixSeconds()
    ) throws {
        guard let organisationId, let workspaceMasterKey, let deviceSeed else {
            throw ProximityRadioAdapterError.invalidOrganisation
        }
        guard isForegroundActive, hasForegroundConsent else {
            lastError = .foregroundConsentRequired
            throw ProximityRadioAdapterError.foregroundConsentRequired
        }
        let trimmedNote = statusNote.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmedNote.count <= ProximityRadioConstants.maxStatusNoteLength,
              !trimmedNote.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            lastError = .invalidStatusNote
            throw ProximityRadioAdapterError.invalidStatusNote
        }
        statusNote = trimmedNote

        let minted = try EphemeralHkdfTokenCodec.mint(
            organisationId: organisationId,
            scopeTag: scopeTag,
            workspaceMasterKey: workspaceMasterKey,
            deviceSeed: deviceSeed,
            nowUnixSeconds: nowUnixSeconds,
            counter: emissionCounter
        )
        emissionCounter &+= 1

        let txtRecord = try BonjourProximityTxtCodec.Record(
            epoch: minted.epoch,
            token: minted.raw,
            quicPort: quicPort
        )

        try gattDriver.startAdvertisingAndScanning(ephemeralToken: minted.raw)
        do {
            try bonjourDriver.startAdvertisingAndBrowsing(
                txtRecord: txtRecord.toDictionary(),
                quicPort: quicPort
            )
        } catch {
            gattDriver.stopAll()
            throw error
        }

        activeTokenHex = minted.tokenHex
        expiresAtUnixSeconds = nowUnixSeconds + selectedDuration.durationSeconds
        isSessionActive = true
        lastError = nil
        scheduleSessionExpiryTimer(durationSeconds: selectedDuration.durationSeconds)
    }

    /// Scene phase handler enforcing immediate radio teardown or bounded grace auto-stop on backgrounding.
    public func handleSceneForegroundChange(
        isActive: Bool,
        backgroundGraceNanoseconds: UInt64 = 0
    ) {
        isForegroundActive = isActive
        backgroundAutoStopTask?.cancel()
        backgroundAutoStopTask = nil

        if !isActive {
            if backgroundGraceNanoseconds == 0 {
                stopRadioSessionPreservingProvisioning()
            } else {
                backgroundAutoStopTask = Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: backgroundGraceNanoseconds)
                    guard !Task.isCancelled, let self, !self.isForegroundActive else { return }
                    self.stopRadioSessionPreservingProvisioning()
                }
            }
        }
    }

    /// Evaluates deterministic wall-clock TTL expiry and tears down radio state if expired.
    public func evaluateExpiry(nowUnixSeconds: UInt64) {
        if let expiresAtUnixSeconds, nowUnixSeconds >= expiresAtUnixSeconds {
            leaveProximity()
        }
    }

    /// Instant kill-switch wiping active check-in token, discovered peers, and stopping BLE + Bonjour radios.
    public func leaveProximity() {
        stopRadioSessionPreservingProvisioning()
        hasForegroundConsent = false
    }

    public func ingestBleObservation(
        tokenData: Data,
        rssiDbm: Int,
        peerNote: String = "",
        nowUnixSeconds: UInt64 = ProximityBounds.currentUnixSeconds()
    ) throws -> DiscoveredProximityPeer {
        let decoded = try validateIncomingPeerToken(tokenData: tokenData, nowUnixSeconds: nowUnixSeconds)
        var classifier = rssiClassifiers[decoded.rollingPseudonymHex] ?? ProximityRssiHysteresisClassifier()
        let band = try classifier.observe(rssiDbm: rssiDbm)
        rssiClassifiers[decoded.rollingPseudonymHex] = classifier

        let peer = DiscoveredProximityPeer(
            id: decoded.rollingPseudonymHex,
            handle: "prox-\(decoded.rollingPseudonymHex.prefix(8))",
            statusNote: String(peerNote.prefix(ProximityRadioConstants.maxStatusNoteLength)),
            distanceBand: band,
            viaBonjourLan: peers.first(where: { $0.id == decoded.rollingPseudonymHex })?.viaBonjourLan ?? false,
            rssiDbm: rssiDbm,
            observedAtUnixSeconds: nowUnixSeconds
        )
        upsertPeer(peer)
        return peer
    }

    public func ingestBonjourTxtObservation(
        entries: [String: String],
        nowUnixSeconds: UInt64 = ProximityBounds.currentUnixSeconds()
    ) throws -> DiscoveredProximityPeer {
        let record = try BonjourProximityTxtCodec.decode(entries)
        let decoded = try validateIncomingPeerToken(tokenData: record.token, nowUnixSeconds: nowUnixSeconds)
        let existing = peers.first(where: { $0.id == decoded.rollingPseudonymHex })
        let peer = DiscoveredProximityPeer(
            id: decoded.rollingPseudonymHex,
            handle: "prox-\(decoded.rollingPseudonymHex.prefix(8))",
            statusNote: existing?.statusNote ?? "",
            distanceBand: existing?.distanceBand ?? .near,
            viaBonjourLan: true,
            rssiDbm: existing?.rssiDbm,
            observedAtUnixSeconds: nowUnixSeconds
        )
        upsertPeer(peer)
        return peer
    }

    private func validateIncomingPeerToken(
        tokenData: Data,
        nowUnixSeconds: UInt64
    ) throws -> EphemeralHkdfTokenCodec.DecodedToken {
        guard isSessionActive, isForegroundActive, hasForegroundConsent else {
            throw ProximityRadioAdapterError.foregroundConsentRequired
        }
        guard let organisationId, let workspaceMasterKey else {
            throw ProximityRadioAdapterError.invalidOrganisation
        }
        let decoded = try EphemeralHkdfTokenCodec.verify(
            raw: tokenData,
            organisationId: organisationId,
            scopeTag: scopeTag,
            workspaceMasterKey: workspaceMasterKey,
            nowUnixSeconds: nowUnixSeconds
        )
        let replayKey = "\(decoded.epoch):\(decoded.rollingPseudonymHex)"
        if let prev = seenPeerCounters[replayKey], decoded.counter <= prev {
            throw ProximityRadioAdapterError.replayRejected
        }
        seenPeerCounters[replayKey] = decoded.counter
        return decoded
    }

    private func upsertPeer(_ peer: DiscoveredProximityPeer) {
        if let idx = peers.firstIndex(where: { $0.id == peer.id }) {
            peers[idx] = peer
        } else {
            peers.append(peer)
        }
    }

    private func bindDriverCallbacks() {
        gattDriver.onPeerTokenObserved = { [weak self] tokenData, rssi in
            _ = try? self?.ingestBleObservation(tokenData: tokenData, rssiDbm: rssi)
        }
        bonjourDriver.onPeerTxtObserved = { [weak self] entries in
            _ = try? self?.ingestBonjourTxtObservation(entries: entries)
        }
    }

    private func scheduleSessionExpiryTimer(durationSeconds: UInt64) {
        autoStopTask?.cancel()
        autoStopTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: durationSeconds * 1_000_000_000)
            guard !Task.isCancelled else { return }
            self?.leaveProximity()
        }
    }

    private func stopRadioSessionPreservingProvisioning() {
        autoStopTask?.cancel()
        autoStopTask = nil
        backgroundAutoStopTask?.cancel()
        backgroundAutoStopTask = nil
        gattDriver.stopAll()
        bonjourDriver.stopAll()
        isSessionActive = false
        activeTokenHex = nil
        expiresAtUnixSeconds = nil
        peers.removeAll()
        seenPeerCounters.removeAll()
        rssiClassifiers.removeAll()
    }
}
