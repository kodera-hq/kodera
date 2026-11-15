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
        override var onFailure: ((ProximityVoluntaryError) -> Unit)? = null
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
        override var onFailure: ((ProximityVoluntaryError) -> Unit)? = null
        val advertisedAttributes = mutableListOf<Map<String, String>>()
        var stopCount = 0
        var failNextStart = false

        override fun startAdvertisingAndDiscovery(attributes: Map<String, String>, quicPort: Int) {
            if (failNextStart) throw ProximityVoluntaryFailure(ProximityVoluntaryError.NSD_UNAVAILABLE)
            advertisedAttributes += LinkedHashMap(attributes)
        }

        override fun stopAll() {
            stopCount += 1
        }
    }

    private class ManualTimer : ProximitySessionTimer {
        val callbacks = mutableListOf<() -> Unit>()
        override fun schedule(tick: () -> Unit): AutoCloseable {
            callbacks += tick
            return AutoCloseable { }
        }
    }

    @Test
    fun currentEpochLeaseMatchesSharedFrozenWireAndCannotAuthorizeFutureEpoch() {
        val path = "packages/kodera-rs/vectors/proximity-epoch-lease-v1.json"
        val root = generateSequence(java.io.File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .first { java.io.File(it, path).isFile }
        val fixture = java.io.File(root, path).readText()
        fun text(name: String) = Regex("\"$name\"\\s*:\\s*\"([^\"]+)\"").find(fixture)!!.groupValues[1]
        fun number(name: String) = Regex("\"$name\"\\s*:\\s*([0-9]+)").find(fixture)!!.groupValues[1].toLong()
        val workspace = text("workspace_id")
        val key = EphemeralHkdfTokenCodec.fromHex(text("epoch_mac_key"))!!
        val seed = EphemeralHkdfTokenCodec.fromHex(text("device_seed"))!!
        val epoch = number("epoch")
        val expiry = number("epoch_expires_at")
        val now = number("now_unix_seconds")
        val token = EphemeralHkdfTokenCodec.mintWithEpochMacKey(workspace, "default", epoch, expiry, key, seed, now, number("counter"))
        assertEquals(text("token_hex"), token.tokenHex)
        assertArrayEquals(token.raw, EphemeralHkdfTokenCodec.verifyWithEpochMacKey(token.raw, workspace, "default", epoch, expiry, key, now).raw)
        assertThrows(ProximityVoluntaryFailure::class.java) {
            EphemeralHkdfTokenCodec.mintWithEpochMacKey(workspace, "default", epoch, expiry, key, seed, expiry)
        }
        val forged = EphemeralHkdfTokenCodec.mintWithEpochMacKey(workspace, "default", epoch + 1, expiry + 900, key, seed, expiry)
        val refusal = assertThrows(ProximityVoluntaryFailure::class.java) {
            EphemeralHkdfTokenCodec.verifyWithEpochMacKey(forged.raw, workspace, "default", epoch + 1, expiry + 900, ByteArray(32) { 0xcd.toByte() }, expiry)
        }
        assertEquals(ProximityVoluntaryError.AUTHENTICATION_FAILED, refusal.reason)
    }

    @Test
    fun epochCodecRejectsNonCanonicalScopesAtMintVerifyAndProvision() {
        val now = 1_800_001L
        val key = ByteArray(32) { 0xab.toByte() }
        val token = EphemeralHkdfTokenCodec.mintWithEpochMacKey(orgA, "default", 2_000, 1_800_900, key, aliceSeed, now)
        val controller = VoluntaryProximitySessionController(FakeBleDriver(), FakeNsdDriver(),
            RuntimeProximityPermissionChecker({ Build.VERSION_CODES.TIRAMISU }, { true }), timer = ManualTimer())
        for (scope in listOf("", "_first", "-first", "first space", "évent", "default\n", "a".repeat(65))) {
            assertThrows(ProximityVoluntaryFailure::class.java) {
                EphemeralHkdfTokenCodec.mintWithEpochMacKey(orgA, scope, 2_000, 1_800_900, key, aliceSeed, now)
            }
            assertThrows(ProximityVoluntaryFailure::class.java) {
                EphemeralHkdfTokenCodec.verifyWithEpochMacKey(token.raw, orgA, scope, 2_000, 1_800_900, key, now)
            }
            assertThrows(ProximityVoluntaryFailure::class.java) {
                controller.provisionEpoch(orgA, scope, 2_000, 1_800_900, key, aliceSeed, now)
            }
            assertNull(controller.organisationId)
        }
        for (scope in listOf("A", "0._:-Z", "a".repeat(64))) {
            val minted = EphemeralHkdfTokenCodec.mintWithEpochMacKey(orgA, scope, 2_000, 1_800_900, key, aliceSeed, now)
            assertArrayEquals(minted.raw, EphemeralHkdfTokenCodec.verifyWithEpochMacKey(minted.raw, orgA, scope,
                2_000, 1_800_900, key, now).raw)
        }
        controller.close()
    }

    @Test
    fun ownBleAndMdnsBeaconsCannotBecomePeersEvenWithAnotherCounter() {
        val ble = FakeBleDriver()
        val nsd = FakeNsdDriver()
        val now = 1_800_001L
        val key = ByteArray(32) { 0xab.toByte() }
        val controller = VoluntaryProximitySessionController(ble, nsd,
            RuntimeProximityPermissionChecker({ Build.VERSION_CODES.TIRAMISU }, { true }), timer = ManualTimer())
        controller.provisionEpoch(orgA, "default", 2_000, 1_800_900, key, aliceSeed, now)
        controller.grantForegroundConsent()
        controller.startVoluntarySession(now)
        assertThrows(ProximityVoluntaryFailure::class.java) { controller.ingestBleObservation(ble.advertisedTokens[0], -30, nowUnixSeconds = now) }
        assertThrows(ProximityVoluntaryFailure::class.java) { controller.ingestMdnsObservation(nsd.advertisedAttributes[0], now) }
        val ownCounter = EphemeralHkdfTokenCodec.mintWithEpochMacKey(orgA, "default", 2_000, 1_800_900, key, aliceSeed, now, 17)
        assertThrows(ProximityVoluntaryFailure::class.java) { controller.ingestBleObservation(ownCounter.raw, -30, nowUnixSeconds = now) }
        assertTrue(controller.peers.isEmpty())
        val peer = EphemeralHkdfTokenCodec.mintWithEpochMacKey(orgA, "default", 2_000, 1_800_900, key, bobSeed, now)
        controller.ingestBleObservation(peer.raw, -65, nowUnixSeconds = now)
        assertEquals(1, controller.peers.size)
        controller.close()
    }

    @Test
    fun peerCapacityRefusesNewPseudonymsButRetainsCountersUntilLeaseExpiry() {
        val now = 1_800_001L
        val key = ByteArray(32) { 0xab.toByte() }
        fun token(index: Int, counter: Long = 0L, at: Long = now): ByteArray {
            val seed = ByteArray(32) { 0x55.toByte() }
            seed[0] = index.toByte(); seed[1] = (index shr 8).toByte()
            return EphemeralHkdfTokenCodec.mintWithEpochMacKey(orgA, "default", at / 900,
                (at / 900 + 1) * 900, key, seed, at, counter).raw
        }
        val controller = VoluntaryProximitySessionController(FakeBleDriver(), FakeNsdDriver(),
            RuntimeProximityPermissionChecker({ Build.VERSION_CODES.TIRAMISU }, { true }), timer = ManualTimer())
        controller.provisionEpoch(orgA, "default", 2_000, 1_800_900, key, aliceSeed, now)
        controller.grantForegroundConsent()
        controller.startVoluntarySession(now)
        for (index in 0 until 256) controller.ingestBleObservation(token(index), -65, nowUnixSeconds = now)
        assertEquals(256, controller.peers.size)
        val overflow = token(256)
        assertThrows(ProximityVoluntaryFailure::class.java) { controller.ingestBleObservation(overflow, -30, nowUnixSeconds = now) }
        val txt = MdnsProximityTxtCodec.Record(2_000, overflow, 48_443)
        assertThrows(ProximityVoluntaryFailure::class.java) { controller.ingestMdnsObservation(txt.toAttributeMap(), now) }
        controller.ingestBleObservation(token(0, 1), -30, nowUnixSeconds = now)
        assertEquals(256, controller.peers.size)
        assertThrows(ProximityVoluntaryFailure::class.java) { controller.ingestBleObservation(token(0), -30, nowUnixSeconds = now) }
        controller.evaluateExpiry(1_800_900)
        assertTrue(controller.peers.isEmpty())
        controller.provisionEpoch(orgA, "default", 2_001, 1_801_800, key, bobSeed, 1_800_900)
        controller.grantForegroundConsent()
        controller.startVoluntarySession(1_800_900)
        controller.ingestBleObservation(token(256, at = 1_800_900), -65, nowUnixSeconds = 1_800_900)
        assertEquals(1, controller.peers.size)
        controller.close()
    }

    @Test
    fun preparedEpochLeaseExpiresWithoutScanningAndObsoleteTickCannotClearReplacement() {
        val ble = FakeBleDriver()
        val nsd = FakeNsdDriver()
        val timer = ManualTimer()
        var now = 1_800_899L
        val controller = VoluntaryProximitySessionController(ble, nsd,
            RuntimeProximityPermissionChecker({ Build.VERSION_CODES.TIRAMISU }, { true }),
            timer = timer, clockUnixSeconds = { now })
        var renewals = 0
        controller.onAuthenticatedRebootstrapRequired = { renewals++ }
        controller.provisionEpoch(orgA, "default", 2_000, 1_800_900,
            ByteArray(32) { 0xab.toByte() }, aliceSeed, now)
        controller.grantForegroundConsent()
        val obsoleteTick = timer.callbacks.single()
        obsoleteTick()
        assertEquals(orgA, controller.organisationId)
        now = 1_800_900
        obsoleteTick()
        assertNull(controller.organisationId)
        assertFalse(controller.hasForegroundConsent)
        assertFalse(controller.isSessionActive)
        assertTrue(ble.advertisedTokens.isEmpty())
        assertTrue(nsd.advertisedAttributes.isEmpty())
        assertEquals(0, renewals)
        assertThrows(ProximityVoluntaryFailure::class.java) { controller.startVoluntarySession(now) }
        controller.provisionEpoch(orgB, "default", 2_001, 1_801_800,
            ByteArray(32) { 0xcd.toByte() }, bobSeed, now)
        obsoleteTick()
        assertEquals(orgB, controller.organisationId)
        now = 1_801_800
        timer.callbacks.last().invoke()
        assertNull(controller.organisationId)
        assertEquals(0, renewals)
        controller.close()
    }

    @Test
    fun epochExpiryStopsAndWipesBeforeRequestingRenewalWithoutExtendingConsent() {
        val ble = FakeBleDriver()
        val nsd = FakeNsdDriver()
        val timer = ManualTimer()
        var now = 1_800_899L
        val checker = RuntimeProximityPermissionChecker({ Build.VERSION_CODES.TIRAMISU }, { true })
        val controller = VoluntaryProximitySessionController(ble, nsd, checker, timer = timer, clockUnixSeconds = { now })
        val deadlines = mutableListOf<Long>()
        controller.onAuthenticatedRebootstrapRequired = { deadlines += it }
        controller.provisionEpoch(orgA, "default", 2_000, 1_800_900, ByteArray(32) { 0xab.toByte() }, aliceSeed, now)
        controller.grantForegroundConsent()
        controller.selectedDuration = ProximitySessionDuration.HOURS_2
        controller.startVoluntarySession(now)
        val deadline = controller.expiresAtUnixSeconds!!
        now = 1_800_900
        timer.callbacks.last().invoke()
        assertEquals(listOf(deadline), deadlines)
        assertFalse(controller.isSessionActive)
        assertFalse(controller.hasForegroundConsent)
        assertNull(controller.organisationId)
        assertNull(controller.activeTokenHex)
        assertEquals(1, ble.advertisedTokens.size)
        assertThrows(ProximityVoluntaryFailure::class.java) { controller.startVoluntarySession(now) }
        controller.provisionEpoch(orgA, "default", 2_001, 1_801_800, ByteArray(32) { 0xcd.toByte() }, bobSeed, now)
        controller.grantForegroundConsent()
        controller.startVoluntarySession(now, consentExpiresAtUnixSeconds = deadline)
        assertEquals(deadline, controller.expiresAtUnixSeconds)
        now = deadline
        timer.callbacks.last().invoke()
        assertFalse(controller.isSessionActive)
        assertEquals(listOf(deadline), deadlines)
        controller.close()
    }

    @Test
    fun scheduledTicksRotateBothTransportsPreserveTtlAndCannotReviveStoppedSessions() {
        val ble = FakeBleDriver()
        val nsd = FakeNsdDriver()
        val timer = ManualTimer()
        var now = 1_800_899L
        val checker = RuntimeProximityPermissionChecker({ Build.VERSION_CODES.TIRAMISU }, { true })
        val controller = VoluntaryProximitySessionController(
            ble, nsd, checker, timer = timer, clockUnixSeconds = { now },
        )
        controller.provision(orgA, "default", masterKey, aliceSeed)
        controller.grantForegroundConsent()
        controller.selectedDuration = ProximitySessionDuration.HOURS_2
        controller.startVoluntarySession(now)
        val expiry = controller.expiresAtUnixSeconds
        val token = controller.activeTokenHex
        timer.callbacks.single().invoke()
        assertEquals(1, ble.advertisedTokens.size)
        now += 1
        timer.callbacks.single().invoke()
        assertEquals(2, ble.advertisedTokens.size)
        assertEquals(2, nsd.advertisedAttributes.size)
        assertNotEquals(token, controller.activeTokenHex)
        assertEquals(expiry, controller.expiresAtUnixSeconds)
        EphemeralHkdfTokenCodec.verify(ble.advertisedTokens.last(), orgA, "default", masterKey, now)
        controller.leaveProximity()
        now += 900
        timer.callbacks.single().invoke()
        assertEquals(2, ble.advertisedTokens.size)
        assertFalse(controller.isSessionActive)
        controller.close()
    }

    @Test
    fun automaticExpiryPrecedesRotationAndOldTimerCannotExpireReplacement() {
        val ble = FakeBleDriver()
        val nsd = FakeNsdDriver()
        val timer = ManualTimer()
        var now = 1_800_000L
        val checker = RuntimeProximityPermissionChecker({ Build.VERSION_CODES.TIRAMISU }, { true })
        val controller = VoluntaryProximitySessionController(ble, nsd, checker, timer = timer, clockUnixSeconds = { now })
        controller.provision(orgA, "default", masterKey, aliceSeed)
        controller.grantForegroundConsent()
        controller.selectedDuration = ProximitySessionDuration.MINUTES_15
        controller.startVoluntarySession(now)
        now += 900
        timer.callbacks[0].invoke()
        assertFalse(controller.isSessionActive)
        assertFalse(controller.hasForegroundConsent)
        assertEquals(1, ble.advertisedTokens.size)
        controller.grantForegroundConsent()
        controller.startVoluntarySession(now)
        now += 900
        timer.callbacks[0].invoke()
        assertTrue(controller.isSessionActive)
        timer.callbacks[1].invoke()
        assertFalse(controller.isSessionActive)
        assertEquals(2, ble.advertisedTokens.size)
        controller.close()
    }

    @Test
    fun failedEpochRefreshStopsBothRadiosAndClearsActiveToken() {
        val ble = FakeBleDriver()
        val nsd = FakeNsdDriver()
        val checker = RuntimeProximityPermissionChecker({ Build.VERSION_CODES.TIRAMISU }, { true })
        val controller = VoluntaryProximitySessionController(ble, nsd, checker, timer = ManualTimer())
        controller.provision(orgA, "default", masterKey, aliceSeed)
        controller.grantForegroundConsent()
        controller.startVoluntarySession(1_800_899L)
        nsd.failNextStart = true
        assertThrows(ProximityVoluntaryFailure::class.java) { controller.refreshSession(1_800_900L) }
        assertFalse(controller.isSessionActive)
        assertNull(controller.activeTokenHex)
        assertEquals(ProximityVoluntaryError.NSD_UNAVAILABLE, controller.lastError)
        assertTrue(ble.stopCount > 0)
        assertTrue(nsd.stopCount > 0)
        controller.close()
    }

    @Test
    fun asynchronousAdvertisingFailureClearsSessionAndBothTransports() {
        val ble = FakeBleDriver()
        val nsd = FakeNsdDriver()
        val checker = RuntimeProximityPermissionChecker({ Build.VERSION_CODES.TIRAMISU }, { true })
        val controller = VoluntaryProximitySessionController(ble, nsd, checker, timer = ManualTimer())
        controller.provision(orgA, "default", masterKey, aliceSeed)
        controller.grantForegroundConsent()
        controller.startVoluntarySession(1_800_000L)
        ble.onFailure?.invoke(ProximityVoluntaryError.BLUETOOTH_UNAVAILABLE)
        assertFalse(controller.isSessionActive)
        assertNull(controller.activeTokenHex)
        assertEquals(ProximityVoluntaryError.BLUETOOTH_UNAVAILABLE, controller.lastError)
        assertTrue(ble.stopCount > 0)
        assertTrue(nsd.stopCount > 0)
        controller.close()
    }

    @Test
    fun mdnsFailureWipesPreparedEpochCapability() {
        val ble = FakeBleDriver()
        val nsd = FakeNsdDriver()
        val checker = RuntimeProximityPermissionChecker({ Build.VERSION_CODES.TIRAMISU }, { true })
        val controller = VoluntaryProximitySessionController(ble, nsd, checker, timer = ManualTimer())
        controller.provisionEpoch(orgA, "default", 2_000, 1_800_900, ByteArray(32) { 0xab.toByte() }, aliceSeed, 1_800_001)
        controller.grantForegroundConsent()
        controller.startVoluntarySession(1_800_001)
        nsd.onFailure?.invoke(ProximityVoluntaryError.NSD_UNAVAILABLE)
        assertFalse(controller.isSessionActive)
        assertNull(controller.organisationId)
        assertNull(controller.activeTokenHex)
        assertEquals(ProximityVoluntaryError.NSD_UNAVAILABLE, controller.lastError)
        controller.close()
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
                Manifest.permission.BLUETOOTH_CONNECT,
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
        granted += Manifest.permission.BLUETOOTH_CONNECT
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
        assertThrows(ProximityVoluntaryFailure::class.java) {
            MdnsProximityTxtCodec.decode(valid + ("tok" to "a".repeat(100_000)))
        }
        assertThrows(ProximityVoluntaryFailure::class.java) {
            MdnsProximityTxtCodec.decode(valid + ("unexpected" to "field"))
        }

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
