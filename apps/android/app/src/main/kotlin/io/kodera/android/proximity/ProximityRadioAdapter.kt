package io.kodera.android.proximity

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.ParcelUuid
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import io.kodera.android.domain.TrustPolicy
import java.nio.ByteBuffer
import java.nio.ByteOrder
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object ProximityRadioConstants {
    const val EPOCH_ROTATION_SECONDS: Long = 15L * 60L
    const val EPOCH_CLOCK_SKEW_SECONDS: Long = 60L
    const val EPHEMERAL_TOKEN_BYTES: Int = 32
    const val GATT_SERVICE_UUID: String = "7b4e4b50-9a10-4f88-b310-6b6f64657261"
    const val MDNS_SERVICE_TYPE: String = "_kodera-prox._udp"
    const val QUIC_ALPN: String = "kodera-prox/1"
    const val MAX_STATUS_NOTE_LENGTH: Int = 80
    const val MAX_SESSION_TTL_SECONDS: Long = 7_200L
}

enum class ProximitySessionDuration(val durationSeconds: Long) {
    MINUTES_15(900L),
    MINUTES_30(1_800L),
    HOUR_1(3_600L),
    HOURS_2(7_200L),
}

enum class ProximityDistanceBand {
    IMMEDIATE,
    NEAR,
    AMBIENT,
}

enum class ProximityVoluntaryError {
    INVALID_ORGANISATION,
    INVALID_KEY_MATERIAL,
    INVALID_STATUS_NOTE,
    FOREGROUND_CONSENT_REQUIRED,
    RUNTIME_PERMISSION_REQUIRED,
    MALFORMED_TOKEN,
    EXPIRED_TOKEN,
    AUTHENTICATION_FAILED,
    REPLAY_REJECTED,
    FORBIDDEN_COORDINATE_FIELD,
    MALFORMED_TXT_RECORD,
    INVALID_RSSI,
    BLUETOOTH_UNAVAILABLE,
    NSD_UNAVAILABLE,
}

class ProximityVoluntaryFailure(val reason: ProximityVoluntaryError) : Exception(reason.name)

/**
 * Runtime permission inspector for Android 12+ (`API >= 31`) BLE advertise/scan and
 * Android 13+ (`API >= 33`) nearby Wi-Fi / mDNS discovery.
 */
interface ProximityPermissionChecker {
    fun requiredBlePermissions(): List<String>
    fun requiredNsdPermissions(): List<String>
    fun missingPermissions(): List<String>
    fun hasBlePermissions(): Boolean = requiredBlePermissions().none { it in missingPermissions() }
    fun hasNsdPermissions(): Boolean = requiredNsdPermissions().none { it in missingPermissions() }
}

class RuntimeProximityPermissionChecker(
    private val sdkIntProvider: () -> Int = { Build.VERSION.SDK_INT },
    private val isPermissionGranted: (String) -> Boolean,
) : ProximityPermissionChecker {
    constructor(context: Context) : this(
        sdkIntProvider = { Build.VERSION.SDK_INT },
        isPermissionGranted = { permission ->
            ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
        },
    )

    override fun requiredBlePermissions(): List<String> {
        val sdk = sdkIntProvider()
        return if (sdk >= Build.VERSION_CODES.S) {
            listOf(
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_SCAN,
            )
        } else {
            emptyList()
        }
    }

    override fun requiredNsdPermissions(): List<String> {
        val sdk = sdkIntProvider()
        return if (sdk >= Build.VERSION_CODES.TIRAMISU) {
            listOf(Manifest.permission.NEARBY_WIFI_DEVICES)
        } else {
            emptyList()
        }
    }

    override fun missingPermissions(): List<String> {
        val required = LinkedHashSet<String>().apply {
            addAll(requiredBlePermissions())
            addAll(requiredNsdPermissions())
        }
        return required.filterNot(isPermissionGranted)
    }
}

/**
 * Stateful BLE RSSI distance-band classifier (`[-127, 20]` dBm, rejecting Bluetooth `127` sentinel)
 * with dead-zone hysteresis matching `packages/kodera-rs/src/proximity.rs`.
 */
