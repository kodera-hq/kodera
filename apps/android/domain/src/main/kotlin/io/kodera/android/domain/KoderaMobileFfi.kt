package io.kodera.android.domain

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.GeneralSecurityException
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

enum class KoderaMobileFfiError(val statusCode: Int) {
    INVALID_PACKET(1),
    INVALID_JSON(2),
    UNKNOWN_OPERATION(3),
    INVALID_INPUT(4),
    AUTHENTICATION_FAILED(5),
    REPLAY_DETECTED(6),
    STALE_EPOCH(7),
    ALGORITHM_MISMATCH(8),
    ORGANISATION_MISMATCH(9),
    CAPACITY_EXCEEDED(10),
    CLEARTEXT_FORBIDDEN(11),
    UNEXPECTED_FIELD(12),
    FEATURE_DISABLED(13),
}

class KoderaMobileFfiFailure(
    val reason: KoderaMobileFfiError,
    val detail: String? = null,
) : Exception(if (detail != null) "${reason.name}:$detail" else reason.name)

/** Fixed-capacity `64 KiB` packet mirroring `kodera_rs::mobile_ffi::KoderaFfiPacket`. */
class KoderaFfiPacket(
    payload: ByteArray = ByteArray(0),
    val status: Int = 0,
) {
    val len: Int
    private val bytes: ByteArray

    init {
        if (payload.size > CAPACITY) {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.CAPACITY_EXCEEDED)
        }
        len = payload.size
        bytes = payload.copyOf()
    }

    fun payloadBytes(): ByteArray = bytes.copyOf()

    companion object {
        const val CAPACITY: Int = 65_536
    }
}

/**
 * Injectable packet-dispatch seam matching `kodera_rs::mobile_ffi::PacketDispatcher` and
 * verified byte-for-byte against `packages/kodera-rs/vectors/mobile-ffi-v1.txt`.
 */
fun interface PacketDispatcher {
    fun dispatch(request: KoderaFfiPacket): KoderaFfiPacket

    fun invoke(request: KoderaFfiPacket): KoderaFfiPacket = dispatch(request)
}

typealias KoderaMobileFfiTransport = PacketDispatcher

/** RFC 9562 UUIDv7 identifier minting and validation matching `kodera_rs::UuidV7` byte-for-byte. */
class UuidV7Identifier private constructor(private val raw: ByteArray) : Comparable<UuidV7Identifier> {
    val timestampMs: Long
        get() = ((raw[0].toLong() and 0xFFL) shl 40) or
            ((raw[1].toLong() and 0xFFL) shl 32) or
            ((raw[2].toLong() and 0xFFL) shl 24) or
            ((raw[3].toLong() and 0xFFL) shl 16) or
            ((raw[4].toLong() and 0xFFL) shl 8) or
            (raw[5].toLong() and 0xFFL)

    fun bytes(): ByteArray = raw.copyOf()

    override fun compareTo(other: UuidV7Identifier): Int {
        for (i in 0 until 16) {
            val a = raw[i].toInt() and 0xFF
            val b = other.raw[i].toInt() and 0xFF
            if (a != b) return a.compareTo(b)
        }
        return 0
    }

    override fun equals(other: Any?): Boolean =
        other is UuidV7Identifier && raw.contentEquals(other.raw)

    override fun hashCode(): Int = raw.contentHashCode()

    override fun toString(): String {
        val hex = "0123456789abcdef"
        val out = StringBuilder(36)
        for (idx in 0 until 16) {
            if (idx == 4 || idx == 6 || idx == 8 || idx == 10) out.append('-')
            val b = raw[idx].toInt() and 0xFF
            out.append(hex[b ushr 4])
            out.append(hex[b and 0x0F])
        }
        return out.toString()
    }

    companion object {
        const val MAXIMUM_TIMESTAMP_MS: Long = 0x0000_FFFF_FFFF_FFFFL
        private val CSPRNG = SecureRandom()

        fun fromParts(unixTimestampMs: Long, randomBytes: ByteArray): UuidV7Identifier {
            if (unixTimestampMs < 0L || unixTimestampMs > MAXIMUM_TIMESTAMP_MS || randomBytes.size != 10) {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
            }
            val out = ByteArray(16)
            out[0] = ((unixTimestampMs ushr 40) and 0xFFL).toByte()
            out[1] = ((unixTimestampMs ushr 32) and 0xFFL).toByte()
            out[2] = ((unixTimestampMs ushr 24) and 0xFFL).toByte()
            out[3] = ((unixTimestampMs ushr 16) and 0xFFL).toByte()
            out[4] = ((unixTimestampMs ushr 8) and 0xFFL).toByte()
            out[5] = (unixTimestampMs and 0xFFL).toByte()
            out[6] = (0x70 or (randomBytes[0].toInt() and 0x0F)).toByte()
            out[7] = randomBytes[1]
            out[8] = (0x80 or (randomBytes[2].toInt() and 0x3F)).toByte()
            for (i in 0 until 7) {
                out[9 + i] = randomBytes[3 + i]
            }
            return UuidV7Identifier(out)
        }

        fun fromCheckedBytes(bytes: ByteArray): UuidV7Identifier {
            if (bytes.size != 16 ||
                ((bytes[6].toInt() ushr 4) and 0x0F) != 0x07 ||
                ((bytes[8].toInt() ushr 6) and 0x03) != 0b10
            ) {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
            }
            return UuidV7Identifier(bytes.copyOf())
        }

        fun parse(canonical: String): UuidV7Identifier {
            if (canonical.length != 36) {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
            }
            val compact = StringBuilder(32)
            for (i in canonical.indices) {
                val c = canonical[i]
                if (i == 8 || i == 13 || i == 18 || i == 23) {
                    if (c != '-') throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                } else if (c in '0'..'9' || c in 'a'..'f') {
                    compact.append(c)
                } else {
                    throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                }
            }
            return fromCheckedBytes(KoderaMobileFfiBridge.decodeHex(compact.toString()))
        }

        fun mint(nowMs: Long = System.currentTimeMillis()): UuidV7Identifier {
            val rand = ByteArray(10)
            CSPRNG.nextBytes(rand)
            return fromParts(nowMs and MAXIMUM_TIMESTAMP_MS, rand)
        }
    }
}

