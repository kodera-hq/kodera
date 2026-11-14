import Foundation

public enum ProximityBeaconV2Error: Error, Equatable, Sendable {
    case invalidInput
    case epochMismatch
    case authenticationFailed
    case replay
    case capacity
    case scopeMismatch
    case foregroundConsentRequired
    case batteryBudgetExceeded
    case dutyCycleThrottled
}

/// Public 27-byte rotating BLE discovery advertisement aligned byte-for-byte with `kodera-rs` `proximity_beacon_v2`.
/// Carries no persistent device identifier, public key, or sender name.
public struct ProximityBeaconV2: Equatable, Hashable, Sendable {
    public static let wireByteCount = 27
    public static let rotationWindowSeconds: UInt64 = 300
    public static let graceSeconds: UInt64 = 30
    public static let maxPeers = 4096
    fileprivate static let domain = Data("kodera-proximity-beacon-v2:\0".utf8)

    public let bytes: Data

    public init(fromBytes raw: Data) throws {
        guard raw.count == Self.wireByteCount else {
            throw ProximityBeaconV2Error.invalidInput
        }
        let array = Array(raw)
        guard array[0] == 0x4B, array[1] == 0x50, array[2] == 0x02 else {
            throw ProximityBeaconV2Error.invalidInput
        }
        self.bytes = Data(array)
    }

    public var window: UInt32 {
        let b = Array(bytes)
        return (UInt32(b[3]) << 24) | (UInt32(b[4]) << 16) | (UInt32(b[5]) << 8) | UInt32(b[6])
    }

    public var pseudonym: Data {
        Data(Array(bytes)[7..<15])
    }

    public var sequence: UInt32 {
        let b = Array(bytes)
        return (UInt32(b[15]) << 24) | (UInt32(b[16]) << 16) | (UInt32(b[17]) << 8) | UInt32(b[18])
    }

    fileprivate static func windowIndex(nowUnixSeconds: UInt64) throws -> UInt32 {
        let quotient = nowUnixSeconds / rotationWindowSeconds
        guard let window = UInt32(exactly: quotient) else {
            throw ProximityBeaconV2Error.invalidInput
        }
        return window
    }

    fileprivate static func transcript(organisationId: String, packet: Data) -> Data {
        var data = domain
        data.append(contentsOf: organisationId.utf8)
        data.append(packet)
        return data
    }

    fileprivate static func bigEndianBytes(_ value: UInt32) -> Data {
        Data([
            UInt8(truncatingIfNeeded: value >> 24),
            UInt8(truncatingIfNeeded: value >> 16),
            UInt8(truncatingIfNeeded: value >> 8),
            UInt8(truncatingIfNeeded: value),
        ])
    }
}

/// Authenticated discovery observation. A group MAC is never proof of member identity or safety.
public struct BeaconObservationV2: Equatable, Sendable {
    public let window: UInt32
    public let pseudonym: Data
    public let sequence: UInt32

    public init(window: UInt32, pseudonym: Data, sequence: UInt32) {
        self.window = window
        self.pseudonym = pseudonym
        self.sequence = sequence
    }
}

/// Rotating v2 beacon emitter provisioned with an organisation discovery key and private per-device seed.
public struct ProximityBeaconV2Sender: Sendable, CustomDebugStringConvertible {
    private let organisationId: String
    private let discoveryKey: Data
    private let deviceSeed: Data
    private var lastWindow: UInt32?
    private var sequence: UInt64 = 0

    public var debugDescription: String { "ProximityBeaconV2Sender([redacted])" }

    public init(organisationId: String, discoveryKey: Data, deviceSeed: Data) throws {
        let zero = Data(repeating: 0, count: 32)
        guard TrustPolicy.canonicalNonNilUUID(organisationId),
              discoveryKey.count == 32,
              deviceSeed.count == 32,
              discoveryKey != zero,
              deviceSeed != zero,
              discoveryKey != deviceSeed else {
            throw ProximityBeaconV2Error.invalidInput
        }
        self.organisationId = organisationId
        self.discoveryKey = discoveryKey
        self.deviceSeed = deviceSeed
    }