class ProximityRssiClassifier(
    val immediateEnterDbm: Int = -55,
    val immediateExitDbm: Int = -61,
    val nearEnterDbm: Int = -75,
    val nearExitDbm: Int = -81,
) {
    var currentBand: ProximityDistanceBand? = null
        private set

    fun observe(rssiDbm: Int): ProximityDistanceBand {
        if (rssiDbm !in -127..20) {
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.INVALID_RSSI)
        }
        val next = when (currentBand) {
            null -> when {
                rssiDbm >= immediateEnterDbm -> ProximityDistanceBand.IMMEDIATE
                rssiDbm >= nearEnterDbm -> ProximityDistanceBand.NEAR
                else -> ProximityDistanceBand.AMBIENT
            }
            ProximityDistanceBand.IMMEDIATE -> when {
                rssiDbm >= immediateExitDbm -> ProximityDistanceBand.IMMEDIATE
                rssiDbm >= nearExitDbm -> ProximityDistanceBand.NEAR
                else -> ProximityDistanceBand.AMBIENT
            }
            ProximityDistanceBand.NEAR -> when {
                rssiDbm >= immediateEnterDbm -> ProximityDistanceBand.IMMEDIATE
                rssiDbm >= nearExitDbm -> ProximityDistanceBand.NEAR
                else -> ProximityDistanceBand.AMBIENT
            }
            ProximityDistanceBand.AMBIENT -> when {
                rssiDbm >= immediateEnterDbm -> ProximityDistanceBand.IMMEDIATE
                rssiDbm >= nearEnterDbm -> ProximityDistanceBand.NEAR
                else -> ProximityDistanceBand.AMBIENT
            }
        }
        currentBand = next
        return next
    }

    fun reset() {
        currentBand = null
    }
}

/**
 * Wire-compatible 32-byte `KT\x01` HKDF-SHA256 rotating 15-minute proximity token codec.
 */
object EphemeralHkdfTokenCodec {
    private const val MAGIC_0: Byte = 0x4B // 'K'
    private const val MAGIC_1: Byte = 0x54 // 'T'
    private const val VERSION: Byte = 1

    data class DecodedToken(
        val raw: ByteArray,
        val epoch: Long,
        val counter: Long,
        val rollingPseudonym: ByteArray,
    ) {
        val tokenHex: String get() = toHex(raw)
        val rollingPseudonymHex: String get() = toHex(rollingPseudonym)
    }

