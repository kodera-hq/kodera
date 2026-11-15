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

    fileprivate static func deriveRollingPseudonym(
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

    static func validateEventScope(_ scope: String) throws {
        let bytes = scope.utf8
        func alphanumeric(_ byte: UInt8) -> Bool {
            (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte)
        }
        guard (1...64).contains(bytes.count), let first = bytes.first, alphanumeric(first),
              bytes.allSatisfy({ alphanumeric($0) || [46, 95, 58, 45].contains($0) }) else {
            throw ProximityRadioAdapterError.malformedToken
        }
    }

    static func validateEpochLease(epoch: UInt32, expiresAt: UInt64, key: Data, now: UInt64) throws {
        guard key.count == 32, key.contains(where: { $0 != 0 }) else {
            throw ProximityRadioAdapterError.invalidKeyMaterial
        }
        guard UInt64(epoch) == now / 900, expiresAt == (UInt64(epoch) + 1) * 900, now < expiresAt else {
            throw ProximityRadioAdapterError.expiredToken
        }
    }

    /// Production minting takes a current-epoch capability and cannot derive any later epoch key.
    public static func mintWithEpochMacKey(
        organisationId: String, scopeTag: String = "default", epoch: UInt32,
        epochExpiresAtUnixSeconds: UInt64, epochMacKey: Data, deviceSeed: Data,
        nowUnixSeconds: UInt64, counter: UInt32 = 0
    ) throws -> DecodedToken {
        guard TrustPolicy.canonicalNonNilUUID(organisationId) else { throw ProximityRadioAdapterError.invalidOrganisation }
        try validateEventScope(scopeTag)
        try validateEpochLease(epoch: epoch, expiresAt: epochExpiresAtUnixSeconds, key: epochMacKey, now: nowUnixSeconds)
        guard deviceSeed.count == 32, deviceSeed.contains(where: { $0 != 0 }),
              !constantTimeEquals(deviceSeed, epochMacKey) else { throw ProximityRadioAdapterError.invalidKeyMaterial }
        let pseudonym = deriveRollingPseudonym(deviceSeed: deviceSeed, organisationId: organisationId, scopeTag: scopeTag, epoch: epoch)
        var header = Data([0x4B, 0x54, 1, 0])
        header.append(contentsOf: withUnsafeBytes(of: epoch.bigEndian, Array.init))
        header.append(contentsOf: withUnsafeBytes(of: counter.bigEndian, Array.init))
        header.append(pseudonym)
        let tag = computeMac(epochMacKey: SymmetricKey(data: epochMacKey), organisationId: organisationId,
                             scopeTag: scopeTag, headerAndBody: header)
        return DecodedToken(raw: header + tag, epoch: epoch, counter: counter, rollingPseudonym: pseudonym)
    }

    public static func verifyWithEpochMacKey(
        raw: Data, organisationId: String, scopeTag: String = "default", epoch: UInt32,
        epochExpiresAtUnixSeconds: UInt64, epochMacKey: Data, nowUnixSeconds: UInt64
    ) throws -> DecodedToken {
        guard TrustPolicy.canonicalNonNilUUID(organisationId) else { throw ProximityRadioAdapterError.invalidOrganisation }
        try validateEventScope(scopeTag)
        try validateEpochLease(epoch: epoch, expiresAt: epochExpiresAtUnixSeconds, key: epochMacKey, now: nowUnixSeconds)
        guard raw.count == 32, raw.prefix(4) == Data([0x4B, 0x54, 1, 0]) else { throw ProximityRadioAdapterError.malformedToken }
        let suppliedEpoch = raw.subdata(in: 4..<8).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).bigEndian }
        guard suppliedEpoch == epoch else { throw ProximityRadioAdapterError.expiredToken }
        let expected = computeMac(epochMacKey: SymmetricKey(data: epochMacKey), organisationId: organisationId,
                                  scopeTag: scopeTag, headerAndBody: raw.subdata(in: 0..<20))
        guard constantTimeEquals(expected, raw.subdata(in: 20..<32)) else { throw ProximityRadioAdapterError.authenticationFailed }
        let counter = raw.subdata(in: 8..<12).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).bigEndian }
        return DecodedToken(raw: raw, epoch: epoch, counter: counter, rollingPseudonym: raw.subdata(in: 12..<20))
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
              Set(entries.keys) == ["v", "ep", "tok", "alpn", "port"],
              entries["alpn"] == ProximityRadioConstants.quicAlpn,
              let epText = entries["ep"],
              (1...10).contains(epText.utf8.count), epText.utf8.allSatisfy({ (48...57).contains($0) }),
              let epoch = UInt32(epText),
              let portText = entries["port"],
              (1...5).contains(portText.utf8.count), portText.utf8.allSatisfy({ (48...57).contains($0) }),
              let port = UInt16(portText),
              port > 0,
              let tokHex = entries["tok"],
              tokHex.utf8.count == 64, tokHex.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
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
    var onFailure: (@MainActor (ProximityRadioAdapterError) -> Void)? { get set }
    func startAdvertisingAndScanning(ephemeralToken: Data) throws
    func stopAll()
}

