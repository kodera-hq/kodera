package io.kodera.android.session

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.kodera.android.domain.BeaconObservationV2
import io.kodera.android.domain.ProximityBatterySnapshot
import io.kodera.android.domain.ProximityBeaconKeyDerivation
import io.kodera.android.domain.ProximityBeaconV2
import io.kodera.android.domain.ProximityBeaconV2Error
import io.kodera.android.domain.ProximityBeaconV2Failure
import io.kodera.android.domain.ProximityBeaconV2Receiver
import io.kodera.android.domain.ProximityBeaconV2Sender
import io.kodera.android.domain.ProximityBounds
import io.kodera.android.domain.ProximityDutyCycleBudget
import io.kodera.android.domain.ProximitySafetyStatus
import io.kodera.android.domain.ProximityTransportLane
import io.kodera.android.domain.TrustPolicy

/** Hardware BLE scan and service-data advertise adapter supplied only when a physical radio is wired. */
interface LocalBleProximityRadio {
    fun startForegroundScanWindow(durationSeconds: Long)
    fun stopForegroundScanWindow()
    fun broadcastBeacon(beacon: ProximityBeaconV2, status: ProximitySafetyStatus)
}

sealed interface LocalBleRadioPosture {
    data object Unprovisioned : LocalBleRadioPosture
    data object AwaitingForegroundConsent : LocalBleRadioPosture
    data object SuspendedInBackground : LocalBleRadioPosture
    data object ReadyForLocalRadio : LocalBleRadioPosture
    data class ScanningWindowActive(
        val startedAtUnixSeconds: Long,
        val expiresAtUnixSeconds: Long,
    ) : LocalBleRadioPosture

    data class Throttled(val reason: ProximityBeaconV2Error) : LocalBleRadioPosture
}

data class OnlineMatrixProximityDraft(
    val organisationId: String,
    val status: ProximitySafetyStatus,
    val lane: ProximityTransportLane = ProximityTransportLane.ONLINE_MATRIX_RELAY,
)

/**
 * Coordinates `#proximity` v2 foreground-only BLE check-ins with explicit opt-in consent,
 * battery/duty-cycle enforcement, rotating 27-byte `KP\x02` beacons, and strict separation
 * between online Matrix room relays and genuine local BLE radio frames.
 */