    fun hkdfSha256(salt: ByteArray, ikm: ByteArray, info: ByteArray, length: Int): ByteArray {
        val effectiveSalt = if (salt.isEmpty()) ByteArray(32) else salt
        val prk = hmacSha256(effectiveSalt, ikm)
        val out = ByteArray(length)
        var previous = ByteArray(0)
        var written = 0
        var blockIndex = 1
        while (written < length) {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(prk, "HmacSHA256"))
            mac.update(previous)
            mac.update(info)
            mac.update(blockIndex.toByte())
            previous = mac.doFinal()
            val copyLen = minOf(previous.size, length - written)
            System.arraycopy(previous, 0, out, written, copyLen)
            written += copyLen
            blockIndex += 1
        }
        return out
    }

    fun mint(
        organisationId: String,
        scopeTag: String = "default",
        workspaceMasterKey: ByteArray,
        deviceSeed: ByteArray,
        nowUnixSeconds: Long,
        counter: Long = 0L,
    ): DecodedToken {
        if (!TrustPolicy.canonicalNonNilUUID(organisationId)) {
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.INVALID_ORGANISATION)
        }
        if (workspaceMasterKey.size != 32 || deviceSeed.size != 32 ||
            constantTimeEquals(workspaceMasterKey, deviceSeed) ||
            workspaceMasterKey.all { it == 0.toByte() } || deviceSeed.all { it == 0.toByte() }
        ) {
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.INVALID_KEY_MATERIAL)
        }
        require(nowUnixSeconds >= 0L && counter in 0L..0xFFFF_FFFFL)

        val epoch = (nowUnixSeconds / ProximityRadioConstants.EPOCH_ROTATION_SECONDS) and 0xFFFF_FFFFL
        val pseudonym = deriveRollingPseudonym(deviceSeed, organisationId, scopeTag, epoch)

        val header = ByteBuffer.allocate(20).order(ByteOrder.BIG_ENDIAN).apply {
            put(MAGIC_0)
            put(MAGIC_1)
            put(VERSION)
            put(0.toByte())
            putInt(epoch.toInt())
            putInt(counter.toInt())
            put(pseudonym)
        }.array()

        val epochKey = deriveEpochMacKey(workspaceMasterKey, organisationId, scopeTag, epoch)
        val macTag = computeMac(epochKey, organisationId, scopeTag, header)

        val raw = ByteArray(ProximityRadioConstants.EPHEMERAL_TOKEN_BYTES)
        System.arraycopy(header, 0, raw, 0, 20)
        System.arraycopy(macTag, 0, raw, 20, 12)
        return DecodedToken(raw.copyOf(), epoch, counter, pseudonym)
    }

    fun verify(
        raw: ByteArray,
        organisationId: String,
        scopeTag: String = "default",
        workspaceMasterKey: ByteArray,
        nowUnixSeconds: Long,
    ): DecodedToken {
        if (!TrustPolicy.canonicalNonNilUUID(organisationId)) {
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.INVALID_ORGANISATION)
        }
        if (workspaceMasterKey.size != 32 || workspaceMasterKey.all { it == 0.toByte() }) {
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.INVALID_KEY_MATERIAL)
        }
        if (raw.size != ProximityRadioConstants.EPHEMERAL_TOKEN_BYTES ||
            raw[0] != MAGIC_0 || raw[1] != MAGIC_1 || raw[2] != VERSION || raw[3] != 0.toByte()
        ) {
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.MALFORMED_TOKEN)
        }

        val buffer = ByteBuffer.wrap(raw, 4, 8).order(ByteOrder.BIG_ENDIAN)
        val epoch = buffer.int.toLong() and 0xFFFF_FFFFL
        val counter = buffer.int.toLong() and 0xFFFF_FFFFL
        val pseudonym = raw.copyOfRange(12, 20)
        val suppliedMac = raw.copyOfRange(20, 32)

        if (epoch !in candidateEpochs(nowUnixSeconds)) {
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.EXPIRED_TOKEN)
        }

        val epochKey = deriveEpochMacKey(workspaceMasterKey, organisationId, scopeTag, epoch)
        val expectedMac = computeMac(epochKey, organisationId, scopeTag, raw.copyOfRange(0, 20))
        if (!constantTimeEquals(expectedMac, suppliedMac)) {
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.AUTHENTICATION_FAILED)
        }

        return DecodedToken(raw.copyOf(), epoch, counter, pseudonym)
    }

    private fun candidateEpochs(nowUnixSeconds: Long): List<Long> {
        val current = (nowUnixSeconds / ProximityRadioConstants.EPOCH_ROTATION_SECONDS) and 0xFFFF_FFFFL
        val allowed = mutableListOf(current)
        val offset = nowUnixSeconds % ProximityRadioConstants.EPOCH_ROTATION_SECONDS
        if (offset < ProximityRadioConstants.EPOCH_CLOCK_SKEW_SECONDS && current > 0L) {
            allowed += (current - 1L)
        }
        if (offset >= ProximityRadioConstants.EPOCH_ROTATION_SECONDS - ProximityRadioConstants.EPOCH_CLOCK_SKEW_SECONDS &&
            current < 0xFFFF_FFFFL
        ) {
            allowed += (current + 1L)
        }
        return allowed
    }

    private fun deriveEpochMacKey(
        workspaceMasterKey: ByteArray,
        organisationId: String,
        scopeTag: String,
        epoch: Long,
    ): ByteArray {
        val salt = "$organisationId:$scopeTag".toByteArray(Charsets.UTF_8)
        val prefix = "kodera.proximity.w9.epoch-mac.v1:".toByteArray(Charsets.UTF_8)
        val info = ByteBuffer.allocate(prefix.size + 4).order(ByteOrder.BIG_ENDIAN).apply {
            put(prefix)
            putInt(epoch.toInt())
        }.array()
        return hkdfSha256(salt, workspaceMasterKey, info, 32)
    }

    private fun deriveRollingPseudonym(
        deviceSeed: ByteArray,
        organisationId: String,
        scopeTag: String,
        epoch: Long,
    ): ByteArray {
        val salt = ByteBuffer.allocate(4).order(ByteOrder.BIG_ENDIAN).putInt(epoch.toInt()).array()
        val info = "kodera.proximity.w9.pseudonym.v1:$organisationId:$scopeTag".toByteArray(Charsets.UTF_8)
        return hkdfSha256(salt, deviceSeed, info, 8)
    }

    private fun computeMac(
        epochKey: ByteArray,
        organisationId: String,
        scopeTag: String,
        headerAndBody: ByteArray,
    ): ByteArray {
        val orgBytes = organisationId.toByteArray(Charsets.UTF_8)
        val scopeBytes = scopeTag.toByteArray(Charsets.UTF_8)
        val domain = "kodera.proximity.w9.token-mac.v1:".toByteArray(Charsets.UTF_8)
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(epochKey, "HmacSHA256"))
        mac.update(domain)
        mac.update(orgBytes.size.toByte())
        mac.update(orgBytes)
        mac.update(scopeBytes.size.toByte())
        mac.update(scopeBytes)
        mac.update(headerAndBody)
        return mac.doFinal().copyOfRange(0, 12)
    }

    private fun hmacSha256(key: ByteArray, message: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(message)
    }

    internal fun constantTimeEquals(lhs: ByteArray, rhs: ByteArray): Boolean {
        if (lhs.size != rhs.size) return false
        var diff = 0
        for (index in lhs.indices) {
            diff = diff or (lhs[index].toInt() xor rhs[index].toInt())
        }
        return diff == 0
    }

    internal fun toHex(bytes: ByteArray): String =
        bytes.joinToString("") { "%02x".format(it.toInt() and 0xFF) }

    internal fun fromHex(hex: String): ByteArray? {
        if (hex.length % 2 != 0) return null
        val out = ByteArray(hex.length / 2)
        for (i in out.indices) {
            val hi = Character.digit(hex[i * 2], 16)
            val lo = Character.digit(hex[i * 2 + 1], 16)
            if (hi < 0 || lo < 0) return null
            out[i] = ((hi shl 4) or lo).toByte()
        }
        return out
    }
}

