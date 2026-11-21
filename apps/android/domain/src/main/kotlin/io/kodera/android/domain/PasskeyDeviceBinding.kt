package io.kodera.android.domain

import java.math.BigInteger
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.AlgorithmParameters
import java.security.GeneralSecurityException
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.PublicKey
import java.security.SecureRandom
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.util.Base64

enum class PasskeyBindingError {
    INVALID_INPUT,
    SCOPE_MISMATCH,
    EPOCH_MISMATCH,
    CAPACITY,
    REPLAY,
    AUTHENTICATION_FAILED,
}

class PasskeyBindingFailure(val reason: PasskeyBindingError) : Exception(reason.name)

/**
 * Backup flag policy for WebAuthn Level 3 §6.5 assertion & registration flags.
 *
 * - [UNIVERSAL] (default): Supports hardware-bound FIDO2 keys (`0x05`), platform biometric /
 *   Google Password Manager passkeys (`0x0D` / `0x1D`), and self-hosted Bitwarden / Vaultwarden
 *   `"Citadel"` passkeys (`0x0D` / `0x1D`) with zero AAGUID lock-in, while rejecting invalid
 *   `BS=1, BE=0` (`0x15`) combinations.
 * - [STRICT_NON_BACKUPABLE]:additionally requires `(flags & 0x18) == 0` (`0x05`).
 */
enum class PasskeyBackupPolicy {
    UNIVERSAL,
    STRICT_NON_BACKUPABLE,
}

enum class PasskeyResidencyPosture {
    SINGLE_DEVICE_BOUND,
    BACKUP_ELIGIBLE_LOCAL,
    MULTI_DEVICE_SYNCED,
}

/** Sensitive 256-bit WebAuthn challenge bound to a single organisation and expiry epoch. */
class PasskeyChallenge internal constructor(
    val organisationId: String,
    private val nonceBytes: ByteArray,
    val expiresAt: Long,
) {
    fun bytes(): ByteArray = nonceBytes.copyOf()

    val base64Url: String get() = PasskeyBase64Url.encodeUnpadded(nonceBytes)

    override fun equals(other: Any?): Boolean =
        other is PasskeyChallenge &&
            organisationId == other.organisationId &&
            expiresAt == other.expiresAt &&
            MessageDigest.isEqual(nonceBytes, other.nonceBytes)

    override fun hashCode(): Int {
        var result = organisationId.hashCode()
        result = 31 * result + nonceBytes.contentHashCode()
        result = 31 * result + expiresAt.hashCode()
        return result
    }

    override fun toString(): String = "PasskeyChallenge([redacted])"
}

/** Raw WebAuthn / Android `CredentialManager` assertion response. */
class PasskeyAssertion(
    keyHandleId: ByteArray,
    clientDataJson: ByteArray,
    authenticatorData: ByteArray,
    signatureDer: ByteArray,
) {
    private val rawKeyHandleId = keyHandleId.copyOf()
    private val rawClientDataJson = clientDataJson.copyOf()
    private val rawAuthenticatorData = authenticatorData.copyOf()
    private val rawSignatureDer = signatureDer.copyOf()

    fun keyHandleIdBytes(): ByteArray = rawKeyHandleId.copyOf()
    fun clientDataJsonBytes(): ByteArray = rawClientDataJson.copyOf()
    fun authenticatorDataBytes(): ByteArray = rawAuthenticatorData.copyOf()
    fun signatureDerBytes(): ByteArray = rawSignatureDer.copyOf()

    override fun toString(): String = "PasskeyAssertion([redacted])"
}

/** Raw WebAuthn / Android `CredentialManager` registration response (`webauthn.create`). */
class PasskeyRegistrationResponse(
    clientDataJson: ByteArray,
    authenticatorData: ByteArray,
) {
    private val rawClientDataJson = clientDataJson.copyOf()
    private val rawAuthenticatorData = authenticatorData.copyOf()

    fun clientDataJsonBytes(): ByteArray = rawClientDataJson.copyOf()
    fun authenticatorDataBytes(): ByteArray = rawAuthenticatorData.copyOf()

    override fun toString(): String = "PasskeyRegistrationResponse([redacted])"
}

/** Verified ES256 (`COSE` alg `-7`, NIST P-256) registration record with zero AAGUID lock-in. */
class VerifiedPasskeyRegistration internal constructor(
    val binding: PasskeyDeviceBinding,
    val aaguidCanonical: String,
    val residencyPosture: PasskeyResidencyPosture,
) {
    val isZeroAaguid: Boolean get() = aaguidCanonical == ZERO_AAGUID

    override fun toString(): String = "VerifiedPasskeyRegistration([redacted])"

    companion object {
        const val ZERO_AAGUID: String = "00000000-0000-0000-0000-000000000000"
    }
}

/**
 * Universal ES256 (`P-256`, COSE alg `-7`) WebAuthn / Android `CredentialManager` passkey verifier
 * and device-key binding coordinator with zero AAGUID lock-in.
 */
