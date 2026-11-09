package io.kodera.android.client

import java.io.File
import java.io.IOException
import java.security.GeneralSecurityException
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class TokenStoreException(message: String) : Exception(message)

/** Where the serialised grant lives between launches. Implementations never log its content. */
interface TokenStore {
    /** @throws TokenStoreException when something is stored but cannot be read back. */
    fun load(): ByteArray?
    /** @throws TokenStoreException */
    fun save(data: ByteArray)
    /** @throws TokenStoreException when the stored state could not be removed. */
    fun wipe()
}

/** Tests and previews only: nothing survives the process. */
class InMemoryTokenStore(initial: ByteArray? = null) : TokenStore {
    private val lock = Any()
    private var data: ByteArray? = initial?.copyOf()
    var saves = 0
        private set
    override fun load(): ByteArray? = synchronized(lock) { data?.copyOf() }
    override fun save(data: ByteArray) { synchronized(lock) { saves++; this.data = data.copyOf() } }
    override fun wipe() { synchronized(lock) { data = null } }
}

/**
 * The AES key that seals the session file. On Android it is a non-exportable Android Keystore key;
 * tests supply a software key.
 */
interface SessionKeys {
    /** The current key, or null when none exists. */
    fun existing(): SecretKey?
    fun getOrCreate(): SecretKey
    /** Delete the key, so no copy of the sealed file can ever be opened again. */
    fun destroy()
}

/**
 * One file sealed with AES-256-GCM: `version (1) | iv length (12) | iv | ciphertext and tag`, with a
 * fixed associated-data label. The cipher draws the IV, as the Keystore requires. Writes go to a
 * sibling file that is renamed over the old one, so a crash leaves the old state or the new one.
 */
class EncryptedFileTokenStore(private val file: File, private val keys: SessionKeys) : TokenStore {
    private val lock = Any()
    private val pending = File(file.parentFile, file.name + ".pending")

    override fun load(): ByteArray? = synchronized(lock) {
        if (!file.exists()) return null
        val sealed = try { file.readBytes() } catch (_: IOException) { throw TokenStoreException("unreadable") }
        if (sealed.size < 2 + IV_BYTES + TAG_BYTES || sealed.size > MAX_BYTES || sealed[0] != VERSION ||
            sealed[1].toInt() != IV_BYTES) throw TokenStoreException("unrecognised")
        val key = try { keys.existing() } catch (_: GeneralSecurityException) { null } catch (_: RuntimeException) { null }
            ?: throw TokenStoreException("no key")
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BYTES * 8, sealed, 2, IV_BYTES))
            cipher.updateAAD(AAD)
            cipher.doFinal(sealed, 2 + IV_BYTES, sealed.size - 2 - IV_BYTES)
        } catch (_: GeneralSecurityException) { throw TokenStoreException("unsealable") }
        catch (_: RuntimeException) { throw TokenStoreException("unsealable") }
    }

    override fun save(data: ByteArray): Unit = synchronized(lock) {
        val sealed = try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, keys.getOrCreate())
            val iv = cipher.iv
            if (iv == null || iv.size != IV_BYTES) throw TokenStoreException("unexpected iv")
            cipher.updateAAD(AAD)
            byteArrayOf(VERSION, IV_BYTES.toByte()) + iv + cipher.doFinal(data)
        } catch (_: GeneralSecurityException) { throw TokenStoreException("unsealable") }
        catch (_: RuntimeException) { throw TokenStoreException("unsealable") }
        if (sealed.size > MAX_BYTES) throw TokenStoreException("too large")
        try {
            file.parentFile?.mkdirs()
            pending.writeBytes(sealed)
            if (!pending.renameTo(file)) throw IOException("rename")
        } catch (_: IOException) {
            pending.delete()
            throw TokenStoreException("unwritable")
        }
    }

    override fun wipe(): Unit = synchronized(lock) {
        // Attempt key destruction first; retained ciphertext is unreadable only if that succeeds.
        try { keys.destroy() } catch (_: GeneralSecurityException) { } catch (_: RuntimeException) { }
        pending.delete()
        val removed = !file.exists() || file.delete()
        if (!removed) throw TokenStoreException("not removed")
    }

    private companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val VERSION: Byte = 1
        const val IV_BYTES = 12
        const val TAG_BYTES = 16
        const val MAX_BYTES = 256 * 1024
        val AAD = "io.kodera.app session v1".toByteArray(Charsets.US_ASCII)
    }
}