/** Wire-identical `KDV1` AES-256-GCM session vault codec bound to `(organisationId, deviceId)` AAD. */
object Kdv1SessionVaultCodec {
    val MAGIC: ByteArray = byteArrayOf(0x4B, 0x44, 0x56, 0x31) // "KDV1"
    const val NONCE_BYTES: Int = 12
    const val TAG_BYTES: Int = 16
    const val MAX_PLAINTEXT_BYTES: Int = 262_144
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private val AAD_DOMAIN = "kodera-mobile-session-vault-kdv1\u0000".toByteArray(Charsets.UTF_8)

    fun aad(organisationId: String, deviceId: String): ByteArray {
        if (!TrustPolicy.canonicalNonNilUUID(organisationId) || !isValidVaultDeviceId(deviceId)) {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
        }
        val orgBytes = organisationId.toByteArray(Charsets.UTF_8)
        val devBytes = deviceId.toByteArray(Charsets.UTF_8)
        return ByteBuffer.allocate(AAD_DOMAIN.size + 8 + orgBytes.size + devBytes.size)
            .put(AAD_DOMAIN)
            .putInt(orgBytes.size)
            .put(orgBytes)
            .putInt(devBytes.size)
            .put(devBytes)
            .array()
    }

    fun seal(
        organisationId: String,
        deviceId: String,
        keyBytes: ByteArray,
        nonceBytes: ByteArray? = null,
        plaintext: ByteArray,
    ): ByteArray {
        if (keyBytes.size != 32) {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
        }
        return sealWithSecretKey(
            organisationId = organisationId,
            deviceId = deviceId,
            secretKey = SecretKeySpec(keyBytes, "AES"),
            nonceBytes = nonceBytes,
            plaintext = plaintext,
        )
    }

    fun sealWithSecretKey(
        organisationId: String,
        deviceId: String,
        secretKey: SecretKey,
        nonceBytes: ByteArray? = null,
        plaintext: ByteArray,
    ): ByteArray {
        if (plaintext.isEmpty() || plaintext.size > MAX_PLAINTEXT_BYTES) {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.CAPACITY_EXCEEDED)
        }
        val aadBytes = aad(organisationId, deviceId)
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            val effectiveNonce: ByteArray
            if (nonceBytes != null) {
                if (nonceBytes.size != NONCE_BYTES) {
                    throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                }
                effectiveNonce = nonceBytes.copyOf()
                cipher.init(Cipher.ENCRYPT_MODE, secretKey, GCMParameterSpec(TAG_BYTES * 8, effectiveNonce))
            } else {
                cipher.init(Cipher.ENCRYPT_MODE, secretKey)
                val generatedIv = cipher.iv
                if (generatedIv == null || generatedIv.size != NONCE_BYTES) {
                    throw KoderaMobileFfiFailure(KoderaMobileFfiError.AUTHENTICATION_FAILED)
                }
                effectiveNonce = generatedIv
            }
            cipher.updateAAD(aadBytes)
            val ciphertextAndTag = cipher.doFinal(plaintext)
            return ByteBuffer.allocate(MAGIC.size + NONCE_BYTES + ciphertextAndTag.size)
                .put(MAGIC)
                .put(effectiveNonce)
                .put(ciphertextAndTag)
                .array()
        } catch (err: KoderaMobileFfiFailure) {
            throw err
        } catch (_: GeneralSecurityException) {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.AUTHENTICATION_FAILED)
        } catch (_: RuntimeException) {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.AUTHENTICATION_FAILED)
        }
    }

    fun open(
        organisationId: String,
        deviceId: String,
        keyBytes: ByteArray,
        sealed: ByteArray,
    ): ByteArray {
        if (keyBytes.size != 32) {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
        }
        return openWithSecretKey(
            organisationId = organisationId,
            deviceId = deviceId,
            secretKey = SecretKeySpec(keyBytes, "AES"),
            sealed = sealed,
        )
    }

    fun openWithSecretKey(
        organisationId: String,
        deviceId: String,
        secretKey: SecretKey,
        sealed: ByteArray,
    ): ByteArray {
        val minLen = MAGIC.size + NONCE_BYTES + 1 + TAG_BYTES
        val maxLen = MAGIC.size + NONCE_BYTES + MAX_PLAINTEXT_BYTES + TAG_BYTES
        if (sealed.size > maxLen) {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.CAPACITY_EXCEEDED)
        }
        if (sealed.size < minLen ||
            sealed[0] != MAGIC[0] || sealed[1] != MAGIC[1] ||
            sealed[2] != MAGIC[2] || sealed[3] != MAGIC[3]
        ) {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
        }
        val aadBytes = aad(organisationId, deviceId)
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            val spec = GCMParameterSpec(TAG_BYTES * 8, sealed, MAGIC.size, NONCE_BYTES)
            cipher.init(Cipher.DECRYPT_MODE, secretKey, spec)
            cipher.updateAAD(aadBytes)
            val offset = MAGIC.size + NONCE_BYTES
            return cipher.doFinal(sealed, offset, sealed.size - offset)
        } catch (_: GeneralSecurityException) {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.AUTHENTICATION_FAILED)
        } catch (_: RuntimeException) {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.AUTHENTICATION_FAILED)
        }
    }

    fun isValidVaultDeviceId(value: String): Boolean {
        val bytes = value.toByteArray(Charsets.UTF_8)
        if (bytes.size !in 1..128) return false
        return bytes.all { b ->
            val c = b.toInt() and 0xFF
            c in 0x30..0x39 || c in 0x41..0x5A || c in 0x61..0x7A ||
                c == 0x2D || c == 0x5F || c == 0x2E || c == 0x3A
        }
    }
}