class PasskeyDeviceBinding private constructor(
    val organisationId: String,
    val rpId: String,
    val origin: String,
    private val keyHandleId: ByteArray,
    private val verifyingKey: PublicKey,
    val backupPolicy: PasskeyBackupPolicy,
    initialCounter: Long,
    val aaguidCanonical: String?,
) {
    private class ChallengeState(val expiresAt: Long, var used: Boolean)

    var lastCounter: Long = initialCounter
        private set
    var latestNow: Long = 0L
        private set
    var verifiedAssertionCount: Int = 0
        private set
    var lastResidencyPosture: PasskeyResidencyPosture? = null
        private set

    private val challenges = LinkedHashMap<String, ChallengeState>()
    private val secureRandom = SecureRandom()

    fun keyHandleIdBytes(): ByteArray = keyHandleId.copyOf()

    override fun toString(): String = "PasskeyDeviceBinding([redacted])"

    @Synchronized
    fun issueChallenge(
        organisationId: String,
        now: Long,
        lifetimeSeconds: Long,
    ): PasskeyChallenge {
        if (organisationId != this.organisationId) {
            throw PasskeyBindingFailure(PasskeyBindingError.SCOPE_MISMATCH)
        }
        if (now < 0L || now < latestNow) {
            throw PasskeyBindingFailure(PasskeyBindingError.EPOCH_MISMATCH)
        }
        if (lifetimeSeconds !in 1L..300L || now > Long.MAX_VALUE - lifetimeSeconds) {
            throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
        }
        val expiresAt = now + lifetimeSeconds
        val retained = challenges.values.count { it.expiresAt >= now }
        if (retained >= MAX_CHALLENGES) {
            throw PasskeyBindingFailure(PasskeyBindingError.CAPACITY)
        }
        val nonce = ByteArray(32)
        secureRandom.nextBytes(nonce)
        val encodedKey = PasskeyBase64Url.encodeUnpadded(nonce)
        if (challenges.containsKey(encodedKey)) {
            throw PasskeyBindingFailure(PasskeyBindingError.REPLAY)
        }
        challenges.entries.removeIf { it.value.expiresAt < now }
        challenges[encodedKey] = ChallengeState(expiresAt = expiresAt, used = false)
        latestNow = now
        return PasskeyChallenge(this.organisationId, nonce, expiresAt)
    }

    @Synchronized
    fun verifyAssertion(
        organisationId: String,
        challenge: PasskeyChallenge,
        assertion: PasskeyAssertion,
        now: Long,
    ): PasskeyResidencyPosture {
        if (organisationId != this.organisationId || challenge.organisationId != this.organisationId) {
            throw PasskeyBindingFailure(PasskeyBindingError.SCOPE_MISMATCH)
        }
        if (now < 0L || now < latestNow) {
            throw PasskeyBindingFailure(PasskeyBindingError.EPOCH_MISMATCH)
        }
        val challengeKey = challenge.base64Url
        val state = challenges[challengeKey]
            ?: throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
        if (state.used) {
            throw PasskeyBindingFailure(PasskeyBindingError.REPLAY)
        }
        latestNow = now
        if (now > state.expiresAt || state.expiresAt != challenge.expiresAt) {
            throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
        }

        val assertionKeyId = assertion.keyHandleIdBytes()
        val clientDataBytes = assertion.clientDataJsonBytes()
        val authData = assertion.authenticatorDataBytes()
        val sigDer = assertion.signatureDerBytes()

        if (!MessageDigest.isEqual(assertionKeyId, keyHandleId) ||
            clientDataBytes.isEmpty() ||
            clientDataBytes.size > 4096 ||
            authData.size !in 37..2048 ||
            sigDer.size !in 8..80
        ) {
            throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
        }

        val clientData = StrictWebAuthnClientData.parse(clientDataBytes)
        val decodedChallenge = PasskeyBase64Url.decodeUnpadded(clientData.challenge)
            ?: throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
        if (clientData.ceremony != "webauthn.get" ||
            clientData.origin != origin ||
            clientData.crossOrigin ||
            !MessageDigest.isEqual(decodedChallenge, challenge.bytes()) ||
            PasskeyBase64Url.encodeUnpadded(decodedChallenge) != clientData.challenge
        ) {
            throw PasskeyBindingFailure(PasskeyBindingError.SCOPE_MISMATCH)
        }

        val expectedRpHash = sha256(rpId.toByteArray(Charsets.UTF_8))
        if (!MessageDigest.isEqual(authData.copyOfRange(0, 32), expectedRpHash)) {
            throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
        }

        val flags = authData[32].toInt() and 0xFF
        val posture = validateAssertionFlags(flags, backupPolicy)
        val extensionSlice = authData.copyOfRange(37, authData.size)
        if ((flags and FLAG_ED) != 0) {
            StrictCborExtensionMap.validate(extensionSlice)
        } else if (extensionSlice.isNotEmpty()) {
            throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
        }

        val counter = readUnsignedBe32(authData, 33)
        if ((counter > 0L || lastCounter > 0L) && counter <= lastCounter) {
            throw PasskeyBindingFailure(PasskeyBindingError.REPLAY)
        }

        if (!P256CurveSupport.isValidCanonicalDerSignature(sigDer)) {
            throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
        }

        val signedPayload = authData + sha256(clientDataBytes)
        val signatureValid = try {
            val verifier = Signature.getInstance("SHA256withECDSA")
            verifier.initVerify(verifyingKey)
            verifier.update(signedPayload)
            verifier.verify(sigDer)
        } catch (_: GeneralSecurityException) {
            throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
        }
        if (!signatureValid) {
            throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
        }

        state.used = true
        lastCounter = counter
        verifiedAssertionCount += 1
        lastResidencyPosture = posture
        return posture
    }

    companion object {
        const val MAX_CHALLENGES: Int = 64
        private const val FLAG_UP: Int = 0x01
        private const val FLAG_UV: Int = 0x04
        private const val FLAG_BE: Int = 0x08
        private const val FLAG_BS: Int = 0x10
        private const val FLAG_AT: Int = 0x40
        private const val FLAG_ED: Int = 0x80
        private const val FLAG_RFU_MASK: Int = 0x22 // bits 1 (0x02) and 5 (0x20)

        fun isAdmittedOrigin(rpId: String, origin: String): Boolean {
            if (!TrustPolicy.validDNSName(rpId)) return false
            if (origin.isEmpty() || origin.toByteArray(Charsets.UTF_8).size > 512 || !TrustPolicy.isVisibleASCII(origin)) {
                return false
            }
            val httpsPrefix = "https://"
            if (origin.startsWith(httpsPrefix)) {
                val host = origin.substring(httpsPrefix.length)
                if (!TrustPolicy.validDNSName(host)) return false
                return host == rpId || host.endsWith(".$rpId")
            }
            val apkHashPrefix = "android:apk-key-hash:"
            if (origin.startsWith(apkHashPrefix)) {
                val hash = origin.substring(apkHashPrefix.length)
                val decoded = PasskeyBase64Url.decodeUnpadded(hash) ?: return false
                return decoded.size == 32 && PasskeyBase64Url.encodeUnpadded(decoded) == hash
            }
            return false
        }

        fun create(
            organisationId: String,
            rpId: String,
            origin: String,
            keyHandleId: ByteArray,
            publicSec1Key: ByteArray,
            backupPolicy: PasskeyBackupPolicy = PasskeyBackupPolicy.UNIVERSAL,
            aaguidCanonical: String? = null,
        ): PasskeyDeviceBinding {
            if (!TrustPolicy.canonicalNonNilUUID(organisationId) ||
                !TrustPolicy.validDNSName(rpId) ||
                !isAdmittedOrigin(rpId, origin) ||
                keyHandleId.isEmpty() ||
                keyHandleId.size > 1024 ||
                (publicSec1Key.size != 33 && publicSec1Key.size != 65)
            ) {
                throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }
            if (aaguidCanonical != null && !TrustPolicy.canonicalUUID(aaguidCanonical)) {
                throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }
            val verifyingKey = P256CurveSupport.parseSec1PublicKey(publicSec1Key)
            return PasskeyDeviceBinding(
                organisationId = organisationId,
                rpId = rpId,
                origin = origin,
                keyHandleId = keyHandleId.copyOf(),
                verifyingKey = verifyingKey,
                backupPolicy = backupPolicy,
                initialCounter = 0L,
                aaguidCanonical = aaguidCanonical,
            )
        }

        /**
         * Verifies an attested WebAuthn / Android `CredentialManager` ES256 registration (`webauthn.create`)
         * with ZERO AAGUID lock-in: accepts `00000000-0000-0000-0000-000000000000` (Vaultwarden / Bitwarden
         * `"Citadel"` software passkeys and privacy-redacted authenticators), Android Keystore / Google
         * Password Manager platform passkeys, and hardware FIDO2 security keys alike.
         */
        fun verifyRegistration(
            organisationId: String,
            rpId: String,
            origin: String,
            expectedChallengeBytes: ByteArray,
            response: PasskeyRegistrationResponse,
            backupPolicy: PasskeyBackupPolicy = PasskeyBackupPolicy.UNIVERSAL,
        ): VerifiedPasskeyRegistration {
            if (!TrustPolicy.canonicalNonNilUUID(organisationId) ||
                !TrustPolicy.validDNSName(rpId) ||
                !isAdmittedOrigin(rpId, origin) ||
                expectedChallengeBytes.size != 32
            ) {
                throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }

            val clientDataBytes = response.clientDataJsonBytes()
            val authData = response.authenticatorDataBytes()
            if (clientDataBytes.isEmpty() || clientDataBytes.size > 4096 || authData.size < 56 || authData.size > 4096) {
                throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }

            val clientData = StrictWebAuthnClientData.parse(clientDataBytes)
            val decodedChallenge = PasskeyBase64Url.decodeUnpadded(clientData.challenge)
                ?: throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
            if (clientData.ceremony != "webauthn.create" ||
                clientData.origin != origin ||
                clientData.crossOrigin ||
                !MessageDigest.isEqual(decodedChallenge, expectedChallengeBytes) ||
                PasskeyBase64Url.encodeUnpadded(decodedChallenge) != clientData.challenge
            ) {
                throw PasskeyBindingFailure(PasskeyBindingError.SCOPE_MISMATCH)
            }

            val expectedRpHash = sha256(rpId.toByteArray(Charsets.UTF_8))
            if (!MessageDigest.isEqual(authData.copyOfRange(0, 32), expectedRpHash)) {
                throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
            }

            val flags = authData[32].toInt() and 0xFF
            val posture = validateRegistrationFlags(flags, backupPolicy)
            val initialCounter = readUnsignedBe32(authData, 33)

            // Bytes 37..53: 16-byte AAGUID — parsed as canonical UUID with zero vendor allowlist/blocklist lock-in.
            val aaguidCanonical = formatUuidBytes(authData.copyOfRange(37, 53))

            val keyHandleLen = ((authData[53].toInt() and 0xFF) shl 8) or (authData[54].toInt() and 0xFF)
            if (keyHandleLen !in 1..1024 || 55 + keyHandleLen >= authData.size) {
                throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }
            val keyHandleId = authData.copyOfRange(55, 55 + keyHandleLen)
            val coseAndExtensions = authData.copyOfRange(55 + keyHandleLen, authData.size)
            val (uncompressedSec1, extensionSlice) = StrictCoseEs256Parser.parseUncompressedSec1AndRemainder(coseAndExtensions)
            if ((flags and FLAG_ED) != 0) {
                StrictCborExtensionMap.validate(extensionSlice)
            } else if (extensionSlice.isNotEmpty()) {
                throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }
            val verifyingKey = P256CurveSupport.parseSec1PublicKey(uncompressedSec1)

            val binding = PasskeyDeviceBinding(
                organisationId = organisationId,
                rpId = rpId,
                origin = origin,
                keyHandleId = keyHandleId,
                verifyingKey = verifyingKey,
                backupPolicy = backupPolicy,
                initialCounter = initialCounter,
                aaguidCanonical = aaguidCanonical,
            ).also { it.lastResidencyPosture = posture }

            return VerifiedPasskeyRegistration(
                binding = binding,
                aaguidCanonical = aaguidCanonical,
                residencyPosture = posture,
            )
        }

        internal fun validateAssertionFlags(flags: Int, policy: PasskeyBackupPolicy): PasskeyResidencyPosture {
            // Require UP (0x01) and UV (0x04): (flags & 0x05) == 0x05
            if ((flags and (FLAG_UP or FLAG_UV)) != (FLAG_UP or FLAG_UV)) {
                throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
            }
            // Refuse RFU bits (0x02, 0x20) and AT (0x40); ED (0x80) is validated against CBOR extension bytes.
            if ((flags and (FLAG_RFU_MASK or FLAG_AT)) != 0) {
                throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
            }
            // WebAuthn Level 3 §6.5 invariant: BS=1 with BE=0 (0x10) is ALWAYS invalid.
            val backupBits = flags and (FLAG_BE or FLAG_BS)
            if (backupBits == FLAG_BS) {
                throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
            }
            if (policy == PasskeyBackupPolicy.STRICT_NON_BACKUPABLE && backupBits != 0) {
                throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
            }
            return residencyPostureFromBackupBits(backupBits)
        }

        private fun validateRegistrationFlags(flags: Int, policy: PasskeyBackupPolicy): PasskeyResidencyPosture {
            if ((flags and (FLAG_UP or FLAG_UV)) != (FLAG_UP or FLAG_UV)) {
                throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
            }
            if ((flags and FLAG_AT) != FLAG_AT) {
                throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
            }
            if ((flags and FLAG_RFU_MASK) != 0) {
                throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
            }
            val backupBits = flags and (FLAG_BE or FLAG_BS)
            if (backupBits == FLAG_BS) {
                throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
            }
            if (policy == PasskeyBackupPolicy.STRICT_NON_BACKUPABLE && backupBits != 0) {
                throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
            }
            return residencyPostureFromBackupBits(backupBits)
        }

        private fun residencyPostureFromBackupBits(backupBits: Int): PasskeyResidencyPosture = when (backupBits) {
            0 -> PasskeyResidencyPosture.SINGLE_DEVICE_BOUND
            FLAG_BE -> PasskeyResidencyPosture.BACKUP_ELIGIBLE_LOCAL
            else -> PasskeyResidencyPosture.MULTI_DEVICE_SYNCED
        }

        private fun readUnsignedBe32(bytes: ByteArray, offset: Int): Long =
            ((bytes[offset].toLong() and 0xFFL) shl 24) or
                ((bytes[offset + 1].toLong() and 0xFFL) shl 16) or
                ((bytes[offset + 2].toLong() and 0xFFL) shl 8) or
                (bytes[offset + 3].toLong() and 0xFFL)

        private fun formatUuidBytes(raw16: ByteArray): String {
            val hex = buildString(32) {
                for (b in raw16) {
                    val u = b.toInt() and 0xFF
                    append("0123456789abcdef"[u ushr 4])
                    append("0123456789abcdef"[u and 0x0F])
                }
            }
            return "${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}"
        }

        internal fun sha256(input: ByteArray): ByteArray =
            MessageDigest.getInstance("SHA-256").digest(input)
    }
}

