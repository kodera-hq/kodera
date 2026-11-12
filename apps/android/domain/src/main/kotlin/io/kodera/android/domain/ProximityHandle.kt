package io.kodera.android.domain

import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Where a sender handle comes from. */
enum class ProximityHandleOrigin(val slug: String) {
    /** Picked by the member as their proximity pseudonym. */
    DEDICATED("dedicated"),
    /** Derived for the sender inside one organisation when the member picked none. */
    GENERATED("generated");
    companion object {
        fun fromSlug(slug: String): ProximityHandleOrigin = entries.firstOrNull { it.slug == slug }
            ?: throw ProximityFailure(ProximityError.INVALID_HANDLE)
    }
}

/**
 * The pseudonym shown for the sender of a `#proximity` check-in.
 *
 * A proximity frame carries its sender's device public key and nothing else about the person. A handle is
 * display metadata held beside the frame, never inside it: the frozen v1 wire format is untouched, a real name
 * is never required and none travels in a frame.
 *
 * A handle is a display label. It is never an identity and never an authorisation input: identity stays the
 * Ed25519 signing key, and the roster and the signature decide what is admitted. Nothing may be granted,
 * refused, deduplicated or looked up by handle. A generated handle keeps 55 bits of a digest keyed with the
 * organisation's beacon salt, so the same key shows another handle in another organisation; two senders can
 * still show the same handle, and a roster view must go through [labelsFor], which adds a fingerprint of each
 * signing key and judges equality over the whole provisioned roster, absent members included.
 *
 * The grammar, the word lists and the vectors are shared with `kodera-rs` and the iOS client through
 * `packages/kodera-rs/vectors/proximity-handle-v1.txt`, which the tests read.
 */
class ProximityHandle private constructor(val value: String, val origin: ProximityHandleOrigin) {
    override fun equals(other: Any?) = other is ProximityHandle && value == other.value && origin == other.origin
    override fun hashCode() = 31 * value.hashCode() + origin.hashCode()
    override fun toString() = "$value (${origin.slug})"

