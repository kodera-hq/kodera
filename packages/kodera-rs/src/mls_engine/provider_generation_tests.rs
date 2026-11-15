//! Primitive qualification through the actual provider traits, not MLS suite admission.

use openmls_rust_crypto::RustCrypto;
use openmls_traits::{
    crypto::OpenMlsCrypto,
    random::OpenMlsRand,
    types::{
        AeadType, CryptoError, HpkeAeadType, HpkeCiphertext, HpkeConfig, HpkeKdfType, HpkeKemType,
        HpkeKeyPair, SignatureScheme,
    },
};
use tls_codec::SecretVLBytes;

const MESSAGE: &[u8] = b"public provider generation qualification message";
const INFO: &[u8] = b"public HPKE generation qualification info";
const AAD: &[u8] = b"public provider qualification associated data";

fn fresh_secret(crypto: &RustCrypto, len: usize) -> SecretVLBytes {
    crypto
        .random_vec(len)
        .expect("provider CSPRNG must generate qualification material")
        .into()
}

fn fresh_signer(crypto: &RustCrypto, scheme: SignatureScheme) -> (SecretVLBytes, Vec<u8>) {
    let (private, public) = crypto
        .signature_key_gen(scheme)
        .expect("provider must generate a genuine signature keypair");
    (private.into(), public)
}

fn refusal<T>(operation: impl FnOnce() -> Result<T, CryptoError>) -> CryptoError {
    refusal_at("provider input", operation)
}

fn refusal_at<T>(
    stage: &'static str,
    operation: impl FnOnce() -> Result<T, CryptoError>,
) -> CryptoError {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation)) {
        Ok(Err(error)) => error,
        Ok(Ok(_)) => panic!("malformed provider input was accepted at {stage}"),
        Err(_) => panic!(
            "malformed provider input panicked instead of returning a typed error at {stage}"
        ),
    }
}

// Test-only DER framing inspection of public signatures. No signing/verification
// implementation is substituted for the provider's real operations.
fn der_fixed_width(signature: &[u8], width: usize) -> Vec<u8> {
    assert!((8..=2 * width + 8).contains(&signature.len()));
    assert_eq!(signature[0], 0x30);
    assert_eq!(usize::from(signature[1]) + 2, signature.len());
    let mut cursor = 2;
    let mut fixed = Vec::with_capacity(2 * width);
    for _ in 0..2 {
        assert_eq!(signature[cursor], 0x02);
        let length = usize::from(signature[cursor + 1]);
        cursor += 2;
        assert!((1..=width + 1).contains(&length));
        assert!(cursor + length <= signature.len());
        let integer = &signature[cursor..cursor + length];
        assert_eq!(integer[0] & 0x80, 0);
        let unsigned = if integer.len() > 1 && integer[0] == 0 {
            assert_ne!(integer[1] & 0x80, 0);
            &integer[1..]
        } else {
            integer
        };
        assert!(unsigned.len() <= width);
        fixed.resize(fixed.len() + width - unsigned.len(), 0);
        fixed.extend_from_slice(unsigned);
        cursor += length;
    }
    assert_eq!(cursor, signature.len());
    fixed
}

fn signature_roundtrip(scheme: SignatureScheme, private_len: usize, public_len: usize) {
    let crypto = RustCrypto::default();
    let (private, public) = fresh_signer(&crypto, scheme);
    let (_, other_public) = fresh_signer(&crypto, scheme);
    assert_eq!(private.as_slice().len(), private_len);
    assert_eq!(public.len(), public_len);
    assert_ne!(public, other_public);
    let signature = crypto
        .sign(scheme, MESSAGE, private.as_slice())
        .expect("fresh private key must sign");
    assert_eq!(
        crypto.verify_signature(scheme, MESSAGE, &public, &signature),
        Ok(())
    );
    assert_eq!(
        crypto.verify_signature(scheme, b"different public message", &public, &signature),
        Err(CryptoError::InvalidSignature)
    );
    assert_eq!(
        crypto.verify_signature(scheme, MESSAGE, &other_public, &signature),
        Err(CryptoError::InvalidSignature)
    );
    if scheme == SignatureScheme::ED25519 {
        assert_eq!(signature.len(), 64);
    } else {
        assert_eq!(public[0], 0x04);
        let width = private_len;
        let fixed = der_fixed_width(&signature, width);
        assert_eq!(fixed.len(), 2 * width);
        assert_eq!(
            crypto.verify_signature(scheme, MESSAGE, &public, &fixed),
            Err(CryptoError::InvalidSignature)
        );
        // SEC1 compressed and uncompressed encodings of the SAME genuine key.
        let mut compressed = vec![0x02 | (public[2 * width] & 1)];
        compressed.extend_from_slice(&public[1..=width]);
        assert_eq!(compressed.len(), width + 1);
        assert_eq!(
            crypto.verify_signature(scheme, MESSAGE, &compressed, &signature),
            Ok(())
        );
    }
}