/**
 * Pure-Kotlin JSON request builder for Android `CredentialManager` (`GetPublicKeyCredentialOption`),
 * keeping authenticator selection universal (`userVerification = "required"`, zero AAGUID filtering).
 */
object PasskeyCredentialManagerBridge {
    fun buildAssertionRequestJson(
        rpId: String,
        challenge: PasskeyChallenge,
        allowedKeyHandleIds: List<ByteArray>,
    ): String {
        if (!TrustPolicy.validDNSName(rpId) ||
            allowedKeyHandleIds.isEmpty() ||
            allowedKeyHandleIds.any { it.isEmpty() || it.size > 1024 }
        ) {
            throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
        }
        val descriptors = allowedKeyHandleIds.joinToString(",") { idBytes ->
            val encodedId = PasskeyBase64Url.encodeUnpadded(idBytes)
            """{"type":"public-key","id":"$encodedId"}"""
        }
        return """{"challenge":"${challenge.base64Url}","rpId":"$rpId","userVerification":"required","allowCredentials":[$descriptors]}"""
    }
}

internal object PasskeyBase64Url {
    private val encoder = Base64.getUrlEncoder().withoutPadding()
    private val decoder = Base64.getUrlDecoder()

    fun encodeUnpadded(bytes: ByteArray): String = encoder.encodeToString(bytes)