/**
 * mDNS `_kodera-prox._udp` TXT dictionary encoder/decoder with strict zero-GPS validation.
 */
object MdnsProximityTxtCodec {
    private val FORBIDDEN_COORDINATE_KEYS = setOf(
        "lat", "latitude", "lon", "lng", "long", "longitude", "gps",
        "coord", "coords", "coordinates", "geo", "geolocation", "alt", "altitude", "bssid", "mac",
    )

    data class Record(
        val epoch: Long,
        val token: ByteArray,
        val quicPort: Int,
    ) {
        init {
            if (token.size != ProximityRadioConstants.EPHEMERAL_TOKEN_BYTES || quicPort !in 1..65_535) {
                throw ProximityVoluntaryFailure(ProximityVoluntaryError.MALFORMED_TXT_RECORD)
            }
        }

        fun toAttributeMap(): Map<String, String> = linkedMapOf(
            "v" to "1",
            "ep" to epoch.toString(),
            "tok" to EphemeralHkdfTokenCodec.toHex(token),
            "alpn" to ProximityRadioConstants.QUIC_ALPN,
            "port" to quicPort.toString(),
        )
    }

    fun decode(attributes: Map<String, String>): Record {
        for (rawKey in attributes.keys) {
            if (rawKey.trim().lowercase() in FORBIDDEN_COORDINATE_KEYS) {
                throw ProximityVoluntaryFailure(ProximityVoluntaryError.FORBIDDEN_COORDINATE_FIELD)
            }
        }
        if (attributes["v"] != "1" || attributes["alpn"] != ProximityRadioConstants.QUIC_ALPN) {
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.MALFORMED_TXT_RECORD)
        }
        val epoch = attributes["ep"]?.toLongOrNull()?.takeIf { it in 0L..0xFFFF_FFFFL }
            ?: throw ProximityVoluntaryFailure(ProximityVoluntaryError.MALFORMED_TXT_RECORD)
        val port = attributes["port"]?.toIntOrNull()?.takeIf { it in 1..65_535 }
            ?: throw ProximityVoluntaryFailure(ProximityVoluntaryError.MALFORMED_TXT_RECORD)
        val tokenHex = attributes["tok"]
            ?: throw ProximityVoluntaryFailure(ProximityVoluntaryError.MALFORMED_TXT_RECORD)
        val token = EphemeralHkdfTokenCodec.fromHex(tokenHex)
            ?.takeIf { it.size == ProximityRadioConstants.EPHEMERAL_TOKEN_BYTES }
            ?: throw ProximityVoluntaryFailure(ProximityVoluntaryError.MALFORMED_TXT_RECORD)
        return Record(epoch = epoch, token = token, quicPort = port)
    }
}

data class DiscoveredProximityPeer(
    val id: String,
    val handle: String,
    val statusNote: String,
    val distanceBand: ProximityDistanceBand,
    val viaMdnsLan: Boolean,
    val rssiDbm: Int?,
    val observedAtUnixSeconds: Long,
)

