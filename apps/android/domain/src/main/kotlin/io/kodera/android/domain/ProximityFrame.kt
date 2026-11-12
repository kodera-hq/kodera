package io.kodera.android.domain

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

// The `#proximity` frame v1 codec. The channel was first named `#urgence` and this frame "emergency frame v1".
//
// FROZEN v1 WIRE FORMAT. The header bytes `4b 45 01` (ASCII "KE", version 1), the field layout and the signed
// label `kodera-emergency-v1:` are bytes that deployed peers sign and verify. They keep their historical value,
// old word included. Changing any of them is a new protocol version, never a rename.
// `packages/kodera-rs/vectors/proximity-frame-v1.txt` pins them and the tests read it.

/** Signed plaintext wire protocol. Authentication does not provide confidentiality or delivery. */
enum class ProximitySafetyStatus(val wire: Int, val priority: Int) {
    MESSAGE_ONLY(0, 0), SAFE(1, 1), NEED_ASSISTANCE(2, 3), MUSTER_POINT(3, 2);
    companion object {
        fun fromWire(value: Int): ProximitySafetyStatus = entries.firstOrNull { it.wire == value }
            ?: throw ProximityFailure(ProximityError.MALFORMED_FRAME)
    }
}

enum class ProximityError { MALFORMED_FRAME, INVALID_ID, INVALID_TTL, TEXT_TOO_LONG, UNAUTHORIZED,
    INVALID_SIGNATURE, CRYPTO_UNAVAILABLE, INVALID_BEACON, REPLAY, QUEUE_FULL, OUT_OF_ORDER, FUTURE_FRAME,
    INVALID_HANDLE }

/**
 * The proximity v1 bounds and clock rule, shared with `kodera-rs` through
 * `packages/kodera-rs/vectors/emergency-v1-rules.txt` (a path kept under its first name), which the tests read.
 */
object ProximityBounds {
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
class ProximityFailure(val reason: ProximityError) : Exception(reason.name)

class ProximityMessageId private constructor(private val raw: ByteArray) : Comparable<ProximityMessageId> {
    fun bytes(): ByteArray = raw.copyOf()
    val timestampMillis: Long get() = raw.take(6).fold(0L) { value, byte -> (value shl 8) or (byte.toLong() and 255) }
    override fun compareTo(other: ProximityMessageId): Int {
        for (index in raw.indices) {
            val difference = (raw[index].toInt() and 255) - (other.raw[index].toInt() and 255)
            if (difference != 0) return difference
        }
        return 0
    }
    override fun equals(other: Any?) = other is ProximityMessageId && raw.contentEquals(other.raw)
    override fun hashCode() = raw.contentHashCode()
    override fun toString() = encodeProximityHex(raw)
    companion object {
        fun fromBytes(value: ByteArray): ProximityMessageId {
            if (value.size != 16 || (value[6].toInt() and 0xf0) != 0x70 || (value[8].toInt() and 0xc0) != 0x80)
                throw ProximityFailure(ProximityError.INVALID_ID)
            return ProximityMessageId(value.copyOf())
        }
        fun fromParts(timestampMillis: Long, randomness: ByteArray): ProximityMessageId {
            require(timestampMillis in 0..0xffffffffffffL && randomness.size == 10)
            val bytes = ByteBuffer.allocate(8).putLong(timestampMillis).array().copyOfRange(2, 8) + randomness
            bytes[6] = ((bytes[6].toInt() and 15) or 0x70).toByte()
            bytes[8] = ((bytes[8].toInt() and 63) or 0x80).toByte()
            return fromBytes(bytes)
        }
    }
}

class ProximityPublicKey(value: ByteArray) {
    init { require(value.size == 32) }
    private val raw = value.copyOf()
    fun bytes() = raw.copyOf()
    override fun equals(other: Any?) = other is ProximityPublicKey && raw.contentEquals(other.raw)
    override fun hashCode() = raw.contentHashCode()
    override fun toString() = encodeProximityHex(raw)
}

interface ProximitySigner {
    val publicKey: ProximityPublicKey
    fun sign(transcript: ByteArray): ByteArray
}
fun interface ProximitySignatureVerifier {
    fun verify(publicKey: ProximityPublicKey, transcript: ByteArray, signature: ByteArray): Boolean
}

/** The production verifier: the platform provider where it has Ed25519, the bundled implementation below API 33. */
object Ed25519ProximityVerifier : ProximitySignatureVerifier by Ed25519SignatureVerifier()

class VerifiedProximityFrame internal constructor(val frame: ProximityFrame)

class ProximityFrame private constructor(
    val messageId: ProximityMessageId, val senderPublicKey: ProximityPublicKey,
    val ttlHops: Int, val status: ProximitySafetyStatus, val text: String, signature: ByteArray,
) {
    private val signatureBytes = signature.copyOf()
    fun signature() = signatureBytes.copyOf()
    fun signingTranscript(): ByteArray = PREFIX + messageId.bytes() + senderPublicKey.bytes() +
        byteArrayOf(status.wire.toByte(), text.toByteArray(Charsets.UTF_8).size.toByte()) + text.toByteArray(Charsets.UTF_8)
    fun encode(): ByteArray = byteArrayOf(0x4b, 0x45, 1) + messageId.bytes() + senderPublicKey.bytes() +
        byteArrayOf(ttlHops.toByte(), status.wire.toByte(), text.toByteArray(Charsets.UTF_8).size.toByte()) +
        text.toByteArray(Charsets.UTF_8) + signatureBytes
    fun decrementHop(): ProximityFrame? = if (ttlHops <= 1) null else
        ProximityFrame(messageId, senderPublicKey, ttlHops - 1, status, text, signatureBytes)
    fun verify(allowedRoster: Set<ProximityPublicKey>, verifier: ProximitySignatureVerifier = Ed25519ProximityVerifier): VerifiedProximityFrame {
        if (senderPublicKey !in allowedRoster) throw ProximityFailure(ProximityError.UNAUTHORIZED)
        if (!verifier.verify(senderPublicKey, signingTranscript(), signatureBytes.copyOf()))
            throw ProximityFailure(ProximityError.INVALID_SIGNATURE)
        return VerifiedProximityFrame(this)
    }
    companion object {
        const val MAX_TEXT_BYTES = 138
        const val MAX_WIRE_BYTES = 256
        // Frozen signed label: the historical word stays (see the note at the top of this file).
        private val PREFIX = "kodera-emergency-v1:".toByteArray(Charsets.US_ASCII)
        fun signed(id: ProximityMessageId, ttlHops: Int, status: ProximitySafetyStatus, text: String, signer: ProximitySigner): ProximityFrame {
            validate(ttlHops, text)
            val unsigned = ProximityFrame(id, signer.publicKey, ttlHops, status, text, ByteArray(64))
            val signature = try { signer.sign(unsigned.signingTranscript()) }
            catch (error: java.security.NoSuchAlgorithmException) { throw ProximityFailure(ProximityError.CRYPTO_UNAVAILABLE) }
            catch (error: java.security.GeneralSecurityException) { throw ProximityFailure(ProximityError.INVALID_SIGNATURE) }
            if (signature.size != 64) throw ProximityFailure(ProximityError.INVALID_SIGNATURE)
            return ProximityFrame(id, unsigned.senderPublicKey, ttlHops, status, text, signature)
        }
        fun decode(input: ByteArray): ProximityFrame {
            if (input.size !in 118..MAX_WIRE_BYTES) throw ProximityFailure(ProximityError.MALFORMED_FRAME)
            val raw = input.copyOf()
            if ( raw[0] != 0x4b.toByte() || raw[1] != 0x45.toByte() || raw[2] != 1.toByte())
                throw ProximityFailure(ProximityError.MALFORMED_FRAME)
            val id = ProximityMessageId.fromBytes(raw.copyOfRange(3, 19))
            val ttl = raw[51].toInt() and 255
            if (ttl !in 1..6) throw ProximityFailure(ProximityError.INVALID_TTL)
            val status = ProximitySafetyStatus.fromWire(raw[52].toInt() and 255)
            val size = raw[53].toInt() and 255
            if (size > MAX_TEXT_BYTES || raw.size != 118 + size) throw ProximityFailure(ProximityError.MALFORMED_FRAME)
            val text = try { Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(raw, 54, size)).toString()
            } catch (error: java.nio.charset.CharacterCodingException) { throw ProximityFailure(ProximityError.MALFORMED_FRAME) }
            return ProximityFrame(id, ProximityPublicKey(raw.copyOfRange(19, 51)), ttl, status, text, raw.copyOfRange(54 + size, raw.size))
        }
        private fun validate(ttl: Int, text: String) {
            if (ttl !in 1..6) throw ProximityFailure(ProximityError.INVALID_TTL)
            val encoded = text.toByteArray(Charsets.UTF_8)
            if (encoded.size > MAX_TEXT_BYTES) throw ProximityFailure(ProximityError.TEXT_TOO_LONG)
            // Reject unpaired UTF-16 surrogates rather than sign Java's replacement bytes.
            if (String(encoded, Charsets.UTF_8) != text) throw ProximityFailure(ProximityError.MALFORMED_FRAME)
        }
    }
}