    fun decodeUnpadded(raw: String): ByteArray? {
        if (raw.isEmpty() || '=' in raw || '+' in raw || '/' in raw) return null
        val validAlphabet = raw.all { ch ->
            ch in '0'..'9' || ch in 'A'..'Z' || ch in 'a'..'z' || ch == '-' || ch == '_'
        }
        if (!validAlphabet || raw.length % 4 == 1) return null
        return try {
            decoder.decode(raw)
        } catch (_: IllegalArgumentException) {
            null
        }
    }
}

private object P256CurveSupport {
    private val P = BigInteger("FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF", 16)
    private val A = P.subtract(BigInteger.valueOf(3))
    private val B = BigInteger("5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B", 16)
    private val ORDER = BigInteger("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16)
    private val SQRT_EXP = P.add(BigInteger.ONE).shiftRight(2) // (p + 1) / 4 since p ≡ 3 (mod 4)

    private val ecParameterSpec: ECParameterSpec by lazy {
        val params = AlgorithmParameters.getInstance("EC")
        params.init(ECGenParameterSpec("secp256r1"))
        params.getParameterSpec(ECParameterSpec::class.java)
    }

    fun parseSec1PublicKey(sec1: ByteArray): PublicKey {
        val point: ECPoint = when (sec1.size) {
            65 -> {
                if (sec1[0] != 0x04.toByte()) {
                    throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                }
                val x = BigInteger(1, sec1.copyOfRange(1, 33))
                val y = BigInteger(1, sec1.copyOfRange(33, 65))
                if (!isOnCurve(x, y)) {
                    throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                }
                ECPoint(x, y)
            }
            33 -> {
                val prefix = sec1[0].toInt() and 0xFF
                if (prefix != 0x02 && prefix != 0x03) {
                    throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                }
                val x = BigInteger(1, sec1.copyOfRange(1, 33))
                if (x < BigInteger.ZERO || x >= P) {
                    throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                }
                val rhs = x.modPow(BigInteger.valueOf(3), P)
                    .add(A.multiply(x))
                    .add(B)
                    .mod(P)
                val root = rhs.modPow(SQRT_EXP, P)
                if (root.modPow(BigInteger.TWO, P) != rhs) {
                    throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                }
                val wantOdd = prefix == 0x03
                if (root == BigInteger.ZERO && wantOdd) {
                    throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                }
                val y = if (root.testBit(0) == wantOdd) root else P.subtract(root)
                if (!isOnCurve(x, y)) {
                    throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                }
                ECPoint(x, y)
            }
            else -> throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
        }
        return try {
            KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, ecParameterSpec))
        } catch (_: GeneralSecurityException) {
            throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
        }
    }

    fun isOnCurve(x: BigInteger, y: BigInteger): Boolean {
        if (x < BigInteger.ZERO || x >= P || y < BigInteger.ZERO || y >= P) return false
        val lhs = y.modPow(BigInteger.TWO, P)
        val rhs = x.modPow(BigInteger.valueOf(3), P).add(A.multiply(x)).add(B).mod(P)
        return lhs == rhs
    }

    /** Enforces strict canonical ASN.1 DER encoding for P-256 ECDSA `(r, s)` signatures. */
    fun isValidCanonicalDerSignature(der: ByteArray): Boolean {
        if (der.size !in 8..72 || der[0] != 0x30.toByte()) return false
        val seqLen = der[1].toInt() and 0xFF
        if (seqLen >= 0x80 || seqLen + 2 != der.size) return false
        val rEnd = readDerPositiveInteger(der, 2) ?: return false
        val (rOffset, rLen, rValue) = rEnd
        val sStart = rOffset + rLen
        val sEnd = readDerPositiveInteger(der, sStart) ?: return false
        val (sOffset, sLen, sValue) = sEnd
        if (sOffset + sLen != der.size) return false
        return rValue >= BigInteger.ONE && rValue < ORDER && sValue >= BigInteger.ONE && sValue < ORDER
    }

    private fun readDerPositiveInteger(der: ByteArray, tagIndex: Int): Triple<Int, Int, BigInteger>? {
        if (tagIndex + 2 > der.size || der[tagIndex] != 0x02.toByte()) return null
        val len = der[tagIndex + 1].toInt() and 0xFF
        val valueStart = tagIndex + 2
        if (len !in 1..33 || valueStart + len > der.size) return null
        val first = der[valueStart].toInt() and 0xFF
        // Must be positive in two's complement and minimally padded.
        if ((first and 0x80) != 0) return null
        if (first == 0 && (len == 1 || (der[valueStart + 1].toInt() and 0x80) == 0)) return null
        val value = BigInteger(1, der.copyOfRange(valueStart, valueStart + len))
        return Triple(valueStart, len, value)
    }
}