enum class SessionEnvelopeCryptoAlgorithm(val wireCode: Int) {
    MATRIX_OLM_V1(1),
    OPENMLS_DRAFT(2);

    companion object {
        fun fromWire(code: Int): SessionEnvelopeCryptoAlgorithm? =
            entries.firstOrNull { it.wireCode == code }
    }
}

data class SessionEnvelopeHeaderModel(
    val organisationId: String,
    val roomId: UuidV7Identifier,
    val messageId: UuidV7Identifier,
    val epoch: Long,
    val algorithm: SessionEnvelopeCryptoAlgorithm,
) {
    init {
        if (!TrustPolicy.canonicalNonNilUUID(organisationId) || epoch < 0L) {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
        }
    }
}

/** Bounded room epoch/algorithm & FIFO message-ID replay tracker matching `kodera_rs::SessionEnvelopeTracker`. */
class SessionEnvelopeTrackerModel(
    val organisationId: String,
    val roomCapacity: Int = 64,
    val replayCapacity: Int = 256,
) {
    private data class RoomState(var epoch: Long, val algorithm: SessionEnvelopeCryptoAlgorithm)
    private data class ReplayKey(val roomId: UuidV7Identifier, val messageId: UuidV7Identifier)

    private val rooms = LinkedHashMap<UuidV7Identifier, RoomState>()
    private val replay = LinkedHashSet<ReplayKey>()

    init {
        if (!TrustPolicy.canonicalNonNilUUID(organisationId) ||
            roomCapacity !in 1..MAX_ENTRIES ||
            replayCapacity !in 1..MAX_ENTRIES
        ) {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
        }
    }

    val roomCount: Int get() = rooms.size
    val replayCount: Int get() = replay.size

    fun verifyAndObserve(header: SessionEnvelopeHeaderModel) {
        if (header.organisationId != organisationId) {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.ORGANISATION_MISMATCH)
        }
        val existing = rooms[header.roomId]
        if (existing != null) {
            if (header.algorithm != existing.algorithm) {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.ALGORITHM_MISMATCH)
            }
            if (header.epoch < existing.epoch) {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.STALE_EPOCH)
            }
        } else if (rooms.size == roomCapacity) {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.CAPACITY_EXCEEDED)
        }

        val key = ReplayKey(header.roomId, header.messageId)
        if (replay.contains(key)) {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.REPLAY_DETECTED)
        }
        if (replay.size == replayCapacity) {
            val oldest = replay.iterator()
            if (oldest.hasNext()) {
                oldest.next()
                oldest.remove()
            }
        }
        replay.add(key)
        rooms[header.roomId] = RoomState(header.epoch, header.algorithm)
    }

    fun clear() {
        rooms.clear()
        replay.clear()
    }

    companion object {
        const val MAX_ENTRIES: Int = 4_096
    }
}

/** Deterministic UTS #51 single-grapheme emoji reaction validator matching `kodera_rs::mobile_ffi::validate_reaction_key`. */
object ReactionKeyValidator {
    const val MAX_UTF8_BYTES: Int = 32
    val QUICK_PALETTE: List<String> = listOf("👍", "❤️", "🎉", "🚀", "👀", "✅")

    fun isValid(key: String): Boolean {
        val utf8 = key.toByteArray(Charsets.UTF_8)
        if (utf8.isEmpty() || utf8.size > MAX_UTF8_BYTES) return false
        val scalars = IntArray(key.codePointCount(0, key.length))
        var offset = 0
        var outIdx = 0
        while (offset < key.length) {
            val c = key[offset]
            if (c.isHighSurrogate() && (offset + 1 >= key.length || !key[offset + 1].isLowSurrogate())) return false
            if (c.isLowSurrogate()) return false
            val cp = Character.codePointAt(key, offset)
            if (isForbiddenScalar(cp)) return false
            scalars[outIdx++] = cp
            offset += Character.charCount(cp)
        }
        if (outIdx == 0) return false

        // 1. Keycap sequence: [0-9#*] U+FE0F? U+20E3
        if (scalars[0] == 0x23 || scalars[0] == 0x2A || scalars[0] in 0x30..0x39) {
            if (scalars.size == 2 && scalars[1] == 0x20E3) return true
            if (scalars.size == 3 && scalars[1] == 0xFE0F && scalars[2] == 0x20E3) return true
            return false
        }

        // 2. Regional indicator flag pair
        if (isRegionalIndicator(scalars[0])) {
            return scalars.size == 2 && isRegionalIndicator(scalars[1])
        }

        // 3. Emoji pictographic base (+ optional VS16 / skin tone) (+ optional ZWJ continuations)
        var idx = 0
        while (true) {
            if (idx >= scalars.size || !isEmojiPictographicBase(scalars[idx])) return false
            idx += 1
            if (idx < scalars.size && scalars[idx] == 0xFE0F) idx += 1
            if (idx < scalars.size && isSkinToneModifier(scalars[idx])) {
                idx += 1
                if (idx < scalars.size && scalars[idx] == 0xFE0F) idx += 1
            }
            if (idx == scalars.size) return true
            if (scalars[idx] == 0x200D) {
                idx += 1
                if (idx >= scalars.size) return false
            } else {
                return false
            }
        }
    }

    private fun isForbiddenScalar(cp: Int): Boolean {
        if (Character.isWhitespace(cp)) return true
        return cp in 0x0000..0x001F ||
            cp in 0x007F..0x009F ||
            cp == 0x00AD || cp == 0x034F || cp == 0x061C ||
            cp in 0x200B..0x200C ||
            cp in 0x200E..0x200F ||
            cp in 0x202A..0x202E ||
            cp in 0x2060..0x206F ||
            cp == 0xFEFF ||
            cp in 0xE0000..0xE007F
    }

    private fun isRegionalIndicator(cp: Int): Boolean = cp in 0x1F1E6..0x1F1FF
    private fun isSkinToneModifier(cp: Int): Boolean = cp in 0x1F3FB..0x1F3FF

