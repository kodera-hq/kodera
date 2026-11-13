package io.kodera.android.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

class PasskeyDeviceBindingTests {
    private val orgA = "00000000-0000-4000-8000-000000000001"
    private val orgB = "00000000-0000-4000-8000-000000000002"
    private val rpId = "accounts.kodera.test"
    private val webOrigin = "https://accounts.kodera.test"
    private val keyHandleSample = "public-fixture-key-handle".toByteArray(Charsets.US_ASCII)

    private fun generateP256KeyPair(): KeyPair {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        return generator.generateKeyPair()
    }

    private fun fixed32ByteBigEndian(value: java.math.BigInteger): ByteArray {
        val raw = value.toByteArray()
        return when {
            raw.size == 32 -> raw
            raw.size > 32 -> raw.copyOfRange(raw.size - 32, raw.size)
            else -> ByteArray(32 - raw.size) + raw
        }
    }

    private fun uncompressedSec1(ecKeyPair: KeyPair): ByteArray {
        val pub = ecKeyPair.public as ECPublicKey
        val x = fixed32ByteBigEndian(pub.w.affineX)
        val y = fixed32ByteBigEndian(pub.w.affineY)
        return byteArrayOf(0x04) + x + y
    }

    private fun compressedSec1(ecKeyPair: KeyPair): ByteArray {
        val pub = ecKeyPair.public as ECPublicKey
        val prefix: Byte = if (pub.w.affineY.testBit(0)) 0x03 else 0x02
        return byteArrayOf(prefix) + fixed32ByteBigEndian(pub.w.affineX)
    }

    private fun coseEs256Key(ecKeyPair: KeyPair): ByteArray {
        val pub = ecKeyPair.public as ECPublicKey
        val x = fixed32ByteBigEndian(pub.w.affineX)
        val y = fixed32ByteBigEndian(pub.w.affineY)
        // CBOR map(5): {1: 2, 3: -7, -1: 1, -2: bstr(32), -3: bstr(32)}
        return byteArrayOf(
            0xA5.toByte(),
            0x01, 0x02,
            0x03, 0x26, // -7 = -1 - 6 (0x20 | 6 = 0x26)
            0x20, 0x01, // -1 = 0x20, 1 = 0x01
            0x21, 0x58, 0x20,
        ) + x + byteArrayOf(0x22, 0x58, 0x20) + y
    }

    private fun signAssertion(
        ecKeyPair: KeyPair,
        challenge: PasskeyChallenge,
        counter: Long,
        flags: Int,
        origin: String = webOrigin,
        rp: String = rpId,
        handleBytes: ByteArray = keyHandleSample,
    ): PasskeyAssertion {
        val clientJson = """{"type":"webauthn.get","challenge":"${challenge.base64Url}","origin":"$origin","crossOrigin":false}"""
            .toByteArray(Charsets.UTF_8)
        val rpHash = PasskeyDeviceBinding.sha256(rp.toByteArray(Charsets.UTF_8))
        val counterBe = byteArrayOf(
            ((counter ushr 24) and 0xFFL).toByte(),
            ((counter ushr 16) and 0xFFL).toByte(),
            ((counter ushr 8) and 0xFFL).toByte(),
            (counter and 0xFFL).toByte(),
        )
        val authData = rpHash + byteArrayOf(flags.toByte()) + counterBe
        val signedBytes = authData + PasskeyDeviceBinding.sha256(clientJson)
        val signer = Signature.getInstance("SHA256withECDSA")
        signer.initSign(ecKeyPair.private)
        signer.update(signedBytes)
        val der = signer.sign()
        return PasskeyAssertion(handleBytes, clientJson, authData, der)
    }