/**
 * Minimal strict CBOR parser for COSE_Key EC2 ES256 (`{1: 2, 3: -7, -1: 1, -2: x(32B), -3: y(32B)}`).
 * Rejects trailing bytes, duplicate labels, unknown labels, or non-ES256 parameters.
 */
private object StrictCoseEs256Parser {
    fun parseUncompressedSec1AndRemainder(coseBytes: ByteArray): Pair<ByteArray, ByteArray> {
        val cursor = CborCursor(coseBytes)
        val entryCount = cursor.readMapHeader()
        if (entryCount != 5) {
            throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
        }
        val seenLabels = HashSet<Int>()
        var kty: Int? = null
        var alg: Int? = null
        var crv: Int? = null
        var xCoord: ByteArray? = null
        var yCoord: ByteArray? = null

        repeat(entryCount) {
            val label = cursor.readSmallInt()
            if (!seenLabels.add(label)) {
                throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }
            when (label) {
                1 -> kty = cursor.readSmallInt()
                3 -> alg = cursor.readSmallInt()
                -1 -> crv = cursor.readSmallInt()
                -2 -> xCoord = cursor.readByteString(expectedLength = 32)
                -3 -> yCoord = cursor.readByteString(expectedLength = 32)
                else -> throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }
        }
        if (kty != 2 || alg != -7 || crv != 1 || xCoord == null || yCoord == null) {
            throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
        }
        return Pair(byteArrayOf(0x04) + xCoord + yCoord, cursor.remainingBytes())
    }