interface ProximityBleRadioDriver {
    var onPeerTokenObserved: ((ByteArray, Int) -> Unit)?
    fun startAdvertisingAndScanning(ephemeralToken: ByteArray)
    fun stopAll()
}

interface ProximityNsdMdnsDriver {
    var onPeerTxtObserved: ((Map<String, String>) -> Unit)?
    fun startAdvertisingAndDiscovery(attributes: Map<String, String>, quicPort: Int)
    fun stopAll()
}

/**
 * Production Android `BluetoothLeAdvertiser` + `BluetoothLeScanner` GATT service adapter.
 * Verifies Android 12+ (`BLUETOOTH_ADVERTISE`, `BLUETOOTH_SCAN`) runtime permissions before
 * touching hardware interfaces.
 */
class AndroidBleGattProximityDriver(
    private val context: Context,
    private val permissionChecker: ProximityPermissionChecker = RuntimeProximityPermissionChecker(context),
) : ProximityBleRadioDriver {
    override var onPeerTokenObserved: ((ByteArray, Int) -> Unit)? = null

    private val serviceUuid = ParcelUuid.fromString(ProximityRadioConstants.GATT_SERVICE_UUID)
    private var activeAdvertiser: BluetoothLeAdvertiser? = null
    private var activeScanner: BluetoothLeScanner? = null
    private var isAdvertising = false
    private var isScanning = false

    private val advertiseCallback = object : AdvertiseCallback() {}

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val payload = result.scanRecord?.getServiceData(serviceUuid) ?: return
            onPeerTokenObserved?.invoke(payload, result.rssi)
        }
    }

    @SuppressLint("MissingPermission")
    override fun startAdvertisingAndScanning(ephemeralToken: ByteArray) {
        if (ephemeralToken.size != ProximityRadioConstants.EPHEMERAL_TOKEN_BYTES) {
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.MALFORMED_TOKEN)
        }
        if (!permissionChecker.hasBlePermissions()) {
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.RUNTIME_PERMISSION_REQUIRED)
        }
        stopAll()

        val manager = context.getSystemService(BluetoothManager::class.java)
        val adapter = manager?.adapter?.takeIf { it.isEnabled }
            ?: throw ProximityVoluntaryFailure(ProximityVoluntaryError.BLUETOOTH_UNAVAILABLE)
        val advertiser = adapter.bluetoothLeAdvertiser
            ?: throw ProximityVoluntaryFailure(ProximityVoluntaryError.BLUETOOTH_UNAVAILABLE)
        val scanner = adapter.bluetoothLeScanner
            ?: throw ProximityVoluntaryFailure(ProximityVoluntaryError.BLUETOOTH_UNAVAILABLE)

        val advertiseSettings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(false)
            .build()
        val advertiseData = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .addServiceUuid(serviceUuid)
            .build()
        val scanResponse = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceData(serviceUuid, ephemeralToken)
            .build()

        advertiser.startAdvertising(advertiseSettings, advertiseData, scanResponse, advertiseCallback)
        activeAdvertiser = advertiser
        isAdvertising = true

        val filter = ScanFilter.Builder().setServiceUuid(serviceUuid).build()
        val scanSettings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_BALANCED)
            .build()
        scanner.startScan(listOf(filter), scanSettings, scanCallback)
        activeScanner = scanner
        isScanning = true
    }

    @SuppressLint("MissingPermission")
    override fun stopAll() {
        if (isAdvertising && permissionChecker.hasBlePermissions()) {
            runCatching { activeAdvertiser?.stopAdvertising(advertiseCallback) }
        }
        if (isScanning && permissionChecker.hasBlePermissions()) {
            runCatching { activeScanner?.stopScan(scanCallback) }
        }
        isAdvertising = false
        isScanning = false
        activeAdvertiser = null
        activeScanner = null
    }
}

/**
 * Production Android `NsdManager` (`_kodera-prox._udp`) mDNS LAN adapter with Android 13+
 * `NEARBY_WIFI_DEVICES` runtime permission enforcement.
 */