public extension ProximityGattRadioDriver {
    var onFailure: (@MainActor (ProximityRadioAdapterError) -> Void)? {
        get { nil }
        set { }
    }
}

/// Protocol seam over Bonjour `Network` (`NWListener` + `NWBrowser` on `_kodera-prox._udp`).
@MainActor
public protocol ProximityBonjourLanDriver: AnyObject {
    var onPeerTxtObserved: (@MainActor ([String: String]) -> Void)? { get set }
    var onFailure: (@MainActor (ProximityRadioAdapterError) -> Void)? { get set }
    func startAdvertisingAndBrowsing(txtRecord: [String: String], quicPort: UInt16) throws
    func stopAll()
}

public extension ProximityBonjourLanDriver {
    var onFailure: (@MainActor (ProximityRadioAdapterError) -> Void)? {
        get { nil }
        set { }
    }
}

#if canImport(CoreBluetooth)
/// Production `CoreBluetooth` GATT service UUID advertiser and foreground scanner.
@MainActor
public final class CoreBluetoothGattRadioDriver: NSObject, ProximityGattRadioDriver {
    public var onPeerTokenObserved: (@MainActor (Data, Int) -> Void)?
    public var onFailure: (@MainActor (ProximityRadioAdapterError) -> Void)?

    private let serviceUUID = CBUUID(string: ProximityRadioConstants.gattServiceUUIDString)
    private let tokenCharUUID = CBUUID(string: ProximityRadioConstants.gattTokenCharacteristicUUIDString)
    private var peripheralManager: CBPeripheralManager?
    private var centralManager: CBCentralManager?
    private var pendingToken: Data?
    private var isActive = false
    private var publishedService: CBMutableService?
    private struct PendingRead {
        let peripheral: CBPeripheral
        let rssi: Int
        let timeout: Task<Void, Never>
    }
    private var pendingReads: [UUID: PendingRead] = [:]
    private var cooldowns: [UUID: Date] = [:]

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
        publishedService = nil
        peripheralManager?.stopAdvertising()
        peripheralManager?.removeAllServices()
        centralManager?.stopScan()
        for read in pendingReads.values {
            read.timeout.cancel()
            read.peripheral.delegate = nil
            centralManager?.cancelPeripheralConnection(read.peripheral)
        }
        pendingReads.removeAll()
        cooldowns.removeAll()
    }

    private func publishServiceAndAdvertise() {
        guard isActive, let peripheralManager, let token = pendingToken, peripheralManager.state == .poweredOn else {
            return
        }
        peripheralManager.stopAdvertising()
        peripheralManager.removeAllServices()
        let characteristic = CBMutableCharacteristic(
            type: tokenCharUUID,
            properties: [.read],
            value: token,
            permissions: [.readable]
        )
        let service = CBMutableService(type: serviceUUID, primary: true)
        service.characteristics = [characteristic]
        publishedService = service
        peripheralManager.add(service)
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

    private func beginRead(_ peripheral: CBPeripheral, rssi: Int) {
        guard isActive, (-127...20).contains(rssi), pendingReads[peripheral.identifier] == nil else { return }
        let now = Date()
        cooldowns = cooldowns.filter { $0.value > now }
        guard cooldowns[peripheral.identifier] == nil, cooldowns.count < 64, pendingReads.count < 4 else { return }
        cooldowns[peripheral.identifier] = now.addingTimeInterval(30)
        let timeout = Task { @MainActor [weak self, weak peripheral] in
            do { try await Task.sleep(nanoseconds: 10_000_000_000) }
            catch { return }
            guard let self, let peripheral else { return }
            self.finishRead(peripheral)
        }
        pendingReads[peripheral.identifier] = PendingRead(peripheral: peripheral, rssi: rssi, timeout: timeout)
        peripheral.delegate = self
        centralManager?.connect(peripheral)
    }

    private func finishRead(_ peripheral: CBPeripheral) {
        guard let read = pendingReads[peripheral.identifier], read.peripheral === peripheral else { return }
        pendingReads.removeValue(forKey: peripheral.identifier)
        read.timeout.cancel()
        peripheral.delegate = nil
        centralManager?.cancelPeripheralConnection(peripheral)
    }

    private func failRadio() {
        guard isActive else { return }
        stopAll()
        onFailure?(.bluetoothUnavailable)
    }
}