    private class CborCursor(private val bytes: ByteArray) {
        private var offset: Int = 0

        fun remainingBytes(): ByteArray = bytes.copyOfRange(offset, bytes.size)

        fun readMapHeader(): Int {
            val initial = nextByte()
            val major = initial ushr 5
            val info = initial and 0x1F
            if (major != 5 || info >= 24) {
                throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }
            return info
        }

        fun readSmallInt(): Int {
            val initial = nextByte()
            val major = initial ushr 5
            val info = initial and 0x1F
            val unsignedVal = when {
                info < 24 -> info
                info == 24 -> {
                    val next = nextByte()
                    if (next < 24) throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                    next
                }
                else -> throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }
            return when (major) {
                0 -> unsignedVal
                1 -> -1 - unsignedVal
                else -> throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }
        }

        fun readByteString(expectedLength: Int): ByteArray {
            val initial = nextByte()
            val major = initial ushr 5
            val info = initial and 0x1F
            if (major != 2) throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            val len = when {
                info < 24 -> info
                info == 24 -> {
                    val next = nextByte()
                    if (next < 24) throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                    next
                }
                else -> throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }
            if (len != expectedLength || offset + len > bytes.size) {
                throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }
            val slice = bytes.copyOfRange(offset, offset + len)
            offset += len
            return slice
        }

        private fun nextByte(): Int {
            if (offset >= bytes.size) throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            return bytes[offset++].toInt() and 0xFF
        }
    }
}