    private fun isEmojiPictographicBase(cp: Int): Boolean {
        if (isRegionalIndicator(cp) || isSkinToneModifier(cp)) return false
        return cp == 0x00A9 || cp == 0x00AE || cp == 0x203C || cp == 0x2049 ||
            cp == 0x2122 || cp == 0x2139 || cp in 0x2194..0x2199 || cp in 0x21A9..0x21AA ||
            cp in 0x231A..0x231B || cp == 0x2328 || cp == 0x23CF || cp in 0x23E9..0x23F3 ||
            cp in 0x23F8..0x23FA || cp == 0x24C2 || cp in 0x25AA..0x25AB || cp == 0x25B6 ||
            cp == 0x25C0 || cp in 0x25FB..0x25FE || cp in 0x2600..0x27BF || cp in 0x2934..0x2935 ||
            cp in 0x2B05..0x2B07 || cp in 0x2B1B..0x2B1C || cp == 0x2B50 || cp == 0x2B55 ||
            cp == 0x3030 || cp == 0x303D || cp == 0x3297 || cp == 0x3299 ||
            cp in 0x1F000..0x1FAFF
    }
}

enum class AttachmentMimeType(val wireValue: String) {
    JPEG("image/jpeg"),
    PNG("image/png"),
    WEBP("image/webp"),
    GIF("image/gif"),
    OGG_AUDIO("audio/ogg"),
    WEBM_AUDIO("audio/webm"),
    MP4_AUDIO("audio/mp4"),
    PDF("application/pdf"),
    PLAIN_TEXT("text/plain"),
    OCTET_STREAM("application/octet-stream");

    val isAudio: Boolean get() = this in setOf(OGG_AUDIO, WEBM_AUDIO, MP4_AUDIO)

    companion object {
        fun fromWire(raw: String): AttachmentMimeType? =
            entries.firstOrNull { it.wireValue == raw }
    }
}

@ConsistentCopyVisibility
data class AttachmentMetadataRef private constructor(
    val id: String,
    val filename: String,
    val contentType: AttachmentMimeType,
    val sizeBytes: Int,
) {
    companion object {
        const val MAX_FILENAME_LENGTH: Int = 255
        const val MAX_SIZE_BYTES: Int = 26_214_400
        const val MAX_REFS_PER_MESSAGE: Int = 10
        const val MATRIX_FIELD_NAME: String = "io.kodera.attachments"

        fun create(
            id: String,
            filename: String,
            contentType: AttachmentMimeType,
            sizeBytes: Int,
        ): AttachmentMetadataRef {
            if (!TrustPolicy.canonicalNonNilUUID(id)) {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
            }
            val cleaned = cleanFilename(filename)
            if (cleaned.isEmpty() || cleaned.length > MAX_FILENAME_LENGTH || sizeBytes !in 1..MAX_SIZE_BYTES) {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
            }
            return AttachmentMetadataRef(id, cleaned, contentType, sizeBytes)
        }

        fun cleanFilename(raw: String): String {
            val sb = StringBuilder(raw.length)
            var offset = 0
            while (offset < raw.length) {
                val cp = Character.codePointAt(raw, offset)
                if (cp >= 0x20 && cp != 0x7F && cp != '/'.code && cp != '\\'.code) {
                    sb.appendCodePoint(cp)
                }
                offset += Character.charCount(cp)
            }
            val trimmed = sb.toString().trim()
            if (trimmed.isEmpty()) return "attachment"
            return if (trimmed.length > MAX_FILENAME_LENGTH) trimmed.substring(0, MAX_FILENAME_LENGTH) else trimmed
        }

        fun fallbackBody(refs: List<AttachmentMetadataRef>): String =
            refs.joinToString("\n") { "📎 ${it.filename}" }
    }
}

/**
 * Payload-free push wakeup admission matching `kodera_rs::mobile_ffi::admit_wakeup_envelope`
 * across APNs, UnifiedPush, and FCM envelopes (with optional `epoch_ms` and `transport`).
 */
