package io.kodera.android.domain

import org.junit.Assert.*
import org.junit.Test

/** `kodera-rs` and the iOS client read the same file: the three agree line for line. */
class ProximityHandleTests {
    private class RosterEntry(val name: String, val salt: ByteArray, val sender: ProximityPublicKey,
        val dedicated: String?, val handle: String, val fingerprint: String?, val present: Boolean)
    private class Generated(val salt: ByteArray, val sender: ProximityPublicKey, val handle: String)
    private class Vectors {
        val bounds = linkedMapOf<String, Int>(); val origins = mutableListOf<String>()
        val adjectives = mutableListOf<String>(); val nouns = mutableListOf<String>()
        val valid = mutableListOf<String>(); val refused = mutableListOf<Pair<String, String>>()
        val generated = mutableListOf<Generated>(); val rosters = mutableListOf<RosterEntry>()
        val fingerprints = mutableListOf<Generated>() // salt, sender, the 64-character fingerprint
    }
    private fun refuses(block: () -> Unit) {
        try { block(); fail("expected INVALID_HANDLE") }
        catch (error: ProximityFailure) { assertEquals(ProximityError.INVALID_HANDLE, error.reason) }
    }

    /** Strict: a line outside the grammar fails the test rather than being skipped. */
    private fun vectors(): Vectors {
        val path = "packages/kodera-rs/vectors/proximity-handle-v1.txt"
        val root = generateSequence(java.io.File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .first { java.io.File(it, path).isFile }
        val parsed = Vectors()
        java.io.File(root, path).readLines(Charsets.UTF_8).filter { it.isNotEmpty() && !it.startsWith("#") }.forEach { line ->
            val f = line.split(" ")
            when {
                f[0] == "bound" && f.size == 3 -> parsed.bounds[f[1]] = f[2].toInt()
                f[0] == "origin" && f.size == 2 -> parsed.origins += f[1]
                f[0] == "adjective" && f.size == 3 -> { assertEquals(line, parsed.adjectives.size, f[1].toInt()); parsed.adjectives += f[2] }
                f[0] == "noun" && f.size == 3 -> { assertEquals(line, parsed.nouns.size, f[1].toInt()); parsed.nouns += f[2] }
                f[0] == "valid" && f.size == 2 -> parsed.valid += f[1]
                f[0] == "refuse" && f.size == 3 ->
                    parsed.refused += f[1] to (if (f[2] == "-") "" else String(decodeProximityHex(f[2]), Charsets.UTF_8))
                f[0] == "generated" && f.size == 4 ->
                    parsed.generated += Generated(decodeProximityHex(f[1]), ProximityPublicKey(decodeProximityHex(f[2])), f[3])
                f[0] == "fingerprint" && f.size == 4 ->
                    parsed.fingerprints += Generated(decodeProximityHex(f[1]), ProximityPublicKey(decodeProximityHex(f[2])), f[3])
                f[0] == "roster" && f.size == 8 && f[7] in setOf("present", "absent") ->
                    parsed.rosters += RosterEntry(f[1], decodeProximityHex(f[2]), ProximityPublicKey(decodeProximityHex(f[3])),
                        f[4].takeUnless { it == "-" }, f[5], f[6].takeUnless { it == "-" }, f[7] == "present")
                else -> fail("unknown line in the shared handle vectors: $line")
            }
        }
        return parsed
    }

    @Test fun sharedVectorsStateTheBoundsOriginsAndWordsThisModuleUses() {
        val shared = vectors()
        assertEquals(mapOf("min_chars" to ProximityHandle.MIN_CHARS, "max_chars" to ProximityHandle.MAX_CHARS,
            "generated_suffix_chars" to ProximityHandle.GENERATED_SUFFIX_CHARS,
            "generated_digest_bits" to ProximityHandle.GENERATED_DIGEST_BITS,
            "min_fingerprint_hex_chars" to ProximityHandle.MIN_FINGERPRINT_HEX_CHARS), shared.bounds)
        assertEquals(ProximityHandle.GENERATED_DIGEST_BITS, 5 + 5 + 5 * ProximityHandle.GENERATED_SUFFIX_CHARS)
        assertEquals(ProximityHandleOrigin.entries.map { it.slug }, shared.origins)
        assertEquals(listOf("dedicated", "generated"), shared.origins)
        for (slug in shared.origins) assertEquals(slug, ProximityHandleOrigin.fromSlug(slug).slug)
        for (slug in listOf("", "Dedicated", "generated ", "random")) refuses { ProximityHandleOrigin.fromSlug(slug) }
        assertEquals(ProximityHandle.ADJECTIVES, shared.adjectives)
        assertEquals(ProximityHandle.NOUNS, shared.nouns)
        assertEquals("kodera-proximity-handle-v1:", ProximityHandle.GENERATED_LABEL)
        assertEquals("kodera-proximity-fingerprint-v1:", ProximityHandle.FINGERPRINT_LABEL)
        assertEquals("0123456789abcdefghjkmnpqrstvwxyz", ProximityHandle.SUFFIX_ALPHABET)
    }

    @Test fun everySharedValidHandleIsAcceptedAndEveryRefusedOneIsRefused() {
        val shared = vectors()
        assertTrue(shared.valid.size >= 10 && shared.refused.size >= 25)
        for (handle in shared.valid) {
            assertTrue(handle, ProximityHandle.isValid(handle))
            val dedicated = ProximityHandle.dedicated(handle)
            assertEquals(handle, dedicated.value)
            assertEquals(ProximityHandleOrigin.DEDICATED, dedicated.origin)
        }
        val salt = ByteArray(32) { 1 }; val sender = ProximityPublicKey(ByteArray(32) { 7 })
        for ((name, text) in shared.refused) {
            assertFalse(name, ProximityHandle.isValid(text))
            refuses { ProximityHandle.dedicated(text) }
            // An invalid dedicated handle is never replaced silently by a generated one.
            refuses { ProximityHandle.resolve(text, salt, sender) }
        }
    }

    /**
     * Refusal mutation: one character of an accepted handle replaced by one outside the grammar, at every
     * position, must be refused.
     */
    @Test fun aSingleForeignCharacterAtAnyPositionIsRefused() {
        for (handle in vectors().valid) for (position in handle.indices) for (foreign in listOf('A', '_', ' ', '.', 'é')) {
            val mutated = StringBuilder(handle).apply { setCharAt(position, foreign) }.toString()
            assertFalse("$handle with $foreign at $position", ProximityHandle.isValid(mutated))
        }
    }

    @Test fun generatedHandlesMatchTheSharedVectorsAndAlwaysValidate() {
        val shared = vectors()
        assertTrue(shared.generated.size >= 10)
        for (vector in shared.generated) {
            val handle = ProximityHandle.generated(vector.salt, vector.sender)
            assertEquals(vector.handle, handle.value)
            assertEquals(ProximityHandleOrigin.GENERATED, handle.origin)
            assertTrue(ProximityHandle.isValid(handle.value))
            assertEquals(handle, ProximityHandle.resolve(null, vector.salt, vector.sender))
            assertEquals(handle, ProximityHandle.fromParts(vector.handle, ProximityHandleOrigin.GENERATED, vector.salt, vector.sender))
        }
        // The longest word pair with the full suffix is exactly the bound, and every pair fits.
        assertEquals(ProximityHandle.MAX_CHARS, ProximityHandle.ADJECTIVES.maxOf { it.length } + 1 +
            ProximityHandle.NOUNS.maxOf { it.length } + 1 + ProximityHandle.GENERATED_SUFFIX_CHARS)
        for (adjective in ProximityHandle.ADJECTIVES) for (noun in ProximityHandle.NOUNS)
            assertTrue(ProximityHandle.isValid("$adjective-$noun-zzzzzzzzz"))
        for (seed in 0..255) {
            val handle = ProximityHandle.generated(ByteArray(32) { seed.toByte() }, ProximityPublicKey(ByteArray(32) { (seed + 1).toByte() }))
            assertTrue(ProximityHandle.isValid(handle.value))
            assertEquals(ProximityHandle.GENERATED_SUFFIX_CHARS, handle.value.substringAfterLast('-').length)
        }
        for (size in listOf(0, 31, 33)) refuses { ProximityHandle.generated(ByteArray(size), ProximityPublicKey(ByteArray(32))) }
    }

    /** The organisation binding: one sender key, two organisations, two handles. */
    @Test fun theSameSenderKeyYieldsDifferentHandlesInTwoOrganisations() {
        val shared = vectors(); var compared = 0
        for (one in shared.generated) for (other in shared.generated) {
            if (one.sender != other.sender || one.salt.contentEquals(other.salt)) continue
            assertNotEquals(one.handle, other.handle)
            assertNotEquals(ProximityHandle.generated(one.salt, one.sender), ProximityHandle.generated(other.salt, one.sender))
            // A handle derived in one organisation is not accepted as this sender's in another.
            refuses { ProximityHandle.fromParts(one.handle, ProximityHandleOrigin.GENERATED, other.salt, one.sender) }
            compared++
        }
        assertTrue("the vectors must hold each sender in two organisations", compared >= 10)
    }

    /**
     * Refusal mutation on the binding itself: derive with the organisation removed (one fixed binding for
     * everyone). No shared vector survives.
     */
    @Test fun aDerivationWithoutTheOrganisationBindingMatchesNoSharedVector() {
        for (vector in vectors().generated) {
            assertNotEquals(vector.handle, ProximityHandle.derive(ByteArray(0), vector.sender))
            assertEquals(vector.handle, ProximityHandle.derive(vector.salt, vector.sender))
        }
    }

    @Test fun aGeneratedHandleBelongsToItsKeyAndADedicatedOneWins() {
        val salt = ByteArray(32) { 0x42 }
        val sender = ProximityPublicKey(ByteArray(32) { 9 }); val other = ProximityPublicKey(ByteArray(32) { 10 })
        val generated = ProximityHandle.generated(salt, sender)
        assertNotEquals(generated, ProximityHandle.generated(salt, other))
        refuses { ProximityHandle.fromParts(generated.value, ProximityHandleOrigin.GENERATED, salt, other) }
        val picked = ProximityHandle.resolve("north-wing-3", salt, sender)
        assertEquals("north-wing-3", picked.value)
        assertEquals(ProximityHandleOrigin.DEDICATED, picked.origin)
        assertEquals(picked, ProximityHandle.fromParts("north-wing-3", ProximityHandleOrigin.DEDICATED, salt, other))
    }

    private fun resolved(entries: List<RosterEntry>, name: String) = entries.map { entry ->
        val handle = ProximityHandle.resolve(entry.dedicated, entry.salt, entry.sender)
        assertEquals(name, entry.handle, handle.value)
        entry.sender to handle
    }

    @Test fun equalHandlesInARosterAreShownWithAKeyFingerprint() {
        val cases = vectors().rosters.groupBy { it.name }
        assertTrue(cases.size >= 6)
        var disambiguated = 0; var extended = 0
        for ((name, entries) in cases) {
            val labels = ProximityHandle.disambiguate(entries.first().salt, resolved(entries, name))
            assertEquals(name, entries.size, labels.size)
            for ((label, entry) in labels.zip(entries)) {
                assertEquals(name, entry.sender, label.senderPublicKey)
                assertEquals(name, entry.fingerprint, label.fingerprint)
                assertEquals(name, entry.fingerprint?.let { "${entry.handle} [$it]" } ?: entry.handle, label.display)
                entry.fingerprint?.let { fingerprint ->
                    assertTrue(name, ProximityHandle.fingerprint(entry.salt, entry.sender).startsWith(fingerprint))
                    // The disambiguated display is not a handle and cannot be stored as one.
                    assertFalse(name, ProximityHandle.isValid(label.display))
                    disambiguated++; if (fingerprint.length > 8) extended++
                }
            }
            // Every provisioned sender of a roster ends with a display of its own.
            assertEquals(name, entries.size, labels.map { it.display }.toSet().size)
        }
        assertTrue(disambiguated >= 11 && extended >= 2)
    }

    /**
     * The groups cover every provisioned sender. A sender whose handle equals an absent member's is labelled
     * with its fingerprint before that member ever checks in.
     */
    @Test fun collisionGroupsCoverProvisionedSendersThatHaveNotCheckedIn() {
        var guarded = 0
        for ((name, entries) in vectors().rosters.groupBy { it.name }) {
            val provisioned = resolved(entries, name)
            val present = entries.filter { it.present }; val observed = present.map { it.sender }
            val salt = entries.first().salt
            val labels = ProximityHandle.labelsFor(salt, provisioned, observed)
            assertEquals(name, present.size, labels.size)
            for ((label, entry) in labels.zip(present)) {
                assertEquals(name, entry.sender, label.senderPublicKey)
                assertEquals(name, entry.handle, label.handle.value)
                assertEquals(name, entry.fingerprint, label.fingerprint)
            }
            // Refusal mutation: groups restricted to the senders seen so far. Where a present sender shares
            // its handle only with absent members, that computation shows the bare handle.
            val observedOnly = provisioned.filter { it.first in observed }
            for ((label, weak) in labels.zip(ProximityHandle.disambiguate(salt, observedOnly))) {
                val holders = provisioned.count { it.second.value == label.handle.value }
                val presentHolders = observedOnly.count { it.second.value == label.handle.value }
                if (holders > 1 && presentHolders == 1) {
                    assertNotNull(name, label.fingerprint)
                    assertNull("$name: the narrowed groups miss it", weak.fingerprint)
                    guarded++
                }
            }
            // A label does not change when the absent members appear.
            val later = ProximityHandle.labelsFor(salt, provisioned, entries.map { it.sender })
            for (label in labels) assertTrue(name, label in later)
        }
        assertTrue("the vectors must hold a handle shared with an absent member", guarded >= 2)
        // A sender the roster does not hold is not labelled at all.
        val anySalt = ByteArray(32) { 1 }
        try { ProximityHandle.labelsFor(anySalt, emptyList(), listOf(ProximityPublicKey(ByteArray(32) { 9 }))); fail("an unknown sender was labelled") }
        catch (error: ProximityFailure) { assertEquals(ProximityError.UNAUTHORIZED, error.reason) }
        assertTrue(ProximityHandle.labelsFor(anySalt, emptyList(), emptyList()).isEmpty())
    }

    @Test fun rosterFingerprintsMatchTheSharedVectors() {
        val shared = vectors()
        assertTrue(shared.fingerprints.size >= 10)
        for (vector in shared.fingerprints) {
            assertEquals(64, vector.handle.length)
            assertEquals(vector.handle, ProximityHandle.fingerprint(vector.salt, vector.sender))
        }
    }

    /**
     * The organisation binding: one sender key, two organisations, two fingerprints. The fingerprint beside a
     * handle must not link a member across organisations.
     */
    @Test fun theSameSenderKeyYieldsDifferentFingerprintsInTwoOrganisations() {
        val shared = vectors(); var compared = 0
        for (one in shared.fingerprints) for (other in shared.fingerprints) {
            if (one.sender != other.sender || one.salt.contentEquals(other.salt)) continue
            // Not even the shortest displayed prefix is shared.
            assertNotEquals(one.handle.take(ProximityHandle.MIN_FINGERPRINT_HEX_CHARS), other.handle.take(ProximityHandle.MIN_FINGERPRINT_HEX_CHARS))
            assertNotEquals(ProximityHandle.fingerprint(one.salt, one.sender), ProximityHandle.fingerprint(other.salt, one.sender))
            compared++
        }
        assertTrue("the vectors must hold each sender in two organisations", compared >= 10)
        // The same roster in two organisations is shown with different fingerprints.
        val roster = listOf(ProximityPublicKey(ByteArray(32) { 1 }) to ProximityHandle.dedicated("north-wing-3"),
            ProximityPublicKey(ByteArray(32) { 2 }) to ProximityHandle.dedicated("north-wing-3"))
        val here = ProximityHandle.disambiguate(ByteArray(32) { 0x42 }, roster)
        val elsewhere = ProximityHandle.disambiguate(ByteArray(32) { 0x43 }, roster)
        for ((one, other) in here.zip(elsewhere)) {
            assertNotNull(one.fingerprint); assertNotNull(other.fingerprint)
            assertNotEquals(one.fingerprint, other.fingerprint)
        }
    }

    /**
     * Refusal mutation on the binding itself: a fingerprint that ignores the organisation (one fixed binding
     * for everyone) matches no shared vector.
     */
    @Test fun aFingerprintWithoutTheOrganisationBindingMatchesNoSharedVector() {
        for (vector in vectors().fingerprints) {
            assertNotEquals(vector.handle, ProximityHandle.deriveFingerprint(ByteArray(0), vector.sender))
            assertEquals(vector.handle, ProximityHandle.deriveFingerprint(vector.salt, vector.sender))
        }
    }

    @Test fun aKeyListedTwiceDoesNotCollideWithItself() {
        val salt = ByteArray(32) { 0x42 }; val sender = ProximityPublicKey(ByteArray(32) { 9 })
        val handle = ProximityHandle.generated(salt, sender)
        assertTrue(ProximityHandle.disambiguate(salt, listOf(sender to handle, sender to handle)).all { it.fingerprint == null })
        assertTrue(ProximityHandle.disambiguate(salt, emptyList()).isEmpty())
        assertEquals(64, ProximityHandle.fingerprint(salt, sender).length)
        // A fingerprint needs its organisation: a salt of the wrong size is refused.
        for (size in listOf(0, 31, 33)) refuses { ProximityHandle.fingerprint(ByteArray(size), sender) }
    }
}