extension CoreBluetoothGattRadioDriver: CBPeripheralManagerDelegate {
    nonisolated public func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        Task { @MainActor [weak self] in
            if [.unauthorized, .unsupported, .poweredOff].contains(peripheral.state) {
                self?.failRadio()
                return
            }
            self?.publishServiceAndAdvertise()
        }
    }

    nonisolated public func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        let failed = error != nil
        Task { @MainActor [weak self] in
            guard let self, self.isActive, service === self.publishedService else { return }
            guard !failed else { self.failRadio(); return }
            peripheral.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [self.serviceUUID]])
        }
    }

    nonisolated public func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if error != nil { Task { @MainActor [weak self] in self?.failRadio() } }
    }
}

extension CoreBluetoothGattRadioDriver: CBCentralManagerDelegate {
    nonisolated public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        Task { @MainActor [weak self] in
            if [.unauthorized, .unsupported, .poweredOff].contains(central.state) {
                self?.failRadio()
                return
            }
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
        Task { @MainActor [weak self] in
            self?.beginRead(peripheral, rssi: rssiValue)
        }
    }

    nonisolated public func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        Task { @MainActor [weak self] in
            guard let self, self.isActive, self.pendingReads[peripheral.identifier]?.peripheral === peripheral else { return }
            peripheral.discoverServices([self.serviceUUID])
        }
    }

    nonisolated public func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        Task { @MainActor [weak self] in self?.finishRead(peripheral) }
    }

    nonisolated public func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        Task { @MainActor [weak self] in self?.finishRead(peripheral) }
    }
}

extension CoreBluetoothGattRadioDriver: CBPeripheralDelegate {
    nonisolated public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        let failed = error != nil
        Task { @MainActor [weak self] in
            guard let self, self.isActive, self.pendingReads[peripheral.identifier]?.peripheral === peripheral else { return }
            guard !failed, let service = peripheral.services?.first(where: { $0.uuid == self.serviceUUID }) else {
                self.finishRead(peripheral)
                return
            }
            peripheral.discoverCharacteristics([self.tokenCharUUID], for: service)
        }
    }

    nonisolated public func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        let failed = error != nil
        Task { @MainActor [weak self] in
            guard let self, self.isActive, self.pendingReads[peripheral.identifier]?.peripheral === peripheral else { return }
            guard !failed, service.uuid == self.serviceUUID,
                  let token = service.characteristics?.first(where: { $0.uuid == self.tokenCharUUID && $0.properties.contains(.read) }) else {
                self.finishRead(peripheral)
                return
            }
            peripheral.readValue(for: token)
        }
    }

    nonisolated public func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        let failed = error != nil
        let bytes = characteristic.value
        let uuid = characteristic.uuid
        Task { @MainActor [weak self] in
            guard let self, self.isActive, let read = self.pendingReads[peripheral.identifier], read.peripheral === peripheral else { return }
            self.finishRead(peripheral)
            guard !failed, uuid == self.tokenCharUUID, let bytes,
                  bytes.count == ProximityRadioConstants.ephemeralTokenByteCount else { return }
            self.onPeerTokenObserved?(bytes, read.rssi)
        }
    }
}
#endif

