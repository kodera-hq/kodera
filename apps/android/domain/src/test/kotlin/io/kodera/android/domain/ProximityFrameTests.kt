package io.kodera.android.domain

import org.junit.Assert.*
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.Signature

class ProximityFrameTests {
    private val publicKey = ProximityPublicKey(decodeProximityHex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"))
    private val canonical = decodeProximityHex("4b4501019a5e626ca073038303030303030303d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a03010bc380206ce2809961627269de751167ed246633a763a7ea63c555078167ddf5960d86437c64e3bf3a50e27e8d2f15a871c011221283833943f8a5a1a5b9bb758a6b9f31d60aa771cb89c005")
    private fun refuses(reason: ProximityError, block: () -> Unit) {
        try { block(); fail("expected $reason") } catch (error: ProximityFailure) { assertEquals(reason, error.reason) }
    }
    /** `kodera-rs` reads the same file: the bounds and the future-skew rule agree line for line. */
    @Test fun boundsAndFutureRuleMatchTheSharedRustRules() {
        val root = generateSequence(java.io.File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .first { java.io.File(it, "packages/kodera-rs/vectors/emergency-v1-rules.txt").isFile }
        val bounds = mutableMapOf<String, Long>(); val rules = mutableMapOf<String, Long>(); var cases = 0
        java.io.File(root, "packages/kodera-rs/vectors/emergency-v1-rules.txt").readLines(Charsets.UTF_8)
            .filter { it.isNotEmpty() && !it.startsWith("#") }.forEach { line ->
                val f = line.split(" ")
                when {
                    f[0] == "bound" && f.size == 3 -> bounds[f[1]] = f[2].toLong()
                    f[0] == "rule" && f.size == 3 -> rules[f[1]] = f[2].toLong()
                    f[0] == "case" && f.size == 6 -> {
                        assertEquals(line, "max_future_skew_ms", f[1])
                        assertTrue(line, f[5] == "accept" || f[5] == "refuse")
                        assertEquals(f[2], f[5] == "refuse", ProximityBounds.isTooFarAhead(f[4].toLong(), f[3].toLong()))
                        cases++
                    }
                    else -> fail("unknown line in the shared rules: $line")
                }
            }
        assertEquals(mapOf("queue_capacity" to ProximityBounds.QUEUE_CAPACITY.toLong(),
            "roster_members" to ProximityBounds.ROSTER_MEMBERS.toLong(),
            "replay_entries" to ProximityBounds.REPLAY_ENTRIES.toLong()), bounds)
        assertEquals(mapOf("max_future_skew_ms" to ProximityBounds.MAX_FUTURE_SKEW_MS), rules)
        assertTrue(cases > 0)
        ProximityReplayGuard(ProximityBounds.REPLAY_ENTRIES)
        assertThrows(IllegalArgumentException::class.java) { ProximityReplayGuard(ProximityBounds.REPLAY_ENTRIES + 1) }
        assertFalse(ProximityBounds.isTooFarAhead(Long.MAX_VALUE, Long.MAX_VALUE))
    }
    @Test fun canonicalFrameHasAGenuineSignatureAndRelayRetainsIt() {
        val frame = ProximityFrame.decode(canonical)
        assertEquals(129, canonical.size)
        assertEquals(1762520100000L, frame.messageId.timestampMillis)
        assertEquals("019a5e626ca073038303030303030303", frame.messageId.toString())
        assertEquals("À l’abri", frame.text)
        assertEquals(ProximitySafetyStatus.SAFE, frame.status)
        assertArrayEquals(canonical, frame.encode())
        frame.verify(setOf(publicKey))
        val relay = frame.decrementHop()!!
        assertEquals(2, relay.ttlHops)
        assertArrayEquals(frame.signingTranscript(), relay.signingTranscript())
        assertArrayEquals(frame.signature(), relay.signature())
        relay.verify(setOf(publicKey))
        assertNull(relay.decrementHop()!!.decrementHop())
    }
    @Test fun beaconMatchesCrossPlatformVectorAndOnlyAdjacentWindows() {
        val salt = ByteArray(32) { 0x42 }; val now = 1762520100L
        assertEquals("1be3967637ebb0ea", encodeProximityHex(ProximityBeacon.compute(salt, now)))
        for (offset in listOf(-300L, 0L, 300L)) assertTrue(ProximityBeacon.matches(salt, ProximityBeacon.compute(salt, now + offset), now))
        for (offset in listOf(-600L, 600L)) assertFalse(ProximityBeacon.matches(salt, ProximityBeacon.compute(salt, now + offset), now))
        assertFalse(ProximityBeacon.matches(salt, ByteArray(7), now))
        assertFalse(ProximityBeacon.matches(ByteArray(32) { 1 }, ProximityBeacon.compute(salt, now), now))
        for (edge in listOf(0L, Long.MAX_VALUE)) assertTrue(ProximityBeacon.matches(salt, ProximityBeacon.compute(salt, edge), edge))
    }
    @Test fun tamperingAndUnauthorizedRosterFailRealCrypto() {
        refuses(ProximityError.UNAUTHORIZED) { ProximityFrame.decode(canonical).verify(emptySet()) }
        for (index in listOf(56, canonical.lastIndex, 52)) {
            val altered = canonical.copyOf().also { it[index] = (it[index].toInt() xor 1).toByte() }
            refuses(ProximityError.INVALID_SIGNATURE) { ProximityFrame.decode(altered).verify(setOf(publicKey)) }
        }
    }
    @Test fun malformedFramesCannotBeNormalizedIntoAuthority() {
        for (raw in listOf(ByteArray(117), canonical + byteArrayOf(0), canonical.copyOf(128)))
            refuses(ProximityError.MALFORMED_FRAME) { ProximityFrame.decode(raw) }
        for ((index, value) in listOf(0 to 0, 2 to 2, 53 to 139, 54 to 255, 52 to 9))
            refuses(ProximityError.MALFORMED_FRAME) { ProximityFrame.decode(canonical.copyOf().also { it[index] = value.toByte() }) }
        for (ttl in listOf(0, 7, 255)) refuses(ProximityError.INVALID_TTL) {
            ProximityFrame.decode(canonical.copyOf().also { it[51] = ttl.toByte() })
        }
        for ((index, value) in listOf(9 to 0x60, 11 to 0xc0)) refuses(ProximityError.INVALID_ID) {
            ProximityFrame.decode(canonical.copyOf().also { it[index] = value.toByte() })
        }
    }
    @Test fun signingUsesUtf8ByteLimitAndDefensiveCopies() {
        val pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
        val keyBytes = pair.public.encoded.takeLast(32).toByteArray()
        val signer = object : ProximitySigner {
            override val publicKey = ProximityPublicKey(keyBytes)
            override fun sign(transcript: ByteArray) = Signature.getInstance("Ed25519").run {
                initSign(pair.private); update(transcript); sign()
            }
        }
        val id = ProximityMessageId.fromParts(100, ByteArray(10))
        val frame = ProximityFrame.signed(id, 6, ProximitySafetyStatus.SAFE, "é".repeat(69), signer)
        assertEquals(256, frame.encode().size)
        refuses(ProximityError.TEXT_TOO_LONG) { ProximityFrame.signed(id, 6, ProximitySafetyStatus.SAFE, "é".repeat(70), signer) }
        refuses(ProximityError.MALFORMED_FRAME) { ProximityFrame.signed(id, 6, ProximitySafetyStatus.SAFE, "\uD800", signer) }
        keyBytes.fill(0); frame.encode().fill(0); frame.signature().fill(0)
        frame.messageId.bytes().fill(0); frame.senderPublicKey.bytes().fill(0)
        frame.verify(setOf(signer.publicKey))
    }
    @Test fun unavailableSignerProviderFailsWithTypedError() {
        val signer = object : ProximitySigner {
            override val publicKey = this@ProximityFrameTests.publicKey
            override fun sign(transcript: ByteArray): ByteArray = throw java.security.NoSuchAlgorithmException()
        }
        refuses(ProximityError.CRYPTO_UNAVAILABLE) {
            ProximityFrame.signed(ProximityMessageId.fromParts(1, ByteArray(10)), 6, ProximitySafetyStatus.SAFE, "", signer)
        }
    }
    // RFC 8032 section 7.1, test 1: the key that signed `canonical`, over the empty message.
    private val rfcSeed = decodeProximityHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
    private val rfcEmptySignature = decodeProximityHex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b")
    /** Android 8 to 12: the platform provider has no Ed25519 at all. */
    private val noPlatformEd25519 = object : Ed25519Primitive {
        override fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean = throw java.security.NoSuchAlgorithmException("Ed25519")
        override fun sign(seed: ByteArray, message: ByteArray): ByteArray = throw java.security.NoSuchAlgorithmException("Ed25519")
    }
    /** A provider that has the algorithm but not the raw-key encodings. */
    private val noRawKeyEd25519 = object : Ed25519Primitive {
        override fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean = throw java.security.spec.InvalidKeySpecException()
        override fun sign(seed: ByteArray, message: ByteArray): ByteArray = throw java.security.spec.InvalidKeySpecException()
    }
    private val unusedFallback = object : Ed25519Primitive {
        override fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean = throw AssertionError("fallback used")
        override fun sign(seed: ByteArray, message: ByteArray): ByteArray = throw AssertionError("fallback used")
    }
    private fun canonicalResigned(signer: ProximitySigner) = ProximityFrame.signed(
        ProximityMessageId.fromBytes(decodeProximityHex("019a5e626ca073038303030303030303")), 3, ProximitySafetyStatus.SAFE, "À l’abri", signer)

    @Test fun withoutPlatformEd25519TheFallbackVerifiesSignsAndRefuses() {
        for (platform in listOf(noPlatformEd25519, noRawKeyEd25519)) {
            val ed25519 = PlatformOrBundledEd25519(platform)
            val verifier = Ed25519SignatureVerifier(ed25519)
            // The shared canonical v1 frame.
            ProximityFrame.decode(canonical).verify(setOf(publicKey), verifier)
            ProximityFrame.decode(canonical).decrementHop()!!.verify(setOf(publicKey), verifier)
            // RFC 8032 test 1, both directions.
            assertTrue(ed25519.verify(publicKey.bytes(), ByteArray(0), rfcEmptySignature))
            assertArrayEquals(rfcEmptySignature, ed25519.sign(rfcSeed, ByteArray(0)))
            // Signing again with the RFC key reproduces the canonical frame byte for byte.
            val signer = Ed25519ProximitySigner(rfcSeed, ed25519)
            assertEquals(publicKey, signer.publicKey)
            assertArrayEquals(canonical, canonicalResigned(signer).encode())
            // A fresh key and frame.
            val fresh = Ed25519ProximitySigner(ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }, ed25519)
            val frame = ProximityFrame.signed(ProximityMessageId.fromParts(200, ByteArray(10) { 7 }), 6, ProximitySafetyStatus.NEED_ASSISTANCE, "Besoin d’aide", fresh)
            ProximityFrame.decode(frame.encode()).verify(setOf(fresh.publicKey), verifier)
            assertFalse(verifier.verify(publicKey, frame.signingTranscript(), frame.signature()))
            // Tampered signatures, transcripts and lengths are refused, not thrown.
            for (index in listOf(54 + "À l’abri".toByteArray().size, canonical.lastIndex)) {
                val altered = canonical.copyOf().also { it[index] = (it[index].toInt() xor 1).toByte() }
                refuses(ProximityError.INVALID_SIGNATURE) { ProximityFrame.decode(altered).verify(setOf(publicKey), verifier) }
            }
            val tampered = rfcEmptySignature.copyOf().also { it[0] = (it[0].toInt() xor 1).toByte() }
            assertFalse(ed25519.verify(publicKey.bytes(), ByteArray(0), tampered))
            assertFalse(ed25519.verify(publicKey.bytes(), byteArrayOf(0), rfcEmptySignature))
            assertFalse(ed25519.verify(publicKey.bytes(), ByteArray(0), rfcEmptySignature.copyOf(63)))
        }
    }
    @Test fun withPlatformEd25519ThePlatformAnswersAndAgreesWithTheFallback() {
        val ed25519 = PlatformOrBundledEd25519(PlatformEd25519, unusedFallback)
        ProximityFrame.decode(canonical).verify(setOf(publicKey), Ed25519SignatureVerifier(ed25519))
        assertTrue(ed25519.verify(publicKey.bytes(), ByteArray(0), rfcEmptySignature))
        assertArrayEquals(rfcEmptySignature, ed25519.sign(rfcSeed, ByteArray(0)))
        assertArrayEquals(canonical, canonicalResigned(Ed25519ProximitySigner(rfcSeed, ed25519)).encode())
        val tampered = canonical.copyOf().also { it[canonical.lastIndex] = (it[canonical.lastIndex].toInt() xor 1).toByte() }
        refuses(ProximityError.INVALID_SIGNATURE) { ProximityFrame.decode(tampered).verify(setOf(publicKey), Ed25519SignatureVerifier(ed25519)) }
        val random = java.util.Random(26)
        repeat(16) {
            val seed = ByteArray(32).also(random::nextBytes); val message = ByteArray(it * 9).also(random::nextBytes)
            val signature = PlatformEd25519.sign(seed, message)
            assertArrayEquals(signature, BundledEd25519.sign(seed, message))
            assertTrue(BundledEd25519.verify(BundledEd25519.publicKey(seed), message, signature))
            assertTrue(PlatformEd25519.verify(BundledEd25519.publicKey(seed), message, signature))
        }
        // The production default still verifies through the platform here.
        ProximityFrame.decode(canonical).verify(setOf(publicKey), Ed25519ProximityVerifier)
    }
    @Test fun replayRejectsDuplicateAndInvalidCapacity() {
        val frame = ProximityFrame.decode(canonical).verify(setOf(publicKey)); val guard = ProximityReplayGuard(2)
        assertTrue(guard.acceptOnce(frame)); assertFalse(guard.acceptOnce(frame))
        try { ProximityReplayGuard(0); fail() } catch (_: IllegalArgumentException) { }
    }
}