    @Test
    fun universalPolicyAcceptsYubiKey0x05Platform0x0DAndVaultwarden0x1DWhileRejectingInvalidFlags() {
        val ecKeyPair = generateP256KeyPair()
        val binding = PasskeyDeviceBinding.create(
            organisationId = orgA,
            rpId = rpId,
            origin = webOrigin,
            keyHandleId = keyHandleSample,
            publicSec1Key = compressedSec1(ecKeyPair),
            backupPolicy = PasskeyBackupPolicy.UNIVERSAL,
        )

        // 1. Hardware FIDO2 YubiKey (0x05 = UP | UV)
        val c1 = binding.issueChallenge(orgA, now = 100L, lifetimeSeconds = 60L)
        val r1 = binding.verifyAssertion(orgA, c1, signAssertion(ecKeyPair, c1, counter = 1L, flags = 0x05), now = 101L)
        assertEquals(PasskeyResidencyPosture.SINGLE_DEVICE_BOUND, r1)

        // 2. Backup-eligible local passkey (0x0D = UP | UV | BE)
        val c2 = binding.issueChallenge(orgA, now = 102L, lifetimeSeconds = 60L)
        val r2 = binding.verifyAssertion(orgA, c2, signAssertion(ecKeyPair, c2, counter = 2L, flags = 0x0D), now = 103L)
        assertEquals(PasskeyResidencyPosture.BACKUP_ELIGIBLE_LOCAL, r2)

        // 3. Vaultwarden "Citadel" / Google Password Manager synced passkey (0x1D = UP | UV | BE | BS)
        val c3 = binding.issueChallenge(orgA, now = 104L, lifetimeSeconds = 60L)
        val r3 = binding.verifyAssertion(orgA, c3, signAssertion(ecKeyPair, c3, counter = 3L, flags = 0x1D), now = 105L)
        assertEquals(PasskeyResidencyPosture.MULTI_DEVICE_SYNCED, r3)
        assertEquals(3, binding.verifiedAssertionCount)

        // 4. Reject invalid flags without consuming the active challenge:
        //    0x15 (BS=1, BE=0 — WebAuthn Level 3 §6.5 violation), 0x01 (missing UV),
        //    0x04 (missing UP), 0x07 (RFU bit 1), 0x25 (RFU bit 5), 0x45 (AT set), 0x85 (ED set).
        val c4 = binding.issueChallenge(orgA, now = 106L, lifetimeSeconds = 60L)
        for (invalidFlags in listOf(0x00, 0x01, 0x04, 0x15, 0x07, 0x25, 0x45, 0x85)) {
            val badAssertion = signAssertion(ecKeyPair, c4, counter = 4L, flags = invalidFlags)
            try {
                binding.verifyAssertion(orgA, c4, badAssertion, now = 107L)
                fail("Expected flag refusal for 0x${invalidFlags.toString(16)}")
            } catch (failure: PasskeyBindingFailure) {
                assertEquals(PasskeyBindingError.AUTHENTICATION_FAILED, failure.reason)
            }
        }

        // Valid assertion still succeeds on the unburned challenge.
        binding.verifyAssertion(orgA, c4, signAssertion(ecKeyPair, c4, counter = 4L, flags = 0x1D), now = 107L)
        assertEquals(4, binding.verifiedAssertionCount)
    }

    @Test
    fun strictNonBackupablePolicyRefusesBackupFlagsWhileAdmitting0x05() {
        val ecKeyPair = generateP256KeyPair()
        val binding = PasskeyDeviceBinding.create(
            organisationId = orgA,
            rpId = rpId,
            origin = webOrigin,
            keyHandleId = keyHandleSample,
            publicSec1Key = uncompressedSec1(ecKeyPair),
            backupPolicy = PasskeyBackupPolicy.STRICT_NON_BACKUPABLE,
        )
        val challenge = binding.issueChallenge(orgA, now = 200L, lifetimeSeconds = 60L)
        for (backupFlag in listOf(0x0D, 0x1D, 0x15)) {
            try {
                binding.verifyAssertion(orgA, challenge, signAssertion(ecKeyPair, challenge, 1L, backupFlag), now = 201L)
                fail("Expected strict refusal for 0x${backupFlag.toString(16)}")
            } catch (failure: PasskeyBindingFailure) {
                assertEquals(PasskeyBindingError.AUTHENTICATION_FAILED, failure.reason)
            }
        }
        binding.verifyAssertion(orgA, challenge, signAssertion(ecKeyPair, challenge, 1L, 0x05), now = 201L)
        assertEquals(1, binding.verifiedAssertionCount)
    }