#if canImport(Network)
/// Production `NWListener` + `NWBrowser` Bonjour `_kodera-prox._udp` LAN discovery adapter.
@MainActor
public final class NetworkBonjourProximityDriver: ProximityBonjourLanDriver {
    public var onPeerTxtObserved: (@MainActor ([String: String]) -> Void)?
    public var onFailure: (@MainActor (ProximityRadioAdapterError) -> Void)?

    private var browser: NWBrowser?
    private var listener: NWListener?
    private var generation = UUID()

    public init() {}

    public func startAdvertisingAndBrowsing(txtRecord: [String: String], quicPort: UInt16) throws {
        stopAll()
        let currentGeneration = generation
        let record = try BonjourProximityTxtCodec.decode(txtRecord)
        guard record.quicPort == quicPort else { throw ProximityRadioAdapterError.malformedTxtRecord }

        var nwTxt = NWTXTRecord()
        for (key, value) in txtRecord {
            nwTxt[key] = value
        }

        if let endpointPort = NWEndpoint.Port(rawValue: quicPort),
           let nwListener = try? NWListener(using: .udp, on: endpointPort) {
            nwListener.service = NWListener.Service(
                name: "kodera-prox-" + record.token.subdata(in: 12..<20).map { String(format: "%02x", $0) }.joined(),
                type: ProximityRadioConstants.bonjourServiceType,
                domain: nil,
                txtRecord: nwTxt
            )
            nwListener.newConnectionHandler = { connection in
                connection.cancel()
            }
            nwListener.stateUpdateHandler = { [weak self] state in
                if case .failed = state {
                    Task { @MainActor [weak self] in self?.failIfCurrent(currentGeneration) }
                }
            }
            nwListener.start(queue: .main)
            listener = nwListener
        } else { throw ProximityRadioAdapterError.bonjourUnavailable }

        let descriptor = NWBrowser.Descriptor.bonjourWithTXTRecord(
            type: ProximityRadioConstants.bonjourServiceType,
            domain: nil
        )
        let nwBrowser = NWBrowser(for: descriptor, using: .udp)
        nwBrowser.browseResultsChangedHandler = { [weak self] results, _ in
            var snapshots: [[String: String]] = []
            for result in results.prefix(64) {
                if case let .bonjour(record) = result.metadata {
                    snapshots.append(record.dictionary)
                }
            }
            Task { @MainActor [weak self] in
                guard let self, self.generation == currentGeneration else { return }
                for dict in snapshots {
                    self.onPeerTxtObserved?(dict)
                }
            }
        }
        nwBrowser.stateUpdateHandler = { [weak self] state in
            if case .failed = state {
                Task { @MainActor [weak self] in self?.failIfCurrent(currentGeneration) }
            }
        }
        nwBrowser.start(queue: .main)
        browser = nwBrowser
    }

    public func stopAll() {
        generation = UUID()
        browser?.cancel()
        browser = nil
        listener?.cancel()
        listener = nil
    }

