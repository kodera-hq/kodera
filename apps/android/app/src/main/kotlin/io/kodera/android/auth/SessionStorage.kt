package io.kodera.android.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import io.kodera.android.client.EncryptedFileTokenStore
import io.kodera.android.client.RustSessionVault
import io.kodera.android.client.SessionKeys
import io.kodera.android.client.TokenStore
import java.io.File
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** Where the sealed session lives on this device. */
internal object SessionStorage {
    /**
     * Under filesDir. res/xml/data_extraction_rules.xml and res/xml/backup_rules.xml exclude this
     * directory from cloud backup and device-to-device transfer; SessionStorageTests ties the two.
     */
    const val SESSION_DIRECTORY = "session"
    private const val SESSION_FILE = "core-session.bin"
    const val RUST_VAULT_FILE = "rust-vault.bin"
    const val VAULT_DEVICE_ID_FILE = "vault-device-id.txt"
    const val PUSH_DEVICE_ID_FILE = "push-device-id.txt"
    const val VAULT_UNWIPED_MARKER_FILE = "vault-unwiped.flag"
    private const val KEY_ALIAS = "io.kodera.app.session"
    private const val RUST_VAULT_KEY_ALIAS = "io.kodera.app.rust_vault"

    /** Directory under [filesDir] excluded from cloud backup and device-to-device transfer. */
    fun sessionDirectory(filesDir: File): File = File(filesDir, SESSION_DIRECTORY)

    /** The sealed session file under [filesDir]. */
    fun sessionFile(filesDir: File): File = File(sessionDirectory(filesDir), SESSION_FILE)

    /** The KDV1 AES-256-GCM session vault file under [filesDir], excluded from cloud backup and transfer. */
    fun rustVaultFile(filesDir: File): File = File(sessionDirectory(filesDir), RUST_VAULT_FILE)

    /** Device identifier bound as AAD to the active session's KDV1 vault. */
    fun vaultDeviceIdFile(sessionDir: File): File = File(sessionDir, VAULT_DEVICE_ID_FILE)

    /** Registered payload-free push wakeup device identifier for explicit revocation on sign-out. */
    fun pushDeviceIdFile(sessionDir: File): File = File(sessionDir, PUSH_DEVICE_ID_FILE)

    /** Persistent refusal marker written if session vault destruction fails; blocks session restore until wiped. */
    fun unwipedMarkerFile(sessionDir: File): File = File(sessionDir, VAULT_UNWIPED_MARKER_FILE)

    fun store(context: Context): TokenStore = EncryptedFileTokenStore(sessionFile(context.filesDir), KeystoreSessionKeys(KEY_ALIAS))

    fun rustVault(context: Context): RustSessionVault =
        RustSessionVault(rustVaultFile(context.filesDir), KeystoreSessionKeys(RUST_VAULT_KEY_ALIAS))
}

/**
 * An AES-256-GCM key generated inside the Android Keystore: it never leaves it, cannot be exported,
 * and is not part of any backup. Usable after the first unlock, like the iOS Keychain item.
 */
internal class KeystoreSessionKeys(private val alias: String) : SessionKeys {
    private val lock = Any()

    private fun keyStore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

    override fun existing(): SecretKey? = synchronized(lock) { keyStore().getKey(alias, null) as? SecretKey }

    override fun getOrCreate(): SecretKey = synchronized(lock) {
        (keyStore().getKey(alias, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER).run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build())
            generateKey()
        }
    }

    override fun destroy() {
        synchronized(lock) { keyStore().run { if (containsAlias(alias)) deleteEntry(alias) } }
    }

    private companion object {
        const val PROVIDER = "AndroidKeyStore"
    }
}
