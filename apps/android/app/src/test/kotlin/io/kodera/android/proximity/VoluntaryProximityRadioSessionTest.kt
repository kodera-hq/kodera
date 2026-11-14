package io.kodera.android.proximity

import android.Manifest
import android.os.Build
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class VoluntaryProximityRadioSessionTest {
    private val orgA = "11111111-1111-4111-8111-111111111111"
    private val orgB = "22222222-2222-4222-8222-222222222222"
    private val masterKey = ByteArray(32) { (it + 1).toByte() }
    private val aliceSeed = ByteArray(32) { (it + 65).toByte() }
    private val bobSeed = ByteArray(32) { (it + 129).toByte() }

    private class FakeBleDriver : ProximityBleRadioDriver {
        override var onPeerTokenObserved: ((ByteArray, Int) -> Unit)? = null
        val advertisedTokens = mutableListOf<ByteArray>()
        var stopCount = 0

        override fun startAdvertisingAndScanning(ephemeralToken: ByteArray) {
            advertisedTokens += ephemeralToken.copyOf()
        }

        override fun stopAll() {
            stopCount += 1
        }
    }

    private class FakeNsdDriver : ProximityNsdMdnsDriver {
        override var onPeerTxtObserved: ((Map<String, String>) -> Unit)? = null
        val advertisedAttributes = mutableListOf<Map<String, String>>()
        var stopCount = 0

        override fun startAdvertisingAndDiscovery(attributes: Map<String, String>, quicPort: Int) {
            advertisedAttributes += LinkedHashMap(attributes)
        }

        override fun stopAll() {
            stopCount += 1
        }
    }

    @Test
    fun hkdfMatchesRfc5869VectorAndRotatesUnlinkablePseudonymsEvery15Minutes() {
        val ikm = ByteArray(22) { 0x0b }
        val salt = ByteArray(13) { it.toByte() }
        val info = ByteArray(10) { (0xf0 + it).toByte() }
        val okm = EphemeralHkdfTokenCodec.hkdfSha256(salt, ikm, info, 42)
        val expectedHex = "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
        assertEquals(expectedHex, EphemeralHkdfTokenCodec.toHex(okm))

        val t0 = 1_760_000_100L
        val tokenEpoch0 = EphemeralHkdfTokenCodec.mint(orgA, "paris-hq", masterKey, aliceSeed, t0, 0L)
        val tokenEpoch1 = EphemeralHkdfTokenCodec.mint(orgA, "paris-hq", masterKey, aliceSeed, t0 + 900L, 0L)
        assertEquals(32, tokenEpoch0.raw.size)
        assertNotEquals(tokenEpoch0.epoch, tokenEpoch1.epoch)
        assertNotEquals(tokenEpoch0.rollingPseudonymHex, tokenEpoch1.rollingPseudonymHex)

        val verified = EphemeralHkdfTokenCodec.verify(tokenEpoch0.raw, orgA, "paris-hq", masterKey, t0 + 30L)
        assertArrayEquals(tokenEpoch0.rollingPseudonym, verified.rollingPseudonym)

        val crossOrg = assertThrows(ProximityVoluntaryFailure::class.java) {
            EphemeralHkdfTokenCodec.verify(tokenEpoch0.raw, orgB, "paris-hq", masterKey, t0 + 30L)
        }
        assertEquals(ProximityVoluntaryError.AUTHENTICATION_FAILED, crossOrg.reason)

        val expired = assertThrows(ProximityVoluntaryFailure::class.java) {
            EphemeralHkdfTokenCodec.verify(tokenEpoch0.raw, orgA, "paris-hq", masterKey, t0 + 1_800L)
        }
        assertEquals(ProximityVoluntaryError.EXPIRED_TOKEN, expired.reason)
    }

    @Test
    fun runtimePermissionCheckerEnforcesAndroid12BleAndAndroid13NearbyWifiPermissions() {
        val granted = mutableSetOf<String>()
        var sdkInt = Build.VERSION_CODES.TIRAMISU

        val checker = RuntimeProximityPermissionChecker(
            sdkIntProvider = { sdkInt },
            isPermissionGranted = { it in granted },
        )
        assertEquals(
            listOf(
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.NEARBY_WIFI_DEVICES,
            ),
            checker.missingPermissions(),
        )

        val ble = FakeBleDriver()
        val nsd = FakeNsdDriver()
        val controller = VoluntaryProximitySessionController(ble, nsd, checker)
        controller.provision(orgA, "default", masterKey, aliceSeed)
        controller.grantForegroundConsent()

        val missingFailure = assertThrows(ProximityVoluntaryFailure::class.java) {
            controller.startVoluntarySession(1_760_000_100L)
        }
        assertEquals(ProximityVoluntaryError.RUNTIME_PERMISSION_REQUIRED, missingFailure.reason)
        assertFalse(controller.isSessionActive)
        assertTrue(ble.advertisedTokens.isEmpty())

        // Android 12 (API 31) requires only BLE advertise + scan, not NEARBY_WIFI_DEVICES.
        sdkInt = Build.VERSION_CODES.S
        granted += Manifest.permission.BLUETOOTH_ADVERTISE
        granted += Manifest.permission.BLUETOOTH_SCAN
        assertTrue(checker.missingPermissions().isEmpty())

        controller.startVoluntarySession(1_760_000_100L)
        assertTrue(controller.isSessionActive)
        assertEquals(1, ble.advertisedTokens.size)
        assertEquals(1, nsd.advertisedAttributes.size)
        controller.close()
    }

    @Test
    fun rssiClassifierAppliesHysteresisAndRejectsBluetoothUnavailableSentinel() {
        val classifier = ProximityRssiClassifier()
        assertEquals(ProximityDistanceBand.IMMEDIATE, classifier.observe(-50))
        // -58 dBm is inside [-61, -55] hysteresis band -> stays IMMEDIATE.
        assertEquals(ProximityDistanceBand.IMMEDIATE, classifier.observe(-58))
        assertEquals(ProximityDistanceBand.NEAR, classifier.observe(-64))
        // -78 dBm is inside [-81, -75] hysteresis band -> stays NEAR.
        assertEquals(ProximityDistanceBand.NEAR, classifier.observe(-78))
        assertEquals(ProximityDistanceBand.AMBIENT, classifier.observe(-86))
        // -77 dBm is below -75 re-entry threshold -> stays AMBIENT.
        assertEquals(ProximityDistanceBand.AMBIENT, classifier.observe(-77))
        assertEquals(ProximityDistanceBand.NEAR, classifier.observe(-73))

        val invalidSentinel = assertThrows(ProximityVoluntaryFailure::class.java) {
            classifier.observe(127)
        }
        assertEquals(ProximityVoluntaryError.INVALID_RSSI, invalidSentinel.reason)
    }

    @Test
    fun mdnsTxtCodecRefusesGpsCoordinateAttributes() {
        val token = EphemeralHkdfTokenCodec.mint(orgA, "default", masterKey, bobSeed, 1_760_000_100L, 1L)
        val valid = MdnsProximityTxtCodec.Record(token.epoch, token.raw, 48_443).toAttributeMap()
        val roundtrip = MdnsProximityTxtCodec.decode(valid)
        assertEquals(48_443, roundtrip.quicPort)
        assertArrayEquals(token.raw, roundtrip.token)

        for (forbiddenKey in listOf("lat", "latitude", "lon", "longitude", "gps", "geo", "bssid")) {
            val poisoned = LinkedHashMap(valid).apply { put(forbiddenKey, "48.8566") }
            val err = assertThrows(ProximityVoluntaryFailure::class.java) {
                MdnsProximityTxtCodec.decode(poisoned)
            }
            assertEquals(ProximityVoluntaryError.FORBIDDEN_COORDINATE_FIELD, err.reason)
        }
    }

    @Test
    fun sessionLifecycleEnforcesOptInReplayProtectionBackgroundStopTtlAndInstantLeave() {
        val ble = FakeBleDriver()
        val nsd = FakeNsdDriver()
        val checker = RuntimeProximityPermissionChecker(
            sdkIntProvider = { Build.VERSION_CODES.TIRAMISU },
            isPermissionGranted = { true },
        )
        val controller = VoluntaryProximitySessionController(ble, nsd, checker)
        val now = 1_760_000_100L

        controller.provision(orgA, "event-floor-2", masterKey, aliceSeed)

        val noConsent = assertThrows(ProximityVoluntaryFailure::class.java) {
            controller.startVoluntarySession(now)
        }
        assertEquals(ProximityVoluntaryError.FOREGROUND_CONSENT_REQUIRED, noConsent.reason)

        controller.grantForegroundConsent()
        controller.selectedDuration = ProximitySessionDuration.MINUTES_15
        controller.statusNote = "  Salle B · café  "
        controller.startVoluntarySession(now)

        assertTrue(controller.isSessionActive)
        assertEquals("Salle B · café", controller.statusNote)
        assertEquals(now + 900L, controller.expiresAtUnixSeconds)

        val bobToken1 = EphemeralHkdfTokenCodec.mint(orgA, "event-floor-2", masterKey, bobSeed, now + 5L, 1L)
        val peerViaBle = controller.ingestBleObservation(bobToken1.raw, -49, "Stand café", now + 5L)
        assertEquals(ProximityDistanceBand.IMMEDIATE, peerViaBle.distanceBand)
        assertFalse(peerViaBle.viaMdnsLan)

        // Replay of exact same counter in same epoch is rejected.
        val replay = assertThrows(ProximityVoluntaryFailure::class.java) {
            controller.ingestBleObservation(bobToken1.raw, -50, "Stand café", now + 6L)
        }
        assertEquals(ProximityVoluntaryError.REPLAY_REJECTED, replay.reason)

        // Higher counter over mDNS merges LAN transport badge onto same peer pseudonym.
        val bobToken2 = EphemeralHkdfTokenCodec.mint(orgA, "event-floor-2", masterKey, bobSeed, now + 7L, 2L)
        val txtAttrs = MdnsProximityTxtCodec.Record(bobToken2.epoch, bobToken2.raw, 48_443).toAttributeMap()
        val peerViaLan = controller.ingestMdnsObservation(txtAttrs, now + 7L)
        assertTrue(peerViaLan.viaMdnsLan)
        assertEquals(1, controller.peers.size)

        // Backgrounding auto-stops both BLE and NSD radios and clears discovered peers.
        controller.onForegroundChanged(false)
        assertFalse(controller.isSessionActive)
        assertTrue(controller.peers.isEmpty())

        // Re-foregrounding + starting again, then TTL expiry wipes session & consent.
        controller.onForegroundChanged(true)
        controller.startVoluntarySession(now + 10L)
        assertTrue(controller.isSessionActive)
        controller.evaluateExpiry(now + 911L)
        assertFalse(controller.isSessionActive)
        assertFalse(controller.hasForegroundConsent)
        assertNull(controller.activeTokenHex)

        // Explicit kill-switch (`leaveProximity`) stops radios immediately.
        controller.grantForegroundConsent()
        controller.startVoluntarySession(now + 20L)
        assertTrue(controller.isSessionActive)
        controller.leaveProximity()
        assertFalse(controller.isSessionActive)
        assertFalse(controller.hasForegroundConsent)
        assertTrue(controller.peers.isEmpty())
        controller.close()
    }
}