class ProximityReplayGuard(private val capacity: Int = 1024) {
    private val seen = java.util.TreeSet<ProximityMessageId>()
    init { require(capacity in 1..ProximityBounds.REPLAY_ENTRIES) }
    @Synchronized fun acceptOnce(frame: VerifiedProximityFrame): Boolean {
        val id = frame.frame.messageId
        if (id in seen) return false
        if (seen.size == capacity) seen.pollFirst()
        return seen.add(id)
    }
    @Synchronized fun contains(id: ProximityMessageId) = id in seen
}

object ProximityBeacon {
    fun compute(salt: ByteArray, unixSeconds: Long): ByteArray {
        require(salt.size == 32 && unixSeconds >= 0)
        val message = "kodera-beacon-v1".toByteArray(Charsets.US_ASCII) + ByteBuffer.allocate(8).putLong(unixSeconds / 300).array()
        return try { Mac.getInstance("HmacSHA256").run { init(SecretKeySpec(salt.copyOf(), "HmacSHA256")); doFinal(message).copyOf(8) } }
        catch (error: java.security.GeneralSecurityException) { throw ProximityFailure(ProximityError.CRYPTO_UNAVAILABLE) }
    }
    fun matches(salt: ByteArray, observed: ByteArray, unixSeconds: Long): Boolean {
        require(unixSeconds >= 0)
        if (observed.size != 8) return false
        val bucket = unixSeconds / 300
        return listOf(bucket, if (bucket > 0) bucket - 1 else bucket, if (bucket < Long.MAX_VALUE / 300) bucket + 1 else bucket)
            .any { MessageDigest.isEqual(observed, compute(salt, it * 300)) }
    }
}
fun encodeProximityHex(raw: ByteArray): String = raw.joinToString("") { "%02x".format(it.toInt() and 255) }
fun decodeProximityHex(text: String): ByteArray {
    require(text.length % 2 == 0 && text.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' })
    return ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
