package io.kodera.android.domain

import java.security.KeyFactory
import java.security.NoSuchAlgorithmException
import java.security.Signature
import java.security.spec.InvalidKeySpecException
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer

/** RFC 8032 Ed25519 over raw keys: a 32-byte public key or private seed and a 64-byte signature. */
interface Ed25519Primitive {
    fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean
    fun sign(seed: ByteArray, message: ByteArray): ByteArray
}

/**
 * The platform JCA provider. Android has Ed25519 only from API 33 and every JDK from 15; elsewhere this throws
 * [NoSuchAlgorithmException], or [InvalidKeySpecException] when a provider has the algorithm but not these encodings.
 */
object PlatformEd25519 : Ed25519Primitive {
    private val publicPrefix = decodeEmergencyHex("302a300506032b6570032100")
    private val privatePrefix = decodeEmergencyHex("302e020100300506032b657004220420")
    override fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean {
        val key = KeyFactory.getInstance("Ed25519").generatePublic(X509EncodedKeySpec(publicPrefix + publicKey))
        return Signature.getInstance("Ed25519").run { initVerify(key); update(message); verify(signature) }
    }
    override fun sign(seed: ByteArray, message: ByteArray): ByteArray {
        val key = KeyFactory.getInstance("Ed25519").generatePrivate(PKCS8EncodedKeySpec(privatePrefix + seed))
        return Signature.getInstance("Ed25519").run { initSign(key); update(message); sign() }
    }
}

/**
 * BouncyCastle's lightweight Ed25519, called directly. It is never registered as a JCA provider, because Android
 * ships its own stripped provider under the name "BC".
 */
object BundledEd25519 : Ed25519Primitive {
    override fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean {
        if (publicKey.size != Ed25519PublicKeyParameters.KEY_SIZE || signature.size != Ed25519PrivateKeyParameters.SIGNATURE_SIZE)
            return false
        val key = try { Ed25519PublicKeyParameters(publicKey, 0) } catch (error: IllegalArgumentException) { return false }
        return Ed25519Signer().run { init(false, key); update(message, 0, message.size); verifySignature(signature) }
    }
    override fun sign(seed: ByteArray, message: ByteArray): ByteArray {
        require(seed.size == Ed25519PrivateKeyParameters.KEY_SIZE)
        return Ed25519Signer().run {
            init(true, Ed25519PrivateKeyParameters(seed, 0)); update(message, 0, message.size); generateSignature()
        }
    }
    fun publicKey(seed: ByteArray): ByteArray {
        require(seed.size == Ed25519PrivateKeyParameters.KEY_SIZE)
        return Ed25519PrivateKeyParameters(seed, 0).generatePublicKey().encoded
    }
}

/**
 * Tries [platform] on every call and uses [fallback] when the platform has no Ed25519 or cannot take raw keys, so
 * Android 8 to 12 verify and sign like Android 13 and the JVM. Ed25519 is deterministic: both give the same bytes.
 */
class PlatformOrBundledEd25519(
    private val platform: Ed25519Primitive = PlatformEd25519,
    private val fallback: Ed25519Primitive = BundledEd25519,
) : Ed25519Primitive {
    override fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean =
        withFallback { it.verify(publicKey, message, signature) }
    override fun sign(seed: ByteArray, message: ByteArray): ByteArray = withFallback { it.sign(seed, message) }
    private inline fun <T> withFallback(call: (Ed25519Primitive) -> T): T = try { call(platform) }
        catch (error: NoSuchAlgorithmException) { call(fallback) }
        catch (error: InvalidKeySpecException) { call(fallback) }
}

/** Emergency frame verification over [ed25519]; any other cryptographic failure is a refusal. */
class Ed25519SignatureVerifier(private val ed25519: Ed25519Primitive = PlatformOrBundledEd25519()) : EmergencySignatureVerifier {
    override fun verify(publicKey: EmergencyPublicKey, transcript: ByteArray, signature: ByteArray): Boolean = try {
        ed25519.verify(publicKey.bytes(), transcript, signature)
    } catch (error: NoSuchAlgorithmException) {
        throw EmergencyFailure(EmergencyError.CRYPTO_UNAVAILABLE)
    } catch (error: java.security.GeneralSecurityException) { false }
}

/** A device key held as its 32-byte RFC 8032 seed. The caller owns where the seed is provisioned and kept. */
class Ed25519EmergencySigner(seed: ByteArray, private val ed25519: Ed25519Primitive = PlatformOrBundledEd25519()) : EmergencySigner {
    private val seed = seed.copyOf()
    override val publicKey = EmergencyPublicKey(BundledEd25519.publicKey(this.seed))
    override fun sign(transcript: ByteArray): ByteArray = ed25519.sign(seed.copyOf(), transcript)
}
