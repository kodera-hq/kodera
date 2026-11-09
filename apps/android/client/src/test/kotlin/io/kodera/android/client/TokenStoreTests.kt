package io.kodera.android.client

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.file.Files
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** A software AES key standing in for the Android Keystore one. */
private class SoftwareKeys : SessionKeys {
    var key: SecretKey? = null
    var destroyed = 0
    var onDestroy: () -> Unit = {}
    override fun existing(): SecretKey? = key
    override fun getOrCreate(): SecretKey = key ?: KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().also { key = it }
    override fun destroy() { onDestroy(); destroyed++; key = null }
}

class TokenStoreTests {
    private val secret = """{"version":1,"issuer":"https://auth.kodera.test/realms/acme-sa","state":"refresh-SECRET-1"}""".toByteArray()

    private fun scratch(): File = Files.createTempDirectory("kodera-token-store").toFile().also { it.deleteOnExit() }

    private fun refused(block: () -> Unit) {
        try { block(); fail("unreadable state was accepted") } catch (_: TokenStoreException) { }
    }

    @Test fun testInMemoryRoundTripAndWipe() {
        val store = InMemoryTokenStore()
        assertNull(store.load())
        store.save(secret)
        assertArrayEquals(secret, store.load())
        store.wipe()
        assertNull(store.load())
    }

    @Test fun testSealedFileRoundTripsAndHoldsNoPlaintext() {
        val file = File(scratch(), "session/core-session.bin")
        val keys = SoftwareKeys()
        val store = EncryptedFileTokenStore(file, keys)
        assertNull(store.load())
        store.save(secret)
        assertArrayEquals(secret, store.load())
        val sealed = file.readBytes()
        assertEquals("version", 1, sealed[0].toInt())
        assertEquals("iv length", 12, sealed[1].toInt())
        assertFalse(String(sealed, Charsets.ISO_8859_1).contains("SECRET"))
        assertFalse("no pending file is left behind", File(file.parentFile, file.name + ".pending").exists())
        // A fresh IV each time: the same state never seals to the same bytes.
        store.save(secret)
        assertFalse(sealed.contentEquals(file.readBytes()))
        assertArrayEquals(secret, EncryptedFileTokenStore(file, keys).load())
    }

    @Test fun testWipeRemovesTheFileAndTheKey() {
        val file = File(scratch(), "session/core-session.bin")
        val keys = SoftwareKeys()
        val store = EncryptedFileTokenStore(file, keys)
        store.save(secret)
        val copy = file.readBytes()
        store.wipe()
        assertFalse(file.exists())
        assertEquals(1, keys.destroyed)
        assertNull(store.load())
        // A copy taken before the wipe cannot be opened with the key that replaces it.
        store.save("other".toByteArray())
        file.writeBytes(copy)
        refused { store.load() }
    }

    @Test fun testWipeDestroysTheKeyBeforeItDeletesTheFile() {
        val file = File(scratch(), "session/core-session.bin")
        val keys = SoftwareKeys()
        val store = EncryptedFileTokenStore(file, keys)
        store.save(secret)
        var fileAtDestroy: Boolean? = null
        keys.onDestroy = { fileAtDestroy = file.exists() }
        store.wipe()
        assertEquals("the key is destroyed while the file is still there", true, fileAtDestroy)
        assertFalse(file.exists())
    }

    @Test fun testAWipeThatCannotDeleteTheFileStillDestroysTheKey() {
        val file = File(scratch(), "session/core-session.bin")
        val keys = SoftwareKeys()
        val store = EncryptedFileTokenStore(file, keys)
        store.save(secret)
        // A non-empty directory in the file's place cannot be deleted.
        assertTrue(file.delete() && file.mkdirs() && File(file, "pinned").createNewFile())
        refused { store.wipe() }
        assertEquals(1, keys.destroyed)
        assertNull(keys.existing())
    }

    @Test fun testTamperedTruncatedOrForeignFilesAreRefused() {
        val file = File(scratch(), "core-session.bin")
        val keys = SoftwareKeys()
        val store = EncryptedFileTokenStore(file, keys)
        store.save(secret)
        val sealed = file.readBytes()
        for (mutation in listOf<(ByteArray) -> ByteArray>(
            { it.copyOf().also { b -> b[b.size - 1] = (b[b.size - 1].toInt() xor 1).toByte() } },
            { it.copyOf().also { b -> b[5] = (b[5].toInt() xor 1).toByte() } },
            { it.copyOf().also { b -> b[0] = 2 } },
            { it.copyOf().also { b -> b[1] = 16 } },
            { it.copyOf(20) },
            { ByteArray(0) },
        )) {
            file.writeBytes(mutation(sealed))
            refused { store.load() }
        }
    }

    @Test fun testAFileWithoutItsKeyIsRefused() {
        val file = File(scratch(), "core-session.bin")
        val keys = SoftwareKeys()
        EncryptedFileTokenStore(file, keys).save(secret)
        keys.key = null
        refused { EncryptedFileTokenStore(file, keys).load() }
        keys.getOrCreate()
        refused { EncryptedFileTokenStore(file, keys).load() }
    }

    @Test fun testAnUnwritableLocationIsAStorageFailure() {
        val blocker = File(scratch(), "session").apply { writeText("a file, not a directory") }
        val store = EncryptedFileTokenStore(File(blocker, "core-session.bin"), SoftwareKeys())
        refused { store.save(secret) }
        assertTrue(blocker.isFile)
    }
}