data class ZeroPayloadWakeupEnvelope(
    val wakeupId: String,
    val organisationId: String,
    val syncHint: String,
    val epochMs: Long? = null,
    val transport: String? = null,
) {
    companion object {
        const val MAX_WAKEUP_EPOCH_MS: Long = 4_102_444_800_000L
        private val ADMITTED_FIELDS = setOf(
            "wakeup_id", "organisation_id", "org_id", "sync_hint", "room_hash",
            "epoch_ms", "transport", "aps",
        )
        private val ADMITTED_TRANSPORTS = setOf("apns", "unifiedpush", "fcm")
        private val FORBIDDEN_MARKERS = setOf(
            "notification", "room_title", "roomtitle", "room_name", "roomname",
            "channel_name", "channelname", "sender", "sender_name", "sendername",
            "sender_display_name", "caller", "caller_name", "callername",
            "display_name", "displayname", "message", "body", "plaintext",
            "text", "content", "topic", "subject", "title", "subtitle",
            "alert", "avatar_url", "matrix_event", "sdp", "livekit_token",
            "access_token", "auth_token",
        )

        fun admit(jsonBytes: ByteArray): ZeroPayloadWakeupEnvelope {
            if (jsonBytes.isEmpty() || jsonBytes.size > 4_096) {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
            }
            val obj = MiniFfiJson.parseObject(jsonBytes)
            for ((key, value) in obj) {
                val norm = normalizeField(key)
                if (norm in FORBIDDEN_MARKERS) {
                    throw KoderaMobileFfiFailure(KoderaMobileFfiError.CLEARTEXT_FORBIDDEN, key)
                }
                if (key == "aps") {
                    val aps = value as? MiniJsonVal.Obj
                        ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                    for ((apsKey, apsVal) in aps.fields) {
                        if (normalizeField(apsKey) in FORBIDDEN_MARKERS) {
                            throw KoderaMobileFfiFailure(KoderaMobileFfiError.CLEARTEXT_FORBIDDEN, "aps.$apsKey")
                        }
                        if (apsKey != "content-available") {
                            throw KoderaMobileFfiFailure(KoderaMobileFfiError.UNEXPECTED_FIELD, "aps.$apsKey")
                        }
                        if (apsVal !is MiniJsonVal.Num || apsVal.value != 1L) {
                            throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                        }
                    }
                    continue
                }
                val leakedNested = findForbiddenNestedValue(value)
                if (leakedNested != null) {
                    throw KoderaMobileFfiFailure(KoderaMobileFfiError.CLEARTEXT_FORBIDDEN, "$key.$leakedNested")
                }
                if (key !in ADMITTED_FIELDS) {
                    throw KoderaMobileFfiFailure(KoderaMobileFfiError.UNEXPECTED_FIELD, key)
                }
            }

            val wakeupId = (obj["wakeup_id"] as? MiniJsonVal.Str)?.value
                ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
            if (!TrustPolicy.canonicalNonNilUUID(wakeupId)) {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
            }

            val orgPrimary = optionalCheckedStr(obj, "org_id")
            val orgAlias = optionalCheckedStr(obj, "organisation_id")
            if (orgPrimary != null && orgAlias != null && orgPrimary != orgAlias) {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
            }
            val orgId = orgPrimary ?: orgAlias ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
            if (!TrustPolicy.canonicalNonNilUUID(orgId)) {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
            }

            val hintPrimary = optionalCheckedStr(obj, "sync_hint")
            val hintAlias = optionalCheckedStr(obj, "room_hash")
            if (hintPrimary != null && hintAlias != null && hintPrimary != hintAlias) {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
            }
            val syncHint = hintPrimary ?: hintAlias ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
            if (!isValidSyncHint(syncHint)) {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
            }

            val epochMs = when (val rawEpoch = obj["epoch_ms"]) {
                null -> null
                is MiniJsonVal.Num -> {
                    if (rawEpoch.value !in 1L..MAX_WAKEUP_EPOCH_MS) {
                        throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                    }
                    rawEpoch.value
                }
                is MiniJsonVal.Str -> {
                    val parsed = parseCanonicalPositiveLong(rawEpoch.value)
                        ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                    if (parsed !in 1L..MAX_WAKEUP_EPOCH_MS) {
                        throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                    }
                    parsed
                }
                else -> throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
            }

            val transport = when (val rawTransport = obj["transport"]) {
                null -> null
                is MiniJsonVal.Str -> {
                    val lower = rawTransport.value.lowercase()
                    if (lower !in ADMITTED_TRANSPORTS) {
                        throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                    }
                    lower
                }
                else -> throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
            }

            return ZeroPayloadWakeupEnvelope(
                wakeupId = wakeupId,
                organisationId = orgId,
                syncHint = syncHint,
                epochMs = epochMs,
                transport = transport,
            )
        }

        private fun optionalCheckedStr(obj: Map<String, MiniJsonVal>, key: String): String? {
            val raw = obj[key] ?: return null
            return (raw as? MiniJsonVal.Str)?.value
                ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
        }

        private fun findForbiddenNestedValue(value: MiniJsonVal): String? = when (value) {
            is MiniJsonVal.Obj -> {
                var found: String? = null
                for ((k, v) in value.fields) {
                    if (normalizeField(k) in FORBIDDEN_MARKERS) {
                        found = k
                        break
                    }
                    val sub = findForbiddenNestedValue(v)
                    if (sub != null) {
                        found = "$k.$sub"
                        break
                    }
                }
                found
            }
            is MiniJsonVal.Arr -> {
                var found: String? = null
                for (item in value.items) {
                    val sub = findForbiddenNestedValue(item)
                    if (sub != null) {
                        found = sub
                        break
                    }
                }
                found
            }
            else -> null
        }

        private fun normalizeField(raw: String): String {
            val trimmed = raw.trim()
            val sb = StringBuilder(trimmed.length)
            for (c in trimmed) {
                sb.append(if (c == '-') '_' else c.lowercaseChar())
            }
            return sb.toString()
        }

        private fun parseCanonicalPositiveLong(raw: String): Long? {
            if (raw.isEmpty() || raw.length > 16 || raw[0] !in '1'..'9' || !raw.all { it in '0'..'9' }) {
                return null
            }
            return raw.toLongOrNull()
        }

        private fun isValidSyncHint(raw: String): Boolean {
            val bytes = raw.toByteArray(Charsets.UTF_8)
            if (bytes.size !in 1..128) return false
            return bytes.all { b ->
                val c = b.toInt() and 0xFF
                c in 0x30..0x39 || c in 0x41..0x5A || c in 0x61..0x7A ||
                    c == 0x2D || c == 0x5F || c == 0x2E || c == 0x3A
            }
        }
    }
}

/**
 * Mobile packet bridge backed by an injectable [PacketDispatcher] seam (`javax.crypto` `KDV1`
 * session vault, [UuidV7Identifier], [SessionEnvelopeTrackerModel], [ReactionKeyValidator], and
 * [ZeroPayloadWakeupEnvelope]) verified byte-for-byte against `packages/kodera-rs/vectors/mobile-ffi-v1.txt`.
 * Because `kodera-rs` enforces `#![forbid(unsafe_code)]` (where Rust 1.82+ forbids `#[no_mangle]`),
 * this bridge dispatches through [PacketDispatcher] without claiming an unmangled C symbol export.
 */