class AndroidNsdMdnsProximityDriver(
    private val context: Context,
    private val permissionChecker: ProximityPermissionChecker = RuntimeProximityPermissionChecker(context),
) : ProximityNsdMdnsDriver {
    override var onPeerTxtObserved: ((Map<String, String>) -> Unit)? = null

    private var nsdManager: NsdManager? = null
    private var registrationListener: NsdManager.RegistrationListener? = null
    private var discoveryListener: NsdManager.DiscoveryListener? = null

    override fun startAdvertisingAndDiscovery(attributes: Map<String, String>, quicPort: Int) {
        if (!permissionChecker.hasNsdPermissions()) {
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.RUNTIME_PERMISSION_REQUIRED)
        }
        stopAll()

        val manager = context.getSystemService(NsdManager::class.java)
            ?: throw ProximityVoluntaryFailure(ProximityVoluntaryError.NSD_UNAVAILABLE)
        nsdManager = manager

        val serviceInfo = NsdServiceInfo().apply {
            serviceName = "kodera-prox-${attributes["tok"]?.take(8) ?: "node"}"
            serviceType = ProximityRadioConstants.MDNS_SERVICE_TYPE
            port = quicPort
            for ((k, v) in attributes) {
                setAttribute(k, v)
            }
        }
        val regListener = object : NsdManager.RegistrationListener {
            override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = Unit
            override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = Unit
            override fun onServiceRegistered(serviceInfo: NsdServiceInfo) = Unit
            override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) = Unit
        }
        manager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, regListener)
        registrationListener = regListener

        val discListener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(regType: String) = Unit
            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
            override fun onServiceLost(serviceInfo: NsdServiceInfo) = Unit

            override fun onServiceFound(found: NsdServiceInfo) {
                @Suppress("DEPRECATION")
                manager.resolveService(
                    found,
                    object : NsdManager.ResolveListener {
                        override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = Unit
                        override fun onServiceResolved(resolved: NsdServiceInfo) {
                            val decoded = LinkedHashMap<String, String>()
                            for ((k, rawVal) in resolved.attributes) {
                                if (rawVal != null) {
                                    decoded[k] = rawVal.toString(Charsets.UTF_8)
                                }
                            }
                            if (decoded.isNotEmpty()) {
                                onPeerTxtObserved?.invoke(decoded)
                            }
                        }
                    },
                )
            }
        }
        manager.discoverServices(ProximityRadioConstants.MDNS_SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discListener)
        discoveryListener = discListener
    }

    override fun stopAll() {
        val manager = nsdManager
        registrationListener?.let { listener ->
            runCatching { manager?.unregisterService(listener) }
        }
        discoveryListener?.let { listener ->
            runCatching { manager?.stopServiceDiscovery(listener) }
        }
        registrationListener = null
        discoveryListener = null
        nsdManager = null
    }
}

/**
 * Foreground opt-in `#proximity` session coordinator combining BLE GATT + NSD mDNS discovery,
 * Android 12+/13+ runtime permission checks, bounded session TTL (`<= 2h`), zero-GPS validation,
 * and one-tap `leaveProximity()` teardown.
 */