    @Test
    fun registrationAcceptsZeroAaguidVaultwardenAndAndroidApkFacetAndEnforcesZeroCountersByChallenge() {
        val ecKeyPair = generateP256KeyPair()
        val apkFacet = "android:apk-key-hash:${PasskeyBase64Url.encodeUnpadded(ByteArray(32) { 9 })}"
        val regChallenge = ByteArray(32) { (it + 1).toByte() }
        val regClientJson = """{"type":"webauthn.create","challenge":"${PasskeyBase64Url.encodeUnpadded(regChallenge)}","origin":"$apkFacet","crossOrigin":false}"""
            .toByteArray(Charsets.UTF_8)

        val rpHash = PasskeyDeviceBinding.sha256(rpId.toByteArray(Charsets.UTF_8))
        val regFlags = byteArrayOf((0x01 or 0x04 or 0x08 or 0x10 or 0x40).toByte()) // UP|UV|BE|BS|AT = 0x5D
        val zeroCounter = ByteArray(4)
        val zeroAaguid = ByteArray(16) // 00000000-0000-0000-0000-000000000000 (Vaultwarden / Citadel)
        val handleLenBe = byteArrayOf(0x00, keyHandleSample.size.toByte())
        val authData = rpHash + regFlags + zeroCounter + zeroAaguid + handleLenBe + keyHandleSample + coseEs256Key(ecKeyPair)

        val verified = PasskeyDeviceBinding.verifyRegistration(
            organisationId = orgA,
            rpId = rpId,
            origin = apkFacet,
            expectedChallengeBytes = regChallenge,
            response = PasskeyRegistrationResponse(regClientJson, authData),
        )
        assertTrue(verified.isZeroAaguid)
        assertEquals(VerifiedPasskeyRegistration.ZERO_AAGUID, verified.aaguidCanonical)
        assertEquals(PasskeyResidencyPosture.MULTI_DEVICE_SYNCED, verified.residencyPosture)

        // Subsequent assertions with signCount=0 (typical for synced software passkeys) require a fresh challenge each time.
        val binding = verified.binding
        val c1 = binding.issueChallenge(orgA, now = 500L, lifetimeSeconds = 30L)
        val a1 = signAssertion(ecKeyPair, c1, counter = 0L, flags = 0x1D, origin = apkFacet)
        binding.verifyAssertion(orgA, c1, a1, now = 501L)

        // Replaying same challenge fails.
        try {
            binding.verifyAssertion(orgA, c1, a1, now = 501L)
            fail("Expected challenge replay refusal")
        } catch (failure: PasskeyBindingFailure) {
            assertEquals(PasskeyBindingError.REPLAY, failure.reason)
        }

        // Reusing old assertion against a newly issued challenge fails scope/challenge check.
        val c2 = binding.issueChallenge(orgA, now = 502L, lifetimeSeconds = 30L)
        try {
            binding.verifyAssertion(orgA, c2, a1, now = 502L)
            fail("Expected challenge mismatch refusal")
        } catch (failure: PasskeyBindingFailure) {
            assertEquals(PasskeyBindingError.SCOPE_MISMATCH, failure.reason)
        }

        val a2 = signAssertion(ecKeyPair, c2, counter = 0L, flags = 0x1D, origin = apkFacet)
        binding.verifyAssertion(orgA, c2, a2, now = 503L)
        assertEquals(2, binding.verifiedAssertionCount)

        // CredentialManager request JSON contains rpId, challenge, userVerification="required", and allowCredentials.
        val c3 = binding.issueChallenge(orgA, now = 504L, lifetimeSeconds = 30L)
        val requestJson = PasskeyCredentialManagerBridge.buildAssertionRequestJson(rpId, c3, listOf(keyHandleSample))
        assertTrue(requestJson.contains("\"userVerification\":\"required\""))
        assertTrue(requestJson.contains("\"rpId\":\"$rpId\""))
        assertTrue(binding.toString().contains("[redacted]"))
        assertTrue(c3.toString().contains("[redacted]"))
        assertTrue(a2.toString().contains("[redacted]"))
    }

    @Test
    fun monotonicCounterOriginFenceAndJsonStrictnessRefuseTampering() {
        val ecKeyPair = generateP256KeyPair()
        val binding = PasskeyDeviceBinding.create(
            organisationId = orgA,
            rpId = rpId,
            origin = webOrigin,
            keyHandleId = keyHandleSample,
            publicSec1Key = uncompressedSec1(ecKeyPair),
        )
        assertFalse(PasskeyDeviceBinding.isAdmittedOrigin(rpId, "http://accounts.kodera.test"))
        assertFalse(PasskeyDeviceBinding.isAdmittedOrigin(rpId, "https://evilaccounts.kodera.test"))
        assertTrue(PasskeyDeviceBinding.isAdmittedOrigin(rpId, "https://sub.accounts.kodera.test"))

        val c1 = binding.issueChallenge(orgA, now = 100L, lifetimeSeconds = 30L)
        binding.verifyAssertion(orgA, c1, signAssertion(ecKeyPair, c1, counter = 5L, flags = 0x05), now = 101L)

        val c2 = binding.issueChallenge(orgA, now = 102L, lifetimeSeconds = 30L)
        // Stale non-zero counter <= 5 must refuse as REPLAY.
        try {
            binding.verifyAssertion(orgA, c2, signAssertion(ecKeyPair, c2, counter = 5L, flags = 0x05), now = 103L)
            fail("Expected stale signCount refusal")
        } catch (failure: PasskeyBindingFailure) {
            assertEquals(PasskeyBindingError.REPLAY, failure.reason)
        }

        // Wrong org refuses.
        try {
            binding.verifyAssertion(orgB, c2, signAssertion(ecKeyPair, c2, counter = 6L, flags = 0x05), now = 103L)
            fail("Expected org mismatch refusal")
        } catch (failure: PasskeyBindingFailure) {
            assertEquals(PasskeyBindingError.SCOPE_MISMATCH, failure.reason)
        }
    }
}
