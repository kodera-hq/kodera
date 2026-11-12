package io.kodera.android.domain

import org.junit.Assert.*
import org.junit.Test

/**
 * Holds this codec to `packages/kodera-rs/vectors/proximity-frame-v1.txt`, the file `kodera-rs` and the iOS
 * client read too. The v1 wire format is frozen: these tests fail when a byte moves.
 */
class ProximityFrameVectorTests {
    private class FrameVector(val name: String, val ttlHops: Int, val status: Int, val timestampMillis: Long,
        val text: ByteArray, val wire: ByteArray, val transcript: ByteArray)
    private class Vectors {
        val constants = linkedMapOf<String, String>(); val frames = mutableListOf<FrameVector>()
        val refused = mutableListOf<Pair<String, ByteArray>>()
    }

    /** Strict: a line outside the grammar fails the test rather than being skipped. */
    private fun vectors(): Vectors {
        val path = "packages/kodera-rs/vectors/proximity-frame-v1.txt"
        val root = generateSequence(java.io.File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .first { java.io.File(it, path).isFile }
        val parsed = Vectors()
        java.io.File(root, path).readLines(Charsets.UTF_8).filter { it.isNotEmpty() && !it.startsWith("#") }.forEach { line ->
            val f = line.split(" ")
            when {
                f[0] == "const" && f.size == 3 -> assertNull(line, parsed.constants.put(f[1], f[2]))
                f[0] == "frame" && f.size == 8 -> parsed.frames += FrameVector(f[1], f[2].toInt(), f[3].toInt(), f[4].toLong(),
                    if (f[5] == "-") ByteArray(0) else decodeProximityHex(f[5]), decodeProximityHex(f[6]), decodeProximityHex(f[7]))
                f[0] == "refuse" && f.size == 3 -> parsed.refused += f[1] to decodeProximityHex(f[2])
                else -> fail("unknown line in the shared frame vectors: $line")
            }
        }
        return parsed
    }

    /**
     * True when [wire] is, for this codec, exactly the frame the vector states: it decodes to the stated fields,
     * encodes back to the vector's own bytes and signs the vector's own transcript.
     */
    private fun conforms(vector: FrameVector, wire: ByteArray): Boolean {
        val frame = try { ProximityFrame.decode(wire) } catch (error: ProximityFailure) { return false }
        return frame.ttlHops == vector.ttlHops && frame.status.wire == vector.status &&
            frame.messageId.timestampMillis == vector.timestampMillis &&
            frame.text.toByteArray(Charsets.UTF_8).contentEquals(vector.text) &&
            frame.encode().contentEquals(vector.wire) && frame.signingTranscript().contentEquals(vector.transcript)
    }

    @Test fun sharedVectorsStateTheFrozenConstantsThisCodecEncodes() {
        val shared = vectors()
        assertEquals(7, shared.constants.size)
        assertEquals("4b45", shared.constants["magic_hex"])
        assertEquals("1", shared.constants["version"])
        assertEquals("118", shared.constants["fixed_overhead_bytes"])
        assertEquals(ProximityFrame.MAX_WIRE_BYTES.toString(), shared.constants["max_frame_bytes"])
        assertEquals(ProximityFrame.MAX_TEXT_BYTES.toString(), shared.constants["max_text_bytes"])
        assertEquals("6", shared.constants["max_ttl_hops"])
        // The signed label keeps the channel's first name: it is wire, not vocabulary.
        val label = decodeProximityHex(shared.constants.getValue("signing_label_hex"))
        assertArrayEquals("kodera-emergency-v1:".toByteArray(Charsets.US_ASCII), label)
        val canonical = ProximityFrame.decode(shared.frames.first().wire)
        assertArrayEquals(decodeProximityHex("4b4501"), canonical.encode().copyOf(3))
        assertArrayEquals(label, canonical.signingTranscript().copyOf(label.size))
    }

    @Test fun everySharedFrameDecodesEncodesAndSignsByteForByte() {
        val shared = vectors()
        assertTrue(shared.frames.size >= 5)
        assertEquals("canonical", shared.frames.first().name)
        assertEquals(129, shared.frames.first().wire.size)
        val statuses = sortedSetOf<Int>(); val sizes = sortedSetOf<Int>()
        for (vector in shared.frames) {
            assertTrue(vector.name, conforms(vector, vector.wire))
            val frame = ProximityFrame.decode(vector.wire)
            assertArrayEquals(vector.name, vector.wire.copyOfRange(vector.wire.size - 64, vector.wire.size), frame.signature())
            assertArrayEquals(vector.name, vector.wire.copyOfRange(19, 51), frame.senderPublicKey.bytes())
            // Every shared frame carries a genuine Ed25519 signature; the production verifier accepts it.
            frame.verify(setOf(frame.senderPublicKey))
            statuses += vector.status; sizes += vector.wire.size
        }
        assertEquals(listOf(0, 1, 2, 3), statuses.toList())
        assertTrue(118 in sizes && 256 in sizes)
    }

    @Test fun everySharedRefusedFrameFailsToDecode() {
        val shared = vectors()
        assertTrue(shared.refused.size >= 15)
        for ((name, wire) in shared.refused) {
            try { ProximityFrame.decode(wire); fail("$name decoded") } catch (error: ProximityFailure) { /* refused */ }
        }
    }

    /**
     * Refusal mutation: flip one bit of a shared frame at every offset. The vector check must fail each time,
     * so no byte of the frozen layout is outside what the vectors pin.
     */
    @Test fun flippingAnySingleByteOfASharedFrameBreaksConformance() {
        for (vector in vectors().frames) {
            for (offset in vector.wire.indices) {
                val mutated = vector.wire.copyOf()
                mutated[offset] = (mutated[offset].toInt() xor 0x01).toByte()
                assertFalse("${vector.name}: byte $offset is not pinned", conforms(vector, mutated))
            }
            assertFalse(conforms(vector, vector.wire.copyOfRange(1, vector.wire.size)))
            assertFalse(conforms(vector, vector.wire.copyOf(vector.wire.size - 1)))
            assertFalse(conforms(vector, vector.wire + byteArrayOf(0)))
        }
    }
}