class VoluntaryProximitySessionController(
    private val bleDriver: ProximityBleRadioDriver,
    private val nsdDriver: ProximityNsdMdnsDriver,
    private val permissionChecker: ProximityPermissionChecker,
    private val quicPort: Int = 48_443,
) : AutoCloseable {
    var organisationId by mutableStateOf<String?>(null)
        private set

    var hasForegroundConsent by mutableStateOf(false)
        private set

    var isForegroundActive by mutableStateOf(true)
        private set

    var isSessionActive by mutableStateOf(false)
        private set

    var selectedDuration by mutableStateOf(ProximitySessionDuration.MINUTES_30)

    var statusNote by mutableStateOf("")

    var activeTokenHex by mutableStateOf<String?>(null)
        private set

    var expiresAtUnixSeconds by mutableStateOf<Long?>(null)
        private set

    var peers by mutableStateOf<List<DiscoveredProximityPeer>>(emptyList())
        private set

    var missingRuntimePermissions by mutableStateOf<List<String>>(emptyList())
        private set

    var lastError by mutableStateOf<ProximityVoluntaryError?>(null)
        private set

    private var workspaceMasterKey: ByteArray? = null
    private var deviceSeed: ByteArray? = null
    private var scopeTag: String = "default"
    private var emissionCounter: Long = 0L
    private val seenPeerCounters = LinkedHashMap<String, Long>()
    private val rssiClassifiers = LinkedHashMap<String, ProximityRssiClassifier>()

    init {
        bleDriver.onPeerTokenObserved = { tokenBytes, rssiDbm ->
            runCatching { ingestBleObservation(tokenBytes, rssiDbm) }
        }
        nsdDriver.onPeerTxtObserved = { attrs ->
            runCatching { ingestMdnsObservation(attrs) }
        }
        refreshPermissionState()
    }

    @Synchronized
    fun refreshPermissionState(): List<String> {
        val missing = permissionChecker.missingPermissions()
        missingRuntimePermissions = missing
        return missing
    }

    @Synchronized
    fun provision(
        organisationId: String,
        scopeTag: String = "default",
        workspaceMasterKey: ByteArray,
        deviceSeed: ByteArray,
    ) {
        leaveProximity()
        if (!TrustPolicy.canonicalNonNilUUID(organisationId)) {
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.INVALID_ORGANISATION)
        }
        if (workspaceMasterKey.size != 32 || deviceSeed.size != 32 ||
            EphemeralHkdfTokenCodec.constantTimeEquals(workspaceMasterKey, deviceSeed) ||
            workspaceMasterKey.all { it == 0.toByte() } || deviceSeed.all { it == 0.toByte() }
        ) {
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.INVALID_KEY_MATERIAL)
        }
        this.organisationId = organisationId
        this.scopeTag = scopeTag
        this.workspaceMasterKey = workspaceMasterKey.copyOf()
        this.deviceSeed = deviceSeed.copyOf()
    }

    @Synchronized
    fun grantForegroundConsent() {
        if (organisationId == null) {
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.INVALID_ORGANISATION)
        }
        if (!isForegroundActive) {
            lastError = ProximityVoluntaryError.FOREGROUND_CONSENT_REQUIRED
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.FOREGROUND_CONSENT_REQUIRED)
        }
        hasForegroundConsent = true
        lastError = null
    }

    @Synchronized
    fun startVoluntarySession(nowUnixSeconds: Long = System.currentTimeMillis() / 1_000L) {
        val orgId = organisationId
        val masterKey = workspaceMasterKey
        val seed = deviceSeed
        if (orgId == null || masterKey == null || seed == null) {
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.INVALID_ORGANISATION)
        }
        if (!isForegroundActive || !hasForegroundConsent) {
            lastError = ProximityVoluntaryError.FOREGROUND_CONSENT_REQUIRED
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.FOREGROUND_CONSENT_REQUIRED)
        }
        val missing = refreshPermissionState()
        if (missing.isNotEmpty()) {
            lastError = ProximityVoluntaryError.RUNTIME_PERMISSION_REQUIRED
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.RUNTIME_PERMISSION_REQUIRED)
        }
        val trimmedNote = statusNote.trim()
        if (trimmedNote.length > ProximityRadioConstants.MAX_STATUS_NOTE_LENGTH ||
            trimmedNote.any { Character.isISOControl(it.code) }
        ) {
            lastError = ProximityVoluntaryError.INVALID_STATUS_NOTE
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.INVALID_STATUS_NOTE)
        }
        statusNote = trimmedNote

        val minted = EphemeralHkdfTokenCodec.mint(
            organisationId = orgId,
            scopeTag = scopeTag,
            workspaceMasterKey = masterKey,
            deviceSeed = seed,
            nowUnixSeconds = nowUnixSeconds,
            counter = emissionCounter,
        )
        emissionCounter = (emissionCounter + 1L) and 0xFFFF_FFFFL

        val txtRecord = MdnsProximityTxtCodec.Record(
            epoch = minted.epoch,
            token = minted.raw,
            quicPort = quicPort,
        )

        bleDriver.startAdvertisingAndScanning(minted.raw)
        try {
            nsdDriver.startAdvertisingAndDiscovery(txtRecord.toAttributeMap(), quicPort)
        } catch (err: Throwable) {
            bleDriver.stopAll()
            throw err
        }

        activeTokenHex = minted.tokenHex
        expiresAtUnixSeconds = nowUnixSeconds + selectedDuration.durationSeconds
        isSessionActive = true
        lastError = null
    }

    @Synchronized
    fun onForegroundChanged(active: Boolean) {
        isForegroundActive = active
        if (!active) {
            stopRadiosPreservingProvisioning()
        }
    }

    @Synchronized
    fun evaluateExpiry(nowUnixSeconds: Long) {
        val exp = expiresAtUnixSeconds
        if (exp != null && nowUnixSeconds >= exp) {
            leaveProximity()
        }
    }

    @Synchronized
    fun leaveProximity() {
        stopRadiosPreservingProvisioning()
        hasForegroundConsent = false
    }

    @Synchronized
    fun ingestBleObservation(
        tokenBytes: ByteArray,
        rssiDbm: Int,
        peerNote: String = "",
        nowUnixSeconds: Long = System.currentTimeMillis() / 1_000L,
    ): DiscoveredProximityPeer {
        val decoded = validateIncomingPeerToken(tokenBytes, nowUnixSeconds)
        val classifier = rssiClassifiers.getOrPut(decoded.rollingPseudonymHex) { ProximityRssiClassifier() }
        val band = classifier.observe(rssiDbm)
        val existing = peers.firstOrNull { it.id == decoded.rollingPseudonymHex }
        val peer = DiscoveredProximityPeer(
            id = decoded.rollingPseudonymHex,
            handle = "prox-${decoded.rollingPseudonymHex.take(8)}",
            statusNote = peerNote.take(ProximityRadioConstants.MAX_STATUS_NOTE_LENGTH),
            distanceBand = band,
            viaMdnsLan = existing?.viaMdnsLan ?: false,
            rssiDbm = rssiDbm,
            observedAtUnixSeconds = nowUnixSeconds,
        )
        upsertPeer(peer)
        return peer
    }

    @Synchronized
    fun ingestMdnsObservation(
        attributes: Map<String, String>,
        nowUnixSeconds: Long = System.currentTimeMillis() / 1_000L,
    ): DiscoveredProximityPeer {
        val record = MdnsProximityTxtCodec.decode(attributes)
        val decoded = validateIncomingPeerToken(record.token, nowUnixSeconds)
        val existing = peers.firstOrNull { it.id == decoded.rollingPseudonymHex }
        val peer = DiscoveredProximityPeer(
            id = decoded.rollingPseudonymHex,
            handle = "prox-${decoded.rollingPseudonymHex.take(8)}",
            statusNote = existing?.statusNote ?: "",
            distanceBand = existing?.distanceBand ?: ProximityDistanceBand.NEAR,
            viaMdnsLan = true,
            rssiDbm = existing?.rssiDbm,
            observedAtUnixSeconds = nowUnixSeconds,
        )
        upsertPeer(peer)
        return peer
    }

    override fun close() {
        leaveProximity()
        workspaceMasterKey?.fill(0)
        deviceSeed?.fill(0)
        workspaceMasterKey = null
        deviceSeed = null
        organisationId = null
    }

    private fun validateIncomingPeerToken(
        tokenBytes: ByteArray,
        nowUnixSeconds: Long,
    ): EphemeralHkdfTokenCodec.DecodedToken {
        if (!isSessionActive || !isForegroundActive || !hasForegroundConsent) {
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.FOREGROUND_CONSENT_REQUIRED)
        }
        val orgId = organisationId
        val masterKey = workspaceMasterKey
        if (orgId == null || masterKey == null) {
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.INVALID_ORGANISATION)
        }
        evaluateExpiry(nowUnixSeconds)
        if (!isSessionActive) {
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.EXPIRED_TOKEN)
        }

        val decoded = EphemeralHkdfTokenCodec.verify(
            raw = tokenBytes,
            organisationId = orgId,
            scopeTag = scopeTag,
            workspaceMasterKey = masterKey,
            nowUnixSeconds = nowUnixSeconds,
        )
        val replayKey = "${decoded.epoch}:${decoded.rollingPseudonymHex}"
        val previousCounter = seenPeerCounters[replayKey]
        if (previousCounter != null && decoded.counter <= previousCounter) {
            throw ProximityVoluntaryFailure(ProximityVoluntaryError.REPLAY_REJECTED)
        }
        seenPeerCounters[replayKey] = decoded.counter
        return decoded
    }

    private fun upsertPeer(peer: DiscoveredProximityPeer) {
        val next = peers.toMutableList()
        val idx = next.indexOfFirst { it.id == peer.id }
        if (idx >= 0) {
            next[idx] = peer
        } else {
            next.add(peer)
        }
        peers = next
    }

    private fun stopRadiosPreservingProvisioning() {
        bleDriver.stopAll()
        nsdDriver.stopAll()
        isSessionActive = false
        activeTokenHex = null
        expiresAtUnixSeconds = null
        peers = emptyList()
        seenPeerCounters.clear()
        rssiClassifiers.clear()
    }
}
