package io.kodera.android.domain

import java.nio.ByteBuffer
import java.security.GeneralSecurityException
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

enum class ProximityBeaconV2Error {
    INVALID_INPUT,
    SCOPE_MISMATCH,
    EPOCH_MISMATCH,
    AUTHENTICATION_FAILED,
    REPLAY,
    CAPACITY,
    FOREGROUND_CONSENT_REQUIRED,
    BATTERY_BUDGET_EXCEEDED,
    DUTY_CYCLE_THROTTLED,
    CRYPTO_UNAVAILABLE,
}

class ProximityBeaconV2Failure(val reason: ProximityBeaconV2Error) : Exception(reason.name)

/**
 * Explicitly distinguishes online Matrix `#proximity` channel relays from genuine local BLE v2 radio frames.
 */
enum class ProximityTransportLane {
    ONLINE_MATRIX_RELAY,
    LOCAL_BLE_RADIO_V2,
}

/**
 * Rotating 27-byte BLE service-data discovery packet (`KP\x02`), carrying no persistent device ID or public key.
 * Byte-for-byte compatible with `packages/kodera-rs/src/proximity_beacon_v2.rs`.
 */
class ProximityBeaconV2 private constructor(
    private val raw: ByteArray,
) {
    fun bytes(): ByteArray = raw.copyOf()

    val window: Long
        get() = readUnsignedBe32(raw, 3)

    fun pseudonymBytes(): ByteArray = raw.copyOfRange(7, 15)

    val pseudonymHex: String
        get() = encodeProximityHex(raw.copyOfRange(7, 15))

    val sequence: Long
        get() = readUnsignedBe32(raw, 15)

    override fun equals(other: Any?): Boolean =
        other is ProximityBeaconV2 && MessageDigest.isEqual(raw, other.raw)

    override fun hashCode(): Int = raw.contentHashCode()

    override fun toString(): String = encodeProximityHex(raw)

    companion object {
        const val WIRE_BYTES: Int = 27
        const val ROTATION_WINDOW_SECONDS: Long = 300L
        const val GRACE_SECONDS: Long = 30L
        const val MAX_PEERS: Int = 4096

        internal val DOMAIN_PREFIX: ByteArray = "kodera-proximity-beacon-v2:\u0000".toByteArray(Charsets.US_ASCII)

        fun fromBytes(bytes: ByteArray): ProximityBeaconV2 {
            if (bytes.size != WIRE_BYTES ||
                bytes[0] != 0x4B.toByte() ||
                bytes[1] != 0x50.toByte() ||
                bytes[2] != 0x02.toByte()
            ) {
                throw ProximityBeaconV2Failure(ProximityBeaconV2Error.INVALID_INPUT)
            }
            return ProximityBeaconV2(bytes.copyOf())
        }

        internal fun windowForUnixSeconds(nowUnixSeconds: Long): Long {
            if (nowUnixSeconds < 0L) {
                throw ProximityBeaconV2Failure(ProximityBeaconV2Error.INVALID_INPUT)
            }
            val computed = nowUnixSeconds / ROTATION_WINDOW_SECONDS
            if (computed > 0xFFFF_FFFFL) {
                throw ProximityBeaconV2Failure(ProximityBeaconV2Error.INVALID_INPUT)
            }
            return computed
        }

        internal fun transcript(organisationId: String, packetSlice: ByteArray): ByteArray {
            val orgBytes = organisationId.toByteArray(Charsets.UTF_8)
            return DOMAIN_PREFIX + orgBytes + packetSlice
        }

        internal fun hmacSha256(keyBytes: ByteArray, message: ByteArray): ByteArray =
            try {
                val mac = Mac.getInstance("HmacSHA256")
                mac.init(SecretKeySpec(keyBytes, "HmacSHA256"))
                mac.doFinal(message)
            } catch (_: GeneralSecurityException) {
                throw ProximityBeaconV2Failure(ProximityBeaconV2Error.CRYPTO_UNAVAILABLE)
            }

        internal fun writeUnsignedBe32(value: Long): ByteArray =
            byteArrayOf(
                ((value ushr 24) and 0xFFL).toByte(),
                ((value ushr 16) and 0xFFL).toByte(),
                ((value ushr 8) and 0xFFL).toByte(),
                (value and 0xFFL).toByte(),
            )

        private fun readUnsignedBe32(bytes: ByteArray, offset: Int): Long =
            ((bytes[offset].toLong() and 0xFFL) shl 24) or
                ((bytes[offset + 1].toLong() and 0xFFL) shl 16) or
                ((bytes[offset + 2].toLong() and 0xFFL) shl 8) or
                (bytes[offset + 3].toLong() and 0xFFL)
    }
}

