package io.kodera.android.domain

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Signed plaintext wire protocol. Authentication does not provide confidentiality or delivery. */
enum class EmergencySafetyStatus(val wire: Int, val priority: Int) {
    MESSAGE_ONLY(0, 0), SAFE(1, 1), NEED_ASSISTANCE(2, 3), MUSTER_POINT(3, 2);
    companion object {
        fun fromWire(value: Int): EmergencySafetyStatus = entries.firstOrNull { it.wire == value }
            ?: throw EmergencyFailure(EmergencyError.MALFORMED_FRAME)
    }
}

enum class EmergencyError { MALFORMED_FRAME, INVALID_ID, INVALID_TTL, TEXT_TOO_LONG, UNAUTHORIZED,
    INVALID_SIGNATURE, CRYPTO_UNAVAILABLE, INVALID_BEACON, REPLAY, QUEUE_FULL, OUT_OF_ORDER, FUTURE_FRAME }

/**
 * The emergency v1 bounds and clock rule, shared with `kodera-rs` through
 * `packages/kodera-rs/vectors/emergency-v1-rules.txt`, which the tests read.
 */
object EmergencyBounds {
    const val QUEUE_CAPACITY = 128
    const val ROSTER_MEMBERS = 4096
    const val REPLAY_ENTRIES = 4096
    const val MAX_FUTURE_SKEW_MS = 300_000L

    fun currentUnixMillis(): Long = System.currentTimeMillis().coerceAtLeast(0L)
    fun currentUnixSeconds(): Long = (System.currentTimeMillis() / 1000L).coerceAtLeast(0L)

    /** True when the frame's UUIDv7 time is more than the skew bound ahead of the verifier's clock. */
    @JvmOverloads
    fun isTooFarAhead(frameTimestampMillis: Long, nowMillis: Long = currentUnixMillis()): Boolean =
        nowMillis <= Long.MAX_VALUE - MAX_FUTURE_SKEW_MS && frameTimestampMillis > nowMillis + MAX_FUTURE_SKEW_MS
}
class EmergencyFailure(val reason: EmergencyError) : Exception(reason.name)

class EmergencyMessageId private constructor(private val raw: ByteArray) : Comparable<EmergencyMessageId> {
    fun bytes(): ByteArray = raw.copyOf()
    val timestampMillis: Long get() = raw.take(6).fold(0L) { value, byte -> (value shl 8) or (byte.toLong() and 255) }
    override fun compareTo(other: EmergencyMessageId): Int {
        for (index in raw.indices) {
            val difference = (raw[index].toInt() and 255) - (other.raw[index].toInt() and 255)
            if (difference != 0) return difference
        }
        return 0
    }
    override fun equals(other: Any?) = other is EmergencyMessageId && raw.contentEquals(other.raw)
    override fun hashCode() = raw.contentHashCode()
    override fun toString() = encodeEmergencyHex(raw)
    companion object {
        fun fromBytes(value: ByteArray): EmergencyMessageId {
            if (value.size != 16 || (value[6].toInt() and 0xf0) != 0x70 || (value[8].toInt() and 0xc0) != 0x80)
                throw EmergencyFailure(EmergencyError.INVALID_ID)
            return EmergencyMessageId(value.copyOf())
        }
        fun fromParts(timestampMillis: Long, randomness: ByteArray): EmergencyMessageId {
            require(timestampMillis in 0..0xffffffffffffL && randomness.size == 10)
            val bytes = ByteBuffer.allocate(8).putLong(timestampMillis).array().copyOfRange(2, 8) + randomness
            bytes[6] = ((bytes[6].toInt() and 15) or 0x70).toByte()
            bytes[8] = ((bytes[8].toInt() and 63) or 0x80).toByte()
            return fromBytes(bytes)
        }
    }
}

class EmergencyPublicKey(value: ByteArray) {
    init { require(value.size == 32) }
    private val raw = value.copyOf()
    fun bytes() = raw.copyOf()
    override fun equals(other: Any?) = other is EmergencyPublicKey && raw.contentEquals(other.raw)
    override fun hashCode() = raw.contentHashCode()
    override fun toString() = encodeEmergencyHex(raw)
}

interface EmergencySigner {
    val publicKey: EmergencyPublicKey
    fun sign(transcript: ByteArray): ByteArray
}
fun interface EmergencySignatureVerifier {
    fun verify(publicKey: EmergencyPublicKey, transcript: ByteArray, signature: ByteArray): Boolean
}

/** The production verifier: the platform provider where it has Ed25519, the bundled implementation below API 33. */
object Ed25519EmergencyVerifier : EmergencySignatureVerifier by Ed25519SignatureVerifier()

class VerifiedEmergencyFrame internal constructor(val frame: EmergencyFrame)