    companion object {
        const val MIN_CHARS = 3
        const val MAX_CHARS = 24
        /** Characters after the two words of a generated handle: 45 bits, five per character. */
        const val GENERATED_SUFFIX_CHARS = 9
        /** Digest bits a generated handle keeps: five per word and 45 in the suffix. */
        const val GENERATED_DIGEST_BITS = 55
        /** Shortest fingerprint prefix shown beside a handle that is not unique in its roster. */
        const val MIN_FINGERPRINT_HEX_CHARS = 8
        /**
         * MACed with the sender key under the organisation's beacon salt. It labels a display value only: it
         * is not part of the frozen frame v1 and signs nothing.
         */
        internal const val GENERATED_LABEL = "kodera-proximity-handle-v1:"
        internal const val FINGERPRINT_LABEL = "kodera-proximity-fingerprint-v1:"
        /** Lowercase, digits first, without `i`, `l`, `o` and `u`: five bits per character. */
        internal const val SUFFIX_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"
        private const val HEX_DIGITS = "0123456789abcdef"
        internal val ADJECTIVES = listOf(
            "amber", "brisk", "calm", "clear", "coral", "crisp", "dusky", "early", "fair", "gentle",
            "golden", "green", "hazel", "ivory", "jade", "keen", "light", "lunar", "mellow", "misty",
            "noble", "olive", "pale", "quiet", "rapid", "royal", "sandy", "silver", "solar", "steady",
            "swift", "vivid")
        internal val NOUNS = listOf(
            "alder", "aspen", "badger", "birch", "brook", "cedar", "comet", "crane", "delta", "dune",
            "ember", "falcon", "fern", "finch", "glade", "harbor", "heron", "island", "juniper", "lark",
            "lynx", "maple", "meadow", "otter", "pebble", "pine", "quartz", "raven", "reef", "river",
            "sparrow", "willow")

        /**
         * Exactly `^[a-z0-9]+(?:-[a-z0-9]+)*$` with 3 to 24 characters. Nothing is trimmed, folded or
         * normalised: a display name, an email address or any non-ASCII text is refused, not repaired.
         */
        fun isValid(raw: String): Boolean {
            if (raw.length !in MIN_CHARS..MAX_CHARS) return false
            var previousWasHyphen = true // a leading hyphen is refused like a doubled one
            for (char in raw) {
                val isHyphen = char == '-'
                val isWord = char in 'a'..'z' || char in '0'..'9'
                if (!(isWord || isHyphen) || (isHyphen && previousWasHyphen)) return false
                previousWasHyphen = isHyphen
            }
            return !previousWasHyphen
        }

        /** A pseudonym the member picked. Refused, never repaired, when it is outside the grammar. */
        fun dedicated(raw: String): ProximityHandle {
            if (!isValid(raw)) throw ProximityFailure(ProximityError.INVALID_HANDLE)
            return ProximityHandle(raw, ProximityHandleOrigin.DEDICATED)
        }

        /**
         * The handle every device of one organisation derives for [sender]. [organisationSalt] is the 32-byte
         * salt [ProximityBeacon.compute] takes: the same key gives the same handle on every platform inside
         * that organisation, and another one outside it.
         */
        fun generated(organisationSalt: ByteArray, sender: ProximityPublicKey): ProximityHandle {
            if (organisationSalt.size != 32) throw ProximityFailure(ProximityError.INVALID_HANDLE)
            return ProximityHandle(derive(organisationSalt, sender), ProximityHandleOrigin.GENERATED)
        }

        /**
         * `<adjective>-<noun>-<9 characters>` from `HMAC-SHA256(binding, label || sender key)`. [binding] is
         * the organisation's beacon salt; the tests pass another one to show what the binding buys.
         */
        internal fun derive(binding: ByteArray, sender: ProximityPublicKey): String {
            val message = GENERATED_LABEL.toByteArray(Charsets.US_ASCII) + sender.bytes()
            // HMAC with an empty key is defined (the key is zero-padded); SecretKeySpec refuses an empty array.
            val key = if (binding.isEmpty()) ByteArray(64) else binding.copyOf()
            val digest = try { Mac.getInstance("HmacSHA256").run { init(SecretKeySpec(key, "HmacSHA256")); doFinal(message) } }
                catch (error: java.security.GeneralSecurityException) { throw ProximityFailure(ProximityError.CRYPTO_UNAVAILABLE) }
            // The top 45 bits of digest[2..8], most significant character first.
            var bits = (2..7).fold(0L) { value, index -> (value shl 8) or (digest[index].toLong() and 255) } ushr 3
            val suffix = CharArray(GENERATED_SUFFIX_CHARS)
            for (index in suffix.indices.reversed()) { suffix[index] = SUFFIX_ALPHABET[(bits and 31).toInt()]; bits = bits ushr 5 }
            return "${ADJECTIVES[digest[0].toInt() and 31]}-${NOUNS[digest[1].toInt() and 31]}-${String(suffix)}"
        }

        /**
         * The dedicated handle when the member picked one, the generated one otherwise. An invalid dedicated
         * handle throws: it is not silently replaced, and it is never shown.
         */
        fun resolve(dedicated: String?, organisationSalt: ByteArray, sender: ProximityPublicKey): ProximityHandle =
            if (dedicated != null) dedicated(dedicated) else generated(organisationSalt, sender)

        /**
         * Rebuilds a handle received with its origin. A generated one must be the one this organisation
         * derives for [sender].
         */
        fun fromParts(raw: String, origin: ProximityHandleOrigin, organisationSalt: ByteArray,
            sender: ProximityPublicKey): ProximityHandle = when (origin) {
            ProximityHandleOrigin.DEDICATED -> dedicated(raw)
            ProximityHandleOrigin.GENERATED -> generated(organisationSalt, sender).also {
                if (it.value != raw) throw ProximityFailure(ProximityError.INVALID_HANDLE)
            }
        }

        /**
         * The 64 lowercase hex characters a sender key is told apart by when handles are equal:
         * `SHA-256("kodera-proximity-fingerprint-v1:" || sender key)`. A prefix of it is shown.
         */
        fun fingerprint(sender: ProximityPublicKey): String = MessageDigest.getInstance("SHA-256")
            .digest(FINGERPRINT_LABEL.toByteArray(Charsets.US_ASCII) + sender.bytes())
            .joinToString("") { byte -> val value = byte.toInt() and 255; "${HEX_DIGITS[value shr 4]}${HEX_DIGITS[value and 15]}" }

        /**
         * Labels for every provisioned sender of one roster, in the order given. When two or more distinct
         * keys resolve to the same handle, whatever its origin, each carries a fingerprint prefix: 8 hex
         * characters, lengthened two at a time until the prefixes of that group differ. A key listed twice is
         * one sender. The result is for display; identity remains the key.
         *
         * [provisioned] must be the whole provisioned roster, never only the senders seen so far: a group
         * computed over observed senders alone would show a bare handle to a sender whose handle equals an
         * absent member's. To label the senders that have checked in, use [labelsFor].
         */
        fun disambiguate(provisioned: List<Pair<ProximityPublicKey, ProximityHandle>>): List<ProximityRosterLabel> {
            val lengths = provisioned.groupBy({ it.second.value }, { it.first }).mapValues { it.value.toSet() }
                .filterValues { it.size > 1 }.mapValues { (_, keys) ->
                    val fingerprints = keys.map(::fingerprint)
                    var length = MIN_FINGERPRINT_HEX_CHARS
                    while (length < 64 && fingerprints.map { it.take(length) }.toSet().size < fingerprints.size) length += 2
                    length
                }
            return provisioned.map { (sender, handle) ->
                ProximityRosterLabel(sender, handle, lengths[handle.value]?.let { fingerprint(sender).take(it) })
            }
        }

        /**
         * Labels for the senders that have checked in, in the order of [observed], with the collision groups
         * computed over the whole [provisioned] roster. A sender whose handle equals that of any provisioned
         * member carries its fingerprint whether or not that member has checked in, so a label never changes
         * when another member appears. An observed key outside the provisioned roster is refused: nothing is
         * labelled for a sender the roster does not hold.
         */
        fun labelsFor(provisioned: List<Pair<ProximityPublicKey, ProximityHandle>>,
            observed: List<ProximityPublicKey>): List<ProximityRosterLabel> {
            val byKey = disambiguate(provisioned).associateBy { it.senderPublicKey }
            return observed.map { byKey[it] ?: throw ProximityFailure(ProximityError.UNAUTHORIZED) }
        }
    }
}

/**
 * What a roster view shows for one sender: the handle, and a fingerprint prefix of the signing key when
 * another sender of the same roster shows the same handle. Display only.
 */
data class ProximityRosterLabel(val senderPublicKey: ProximityPublicKey, val handle: ProximityHandle,
    /** Null when the handle is unique in the roster it was computed for. */
    val fingerprint: String?) {
    /**
     * `handle`, or `handle [fingerprint]` when the handle alone would be ambiguous. The second form is a
     * display string, not a handle: it is outside the handle grammar on purpose.
     */
    val display: String get() = if (fingerprint == null) handle.value else "${handle.value} [$fingerprint]"
}