/** Authenticated discovery observation; never proof of personal identity, physical presence, or safety. */
data class BeaconObservationV2(
    val window: Long,
    private val pseudonymRaw: ByteArray,
    val sequence: Long,
) {
    init {
        require(pseudonymRaw.size == 8)
    }

    fun pseudonymBytes(): ByteArray = pseudonymRaw.copyOf()

    val pseudonymHex: String get() = encodeProximityHex(pseudonymRaw)
    val lane: ProximityTransportLane get() = ProximityTransportLane.LOCAL_BLE_RADIO_V2

    override fun equals(other: Any?): Boolean =
        other is BeaconObservationV2 &&
            window == other.window &&
            sequence == other.sequence &&
            MessageDigest.isEqual(pseudonymRaw, other.pseudonymRaw)

    override fun hashCode(): Int {
        var result = window.hashCode()
        result = 31 * result + pseudonymRaw.contentHashCode()
        result = 31 * result + sequence.hashCode()
        return result
    }
}

/**
 * RFC 5869 HKDF-SHA256 key derivation for provisioning domain-separated organisation discovery
 * and per-device beacon seeds from root material.
 */
object ProximityBeaconKeyDerivation {
    private val DISCOVERY_INFO = "kodera-proximity-v2:discovery".toByteArray(Charsets.US_ASCII)
    private val DEVICE_SEED_INFO_PREFIX = "kodera-proximity-v2:device-seed:".toByteArray(Charsets.US_ASCII)

    class ProvisionedBeaconKeys internal constructor(
        private val discoveryBytes: ByteArray,
        private val seedBytes: ByteArray,
    ) : AutoCloseable {
        fun discoveryKeyBytes(): ByteArray = discoveryBytes.copyOf()
        fun deviceSeedBytes(): ByteArray = seedBytes.copyOf()

        override fun close() {
            discoveryBytes.fill(0)
            seedBytes.fill(0)
        }

        override fun toString(): String = "ProvisionedBeaconKeys([redacted])"
    }

    fun deriveKeys(
        organisationId: String,
        rootMaterial: ByteArray,
        deviceContext: String,
    ): ProvisionedBeaconKeys {
        if (!TrustPolicy.canonicalNonNilUUID(organisationId) ||
            rootMaterial.size != 32 ||
            rootMaterial.all { it == 0.toByte() } ||
            !TrustPolicy.boundedScopeChannelId(deviceContext)
        ) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.INVALID_INPUT)
        }
        val salt = organisationId.toByteArray(Charsets.UTF_8)
        val prk = hkdfExtract(salt = salt, inputMaterial = rootMaterial)
        return try {
            val discovery = hkdfExpand32(prk, DISCOVERY_INFO)
            val seedInfo = DEVICE_SEED_INFO_PREFIX + deviceContext.toByteArray(Charsets.UTF_8)
            val seed = hkdfExpand32(prk, seedInfo)
            ProvisionedBeaconKeys(discovery, seed)
        } finally {
            prk.fill(0)
        }
    }

    internal fun hkdfExtract(salt: ByteArray, inputMaterial: ByteArray): ByteArray =
        ProximityBeaconV2.hmacSha256(
            keyBytes = if (salt.isEmpty()) ByteArray(32) else salt,
            message = inputMaterial,
        )

    internal fun hkdfExpand32(prkBytes: ByteArray, contextInfo: ByteArray): ByteArray {
        val blockInput = contextInfo + byteArrayOf(0x01)
        return ProximityBeaconV2.hmacSha256(keyBytes = prkBytes, message = blockInput)
    }
}