class EmergencyFrame private constructor(
    val messageId: EmergencyMessageId, val senderPublicKey: EmergencyPublicKey,
    val ttlHops: Int, val status: EmergencySafetyStatus, val text: String, signature: ByteArray,
) {
    private val signatureBytes = signature.copyOf()
    fun signature() = signatureBytes.copyOf()
    fun signingTranscript(): ByteArray = PREFIX + messageId.bytes() + senderPublicKey.bytes() +
        byteArrayOf(status.wire.toByte(), text.toByteArray(Charsets.UTF_8).size.toByte()) + text.toByteArray(Charsets.UTF_8)
    fun encode(): ByteArray = byteArrayOf(0x4b, 0x45, 1) + messageId.bytes() + senderPublicKey.bytes() +
        byteArrayOf(ttlHops.toByte(), status.wire.toByte(), text.toByteArray(Charsets.UTF_8).size.toByte()) +
        text.toByteArray(Charsets.UTF_8) + signatureBytes
    fun decrementHop(): EmergencyFrame? = if (ttlHops <= 1) null else
        EmergencyFrame(messageId, senderPublicKey, ttlHops - 1, status, text, signatureBytes)
    fun verify(allowedRoster: Set<EmergencyPublicKey>, verifier: EmergencySignatureVerifier = Ed25519EmergencyVerifier): VerifiedEmergencyFrame {
        if (senderPublicKey !in allowedRoster) throw EmergencyFailure(EmergencyError.UNAUTHORIZED)
        if (!verifier.verify(senderPublicKey, signingTranscript(), signatureBytes.copyOf()))
            throw EmergencyFailure(EmergencyError.INVALID_SIGNATURE)
        return VerifiedEmergencyFrame(this)
    }
    companion object {
        const val MAX_TEXT_BYTES = 138
        const val MAX_WIRE_BYTES = 256
        private val PREFIX = "kodera-emergency-v1:".toByteArray(Charsets.US_ASCII)
        fun signed(id: EmergencyMessageId, ttlHops: Int, status: EmergencySafetyStatus, text: String, signer: EmergencySigner): EmergencyFrame {
            validate(ttlHops, text)
            val unsigned = EmergencyFrame(id, signer.publicKey, ttlHops, status, text, ByteArray(64))
            val signature = try { signer.sign(unsigned.signingTranscript()) }
            catch (error: java.security.NoSuchAlgorithmException) { throw EmergencyFailure(EmergencyError.CRYPTO_UNAVAILABLE) }
            catch (error: java.security.GeneralSecurityException) { throw EmergencyFailure(EmergencyError.INVALID_SIGNATURE) }
            if (signature.size != 64) throw EmergencyFailure(EmergencyError.INVALID_SIGNATURE)
            return EmergencyFrame(id, unsigned.senderPublicKey, ttlHops, status, text, signature)
        }
        fun decode(input: ByteArray): EmergencyFrame {
            if (input.size !in 118..MAX_WIRE_BYTES) throw EmergencyFailure(EmergencyError.MALFORMED_FRAME)
            val raw = input.copyOf()
            if ( raw[0] != 0x4b.toByte() || raw[1] != 0x45.toByte() || raw[2] != 1.toByte())
                throw EmergencyFailure(EmergencyError.MALFORMED_FRAME)
            val id = EmergencyMessageId.fromBytes(raw.copyOfRange(3, 19))
            val ttl = raw[51].toInt() and 255
            if (ttl !in 1..6) throw EmergencyFailure(EmergencyError.INVALID_TTL)
            val status = EmergencySafetyStatus.fromWire(raw[52].toInt() and 255)
            val size = raw[53].toInt() and 255
            if (size > MAX_TEXT_BYTES || raw.size != 118 + size) throw EmergencyFailure(EmergencyError.MALFORMED_FRAME)
            val text = try { Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(raw, 54, size)).toString()
            } catch (error: java.nio.charset.CharacterCodingException) { throw EmergencyFailure(EmergencyError.MALFORMED_FRAME) }
            return EmergencyFrame(id, EmergencyPublicKey(raw.copyOfRange(19, 51)), ttl, status, text, raw.copyOfRange(54 + size, raw.size))
        }
        private fun validate(ttl: Int, text: String) {
            if (ttl !in 1..6) throw EmergencyFailure(EmergencyError.INVALID_TTL)
            val encoded = text.toByteArray(Charsets.UTF_8)
            if (encoded.size > MAX_TEXT_BYTES) throw EmergencyFailure(EmergencyError.TEXT_TOO_LONG)
            // Reject unpaired UTF-16 surrogates rather than sign Java's replacement bytes.
            if (String(encoded, Charsets.UTF_8) != text) throw EmergencyFailure(EmergencyError.MALFORMED_FRAME)
        }
    }
}

class EmergencyReplayGuard(private val capacity: Int = 1024) {
    private val seen = java.util.TreeSet<EmergencyMessageId>()
    init { require(capacity in 1..EmergencyBounds.REPLAY_ENTRIES) }
    @Synchronized fun acceptOnce(frame: VerifiedEmergencyFrame): Boolean {
        val id = frame.frame.messageId
        if (id in seen) return false
        if (seen.size == capacity) seen.pollFirst()
        return seen.add(id)
    }
    @Synchronized fun contains(id: EmergencyMessageId) = id in seen
}

object ProximityBeacon {
    fun compute(salt: ByteArray, unixSeconds: Long): ByteArray {
        require(salt.size == 32 && unixSeconds >= 0)
        val message = "kodera-beacon-v1".toByteArray(Charsets.US_ASCII) + ByteBuffer.allocate(8).putLong(unixSeconds / 300).array()
        return try { Mac.getInstance("HmacSHA256").run { init(SecretKeySpec(salt.copyOf(), "HmacSHA256")); doFinal(message).copyOf(8) } }
        catch (error: java.security.GeneralSecurityException) { throw EmergencyFailure(EmergencyError.CRYPTO_UNAVAILABLE) }
    }
    fun matches(salt: ByteArray, observed: ByteArray, unixSeconds: Long): Boolean {
        require(unixSeconds >= 0)
        if (observed.size != 8) return false
        val bucket = unixSeconds / 300
        return listOf(bucket, if (bucket > 0) bucket - 1 else bucket, if (bucket < Long.MAX_VALUE / 300) bucket + 1 else bucket)
            .any { MessageDigest.isEqual(observed, compute(salt, it * 300)) }
    }
}
fun encodeEmergencyHex(raw: ByteArray): String = raw.joinToString("") { "%02x".format(it.toInt() and 255) }
fun decodeEmergencyHex(text: String): ByteArray {
    require(text.length % 2 == 0 && text.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' })
    return ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