private object StrictCborExtensionMap {
    private const val MAX_EXTENSION_BYTES: Int = 2048
    private const val MAX_CBOR_DEPTH: Int = 4

    fun validate(bytes: ByteArray) {
        if (bytes.isEmpty() || bytes.size > MAX_EXTENSION_BYTES) {
            throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
        }
        val cursor = ExtensionCborCursor(bytes)
        val initial = cursor.peekByte()
        if ((initial ushr 5) != 5) {
            throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
        }
        val mapLen = cursor.readDefiniteLength()
        if (mapLen !in 1..32) {
            throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
        }
        repeat(mapLen) {
            cursor.skipItem(depth = 1)
            cursor.skipItem(depth = 1)
        }
        if (!cursor.isAtEnd()) {
            throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
        }
    }

    private class ExtensionCborCursor(private val bytes: ByteArray) {
        private var offset: Int = 0

        fun isAtEnd(): Boolean = offset == bytes.size

        fun peekByte(): Int {
            if (offset >= bytes.size) throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
            return bytes[offset].toInt() and 0xFF
        }

        private fun nextByte(): Int {
            val b = peekByte()
            offset++
            return b
        }

        fun readDefiniteLength(): Int {
            val initial = nextByte()
            return when (val info = initial and 0x1F) {
                in 0..23 -> info
                24 -> {
                    val v = nextByte()
                    if (v < 24) throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
                    v
                }
                25 -> {
                    val hi = nextByte()
                    val lo = nextByte()
                    val v = (hi shl 8) or lo
                    if (v < 256) throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
                    v
                }
                else -> throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
            }
        }

        fun skipItem(depth: Int) {
            if (depth > MAX_CBOR_DEPTH) {
                throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
            }
            val initial = peekByte()
            val major = initial ushr 5
            val info = initial and 0x1F
            when (major) {
                0, 1 -> {
                    nextByte()
                    val extra = when (info) {
                        in 0..23 -> 0
                        24 -> 1
                        25 -> 2
                        26 -> 4
                        27 -> 8
                        else -> throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
                    }
                    if (offset + extra > bytes.size) {
                        throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
                    }
                    offset += extra
                }
                2 -> {
                    val len = readDefiniteLength()
                    if (offset + len > bytes.size) {
                        throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
                    }
                    offset += len
                }
                3 -> {
                    val len = readDefiniteLength()
                    if (offset + len > bytes.size) {
                        throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
                    }
                    try {
                        Charsets.UTF_8.newDecoder()
                            .onMalformedInput(CodingErrorAction.REPORT)
                            .onUnmappableCharacter(CodingErrorAction.REPORT)
                            .decode(ByteBuffer.wrap(bytes, offset, len))
                    } catch (_: java.nio.charset.CharacterCodingException) {
                        throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
                    }
                    offset += len
                }
                4 -> {
                    if (depth == MAX_CBOR_DEPTH) {
                        throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
                    }
                    val len = readDefiniteLength()
                    if (len > 32) throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
                    repeat(len) { skipItem(depth + 1) }
                }
                5 -> {
                    if (depth == MAX_CBOR_DEPTH) {
                        throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
                    }
                    val len = readDefiniteLength()
                    if (len > 32) throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
                    repeat(len) {
                        skipItem(depth + 1)
                        skipItem(depth + 1)
                    }
                }
                7 -> {
                    if (info !in 20..22) {
                        throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
                    }
                    nextByte()
                }
                else -> throw PasskeyBindingFailure(PasskeyBindingError.AUTHENTICATION_FAILED)
            }
        }
    }
}