fn malformed_signature_inputs(scheme: SignatureScheme, private_len: usize) {
    let crypto = RustCrypto::default();
    let (private, public) = fresh_signer(&crypto, scheme);
    let signature = crypto
        .sign(scheme, MESSAGE, private.as_slice())
        .expect("healthy signer");
    assert_eq!(
        crypto.verify_signature(scheme, MESSAGE, &public, &signature),
        Ok(())
    );
    let short: SecretVLBytes = private.as_slice()[..private_len - 1].to_vec().into();
    let mut extended = private.as_slice().to_vec();
    extended.push(crypto.random_array::<1>().expect("fresh extension byte")[0]);
    let extended: SecretVLBytes = extended.into();
    let expected = if scheme == SignatureScheme::ED25519 {
        CryptoError::CryptoLibraryError
    } else {
        CryptoError::InvalidLength
    };
    for invalid in [short, extended] {
        assert_eq!(
            refusal(|| crypto.sign(scheme, MESSAGE, invalid.as_slice())),
            expected
        );
    }
    assert_eq!(
        refusal(|| crypto.verify_signature(
            scheme,
            MESSAGE,
            &public[..public.len() - 1],
            &signature
        )),
        CryptoError::CryptoLibraryError
    );
    if scheme == SignatureScheme::ED25519 {
        assert_eq!(
            refusal(|| crypto.verify_signature(scheme, MESSAGE, &public, &signature[..63])),
            CryptoError::CryptoLibraryError
        );
        let mut extended_signature = signature.clone();
        extended_signature.push(0);
        assert_eq!(
            refusal(|| crypto.verify_signature(scheme, MESSAGE, &public, &extended_signature)),
            CryptoError::CryptoLibraryError
        );
    } else {
        let mut invalid_point = public.clone();
        invalid_point[0] = 0x05; // An invalid SEC1 point tag, not a private scalar.
        assert_eq!(
            refusal(|| crypto.verify_signature(scheme, MESSAGE, &invalid_point, &signature)),
            CryptoError::CryptoLibraryError
        );
        let mut bad_tag = signature.clone();
        bad_tag[0] = 0x31;
        let mut trailing = signature.clone();
        trailing.push(0);
        for invalid in [bad_tag, trailing, signature[..signature.len() - 1].to_vec()] {
            assert_eq!(
                refusal(|| crypto.verify_signature(scheme, MESSAGE, &public, &invalid)),
                CryptoError::InvalidSignature
            );
        }
    }
    // Refusals must not substitute for a broken provider or poison healthy use.
    let fresh = crypto
        .sign(scheme, MESSAGE, private.as_slice())
        .expect("healthy signer after refusal");
    assert_eq!(
        crypto.verify_signature(scheme, MESSAGE, &public, &fresh),
        Ok(())
    );
}

#[test]
fn provider_generated_ed25519_signature_roundtrip() {
    signature_roundtrip(SignatureScheme::ED25519, 32, 32);
}

#[test]
fn provider_generated_p256_der_and_sec1_roundtrip() {
    signature_roundtrip(SignatureScheme::ECDSA_SECP256R1_SHA256, 32, 65);
}

#[test]
fn provider_generated_p384_der_and_sec1_roundtrip() {
    signature_roundtrip(SignatureScheme::ECDSA_SECP384R1_SHA384, 48, 97);
}

#[test]
fn provider_ed25519_malformed_lengths_are_typed_not_panics() {
    malformed_signature_inputs(SignatureScheme::ED25519, 32);
}

#[test]
fn provider_p256_malformed_private_point_and_der_are_typed_not_panics() {
    malformed_signature_inputs(SignatureScheme::ECDSA_SECP256R1_SHA256, 32);
}

#[test]
fn provider_p384_malformed_private_point_and_der_are_typed_not_panics() {
    malformed_signature_inputs(SignatureScheme::ECDSA_SECP384R1_SHA384, 48);
}