/** Emits rotating pseudonymous v2 BLE discovery packets with monotonic per-window sequence numbers. */
class ProximityBeaconV2Sender(
    val organisationId: String,
    discoveryKey: ByteArray,
    deviceSeed: ByteArray,
) : AutoCloseable {
    private val discoveryBytes: ByteArray
    private val seedBytes: ByteArray
    private var lastWindow: Long? = null
    private var sequence: Long = 0L
    private var closed: Boolean = false

    init {
        if (!TrustPolicy.canonicalNonNilUUID(organisationId) ||
            discoveryKey.size != 32 ||
            deviceSeed.size != 32 ||
            discoveryKey.all { it == 0.toByte() } ||
            deviceSeed.all { it == 0.toByte() } ||
            MessageDigest.isEqual(discoveryKey, deviceSeed)
        ) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.INVALID_INPUT)
        }
        discoveryBytes = discoveryKey.copyOf()
        seedBytes = deviceSeed.copyOf()
    }

    @Synchronized
    fun emitAt(nowUnixSeconds: Long): ProximityBeaconV2 {
        if (closed) throw ProximityBeaconV2Failure(ProximityBeaconV2Error.INVALID_INPUT)
        val currentWindow = ProximityBeaconV2.windowForUnixSeconds(nowUnixSeconds)
        val previous = lastWindow
        if (previous != null && currentWindow < previous) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.EPOCH_MISMATCH)
        }
        val currentSequence = if (previous == currentWindow) sequence else 0L
        if (currentSequence > 0xFFFF_FFFFL) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.CAPACITY)
        }
        val windowBe = ProximityBeaconV2.writeUnsignedBe32(currentWindow)
        val pseudonymContext = ProximityBeaconV2.transcript(organisationId, windowBe) + discoveryBytes
        val pseudonymFull = ProximityBeaconV2.hmacSha256(seedBytes, pseudonymContext)

        val raw = ByteArray(ProximityBeaconV2.WIRE_BYTES)
        raw[0] = 0x4B
        raw[1] = 0x50
        raw[2] = 0x02
        System.arraycopy(windowBe, 0, raw, 3, 4)
        System.arraycopy(pseudonymFull, 0, raw, 7, 8)
        val sequenceBe = ProximityBeaconV2.writeUnsignedBe32(currentSequence)
        System.arraycopy(sequenceBe, 0, raw, 15, 4)

        val tagFull = ProximityBeaconV2.hmacSha256(
            discoveryBytes,
            ProximityBeaconV2.transcript(organisationId, raw.copyOfRange(0, 19)),
        )
        System.arraycopy(tagFull, 0, raw, 19, 8)

        lastWindow = currentWindow
        sequence = currentSequence + 1L
        return ProximityBeaconV2.fromBytes(raw)
    }

    @Synchronized
    override fun close() {
        closed = true
        discoveryBytes.fill(0)
        seedBytes.fill(0)
    }

    override fun toString(): String = "ProximityBeaconV2Sender([redacted])"
}

/** Verifies v2 BLE discovery packets with constant-time MAC comparison and bounded per-window replay tracking. */
class ProximityBeaconV2Receiver(
    val organisationId: String,
    discoveryKey: ByteArray,
    val capacity: Int = 256,
) : AutoCloseable {
    private data class PeerWindowIdentity(val window: Long, val pseudonymHex: String)

    private val discoveryBytes: ByteArray
    private var latestClockWindow: Long? = null
    private val seen = LinkedHashMap<PeerWindowIdentity, Long>()
    private var closed: Boolean = false

    init {
        if (!TrustPolicy.canonicalNonNilUUID(organisationId) ||
            discoveryKey.size != 32 ||
            discoveryKey.all { it == 0.toByte() } ||
            capacity !in 1..ProximityBeaconV2.MAX_PEERS
        ) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.INVALID_INPUT)
        }
        discoveryBytes = discoveryKey.copyOf()
    }

    @Synchronized
    fun acceptAt(bytes: ByteArray, nowUnixSeconds: Long): BeaconObservationV2 {
        if (closed) throw ProximityBeaconV2Failure(ProximityBeaconV2Error.INVALID_INPUT)
        val packet = ProximityBeaconV2.fromBytes(bytes)
        val currentWindow = ProximityBeaconV2.windowForUnixSeconds(nowUnixSeconds)
        val previousClock = latestClockWindow
        if (previousClock != null && currentWindow < previousClock) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.EPOCH_MISMATCH)
        }
        val withinGrace = (nowUnixSeconds % ProximityBeaconV2.ROTATION_WINDOW_SECONDS) <= ProximityBeaconV2.GRACE_SECONDS
        val previousAdmitted = currentWindow > 0L && (currentWindow - 1L) == packet.window && withinGrace
        if (packet.window != currentWindow && !previousAdmitted) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.EPOCH_MISMATCH)
        }

        val expectedTag = ProximityBeaconV2.hmacSha256(
            discoveryBytes,
            ProximityBeaconV2.transcript(organisationId, bytes.copyOfRange(0, 19)),
        ).copyOfRange(0, 8)
        val actualTag = bytes.copyOfRange(19, ProximityBeaconV2.WIRE_BYTES)
        var mismatch = 0
        for (i in 0 until 8) {
            mismatch = mismatch or ((expectedTag[i].toInt() xor actualTag[i].toInt()) and 0xFF)
        }
        if (mismatch != 0) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.AUTHENTICATION_FAILED)
        }

        val identity = PeerWindowIdentity(packet.window, packet.pseudonymHex)
        val priorSequence = seen[identity]
        if (priorSequence != null && packet.sequence <= priorSequence) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.REPLAY)
        }

        val oldestRetainedWindow = if (withinGrace && currentWindow > 0L) currentWindow - 1L else currentWindow
        val retainedCount = seen.keys.count { it.window >= oldestRetainedWindow }
        if (priorSequence == null && retainedCount >= capacity) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.CAPACITY)
        }

        seen.entries.removeIf { it.key.window < oldestRetainedWindow }
        seen[identity] = packet.sequence
        latestClockWindow = currentWindow
        return BeaconObservationV2(
            window = packet.window,
            pseudonymRaw = packet.pseudonymBytes(),
            sequence = packet.sequence,
        )
    }

    @Synchronized
    override fun close() {
        closed = true
        discoveryBytes.fill(0)
        seen.clear()
    }

    override fun toString(): String = "ProximityBeaconV2Receiver([redacted])"
}