private class StrictWebAuthnClientData(
    val ceremony: String,
    val challenge: String,
    val origin: String,
    val crossOrigin: Boolean,
) {
    companion object {
        private const val MAX_JSON_DEPTH: Int = 4

        fun parse(bytes: ByteArray): StrictWebAuthnClientData {
            if (bytes.isEmpty() || bytes.size > 4096) {
                throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }
            val decoded = try {
                Charsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString()
            } catch (_: java.nio.charset.CharacterCodingException) {
                throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }
            return ClientDataCursor(decoded).parseTopObject()
        }
    }

    private class ClientDataCursor(private val text: String) {
        private var offset: Int = 0

        fun parseTopObject(): StrictWebAuthnClientData {
            skipWhitespace()
            expect('{')
            skipWhitespace()
            val seenKeys = HashSet<String>()
            var ceremony: String? = null
            var challenge: String? = null
            var origin: String? = null
            var crossOrigin = false

            if (!tryConsume('}')) {
                while (true) {
                    if (seenKeys.size >= 64) {
                        throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                    }
                    skipWhitespace()
                    val key = parseString()
                    if (!seenKeys.add(key)) {
                        throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                    }
                    skipWhitespace()
                    expect(':')
                    skipWhitespace()
                    when (key) {
                        "type" -> ceremony = parseString()
                        "challenge" -> challenge = parseString()
                        "origin" -> origin = parseString()
                        "crossOrigin" -> crossOrigin = parseBoolean()
                        else -> skipValue(depth = 1)
                    }
                    skipWhitespace()
                    if (tryConsume('}')) {
                        break
                    }
                    expect(',')
                }
            }
            skipWhitespace()
            if (offset != text.length) {
                throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }
            return StrictWebAuthnClientData(
                ceremony = ceremony ?: throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT),
                challenge = challenge ?: throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT),
                origin = origin ?: throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT),
                crossOrigin = crossOrigin,
            )
        }

        private fun skipWhitespace() {
            while (offset < text.length && (text[offset] == ' ' || text[offset] == '\t' || text[offset] == '\r' || text[offset] == '\n')) {
                offset++
            }
        }

        private fun parseBoolean(): Boolean {
            if (offset >= text.length) throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            return when (text[offset]) {
                't' -> {
                    expectLiteral("true")
                    true
                }
                'f' -> {
                    expectLiteral("false")
                    false
                }
                else -> throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }
        }

        private fun parseNumber() {
            tryConsume('-')
            if (offset >= text.length) throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            when (text[offset]) {
                '0' -> offset++
                in '1'..'9' -> {
                    offset++
                    while (offset < text.length && text[offset] in '0'..'9') offset++
                }
                else -> throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }
            if (tryConsume('.')) {
                if (offset >= text.length || text[offset] !in '0'..'9') {
                    throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                }
                while (offset < text.length && text[offset] in '0'..'9') offset++
            }
            if (offset < text.length && (text[offset] == 'e' || text[offset] == 'E')) {
                offset++
                if (offset < text.length && (text[offset] == '+' || text[offset] == '-')) offset++
                if (offset >= text.length || text[offset] !in '0'..'9') {
                    throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                }
                while (offset < text.length && text[offset] in '0'..'9') offset++
            }
        }

        private fun skipValue(depth: Int) {
            if (depth > MAX_JSON_DEPTH || offset >= text.length) {
                throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }
            when (text[offset]) {
                '"' -> {
                    parseString()
                }
                't' -> expectLiteral("true")
                'f' -> expectLiteral("false")
                'n' -> expectLiteral("null")
                '-', in '0'..'9' -> parseNumber()
                '[' -> {
                    if (depth == MAX_JSON_DEPTH) throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                    offset++
                    skipWhitespace()
                    if (tryConsume(']')) return
                    var count = 0
                    while (true) {
                        count++
                        if (count > 64) throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                        skipWhitespace()
                        skipValue(depth + 1)
                        skipWhitespace()
                        if (tryConsume(']')) return
                        expect(',')
                    }
                }
                '{' -> {
                    if (depth == MAX_JSON_DEPTH) throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                    offset++
                    skipWhitespace()
                    if (tryConsume('}')) return
                    val nestedKeys = HashSet<String>()
                    while (true) {
                        if (nestedKeys.size >= 64) throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                        skipWhitespace()
                        val k = parseString()
                        if (!nestedKeys.add(k)) throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                        skipWhitespace()
                        expect(':')
                        skipWhitespace()
                        skipValue(depth + 1)
                        skipWhitespace()
                        if (tryConsume('}')) return
                        expect(',')
                    }
                }
                else -> throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }
        }

        private fun parseString(): String {
            expect('"')
            val out = StringBuilder()
            while (offset < text.length) {
                val ch = text[offset++]
                if (ch == '"') {
                    val result = out.toString()
                    if (String(result.toByteArray(Charsets.UTF_8), Charsets.UTF_8) != result) {
                        throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                    }
                    return result
                }
                if (ch.code < 0x20) throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                if (ch == '\\') {
                    if (offset >= text.length) throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                    when (val esc = text[offset++]) {
                        '"', '\\', '/' -> out.append(esc)
                        'b' -> out.append('\b')
                        'f' -> out.append('\u000C')
                        'n' -> out.append('\n')
                        'r' -> out.append('\r')
                        't' -> out.append('\t')
                        'u' -> {
                            if (offset + 4 > text.length) {
                                throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                            }
                            val codeUnit = text.substring(offset, offset + 4).toIntOrNull(16)
                                ?: throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                            offset += 4
                            out.append(codeUnit.toChar())
                        }
                        else -> throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
                    }
                } else {
                    out.append(ch)
                }
            }
            throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
        }

        private fun expect(expected: Char) {
            if (offset >= text.length || text[offset] != expected) {
                throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }
            offset++
        }

        private fun tryConsume(expected: Char): Boolean {
            if (offset < text.length && text[offset] == expected) {
                offset++
                return true
            }
            return false
        }

        private fun expectLiteral(literal: String) {
            if (!text.startsWith(literal, offset)) {
                throw PasskeyBindingFailure(PasskeyBindingError.INVALID_INPUT)
            }
            offset += literal.length
        }
    }
}