fn aead_roundtrip(algorithm: AeadType) {
    let crypto = RustCrypto::default();
    let key = fresh_secret(&crypto, algorithm.key_size());
    let nonce = crypto
        .random_vec(algorithm.nonce_size())
        .expect("fresh AEAD nonce");
    let ciphertext = crypto
        .aead_encrypt(algorithm, key.as_slice(), MESSAGE, &nonce, AAD)
        .expect("AEAD encrypt");
    assert_eq!(ciphertext.len(), MESSAGE.len() + algorithm.tag_size());
    let clear: SecretVLBytes = crypto
        .aead_decrypt(algorithm, key.as_slice(), &ciphertext, &nonce, AAD)
        .expect("AEAD decrypt")
        .into();
    assert!(clear.as_slice() == MESSAGE);
    let mut tampered = ciphertext.clone();
    *tampered.last_mut().expect("tag exists") ^= 1;
    assert_eq!(
        refusal(|| crypto.aead_decrypt(algorithm, key.as_slice(), &tampered, &nonce, AAD)),
        CryptoError::AeadDecryptionError
    );
    assert_eq!(
        refusal(|| crypto.aead_decrypt(
            algorithm,
            key.as_slice(),
            &ciphertext,
            &nonce,
            b"wrong AAD"
        )),
        CryptoError::AeadDecryptionError
    );
    let mut changed_nonce = nonce.clone();
    changed_nonce[0] ^= 1;
    assert_eq!(
        refusal(|| crypto.aead_decrypt(
            algorithm,
            key.as_slice(),
            &ciphertext,
            &changed_nonce,
            AAD
        )),
        CryptoError::AeadDecryptionError
    );
    assert_eq!(
        refusal(|| crypto.aead_decrypt(algorithm, key.as_slice(), &[], &nonce, AAD)),
        CryptoError::AeadDecryptionError
    );
}

fn aead_malformed_lengths(algorithm: AeadType) {
    let crypto = RustCrypto::default();
    let key = fresh_secret(&crypto, algorithm.key_size());
    let nonce = crypto
        .random_vec(algorithm.nonce_size())
        .expect("fresh AEAD nonce");
    let ciphertext = crypto
        .aead_encrypt(algorithm, key.as_slice(), MESSAGE, &nonce, AAD)
        .expect("healthy AEAD");
    let mut long_nonce = nonce.clone();
    long_nonce.push(crypto.random_array::<1>().expect("nonce extension")[0]);
    for invalid in [Vec::new(), nonce[..nonce.len() - 1].to_vec(), long_nonce] {
        assert_eq!(
            refusal(|| crypto.aead_encrypt(algorithm, key.as_slice(), MESSAGE, &invalid, AAD)),
            CryptoError::InvalidLength
        );
        assert_eq!(
            refusal(|| crypto.aead_decrypt(algorithm, key.as_slice(), &ciphertext, &invalid, AAD)),
            CryptoError::InvalidLength
        );
    }
    let short_key = fresh_secret(&crypto, algorithm.key_size() - 1);
    assert_eq!(
        refusal(|| crypto.aead_encrypt(algorithm, short_key.as_slice(), MESSAGE, &nonce, AAD)),
        CryptoError::CryptoLibraryError
    );
    assert_eq!(
        refusal(|| crypto.aead_decrypt(algorithm, short_key.as_slice(), &ciphertext, &nonce, AAD)),
        CryptoError::CryptoLibraryError
    );
    let healthy: SecretVLBytes = crypto
        .aead_decrypt(algorithm, key.as_slice(), &ciphertext, &nonce, AAD)
        .expect("healthy AEAD after refusal")
        .into();
    assert!(healthy.as_slice() == MESSAGE);
}

#[test]
fn provider_aes128_gcm_roundtrip_and_authentication_refusals() {
    aead_roundtrip(AeadType::Aes128Gcm);
}
#[test]
fn provider_aes256_gcm_roundtrip_and_authentication_refusals() {
    aead_roundtrip(AeadType::Aes256Gcm);
}
#[test]
fn provider_chacha20_poly1305_roundtrip_and_authentication_refusals() {
    aead_roundtrip(AeadType::ChaCha20Poly1305);
}
#[test]
fn provider_aes128_gcm_malformed_lengths_do_not_panic() {
    aead_malformed_lengths(AeadType::Aes128Gcm);
}
#[test]
fn provider_aes256_gcm_malformed_lengths_do_not_panic() {
    aead_malformed_lengths(AeadType::Aes256Gcm);
}
#[test]
fn provider_chacha20_poly1305_malformed_lengths_do_not_panic() {
    aead_malformed_lengths(AeadType::ChaCha20Poly1305);
}

