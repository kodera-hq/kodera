package io.kodera.android.client

import io.kodera.android.domain.Kdv1SessionVaultCodec
import io.kodera.android.domain.KoderaMobileFfiError
import io.kodera.android.domain.KoderaMobileFfiFailure
import java.io.File
import java.io.IOException
import java.security.GeneralSecurityException

/**
 * Android Keystore-backed `KDV1` AES-256-GCM session vault persisted atomically at
 * `filesDir/session/rust-vault.bin` (excluded from cloud backup and device-to-device transfer)
 * and cryptographically bound to `(organisationId, deviceId)` AAD.
 */
class RustSessionVault(
    private val file: File,
    private val keys: SessionKeys,
) {
    private val lock = Any()
    private val pendingFile = File(file.parentFile, file.name + ".pending")

    fun seal(
        organisationId: String,
        deviceId: String,
        plaintext: ByteArray,
        deterministicNonceForTest: ByteArray? = null,
    ): ByteArray = synchronized(lock) {
        sealLocked(organisationId, deviceId, plaintext, deterministicNonceForTest)
    }

    /**
     * Re-checks [isActive] inside the vault's serializing [lock] immediately before writing ciphertext,
     * preventing any late Matrix login or token refresh from recreating a vault wiped by `signOut`.
     */
    fun sealIfActive(
        organisationId: String,
        deviceId: String,
        plaintext: ByteArray,
        deterministicNonceForTest: ByteArray? = null,
        isActive: () -> Boolean,
    ): ByteArray? = synchronized(lock) {
        if (!isActive()) return null
        sealLocked(organisationId, deviceId, plaintext, deterministicNonceForTest)
    }

    private fun sealLocked(
        organisationId: String,
        deviceId: String,
        plaintext: ByteArray,
        deterministicNonceForTest: ByteArray?,
    ): ByteArray {
        val secretKey = try {
            keys.getOrCreate()
        } catch (_: GeneralSecurityException) {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.AUTHENTICATION_FAILED)
        } catch (_: RuntimeException) {
            throw KoderaMobileFfiFailure(KoderaMobileFfiError.AUTHENTICATION_FAILED)
        }
        val sealed = Kdv1SessionVaultCodec.sealWithSecretKey(
            organisationId = organisationId,
            deviceId = deviceId,
            secretKey = secretKey,
            nonceBytes = deterministicNonceForTest,
            plaintext = plaintext,
        )
        try {
            file.parentFile?.mkdirs()
            pendingFile.writeBytes(sealed)
            if (!pendingFile.renameTo(file)) {
                throw IOException("rename failed")
            }
        } catch (_: IOException) {
            pendingFile.delete()
            throw TokenStoreException("rust vault unwritable")
        }
        return sealed
    }

    fun open(
        organisationId: String,
        deviceId: String,
    ): ByteArray? = synchronized(lock) {
        if (!file.exists()) return null
        val sealed = try {
            file.readBytes()
        } catch (_: IOException) {
            throw TokenStoreException("rust vault unreadable")
        }
        val secretKey = try {
            keys.existing()
        } catch (_: GeneralSecurityException) {
            null
        } catch (_: RuntimeException) {
            null
        } ?: throw KoderaMobileFfiFailure(KoderaMobileFfiError.AUTHENTICATION_FAILED)

        Kdv1SessionVaultCodec.openWithSecretKey(
            organisationId = organisationId,
            deviceId = deviceId,
            secretKey = secretKey,
            sealed = sealed,
        )
    }

    fun wipe() = synchronized(lock) {
        wipeLocked()
    }

    /** Atomically runs [beforeWipe] (such as session fence invalidation) and wipes the vault under [lock]. */
    fun retireAndWipe(beforeWipe: () -> Unit = {}) = synchronized(lock) {
        beforeWipe()
        wipeLocked()
    }

    private fun wipeLocked() {
        var keyDestroyFailed = false
        try {
            keys.destroy()
        } catch (_: GeneralSecurityException) {
            keyDestroyFailed = true
        } catch (_: RuntimeException) {
            keyDestroyFailed = true
        }
        val pendingRemoved = !pendingFile.exists() || pendingFile.delete()
        val removed = !file.exists() || file.delete()
        if (keyDestroyFailed || !pendingRemoved || !removed) {
            throw TokenStoreException("rust vault not wiped")
        }
    }
}