class KoderaMobileFfiBridge(
    private val customDispatcher: PacketDispatcher? = null,
) : PacketDispatcher {
    override fun dispatch(request: KoderaFfiPacket): KoderaFfiPacket {
        val raw = request.payloadBytes()
        if (raw.isEmpty() || raw.size != request.len || raw.size > KoderaFfiPacket.CAPACITY) {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_PACKET)
        }
        if (customDispatcher != null) {
            return customDispatcher.dispatch(request)
        }
        val obj = MiniFfiJson.parseObject(raw)
        val op = (obj["op"] as? MiniJsonVal.Str)?.value
            ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)

        return when (op) {
            "uuid_v7_mint" -> {
                ensureAllowedKeys(obj, setOf("op", "unix_ts_ms", "rand_hex"))
                val unixTsMs = when (val rawTs = obj["unix_ts_ms"]) {
                    null -> System.currentTimeMillis() and UuidV7Identifier.MAXIMUM_TIMESTAMP_MS
                    is MiniJsonVal.Num -> {
                        if (rawTs.value !in 0L..UuidV7Identifier.MAXIMUM_TIMESTAMP_MS) {
                            throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                        }
                        rawTs.value
                    }
                    else -> throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                }
                val minted = when (val rawRand = obj["rand_hex"]) {
                    null -> UuidV7Identifier.mint(unixTsMs)
                    is MiniJsonVal.Str -> UuidV7Identifier.fromParts(unixTsMs, decodeHex(rawRand.value))
                    else -> throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                }
                val resp = """{"ok":true,"uuid":"$minted","timestamp_ms":$unixTsMs}"""
                KoderaFfiPacket(resp.toByteArray(Charsets.UTF_8), status = 0)
            }

            "session_vault_seal" -> {
                ensureAllowedKeys(obj, setOf("op", "org_id", "device_id", "key_hex", "nonce_hex", "plaintext_hex"))
                val orgId = (obj["org_id"] as? MiniJsonVal.Str)?.value
                    ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                val deviceId = (obj["device_id"] as? MiniJsonVal.Str)?.value
                    ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                val keyHex = (obj["key_hex"] as? MiniJsonVal.Str)?.value
                    ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                val plainHex = (obj["plaintext_hex"] as? MiniJsonVal.Str)?.value
                    ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                val nonceBytes = when (val rawNonce = obj["nonce_hex"]) {
                    null -> null
                    is MiniJsonVal.Str -> decodeHex(rawNonce.value)
                    else -> throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                }
                val sealed = Kdv1SessionVaultCodec.seal(
                    organisationId = orgId,
                    deviceId = deviceId,
                    keyBytes = decodeHex(keyHex),
                    nonceBytes = nonceBytes,
                    plaintext = decodeHex(plainHex),
                )
                val resp = """{"ok":true,"sealed_hex":"${encodeHex(sealed)}"}"""
                KoderaFfiPacket(resp.toByteArray(Charsets.UTF_8), status = 0)
            }

            "session_vault_open" -> {
                ensureAllowedKeys(obj, setOf("op", "org_id", "device_id", "key_hex", "sealed_hex"))
                val orgId = (obj["org_id"] as? MiniJsonVal.Str)?.value
                    ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                val deviceId = (obj["device_id"] as? MiniJsonVal.Str)?.value
                    ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                val keyHex = (obj["key_hex"] as? MiniJsonVal.Str)?.value
                    ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                val sealedHex = (obj["sealed_hex"] as? MiniJsonVal.Str)?.value
                    ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                val plain = Kdv1SessionVaultCodec.open(
                    organisationId = orgId,
                    deviceId = deviceId,
                    keyBytes = decodeHex(keyHex),
                    sealed = decodeHex(sealedHex),
                )
                val resp = """{"ok":true,"plaintext_hex":"${encodeHex(plain)}"}"""
                KoderaFfiPacket(resp.toByteArray(Charsets.UTF_8), status = 0)
            }

            "session_envelope_verify_and_observe" -> {
                ensureAllowedKeys(
                    obj,
                    setOf("op", "org_id", "room_capacity", "replay_capacity", "history", "envelope"),
                )
                val orgId = (obj["org_id"] as? MiniJsonVal.Str)?.value
                    ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                val roomCap = when (val rc = obj["room_capacity"]) {
                    null -> 64
                    is MiniJsonVal.Num -> rc.value.takeIf { it in 1L..Int.MAX_VALUE }?.toInt()
                        ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                    else -> throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                }
                val replayCap = when (val rpc = obj["replay_capacity"]) {
                    null -> 256
                    is MiniJsonVal.Num -> rpc.value.takeIf { it in 1L..Int.MAX_VALUE }?.toInt()
                        ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                    else -> throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                }
                val tracker = SessionEnvelopeTrackerModel(orgId, roomCap, replayCap)
                val rawHistory = obj["history"]
                if (rawHistory != null) {
                    val items = (rawHistory as? MiniJsonVal.Arr)?.items
                        ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                    if (items.size > 512) {
                        throw KoderaMobileFfiFailure(KoderaMobileFfiError.CAPACITY_EXCEEDED)
                    }
                    for (entry in items) {
                        val entryObj = (entry as? MiniJsonVal.Obj)?.fields
                            ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                        tracker.verifyAndObserve(parseEnvelopeHeader(entryObj))
                    }
                }
                val candidateObj = (obj["envelope"] as? MiniJsonVal.Obj)?.fields
                    ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                tracker.verifyAndObserve(parseEnvelopeHeader(candidateObj))
                val resp = """{"ok":true,"room_count":${tracker.roomCount},"replay_count":${tracker.replayCount}}"""
                KoderaFfiPacket(resp.toByteArray(Charsets.UTF_8), status = 0)
            }

            "mls_device_create" -> {
                ensureAllowedKeys(
                    obj,
                    setOf("op", "org_id", "membership_id", "public_identity_hex", "wrapping_key_hex"),
                )
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.FEATURE_DISABLED)
            }

            "mls_device_restore" -> {
                ensureAllowedKeys(
                    obj,
                    setOf(
                        "op", "org_id", "membership_id", "expected_device_key_hex",
                        "expected_generation", "wrapping_key_hex", "sealed_hex",
                    ),
                )
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.FEATURE_DISABLED)
            }

            "attachment_mime_validate" -> {
                ensureAllowedKeys(obj, setOf("op", "content_type"))
                val mime = (obj["content_type"] as? MiniJsonVal.Str)?.value
                    ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                val valid = AttachmentMimeType.fromWire(mime) != null
                KoderaFfiPacket("""{"ok":true,"valid":$valid}""".toByteArray(Charsets.UTF_8), status = 0)
            }

            "reaction_validate" -> {
                ensureAllowedKeys(obj, setOf("op", "key"))
                val key = (obj["key"] as? MiniJsonVal.Str)?.value
                    ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                val valid = ReactionKeyValidator.isValid(key)
                val resp = """{"ok":true,"valid":$valid}"""
                KoderaFfiPacket(resp.toByteArray(Charsets.UTF_8), status = 0)
            }

            "call_wake_admit" -> {
                ensureAllowedKeys(obj, setOf("op", "payload_hex", "now"))
                val hex = (obj["payload_hex"] as? MiniJsonVal.Str)?.value ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                val now = (obj["now"] as? MiniJsonVal.Num)?.value ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                val w = decodeNativeCallWake(decodeHex(hex), now)
                val out = """{"ok":true,"call_id":"${w.callId}","organisation_id":"${w.organisationId}","channel_id":"${w.channelId}","epoch":${w.epoch},"state":"${w.state.wire}","expires_at":${w.expiresAt}}"""
                KoderaFfiPacket(out.toByteArray(), status = 0)
            }

            "wakeup_envelope_admit" -> {
                ensureAllowedKeys(obj, setOf("op", "payload_hex"))
                val payloadHex = (obj["payload_hex"] as? MiniJsonVal.Str)?.value
                    ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
                val admitted = ZeroPayloadWakeupEnvelope.admit(decodeHex(payloadHex))
                val resp =
                    """{"ok":true,"wakeup_id":"${admitted.wakeupId}","organisation_id":"${admitted.organisationId}","sync_hint":"${admitted.syncHint}"}"""
                KoderaFfiPacket(resp.toByteArray(Charsets.UTF_8), status = 0)
            }

            else -> throw KoderaMobileFfiFailure(KoderaMobileFfiError.UNKNOWN_OPERATION)
        }
    }

    private fun parseEnvelopeHeader(obj: Map<String, MiniJsonVal>): SessionEnvelopeHeaderModel {
        ensureAllowedKeys(obj, setOf("org_id", "room_id", "message_id", "epoch", "algorithm"))
        val orgId = (obj["org_id"] as? MiniJsonVal.Str)?.value
            ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
        val roomIdStr = (obj["room_id"] as? MiniJsonVal.Str)?.value
            ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
        val msgIdStr = (obj["message_id"] as? MiniJsonVal.Str)?.value
            ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
        val epoch = (obj["epoch"] as? MiniJsonVal.Num)?.value
            ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
        val algVal = (obj["algorithm"] as? MiniJsonVal.Num)?.value?.takeIf { it in 0L..255L }?.toInt()
            ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
        val alg = SessionEnvelopeCryptoAlgorithm.fromWire(algVal)
            ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
        return SessionEnvelopeHeaderModel(
            organisationId = orgId,
            roomId = UuidV7Identifier.parse(roomIdStr),
            messageId = UuidV7Identifier.parse(msgIdStr),
            epoch = epoch,
            algorithm = alg,
        )
    }

    private fun ensureAllowedKeys(obj: Map<String, MiniJsonVal>, allowed: Set<String>) {
        for (key in obj.keys) {
            if (key !in allowed) {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.UNEXPECTED_FIELD, key)
            }
        }
    }

    companion object {
        fun encodeHex(bytes: ByteArray): String {
            val table = "0123456789abcdef"
            val sb = StringBuilder(bytes.size * 2)
            for (b in bytes) {
                val v = b.toInt() and 0xFF
                sb.append(table[v ushr 4])
                sb.append(table[v and 0x0F])
            }
            return sb.toString()
        }

        fun decodeHex(hex: String): ByteArray {
            if (hex.length % 2 != 0) {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
            }
            val out = ByteArray(hex.length / 2)
            var idx = 0
            while (idx < hex.length) {
                val hi = nibble(hex[idx])
                val lo = nibble(hex[idx + 1])
                out[idx / 2] = ((hi shl 4) or lo).toByte()
                idx += 2
            }
            return out
        }

        private fun nibble(c: Char): Int = when (c) {
            in '0'..'9' -> c - '0'
            in 'a'..'f' -> c - 'a' + 10
            else -> throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_INPUT)
        }
    }
}