    public mutating func emit(atUnixSeconds nowUnixSeconds: UInt64) throws -> ProximityBeaconV2 {
        let current = try ProximityBeaconV2.windowIndex(nowUnixSeconds: nowUnixSeconds)
        if let lastWindow, current < lastWindow {
            throw ProximityBeaconV2Error.epochMismatch
        }
        let nextSequence: UInt64 = (lastWindow == current) ? sequence : 0
        guard let sequenceU32 = UInt32(exactly: nextSequence) else {
            throw ProximityBeaconV2Error.capacity
        }
        var context = ProximityBeaconV2.transcript(
            organisationId: organisationId,
            packet: ProximityBeaconV2.bigEndianBytes(current)
        )
        context.append(discoveryKey)
        let pseudonymDigest = ProximitySHA256.hmac(key: deviceSeed, data: context)

        var headerAndBody = Data([0x4B, 0x50, 0x02])
        headerAndBody.append(ProximityBeaconV2.bigEndianBytes(current))
        headerAndBody.append(pseudonymDigest.prefix(8))
        headerAndBody.append(ProximityBeaconV2.bigEndianBytes(sequenceU32))

        let tag = ProximitySHA256.hmac(
            key: discoveryKey,
            data: ProximityBeaconV2.transcript(organisationId: organisationId, packet: headerAndBody)
        )
        var wire = headerAndBody
        wire.append(tag.prefix(8))

        lastWindow = current
        sequence = nextSequence + 1
        return try ProximityBeaconV2(fromBytes: wire)
    }
}

/// Bounded per-window replay verifier for v2 discovery beacons.
public struct ProximityBeaconV2Receiver: Sendable, CustomDebugStringConvertible {
    private struct SeenKey: Hashable, Sendable {
        let window: UInt32
        let pseudonym: Data
    }

    private let organisationId: String
    private let discoveryKey: Data
    private let capacity: Int
    private var latestClockWindow: UInt32?
    private var seen: [SeenKey: UInt32] = [:]

    public var debugDescription: String { "ProximityBeaconV2Receiver([redacted])" }

    public init(organisationId: String, discoveryKey: Data, capacity: Int = 256) throws {
        let zero = Data(repeating: 0, count: 32)
        guard TrustPolicy.canonicalNonNilUUID(organisationId),
              discoveryKey.count == 32,
              discoveryKey != zero,
              (1...ProximityBeaconV2.maxPeers).contains(capacity) else {
            throw ProximityBeaconV2Error.invalidInput
        }
        self.organisationId = organisationId
        self.discoveryKey = discoveryKey
        self.capacity = capacity
    }

    public mutating func accept(
        bytes: Data,
        nowUnixSeconds: UInt64
    ) throws -> BeaconObservationV2 {
        let packet = try ProximityBeaconV2(fromBytes: bytes)
        let current = try ProximityBeaconV2.windowIndex(nowUnixSeconds: nowUnixSeconds)
        if let latestClockWindow, current < latestClockWindow {
            throw ProximityBeaconV2Error.epochMismatch
        }
        let inGrace = (nowUnixSeconds % ProximityBeaconV2.rotationWindowSeconds) <= ProximityBeaconV2.graceSeconds
        let previousAdmitted = current > 0 && (current - 1) == packet.window && inGrace
        guard packet.window == current || previousAdmitted else {
            throw ProximityBeaconV2Error.epochMismatch
        }

        let headerSlice = Data(Array(bytes)[0..<19])
        let expectedTag = Array(
            ProximitySHA256.hmac(
                key: discoveryKey,
                data: ProximityBeaconV2.transcript(organisationId: organisationId, packet: headerSlice)
            ).prefix(8)
        )
        let suppliedTag = Array(bytes)[19..<27]
        let mismatch = zip(expectedTag, suppliedTag).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) }
        guard mismatch == 0 else {
            throw ProximityBeaconV2Error.authenticationFailed
        }

        let key = SeenKey(window: packet.window, pseudonym: packet.pseudonym)
        if let lastSequence = seen[key], packet.sequence <= lastSequence {
            throw ProximityBeaconV2Error.replay
        }

        let oldest: UInt32 = (inGrace && current > 0) ? (current - 1) : current
        let retainedCount = seen.keys.filter { $0.window >= oldest }.count
        if seen[key] == nil && retainedCount >= capacity {
            throw ProximityBeaconV2Error.capacity
        }

        seen = seen.filter { $0.key.window >= oldest }
        seen[key] = packet.sequence
        latestClockWindow = current
        return BeaconObservationV2(
            window: packet.window,
            pseudonym: packet.pseudonym,
            sequence: packet.sequence
        )
    }
}