#[derive(Clone, Copy)]
enum KemCase {
    X25519,
    P256,
    P384,
}

impl KemCase {
    fn config(self) -> HpkeConfig {
        match self {
            Self::X25519 => HpkeConfig(
                HpkeKemType::DhKem25519,
                HpkeKdfType::HkdfSha256,
                HpkeAeadType::AesGcm128,
            ),
            Self::P256 => HpkeConfig(
                HpkeKemType::DhKemP256,
                HpkeKdfType::HkdfSha256,
                HpkeAeadType::AesGcm128,
            ),
            Self::P384 => HpkeConfig(
                HpkeKemType::DhKemP384,
                HpkeKdfType::HkdfSha384,
                HpkeAeadType::AesGcm256,
            ),
        }
    }

    fn lengths(self) -> (usize, usize, usize) {
        match self {
            Self::X25519 => (32, 32, 32),
            Self::P256 => (32, 65, 32),
            Self::P384 => (48, 97, 48),
        }
    }
}

fn fresh_hpke(crypto: &RustCrypto, kind: KemCase) -> HpkeKeyPair {
    let ikm = fresh_secret(crypto, 64);
    crypto
        .derive_hpke_keypair(kind.config(), ikm.as_slice())
        .expect("fresh HPKE key derivation")
}

fn hpke_roundtrip(kind: KemCase) {
    let crypto = RustCrypto::default();
    let recipient = fresh_hpke(&crypto, kind);
    let other = fresh_hpke(&crypto, kind);
    let (private_len, public_len, _) = kind.lengths();
    assert_eq!(recipient.private.len(), private_len);
    assert_eq!(recipient.public.len(), public_len);
    assert_ne!(recipient.public, other.public);
    let ciphertext = crypto
        .hpke_seal(kind.config(), &recipient.public, INFO, AAD, MESSAGE)
        .expect("HPKE seal");
    assert_eq!(ciphertext.kem_output.as_slice().len(), public_len);
    let clear: SecretVLBytes = crypto
        .hpke_open(kind.config(), &ciphertext, &recipient.private, INFO, AAD)
        .expect("HPKE open")
        .into();
    assert!(clear.as_slice() == MESSAGE);
    let second = crypto
        .hpke_seal(kind.config(), &recipient.public, INFO, AAD, MESSAGE)
        .expect("fresh HPKE seal");
    assert_ne!(ciphertext.kem_output, second.kem_output);
    let malformed_public = refusal(|| {
        crypto.hpke_seal(
            kind.config(),
            &recipient.public[..public_len - 1],
            INFO,
            AAD,
            MESSAGE,
        )
    });
    assert!(matches!(
        malformed_public,
        CryptoError::InvalidLength | CryptoError::CryptoLibraryError
    ));
    assert_eq!(
        refusal(|| crypto.hpke_open(
            kind.config(),
            &ciphertext,
            &recipient.private,
            INFO,
            b"wrong AAD"
        )),
        CryptoError::HpkeDecryptionError
    );
    assert_eq!(
        refusal(|| crypto.hpke_open(
            kind.config(),
            &ciphertext,
            &recipient.private,
            b"wrong info",
            AAD
        )),
        CryptoError::HpkeDecryptionError
    );
    assert_eq!(
        refusal(|| crypto.hpke_open(kind.config(), &ciphertext, &other.private, INFO, AAD)),
        CryptoError::HpkeDecryptionError
    );
    let short_private: SecretVLBytes = recipient.private[..private_len - 1].to_vec().into();
    assert_eq!(
        refusal(|| crypto.hpke_open(
            kind.config(),
            &ciphertext,
            short_private.as_slice(),
            INFO,
            AAD
        )),
        CryptoError::HpkeDecryptionError
    );
    let malformed_enc = HpkeCiphertext {
        kem_output: ciphertext.kem_output.as_slice()[..public_len - 1]
            .to_vec()
            .into(),
        ciphertext: ciphertext.ciphertext.clone(),
    };
    assert_eq!(
        refusal(|| crypto.hpke_open(kind.config(), &malformed_enc, &recipient.private, INFO, AAD)),
        CryptoError::HpkeDecryptionError
    );
    let mut damaged = ciphertext.ciphertext.as_slice().to_vec();
    *damaged.last_mut().expect("HPKE tag exists") ^= 1;
    let damaged = HpkeCiphertext {
        kem_output: ciphertext.kem_output.clone(),
        ciphertext: damaged.into(),
    };
    assert_eq!(
        refusal(|| crypto.hpke_open(kind.config(), &damaged, &recipient.private, INFO, AAD)),
        CryptoError::HpkeDecryptionError
    );
    let healthy: SecretVLBytes = crypto
        .hpke_open(kind.config(), &ciphertext, &recipient.private, INFO, AAD)
        .expect("healthy HPKE after refusals")
        .into();
    assert!(healthy.as_slice() == MESSAGE);
}