class ProximityV2CheckInController(
    val budget: ProximityDutyCycleBudget = ProximityDutyCycleBudget(),
) : AutoCloseable {
    companion object {
        const val MAX_STORED_OBSERVATIONS: Int = 64
    }

    private var sender: ProximityBeaconV2Sender? = null
    private var receiver: ProximityBeaconV2Receiver? = null
    private var radio: LocalBleProximityRadio? = null
    private var lastScanStartedAtUnixSeconds: Long? = null
    private var activeEmissionWindow: Long? = null
    private var emissionsInCurrentWindow: Int = 0
    private val peerObservations = ArrayDeque<BeaconObservationV2>()
    private var radioContext = Any()
    private var nativeRadioOperation = false

    var organisationId by mutableStateOf<String?>(null)
        private set

    var hasForegroundConsent by mutableStateOf(false)
        private set

    var isForegroundActive by mutableStateOf(false)
        private set

    var battery by mutableStateOf(ProximityBatterySnapshot())
        private set

    var localRadioPosture by mutableStateOf<LocalBleRadioPosture>(LocalBleRadioPosture.Unprovisioned)
        private set

    var lastEmittedPseudonymHex by mutableStateOf<String?>(null)
        private set

    var lastEmittedWindow by mutableStateOf<Long?>(null)
        private set

    var verifiedLocalBroadcastCount by mutableIntStateOf(0)
        private set

    var verifiedPeerCount by mutableIntStateOf(0)
        private set

    var lastOnlineMatrixDraft by mutableStateOf<OnlineMatrixProximityDraft?>(null)
        private set

    var onlineMatrixDraftCount by mutableIntStateOf(0)
        private set

    var lastError by mutableStateOf<ProximityBeaconV2Error?>(null)
        private set

    val isProvisionedForLocalRadio: Boolean
        @Synchronized get() = sender != null && receiver != null && radio != null

    @Synchronized
    fun configureOrganisation(incomingOrganisationId: String?) {
        if (incomingOrganisationId != null && !TrustPolicy.canonicalNonNilUUID(incomingOrganisationId)) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.INVALID_INPUT)
        }
        if (organisationId == incomingOrganisationId) return
        try {
            val context = teardownRadioMaterial()
            requireRadioContext(context)
            organisationId = incomingOrganisationId
            hasForegroundConsent = false
            lastOnlineMatrixDraft = null
            onlineMatrixDraftCount = 0
            lastError = null
        } finally {
            refreshPosture()
        }
    }

    @Synchronized
    fun provisionLocalRadio(
        targetOrganisationId: String,
        discoveryKey: ByteArray,
        deviceSeed: ByteArray,
        radioAdapter: LocalBleProximityRadio,
    ) {
        var nextSender: ProximityBeaconV2Sender? = null
        var nextReceiver: ProximityBeaconV2Receiver? = null
        try {
            // Retire before replacement, including same-organisation and failed provisioning.
            // Same-org key refresh must not refund already consumed physical radio duty.
            val changesOrganisation = TrustPolicy.canonicalNonNilUUID(targetOrganisationId) &&
                organisationId != targetOrganisationId
            val context = teardownRadioMaterial(resetBudget = changesOrganisation)
            requireRadioContext(context)
            if (!TrustPolicy.canonicalNonNilUUID(targetOrganisationId)) {
                throw ProximityBeaconV2Failure(ProximityBeaconV2Error.INVALID_INPUT)
            }
            if (organisationId != targetOrganisationId) {
                organisationId = targetOrganisationId
                hasForegroundConsent = false
                lastOnlineMatrixDraft = null
                onlineMatrixDraftCount = 0
            }
            nextSender = ProximityBeaconV2Sender(targetOrganisationId, discoveryKey, deviceSeed)
            nextReceiver = ProximityBeaconV2Receiver(targetOrganisationId, discoveryKey)
            sender = nextSender
            receiver = nextReceiver
            radio = radioAdapter
            nextSender = null
            nextReceiver = null
            lastError = null
        } finally {
            nextSender?.close()
            nextReceiver?.close()
            refreshPosture()
        }
    }

    @Synchronized
    fun provisionFromRootMaterial(
        targetOrganisationId: String,
        rootMaterial: ByteArray,
        deviceContext: String,
        radioAdapter: LocalBleProximityRadio,
    ) {
        val context = radioContext
        try {
            ProximityBeaconKeyDerivation.deriveKeys(targetOrganisationId, rootMaterial, deviceContext).use { keys ->
                val discovery = keys.discoveryKeyBytes()
                val seed = keys.deviceSeedBytes()
                try {
                    provisionLocalRadio(targetOrganisationId, discovery, seed, radioAdapter)
                } finally {
                    discovery.fill(0)
                    seed.fill(0)
                }
            }
        } catch (failure: Throwable) {
            // Derivation can fail before provisionLocalRadio has retired anything.
            // Do not clear a newer context installed by a reentrant adapter callback.
            if (radioContext === context) {
                // No organisation transition happened when derivation failed in this context.
                try { teardownRadioMaterial(resetBudget = false) } finally { refreshPosture() }
            }
            throw failure
        }
    }

    @Synchronized
    fun setForegroundConsent(granted: Boolean) {
        if (organisationId == null && granted) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.SCOPE_MISMATCH)
        }
        hasForegroundConsent = granted
        if (!granted) {
            radioContext = Any()
            stopRadio(radio)
        }
        lastError = null
        refreshPosture()
    }

    @Synchronized
    fun onForeground() {
        isForegroundActive = true
        refreshPosture()
    }

    @Synchronized
    fun onBackground() {
        isForegroundActive = false
        radioContext = Any()
        stopRadio(radio)
        refreshPosture()
    }

    @Synchronized
    fun updateBattery(snapshot: ProximityBatterySnapshot) {
        battery = snapshot
        try {
            budget.validateBattery(snapshot)
        } catch (_: ProximityBeaconV2Failure) {
            radioContext = Any()
            stopRadio(radio)
        }
        refreshPosture()
    }

    /**
     * Queues a status draft exclusively for the online Matrix `#proximity` channel lane,
     * never counting it as a local BLE radio broadcast or peer radio observation.
     */
    @Synchronized
    fun recordOnlineMatrixChannelDraft(status: ProximitySafetyStatus): OnlineMatrixProximityDraft {
        if (status == ProximitySafetyStatus.MESSAGE_ONLY) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.INVALID_INPUT)
        }
        val currentOrg = organisationId
            ?: throw ProximityBeaconV2Failure(ProximityBeaconV2Error.SCOPE_MISMATCH)
        val draft = OnlineMatrixProximityDraft(
            organisationId = currentOrg,
            status = status,
            lane = ProximityTransportLane.ONLINE_MATRIX_RELAY,
        )
        lastOnlineMatrixDraft = draft
        onlineMatrixDraftCount += 1
        return draft
    }

    @Synchronized
    fun startScanWindow(nowUnixSeconds: Long = ProximityBounds.currentUnixSeconds()) {
        if (organisationId == null) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.SCOPE_MISMATCH)
        }
        if (!isForegroundActive || !hasForegroundConsent) {
            lastError = ProximityBeaconV2Error.FOREGROUND_CONSENT_REQUIRED
            refreshPosture()
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.FOREGROUND_CONSENT_REQUIRED)
        }
        val activeRadio = radio
        if (activeRadio == null || sender == null || receiver == null) {
            lastError = ProximityBeaconV2Error.INVALID_INPUT
            refreshPosture()
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.INVALID_INPUT)
        }
        requireRadioIoAvailable()
        try {
            budget.validateScanStart(battery, lastScanStartedAtUnixSeconds, nowUnixSeconds)
        } catch (failure: ProximityBeaconV2Failure) {
            lastError = failure.reason
            localRadioPosture = LocalBleRadioPosture.Throttled(failure.reason)
            throw failure
        }

        val context = radioContext
        lastScanStartedAtUnixSeconds = nowUnixSeconds
        nativeRadioOperation = true
        try {
            try {
                activeRadio.startForegroundScanWindow(budget.maxScanWindowSeconds)
            } finally {
                // A same-thread callback may reset while the native start still completes.
                // No replacement IO can start until this captured old window is retired.
                if (radioContext !== context) stopRadio(activeRadio)
            }
            requireRadioContext(context)
            lastError = null
            localRadioPosture = LocalBleRadioPosture.ScanningWindowActive(
                startedAtUnixSeconds = nowUnixSeconds,
                expiresAtUnixSeconds = nowUnixSeconds + budget.maxScanWindowSeconds,
            )
        } finally {
            nativeRadioOperation = false
        }
    }

    @Synchronized
    fun emitCheckInOverLocalRadio(
        status: ProximitySafetyStatus,
        nowUnixSeconds: Long = ProximityBounds.currentUnixSeconds(),
    ): ProximityBeaconV2 {
        if (status == ProximitySafetyStatus.MESSAGE_ONLY) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.INVALID_INPUT)
        }
        if (organisationId == null) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.SCOPE_MISMATCH)
        }
        if (!isForegroundActive || !hasForegroundConsent) {
            lastError = ProximityBeaconV2Error.FOREGROUND_CONSENT_REQUIRED
            refreshPosture()
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.FOREGROUND_CONSENT_REQUIRED)
        }
        val activeSender = sender
        val activeRadio = radio
        if (activeSender == null || activeRadio == null) {
            lastError = ProximityBeaconV2Error.INVALID_INPUT
            refreshPosture()
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.INVALID_INPUT)
        }

        requireRadioIoAvailable()
        val currentWindow = nowUnixSeconds / ProximityBeaconV2.ROTATION_WINDOW_SECONDS
        val windowCount = if (activeEmissionWindow == currentWindow) emissionsInCurrentWindow else 0
        try {
            budget.validateBroadcast(battery, windowCount)
        } catch (failure: ProximityBeaconV2Failure) {
            lastError = failure.reason
            localRadioPosture = LocalBleRadioPosture.Throttled(failure.reason)
            throw failure
        }

        val beacon = activeSender.emitAt(nowUnixSeconds)
        val context = radioContext
        // An uncertain callback may already have transmitted: never refund duty or sequence.
        activeEmissionWindow = currentWindow
        emissionsInCurrentWindow = windowCount + 1
        nativeRadioOperation = true
        try {
            activeRadio.broadcastBeacon(beacon, status)
            requireRadioContext(context)
            verifiedLocalBroadcastCount += 1
            lastEmittedPseudonymHex = beacon.pseudonymHex
            lastEmittedWindow = beacon.window
            lastError = null
            refreshPosture()
            return beacon
        } finally {
            nativeRadioOperation = false
        }
    }

    @Synchronized
    fun ingestObservedPeerBeacon(
        rawBytes: ByteArray,
        nowUnixSeconds: Long = ProximityBounds.currentUnixSeconds(),
    ): BeaconObservationV2 {
        if (organisationId == null) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.SCOPE_MISMATCH)
        }
        if (!isForegroundActive || !hasForegroundConsent) {
            throw ProximityBeaconV2Failure(ProximityBeaconV2Error.FOREGROUND_CONSENT_REQUIRED)
        }
        val activeReceiver = receiver
            ?: throw ProximityBeaconV2Failure(ProximityBeaconV2Error.INVALID_INPUT)
        val observation = activeReceiver.acceptAt(rawBytes, nowUnixSeconds)
        if (peerObservations.size == MAX_STORED_OBSERVATIONS) {
            peerObservations.removeFirst()
        }
        peerObservations.addLast(observation)
        verifiedPeerCount = peerObservations.size
        return observation
    }

    @Synchronized
    fun recentPeerObservations(): List<BeaconObservationV2> = peerObservations.toList()

    @Synchronized
    override fun close() {
        organisationId = null
        hasForegroundConsent = false
        isForegroundActive = false
        lastOnlineMatrixDraft = null
        onlineMatrixDraftCount = 0
        try { teardownRadioMaterial() } finally { refreshPosture() }
    }

    private fun teardownRadioMaterial(resetBudget: Boolean = true): Any {
        val context = Any()
        radioContext = context
        val oldRadio = radio
        val oldSender = sender
        val oldReceiver = receiver
        radio = null
        sender = null
        receiver = null
        if (resetBudget) {
            lastScanStartedAtUnixSeconds = null
            activeEmissionWindow = null
            emissionsInCurrentWindow = 0
        }
        verifiedLocalBroadcastCount = 0
        peerObservations.clear()
        verifiedPeerCount = 0
        lastEmittedPseudonymHex = null
        lastEmittedWindow = null
        // Detach and close owned material before calling an adapter that can throw or reenter.
        oldSender?.close()
        oldReceiver?.close()
        stopRadio(oldRadio)
        return context
    }

    private fun stopRadio(target: LocalBleProximityRadio?) {
        val previous = nativeRadioOperation
        nativeRadioOperation = true
        try { target?.stopForegroundScanWindow() } finally { nativeRadioOperation = previous }
    }

    private fun requireRadioIoAvailable() {
        if (nativeRadioOperation) throw ProximityBeaconV2Failure(ProximityBeaconV2Error.DUTY_CYCLE_THROTTLED)
    }

    private fun requireRadioContext(context: Any) {
        if (radioContext !== context) throw ProximityBeaconV2Failure(ProximityBeaconV2Error.SCOPE_MISMATCH)
    }

    private fun refreshPosture() {
        if (organisationId == null) {
            localRadioPosture = LocalBleRadioPosture.Unprovisioned
            return
        }
        if (!hasForegroundConsent) {
            localRadioPosture = LocalBleRadioPosture.AwaitingForegroundConsent
            return
        }
        if (!isForegroundActive) {
            localRadioPosture = LocalBleRadioPosture.SuspendedInBackground
            return
        }
        try {
            budget.validateBattery(battery)
        } catch (failure: ProximityBeaconV2Failure) {
            localRadioPosture = LocalBleRadioPosture.Throttled(failure.reason)
            return
        }
        localRadioPosture = if (sender != null && receiver != null && radio != null) {
            LocalBleRadioPosture.ReadyForLocalRadio
        } else {
            LocalBleRadioPosture.Unprovisioned
        }
    }
}