/** Snapshot of device battery and power-saver state guarding BLE scan/advertise duty cycles. */
data class ProximityBatterySnapshot(
    val batteryLevelPercent: Int? = null,
    val isPowerSaveMode: Boolean = false,
) {
    init {
        if (batteryLevelPercent != null && batteryLevelPercent !in 0..100) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.INVALID_INPUT)
        }
    }
}

/**
 * Battery-budget and duty-cycle guard for foreground BLE proximity operations:
 * - Refuses radio activation under Android Battery Saver (`isPowerSaveMode == true`) or below `minBatteryPercent` (15%).
 * - Caps active scan window to at most 20% of scan interval (`maxScanWindowSeconds * 5 <= minScanCooldownSeconds`)
 *   and caps broadcasts per 300s window.
 */
data class ProximityDutyCycleBudget(
    val maxScanWindowSeconds: Long = 10L,
    val minScanCooldownSeconds: Long = 50L,
    val maxBroadcastsPerRotationWindow: Int = 6,
    val minBatteryPercent: Int = 15,
) {
    init {
        if (maxScanWindowSeconds !in 1L..30L ||
            minScanCooldownSeconds < maxScanWindowSeconds * 5L ||
            maxBroadcastsPerRotationWindow !in 1..30 ||
            minBatteryPercent !in 5..50
        ) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.INVALID_INPUT)
        }
    }

    val activeDutyCyclePermille: Int
        get() = ((maxScanWindowSeconds * 1000L) / minScanCooldownSeconds).toInt()

    fun validateBattery(battery: ProximityBatterySnapshot) {
        if (battery.isPowerSaveMode) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.BATTERY_BUDGET_EXCEEDED)
        }
        val level = battery.batteryLevelPercent
        if (level != null && level < minBatteryPercent) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.BATTERY_BUDGET_EXCEEDED)
        }
    }

    fun validateScanStart(
        battery: ProximityBatterySnapshot,
        lastScanStartedAtUnixSeconds: Long?,
        nowUnixSeconds: Long,
    ) {
        if (nowUnixSeconds < 0L) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.INVALID_INPUT)
        }
        validateBattery(battery)
        if (lastScanStartedAtUnixSeconds != null) {
            if (nowUnixSeconds < lastScanStartedAtUnixSeconds) {
                throw ProximityBeaconV2Failure(ProximityBeaconV2Error.EPOCH_MISMATCH)
            }
            if (nowUnixSeconds - lastScanStartedAtUnixSeconds < minScanCooldownSeconds) {
                throw ProximityBeaconV2Failure(ProximityBeaconV2Error.DUTY_CYCLE_THROTTLED)
            }
        }
    }

    fun validateBroadcast(
        battery: ProximityBatterySnapshot,
        emissionsInCurrentWindow: Int,
    ) {
        validateBattery(battery)
        if (emissionsInCurrentWindow < 0) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.INVALID_INPUT)
        }
        if (emissionsInCurrentWindow >= maxBroadcastsPerRotationWindow) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.DUTY_CYCLE_THROTTLED)
        }
    }
}
