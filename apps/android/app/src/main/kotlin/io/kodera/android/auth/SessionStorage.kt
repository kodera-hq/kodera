package io.kodera.android.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import io.kodera.android.client.EncryptedFileTokenStore
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
    private const val KEY_ALIAS = "io.kodera.app.session"

    /** The sealed session file under [filesDir]. */
    fun sessionFile(filesDir: File): File = File(File(filesDir, SESSION_DIRECTORY), SESSION_FILE)

    fun store(context: Context): TokenStore = EncryptedFileTokenStore(sessionFile(context.filesDir), KeystoreSessionKeys(KEY_ALIAS))
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