fn hpke_exporter(kind: KemCase) {
    let crypto = RustCrypto::default();
    let recipient = fresh_hpke(&crypto, kind);
    let (private_len, public_len, hash_len) = kind.lengths();
    let (enc, sent) = crypto
        .hpke_setup_sender_and_export(kind.config(), &recipient.public, INFO, AAD, 32)
        .expect("HPKE sender/exporter setup");
    let received = crypto
        .hpke_setup_receiver_and_export(kind.config(), &enc, &recipient.private, INFO, AAD, 32)
        .expect("HPKE receiver/exporter setup");
    assert_eq!(sent.len(), 32);
    assert!(sent[..] == received[..]);
    // Export-only setup has no ciphertext authentication. Wrong domains yield
    // different exported secrets, not an invented decryption-error guarantee.
    let changed = crypto
        .hpke_setup_receiver_and_export(
            kind.config(),
            &enc,
            &recipient.private,
            INFO,
            b"changed export context",
            32,
        )
        .expect("valid setup with different exporter context");
    assert!(sent[..] != changed[..]);
    let changed_info = crypto
        .hpke_setup_receiver_and_export(
            kind.config(),
            &enc,
            &recipient.private,
            b"changed info",
            AAD,
            32,
        )
        .expect("valid setup with different info");
    assert!(sent[..] != changed_info[..]);
    assert_eq!(
        refusal_at("HPKE exporter sender public-key length", || crypto
            .hpke_setup_sender_and_export(
                kind.config(),
                &recipient.public[..public_len - 1],
                INFO,
                AAD,
                32
            )),
        CryptoError::SenderSetupError
    );
    assert_eq!(
        refusal_at("HPKE exporter receiver encapsulation length", || crypto
            .hpke_setup_receiver_and_export(
                kind.config(),
                &enc[..enc.len() - 1],
                &recipient.private,
                INFO,
                AAD,
                32
            )),
        CryptoError::ReceiverSetupError
    );
    let short_private: SecretVLBytes = recipient.private[..private_len - 1].to_vec().into();
    assert_eq!(
        refusal_at("HPKE exporter receiver private-key length", || crypto
            .hpke_setup_receiver_and_export(
                kind.config(),
                &enc,
                short_private.as_slice(),
                INFO,
                AAD,
                32
            )),
        CryptoError::ReceiverSetupError
    );
    assert_eq!(
        refusal_at("HPKE exporter output length", || crypto
            .hpke_setup_sender_and_export(
                kind.config(),
                &recipient.public,
                INFO,
                AAD,
                hash_len * 256
            )),
        CryptoError::ExporterError
    );
}

#[test]
fn provider_hpke_x25519_roundtrip_and_malformed_inputs() {
    hpke_roundtrip(KemCase::X25519);
}
#[test]
fn provider_hpke_p256_roundtrip_and_malformed_inputs() {
    hpke_roundtrip(KemCase::P256);
}
#[test]
fn provider_hpke_p384_roundtrip_and_malformed_inputs() {
    hpke_roundtrip(KemCase::P384);
}
#[test]
fn provider_hpke_x25519_exporter_domains_and_typed_refusals() {
    hpke_exporter(KemCase::X25519);
}
#[test]
fn provider_hpke_p256_exporter_domains_and_typed_refusals() {
    hpke_exporter(KemCase::P256);
}
#[test]
fn provider_hpke_p384_exporter_domains_and_typed_refusals() {
    hpke_exporter(KemCase::P384);
}
