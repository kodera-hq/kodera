package io.kodera.android.session

import io.kodera.android.domain.ProximityBeaconV2
import io.kodera.android.domain.ProximityBeaconV2Error
import io.kodera.android.domain.ProximityBeaconV2Failure
import io.kodera.android.domain.ProximityDutyCycleBudget
import io.kodera.android.domain.ProximitySafetyStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ProximityRadioFenceTests {
    private val orgA = "11111111-2222-4333-8444-555555555555"
    private val orgB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

    private class Radio : LocalBleProximityRadio {
        var scanStarts = 0
        var stops = 0
        var scanning = false
        var failScan = false
        var failBroadcast = false
        var onStart: (() -> Unit)? = null
        var onBroadcast: (() -> Unit)? = null
        val frames = mutableListOf<ProximityBeaconV2>()

        override fun startForegroundScanWindow(durationSeconds: Long) {
            scanStarts += 1
            onStart?.invoke()
            // Simulate a platform scan becoming active after its callback reconfigured the owner.
            scanning = true
            if (failScan) error("synthetic uncertain scan start")
        }

        override fun stopForegroundScanWindow() {
            stops += 1
            scanning = false
        }

        override fun broadcastBeacon(beacon: ProximityBeaconV2, status: ProximitySafetyStatus) {
            frames += beacon
            onBroadcast?.invoke()
            if (failBroadcast) error("synthetic uncertain broadcast")
        }
    }

    private fun provision(controller: ProximityV2CheckInController, org: String, radio: Radio) {
        controller.provisionLocalRadio(org, ByteArray(32) { (it + 1).toByte() },
            ByteArray(32) { (it + 33).toByte() }, radio)
    }

    private fun controller(radio: Radio, limit: Int = 1): ProximityV2CheckInController {
        return ProximityV2CheckInController(ProximityDutyCycleBudget(maxBroadcastsPerRotationWindow = limit)).also {
            provision(it, orgA, radio)
            it.onForeground()
            it.setForegroundConsent(true)
        }
    }

    @Test
    fun ordinaryEmissionAndScanKeepTheExistingPositiveBoundary() {
        val radio = Radio()
        val controller = controller(radio)
        controller.startScanWindow(600)
        assertTrue(radio.scanning)
        val frame = controller.emitCheckInOverLocalRadio(ProximitySafetyStatus.SAFE, 600)
        assertEquals(0L, frame.sequence)
        assertEquals(1, controller.verifiedLocalBroadcastCount)
        controller.close()
        assertFalse(radio.scanning)
        assertFalse(controller.isProvisionedForLocalRadio)
    }

    @Test
    fun uncertainBroadcastConsumesDutyBudgetBeforeCallingTheAdapter() {
        val radio = Radio().also { it.failBroadcast = true }
        val controller = controller(radio)
        assertThrows(IllegalStateException::class.java) {
            controller.emitCheckInOverLocalRadio(ProximitySafetyStatus.SAFE, 600)
        }
        val refused = assertThrows(ProximityBeaconV2Failure::class.java) {
            controller.emitCheckInOverLocalRadio(ProximitySafetyStatus.SAFE, 601)
        }
        assertEquals(ProximityBeaconV2Error.DUTY_CYCLE_THROTTLED, refused.reason)
        assertEquals(1, radio.frames.size)
        assertEquals(0, controller.verifiedLocalBroadcastCount)
        controller.close()
    }

    @Test
    fun uncertainScanStartConsumesCooldownBeforeCallingTheAdapter() {
        val radio = Radio().also { it.failScan = true }
        val controller = controller(radio)
        assertThrows(IllegalStateException::class.java) { controller.startScanWindow(600) }
        val refused = assertThrows(ProximityBeaconV2Failure::class.java) { controller.startScanWindow(601) }
        assertEquals(ProximityBeaconV2Error.DUTY_CYCLE_THROTTLED, refused.reason)
        assertEquals(1, radio.scanStarts)
        controller.close()
        assertFalse(radio.scanning)
    }

    @Test
    fun sameOrganisationReplacementStopsTheOldActiveRadio() {
        val old = Radio()
        val replacement = Radio()
        val controller = controller(old)
        controller.startScanWindow(600)
        provision(controller, orgA, replacement)
        assertFalse(old.scanning)
        assertEquals(1, old.stops)
        assertTrue(controller.isProvisionedForLocalRadio)
        controller.close()
    }

    @Test
    fun failedReplacementCannotKeepUsingOldProvisionedMaterial() {
        val old = Radio()
        val controller = controller(old)
        controller.startScanWindow(600)
        assertThrows(ProximityBeaconV2Failure::class.java) {
            controller.provisionLocalRadio(orgA, ByteArray(32), ByteArray(32) { 7 }, Radio())
        }
        assertFalse(old.scanning)
        assertFalse(controller.isProvisionedForLocalRadio)
        assertThrows(ProximityBeaconV2Failure::class.java) {
            controller.emitCheckInOverLocalRadio(ProximitySafetyStatus.SAFE, 601)
        }
        assertTrue(old.frames.isEmpty())
        controller.close()
    }

    @Test
    fun invalidRootReplacementAlsoFailsClosed() {
        val old = Radio()
        val controller = controller(old)
        controller.startScanWindow(600)
        assertThrows(ProximityBeaconV2Failure::class.java) {
            controller.provisionFromRootMaterial(orgA, ByteArray(32), "synthetic-device", Radio())
        }
        assertFalse(old.scanning)
        assertFalse(controller.isProvisionedForLocalRadio)
        controller.close()
    }

    @Test
    fun reentrantBroadcastCannotWriteOldMetadataIntoTheReplacementOrganisation() {
        val radio = Radio()
        val controller = controller(radio)
        radio.onBroadcast = { controller.configureOrganisation(orgB) }
        val refused = assertThrows(ProximityBeaconV2Failure::class.java) {
            controller.emitCheckInOverLocalRadio(ProximitySafetyStatus.SAFE, 600)
        }
        assertEquals(ProximityBeaconV2Error.SCOPE_MISMATCH, refused.reason)
        assertEquals(orgB, controller.organisationId)
        assertEquals(0, controller.verifiedLocalBroadcastCount)
        assertNull(controller.lastEmittedPseudonymHex)
        assertFalse(controller.isProvisionedForLocalRadio)
        controller.close()
    }

    @Test
    fun reentrantLateScanRetiresBeforeTheSameAdapterStartsInTheNewContext() {
        val radio = Radio()
        val controller = controller(radio)
        radio.onStart = {
            radio.onStart = null
            controller.configureOrganisation(orgB)
            provision(controller, orgB, radio)
            controller.onForeground()
            controller.setForegroundConsent(true)
            // A synchronized monitor permits same-thread callbacks; an IO reservation must not.
            assertThrows(ProximityBeaconV2Failure::class.java) { controller.startScanWindow(660) }
        }
        val refused = assertThrows(ProximityBeaconV2Failure::class.java) { controller.startScanWindow(600) }
        assertEquals(ProximityBeaconV2Error.SCOPE_MISMATCH, refused.reason)
        assertFalse(radio.scanning)
        assertEquals(orgB, controller.organisationId)
        controller.startScanWindow(660)
        assertTrue(radio.scanning)
        assertTrue(controller.localRadioPosture is LocalBleRadioPosture.ScanningWindowActive)
        controller.close()
    }

    @Test
    fun failedRootDerivationCannotRefundSameOrganisationDuty() {
        val old = Radio()
        val controller = controller(old)
        controller.emitCheckInOverLocalRadio(ProximitySafetyStatus.SAFE, 600)
        assertThrows(ProximityBeaconV2Failure::class.java) {
            controller.provisionFromRootMaterial(orgA, ByteArray(32), "synthetic-device", Radio())
        }
        assertFalse(controller.isProvisionedForLocalRadio)
        val replacement = Radio()
        controller.provisionFromRootMaterial(orgA, ByteArray(32) { (it + 7).toByte() }, "synthetic-device", replacement)
        val refused = assertThrows(ProximityBeaconV2Failure::class.java) {
            controller.emitCheckInOverLocalRadio(ProximitySafetyStatus.SAFE, 601)
        }
        assertEquals(ProximityBeaconV2Error.DUTY_CYCLE_THROTTLED, refused.reason)
        assertTrue(replacement.frames.isEmpty())
        controller.close()
    }

    @Test
    fun invalidOrganisationAttemptCannotRefundTheCurrentOrganisationsDuty() {
        val old = Radio()
        val controller = controller(old)
        controller.emitCheckInOverLocalRadio(ProximitySafetyStatus.SAFE, 600)
        assertThrows(ProximityBeaconV2Failure::class.java) {
            controller.provisionLocalRadio("invalid", ByteArray(32) { 3 }, ByteArray(32) { 4 }, Radio())
        }
        assertEquals(orgA, controller.organisationId)
        assertFalse(controller.isProvisionedForLocalRadio)
        val replacement = Radio()
        provision(controller, orgA, replacement)
        val refused = assertThrows(ProximityBeaconV2Failure::class.java) {
            controller.emitCheckInOverLocalRadio(ProximitySafetyStatus.SAFE, 601)
        }
        assertEquals(ProximityBeaconV2Error.DUTY_CYCLE_THROTTLED, refused.reason)
        assertTrue(replacement.frames.isEmpty())
        controller.close()
    }

}