    private func failIfCurrent(_ expected: UUID) {
        guard generation == expected else { return }
        stopAll()
        onFailure?(.bonjourUnavailable)
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
    public var onAuthenticatedRebootstrapRequired: (@MainActor (UInt64) -> Void)?

    private let gattDriver: any ProximityGattRadioDriver
    private let bonjourDriver: any ProximityBonjourLanDriver
    private let quicPort: UInt16
    private var workspaceMasterKey: Data?
    private var epochLease: (epoch: UInt32, expiresAt: UInt64, key: Data)?
    private var deviceSeed: Data?
    private var scopeTag = "default"
    private var emissionCounter: UInt32 = 0
    private static let maxTrackedPeers = 256
    private var seenPeerCounters: [String: UInt32] = [:]
    private var rssiClassifiers: [String: ProximityRssiHysteresisClassifier] = [:]
    private var autoStopTask: Task<Void, Never>?
    private var backgroundAutoStopTask: Task<Void, Never>?
    private var rotationTask: Task<Void, Never>?
    private var preparedLeaseExpiryTask: Task<Void, Never>?
    private var activeEpoch: UInt32?
    private let clock: @MainActor () -> UInt64

    public init(
        gattDriver: any ProximityGattRadioDriver,
        bonjourDriver: any ProximityBonjourLanDriver,
        quicPort: UInt16 = 48_443,
        clock: @escaping @MainActor () -> UInt64 = { ProximityBounds.currentUnixSeconds() }
    ) {
        self.gattDriver = gattDriver
        self.bonjourDriver = bonjourDriver
        self.quicPort = quicPort
        self.clock = clock
        bindDriverCallbacks()
    }

    public func provision(
        organisationId: String,
        scopeTag: String = "default",
        workspaceMasterKey: Data,
        deviceSeed: Data
    ) throws {
        leaveProximity()
        epochLease = nil
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

    /// Production provisioning retains a single current-epoch MAC capability, never a workspace master.
    public func provisionEpoch(
        organisationId: String, scopeTag: String = "default", epoch: UInt32,
        epochExpiresAtUnixSeconds: UInt64, epochMacKey: Data, deviceSeed: Data,
        nowUnixSeconds: UInt64 = ProximityBounds.currentUnixSeconds()
    ) throws {
        clearProvisioning()
        guard TrustPolicy.canonicalNonNilUUID(organisationId) else { throw ProximityRadioAdapterError.invalidOrganisation }
        try EphemeralHkdfTokenCodec.validateEventScope(scopeTag)
        try EphemeralHkdfTokenCodec.validateEpochLease(epoch: epoch, expiresAt: epochExpiresAtUnixSeconds, key: epochMacKey, now: nowUnixSeconds)
        guard deviceSeed.count == 32, deviceSeed.contains(where: { $0 != 0 }),
              !EphemeralHkdfTokenCodec.constantTimeEquals(epochMacKey, deviceSeed) else { throw ProximityRadioAdapterError.invalidKeyMaterial }
        self.organisationId = organisationId
        self.scopeTag = scopeTag
        self.deviceSeed = deviceSeed
        epochLease = (epoch, epochExpiresAtUnixSeconds, epochMacKey)
        preparedLeaseExpiryTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: (epochExpiresAtUnixSeconds - nowUnixSeconds) * 1_000_000_000) }
            catch { return }
            guard !Task.isCancelled, let self else { return }
            self.clearProvisioning()
        }
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
        nowUnixSeconds: UInt64 = ProximityBounds.currentUnixSeconds(),
        consentExpiresAtUnixSeconds: UInt64? = nil
    ) throws {
        evaluateExpiry(nowUnixSeconds: nowUnixSeconds)
        guard organisationId != nil, deviceSeed != nil else {
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

        guard nowUnixSeconds < UInt64.max - selectedDuration.durationSeconds,
              consentExpiresAtUnixSeconds.map({ $0 > nowUnixSeconds }) ?? true else { throw ProximityRadioAdapterError.expiredToken }
        let minted = try mintToken(nowUnixSeconds: nowUnixSeconds)
        emissionCounter &+= 1

        let txtRecord = try BonjourProximityTxtCodec.Record(
            epoch: minted.epoch,
            token: minted.raw,
            quicPort: quicPort
        )

        do {
            try gattDriver.startAdvertisingAndScanning(ephemeralToken: minted.raw)
            try bonjourDriver.startAdvertisingAndBrowsing(
                txtRecord: txtRecord.toDictionary(),
                quicPort: quicPort
            )
        } catch {
            clearProvisioning()
            lastError = (error as? ProximityRadioAdapterError) ?? .bluetoothUnavailable
            throw error
        }

        activeTokenHex = minted.tokenHex
        activeEpoch = minted.epoch
        let deadline = min(nowUnixSeconds + selectedDuration.durationSeconds, consentExpiresAtUnixSeconds ?? UInt64.max)
        expiresAtUnixSeconds = deadline
        isSessionActive = true
        lastError = nil
        preparedLeaseExpiryTask?.cancel()
        preparedLeaseExpiryTask = nil
        scheduleSessionExpiryTimer(durationSeconds: deadline - nowUnixSeconds)
        scheduleRotationTimer(nowUnixSeconds: nowUnixSeconds)
    }

    /// Refreshes both transports at an epoch boundary without extending the consent deadline.
    public func refreshSession(nowUnixSeconds: UInt64) throws {
        evaluateExpiry(nowUnixSeconds: nowUnixSeconds)
        guard isSessionActive, isForegroundActive, hasForegroundConsent else { return }
        let epoch = UInt32(truncatingIfNeeded: nowUnixSeconds / ProximityRadioConstants.epochRotationSeconds)
        guard epoch != activeEpoch else { return }
        do {
            let minted = try mintToken(nowUnixSeconds: nowUnixSeconds)
            emissionCounter &+= 1
            let record = try BonjourProximityTxtCodec.Record(epoch: minted.epoch, token: minted.raw, quicPort: quicPort)
            try gattDriver.startAdvertisingAndScanning(ephemeralToken: minted.raw)
            try bonjourDriver.startAdvertisingAndBrowsing(txtRecord: record.toDictionary(), quicPort: quicPort)
            activeTokenHex = minted.tokenHex
            activeEpoch = minted.epoch
            peers.removeAll()
            rssiClassifiers.removeAll()
        } catch {
            clearProvisioning()
            lastError = (error as? ProximityRadioAdapterError) ?? .bluetoothUnavailable
            throw error
        }
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
                if epochLease != nil { clearProvisioning() } else { stopRadioSessionPreservingProvisioning() }
            } else {
                backgroundAutoStopTask = Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: backgroundGraceNanoseconds)
                    guard !Task.isCancelled, let self, !self.isForegroundActive else { return }
                    if self.epochLease != nil { self.clearProvisioning() } else { self.stopRadioSessionPreservingProvisioning() }
                }
            }
        }
    }

    /// Evaluates deterministic wall-clock TTL expiry and tears down radio state if expired.
    public func evaluateExpiry(nowUnixSeconds: UInt64) {
        if let expiresAtUnixSeconds, nowUnixSeconds >= expiresAtUnixSeconds {
            if epochLease != nil { clearProvisioning() } else { leaveProximity() }
            return
        }
        if let lease = epochLease, nowUnixSeconds >= lease.expiresAt {
            let deadline = isSessionActive && isForegroundActive && hasForegroundConsent ? expiresAtUnixSeconds : nil
            clearProvisioning()
            if let deadline, nowUnixSeconds < deadline { onAuthenticatedRebootstrapRequired?(deadline) }
        }
    }

    /// Instant kill-switch wiping active check-in token, discovered peers, and stopping BLE + Bonjour radios.
    public func leaveProximity() {
        let hadEpochLease = epochLease != nil
        stopRadioSessionPreservingProvisioning()
        hasForegroundConsent = false
        if hadEpochLease {
            epochLease = nil
            deviceSeed = nil
            organisationId = nil
        }
    }

    /// Drops volatile radio provisioning when its authenticated owner or workspace is left.
    public func clearProvisioning() {
        leaveProximity()
        workspaceMasterKey = nil
        epochLease = nil
        deviceSeed = nil
        organisationId = nil
        emissionCounter = 0
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
        evaluateExpiry(nowUnixSeconds: nowUnixSeconds)
        guard isSessionActive, isForegroundActive, hasForegroundConsent else {
            throw ProximityRadioAdapterError.foregroundConsentRequired
        }
        guard let organisationId else {
            throw ProximityRadioAdapterError.invalidOrganisation
        }
        let decoded: EphemeralHkdfTokenCodec.DecodedToken
        if let lease = epochLease {
            decoded = try EphemeralHkdfTokenCodec.verifyWithEpochMacKey(raw: tokenData, organisationId: organisationId,
                scopeTag: scopeTag, epoch: lease.epoch, epochExpiresAtUnixSeconds: lease.expiresAt,
                epochMacKey: lease.key, nowUnixSeconds: nowUnixSeconds)
        } else if let workspaceMasterKey {
            decoded = try EphemeralHkdfTokenCodec.verify(raw: tokenData, organisationId: organisationId,
                scopeTag: scopeTag, workspaceMasterKey: workspaceMasterKey, nowUnixSeconds: nowUnixSeconds)
        } else { throw ProximityRadioAdapterError.invalidKeyMaterial }
        guard let deviceSeed,
              !EphemeralHkdfTokenCodec.constantTimeEquals(decoded.rollingPseudonym,
                EphemeralHkdfTokenCodec.deriveRollingPseudonym(deviceSeed: deviceSeed,
                    organisationId: organisationId, scopeTag: scopeTag, epoch: decoded.epoch)) else {
            throw ProximityRadioAdapterError.replayRejected
        }
        let replayKey = "\(decoded.epoch):\(decoded.rollingPseudonymHex)"
        if let prev = seenPeerCounters[replayKey], decoded.counter <= prev {
            throw ProximityRadioAdapterError.replayRejected
        }
        // Never evict replay receipts to admit new pseudonyms during a valid lease/session.
        // Refuse before touching any replay, peer or classifier state once any bound is full.
        guard (seenPeerCounters[replayKey] != nil || seenPeerCounters.count < Self.maxTrackedPeers),
              (peers.contains(where: { $0.id == decoded.rollingPseudonymHex }) || peers.count < Self.maxTrackedPeers),
              (rssiClassifiers[decoded.rollingPseudonymHex] != nil || rssiClassifiers.count < Self.maxTrackedPeers) else {
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
        bonjourDriver.onFailure = { [weak self] error in
            self?.clearProvisioning()
            self?.lastError = error
        }
        gattDriver.onFailure = { [weak self] error in
            self?.clearProvisioning()
            self?.lastError = error
        }
        gattDriver.onPeerTokenObserved = { [weak self] tokenData, rssi in
            _ = try? self?.ingestBleObservation(tokenData: tokenData, rssiDbm: rssi)
        }
        bonjourDriver.onPeerTxtObserved = { [weak self] entries in
            _ = try? self?.ingestBonjourTxtObservation(entries: entries)
        }
    }

    private func mintToken(nowUnixSeconds: UInt64) throws -> EphemeralHkdfTokenCodec.DecodedToken {
        guard let organisationId, let deviceSeed else { throw ProximityRadioAdapterError.invalidKeyMaterial }
        if let lease = epochLease {
            return try EphemeralHkdfTokenCodec.mintWithEpochMacKey(organisationId: organisationId, scopeTag: scopeTag,
                epoch: lease.epoch, epochExpiresAtUnixSeconds: lease.expiresAt, epochMacKey: lease.key,
                deviceSeed: deviceSeed, nowUnixSeconds: nowUnixSeconds, counter: emissionCounter)
        }
        guard let workspaceMasterKey else { throw ProximityRadioAdapterError.invalidKeyMaterial }
        return try EphemeralHkdfTokenCodec.mint(organisationId: organisationId, scopeTag: scopeTag,
            workspaceMasterKey: workspaceMasterKey, deviceSeed: deviceSeed, nowUnixSeconds: nowUnixSeconds, counter: emissionCounter)
    }

    private func scheduleSessionExpiryTimer(durationSeconds: UInt64) {
        autoStopTask?.cancel()
        autoStopTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: durationSeconds * 1_000_000_000)
            guard !Task.isCancelled else { return }
            self?.leaveProximity()
        }
    }

    private func scheduleRotationTimer(nowUnixSeconds: UInt64) {
        rotationTask?.cancel()
        let delay = ProximityRadioConstants.epochRotationSeconds - nowUnixSeconds % ProximityRadioConstants.epochRotationSeconds
        rotationTask = Task { @MainActor [weak self] in
            var remaining = delay
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: remaining * 1_000_000_000) }
                catch { return }
                guard !Task.isCancelled, let self, self.isSessionActive else { return }
                let now = self.clock()
                do { try self.refreshSession(nowUnixSeconds: now) }
                catch { return }
                remaining = ProximityRadioConstants.epochRotationSeconds - now % ProximityRadioConstants.epochRotationSeconds
            }
        }
    }

    private func stopRadioSessionPreservingProvisioning() {
        preparedLeaseExpiryTask?.cancel()
        preparedLeaseExpiryTask = nil
        autoStopTask?.cancel()
        autoStopTask = nil
        rotationTask?.cancel()
        rotationTask = nil
        backgroundAutoStopTask?.cancel()
        backgroundAutoStopTask = nil
        gattDriver.stopAll()
        bonjourDriver.stopAll()
        isSessionActive = false
        activeTokenHex = nil
        activeEpoch = nil
        expiresAtUnixSeconds = nil
        peers.removeAll()
        seenPeerCounters.removeAll()
        rssiClassifiers.removeAll()
    }
}