private sealed interface MiniJsonVal {
    data class Obj(val fields: Map<String, MiniJsonVal>) : MiniJsonVal
    data class Arr(val items: List<MiniJsonVal>) : MiniJsonVal
    data class Str(val value: String) : MiniJsonVal
    data class Num(val value: Long) : MiniJsonVal
    data object NonUintNumber : MiniJsonVal
    data class Bool(val value: Boolean) : MiniJsonVal
    data object Null : MiniJsonVal
}

private class MiniFfiJson(private val text: String) {
    private var pos = 0

    fun parseRootObject(): Map<String, MiniJsonVal> {
        skipWs()
        val v = parseValue(1)
        skipWs()
        if (pos != text.length || v !is MiniJsonVal.Obj) {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
        }
        return v.fields
    }

    private fun skipWs() {
        while (pos < text.length) {
            val c = text[pos]
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') pos++ else break
        }
    }

    private fun parseValue(depth: Int): MiniJsonVal {
        if (depth > 16) throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
        skipWs()
        if (pos >= text.length) throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
        return when (text[pos]) {
            '{' -> parseObj(depth)
            '[' -> parseArr(depth)
            '"' -> MiniJsonVal.Str(parseStr())
            't' -> { expect("true"); MiniJsonVal.Bool(true) }
            'f' -> { expect("false"); MiniJsonVal.Bool(false) }
            'n' -> { expect("null"); MiniJsonVal.Null }
            '-', in '0'..'9' -> parseNumber()
            else -> throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
        }
    }