/// Device power snapshot supplied to the duty-cycle controller.
public struct ProximityBatterySnapshot: Equatable, Sendable {
    public let levelPercent: Int
    public let isCharging: Bool
    public let isLowPowerModeEnabled: Bool

    public init(levelPercent: Int, isCharging: Bool = false, isLowPowerModeEnabled: Bool = false) throws {
        guard (0...100).contains(levelPercent) else {
            throw ProximityBeaconV2Error.invalidInput
        }
        self.levelPercent = levelPercent
        self.isCharging = isCharging
        self.isLowPowerModeEnabled = isLowPowerModeEnabled
    }

    public static let nominal = try! ProximityBatterySnapshot(
        levelPercent: 80,
        isCharging: false,
        isLowPowerModeEnabled: false
    )
}

/// Enforces bounded BLE scan windows, cooldown intervals (<= 20% active duty cycle), and battery floors.
public struct ProximityDutyCycleBudget: Equatable, Sendable {
    public let minimumBatteryPercent: Int
    public let maxScanWindowSeconds: UInt64
    public let minCooldownSeconds: UInt64
    public let maxBroadcastsPerRotationWindow: Int

    public static let standard = try! ProximityDutyCycleBudget(
        minimumBatteryPercent: 15,
        maxScanWindowSeconds: 10,
        minCooldownSeconds: 50,
        maxBroadcastsPerRotationWindow: 6
    )

    public init(
        minimumBatteryPercent: Int,
        maxScanWindowSeconds: UInt64,
        minCooldownSeconds: UInt64,
        maxBroadcastsPerRotationWindow: Int
    ) throws {
        guard (10...50).contains(minimumBatteryPercent),
              (1...30).contains(maxScanWindowSeconds),
              (10...300).contains(minCooldownSeconds),
              (1...20).contains(maxBroadcastsPerRotationWindow),
              maxScanWindowSeconds * 5 <= maxScanWindowSeconds + minCooldownSeconds else {
            throw ProximityBeaconV2Error.invalidInput
        }
        self.minimumBatteryPercent = minimumBatteryPercent
        self.maxScanWindowSeconds = maxScanWindowSeconds
        self.minCooldownSeconds = minCooldownSeconds
        self.maxBroadcastsPerRotationWindow = maxBroadcastsPerRotationWindow
    }

    public func validateBattery(_ battery: ProximityBatterySnapshot) throws {
        if battery.isLowPowerModeEnabled {
            throw ProximityBeaconV2Error.batteryBudgetExceeded
        }
        if !battery.isCharging && battery.levelPercent < minimumBatteryPercent {
            throw ProximityBeaconV2Error.batteryBudgetExceeded
        }
    }

    public func validateScanStart(
        battery: ProximityBatterySnapshot,
        lastScanStartedAt: UInt64?,
        nowUnixSeconds: UInt64
    ) throws {
        try validateBattery(battery)
        if let lastScanStartedAt {
            guard nowUnixSeconds >= lastScanStartedAt else {
                throw ProximityBeaconV2Error.epochMismatch
            }
            let minimumNextStart = lastScanStartedAt + maxScanWindowSeconds + minCooldownSeconds
            guard nowUnixSeconds >= minimumNextStart else {
                throw ProximityBeaconV2Error.dutyCycleThrottled
            }
        }
    }

    public func validateBroadcast(
        battery: ProximityBatterySnapshot,
        emissionsInCurrentWindow: Int
    ) throws {
        try validateBattery(battery)
        guard emissionsInCurrentWindow < maxBroadcastsPerRotationWindow else {
            throw ProximityBeaconV2Error.dutyCycleThrottled
        }
    }
}