    private fun parseObj(depth: Int): MiniJsonVal.Obj {
        pos++
        skipWs()
        val map = LinkedHashMap<String, MiniJsonVal>()
        if (pos < text.length && text[pos] == '}') {
            pos++
            return MiniJsonVal.Obj(map)
        }
        while (true) {
            skipWs()
            if (pos >= text.length || text[pos] != '"') {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
            }
            val key = parseStr()
            if (map.containsKey(key)) {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
            }
            skipWs()
            if (pos >= text.length || text[pos] != ':') {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
            }
            pos++
            map[key] = parseValue(depth + 1)
            skipWs()
            if (pos >= text.length) throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
            when (text[pos]) {
                '}' -> { pos++; return MiniJsonVal.Obj(map) }
                ',' -> pos++
                else -> throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
            }
        }
    }

    private fun parseArr(depth: Int): MiniJsonVal.Arr {
        pos++
        skipWs()
        val list = ArrayList<MiniJsonVal>()
        if (pos < text.length && text[pos] == ']') {
            pos++
            return MiniJsonVal.Arr(list)
        }
        while (true) {
            list.add(parseValue(depth + 1))
            skipWs()
            if (pos >= text.length) throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
            when (text[pos]) {
                ']' -> { pos++; return MiniJsonVal.Arr(list) }
                ',' -> pos++
                else -> throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
            }
        }
    }

    private fun parseStr(): String {
        if (pos >= text.length || text[pos] != '"') {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
        }
        pos++
        val sb = StringBuilder()
        while (pos < text.length) {
            val c = text[pos++]
            if (c == '"') return sb.toString()
            if (c.code < 0x20) throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
            if (c == '\\') {
                if (pos >= text.length) throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
                when (val esc = text[pos++]) {
                    '"', '\\', '/' -> sb.append(esc)
                    'b' -> sb.append('\b')
                    'f' -> sb.append('\u000C')
                    'n' -> sb.append('\n')
                    'r' -> sb.append('\r')
                    't' -> sb.append('\t')
                    'u' -> {
                        val unit = readHexU16()
                        if (unit in 0xD800..0xDBFF) {
                            if (pos + 2 > text.length || text[pos] != '\\' || text[pos + 1] != 'u') {
                                throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
                            }
                            pos += 2
                            val low = readHexU16()
                            if (low !in 0xDC00..0xDFFF) {
                                throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
                            }
                            sb.append(unit.toChar())
                            sb.append(low.toChar())
                        } else if (unit in 0xDC00..0xDFFF) {
                            throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
                        } else {
                            sb.append(unit.toChar())
                        }
                    }
                    else -> throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
                }
            } else {
                sb.append(c)
            }
        }
        throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
    }

    private fun parseNumber(): MiniJsonVal {
        val start = pos
        val negative = if (pos < text.length && text[pos] == '-') { pos++; true } else false
        val intStart = pos
        if (pos < text.length && text[pos] == '0') {
            pos++
            if (pos < text.length && text[pos] in '0'..'9') {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
            }
        } else {
            while (pos < text.length && text[pos] in '0'..'9') pos++
            if (pos == intStart) {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
            }
        }
        var fractionalOrExp = false
        if (pos < text.length && text[pos] == '.') {
            fractionalOrExp = true
            pos++
            val fracStart = pos
            while (pos < text.length && text[pos] in '0'..'9') pos++
            if (pos == fracStart) throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
        }
        if (pos < text.length && (text[pos] == 'e' || text[pos] == 'E')) {
            fractionalOrExp = true
            pos++
            if (pos < text.length && (text[pos] == '+' || text[pos] == '-')) pos++
            val expStart = pos
            while (pos < text.length && text[pos] in '0'..'9') pos++
            if (pos == expStart) throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
        }
        if (negative || fractionalOrExp) return MiniJsonVal.NonUintNumber
        val parsed = text.substring(start, pos).toLongOrNull()
        return if (parsed != null && parsed >= 0L) MiniJsonVal.Num(parsed) else MiniJsonVal.NonUintNumber
    }

    private fun readHexU16(): Int {
        if (pos + 4 > text.length) throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
        var acc = 0
        for (i in 0 until 4) {
            val c = text[pos + i]
            val digit = when (c) {
                in '0'..'9' -> c - '0'
                in 'a'..'f' -> c - 'a' + 10
                in 'A'..'F' -> c - 'A' + 10
                else -> throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
            }
            acc = (acc shl 4) or digit
        }
        pos += 4
        return acc
    }

    private fun expect(lit: String) {
        if (!text.startsWith(lit, pos)) {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
        }
        pos += lit.length
    }

    companion object {
        fun parseObject(bytes: ByteArray): Map<String, MiniJsonVal> {
            val text = try {
                Charsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString()
            } catch (_: Exception) {
                throw KoderaMobileFfiFailure(KoderaMobileFfiError.INVALID_JSON)
            }
            return MiniFfiJson(text).parseRootObject()
        }
    }
}

/** Strict parser shared by the typed call binding and local packet driver. */
internal fun decodeNativeCallWake(data: ByteArray, now: Long, response: Boolean = false): NativeCallWake {
    if (data.size > 4096) NativeCallWake.fail(KoderaMobileFfiError.CAPACITY_EXCEEDED)
    val obj = MiniFfiJson.parseObject(data)
    val allowed = setOf("call_id", "organisation_id", "channel_id", "epoch", "state", "expires_at") + if (response) setOf("ok") else emptySet()
    if (obj.keys.any { it !in allowed }) NativeCallWake.fail(KoderaMobileFfiError.UNEXPECTED_FIELD)
    fun str(key: String) = (obj[key] as? MiniJsonVal.Str)?.value ?: NativeCallWake.fail(KoderaMobileFfiError.INVALID_INPUT)
    fun num(key: String) = (obj[key] as? MiniJsonVal.Num)?.value ?: NativeCallWake.fail(KoderaMobileFfiError.INVALID_INPUT)
    val state = NativeRingPhase.entries.firstOrNull { it.wire == str("state") } ?: NativeCallWake.fail(KoderaMobileFfiError.INVALID_INPUT)
    return NativeCallWake(str("call_id"), str("organisation_id"), str("channel_id"), num("epoch"), state, num("expires_at")).also { it.validate(now) }
}
