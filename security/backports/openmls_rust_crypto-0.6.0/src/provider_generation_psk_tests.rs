//! Separate provider-package tests: requires its real targeted-messages-draft feature.

use std::cell::{Cell, RefCell};

use crate::RustCrypto;
use openmls_traits::{
    crypto::{HpkeSealPskResolvedAadError, OpenMlsCrypto},
    random::OpenMlsRand,
    types::{CryptoError, HpkeAeadType, HpkeConfig, HpkeKdfType, HpkeKemType},
};
use tls_codec::SecretVLBytes;

const MESSAGE: &[u8] = b"public provider PSK callback qualification";
const INFO: &[u8] = b"public PSK qualification info";
const AAD_PREFIX: &[u8] = b"public PSK qualification AAD";
const PSK_ID: &[u8] = b"public synthetic PSK identifier";

fn config(kem: HpkeKemType) -> HpkeConfig {
    match kem {
        HpkeKemType::DhKemP384 => HpkeConfig(kem, HpkeKdfType::HkdfSha384, HpkeAeadType::AesGcm256),
        _ => HpkeConfig(kem, HpkeKdfType::HkdfSha256, HpkeAeadType::AesGcm128),
    }
}

fn fresh(crypto: &RustCrypto, len: usize) -> SecretVLBytes {
    crypto
        .random_vec(len)
        .expect("fresh PSK qualification material")
        .into()
}

fn aad(enc: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(AAD_PREFIX.len() + enc.len());
    result.extend_from_slice(AAD_PREFIX);
    result.extend_from_slice(enc);
    result
}

fn roundtrip(kem: HpkeKemType) {
    let crypto = RustCrypto::default();
    let ikm = fresh(&crypto, 64);
    let recipient = crypto
        .derive_hpke_keypair(config(kem), ikm.as_slice())
        .expect("fresh recipient");
    let psk = fresh(&crypto, 32);
    let calls = Cell::new(0);
    let observed = RefCell::new(None);
    let sealed = crypto
        .hpke_seal_psk_resolved_aad(
            config(kem),
            &recipient.public,
            INFO,
            MESSAGE,
            psk.as_slice(),
            PSK_ID,
            |enc| {
                calls.set(calls.get() + 1);
                observed.replace(Some(enc.to_vec()));
                Ok::<_, ()>(aad(enc))
            },
        )
        .expect("real PSK callback seal");
    assert_eq!(calls.get(), 1);
    assert_eq!(
        observed.borrow().as_deref(),
        Some(sealed.kem_output.as_slice())
    );
    let associated = aad(sealed.kem_output.as_slice());
    let clear: SecretVLBytes = crypto
        .hpke_open_psk(
            config(kem),
            &sealed,
            &recipient.private,
            INFO,
            &associated,
            psk.as_slice(),
            PSK_ID,
        )
        .expect("real PSK open")
        .into();
    assert!(clear.as_slice() == MESSAGE);
    let mut wrong_psk = psk.as_slice().to_vec();
    wrong_psk[0] ^= 1;
    let wrong_psk: SecretVLBytes = wrong_psk.into();
    for result in [
        crypto.hpke_open_psk(
            config(kem),
            &sealed,
            &recipient.private,
            INFO,
            &associated,
            wrong_psk.as_slice(),
            PSK_ID,
        ),
        crypto.hpke_open_psk(
            config(kem),
            &sealed,
            &recipient.private,
            INFO,
            &associated,
            psk.as_slice(),
            b"wrong public PSK identifier",
        ),
        crypto.hpke_open_psk(
            config(kem),
            &sealed,
            &recipient.private,
            INFO,
            AAD_PREFIX,
            psk.as_slice(),
            PSK_ID,
        ),
    ] {
        match result {
            Err(error) => assert_eq!(error, CryptoError::HpkeDecryptionError),
            Ok(_) => panic!("changed PSK binding was accepted"),
        }
    }
}

#[test]
fn provider_psk_x25519_callback_binds_real_encapsulation_and_aad() {
    roundtrip(HpkeKemType::DhKem25519);
}
#[test]
fn provider_psk_p256_callback_binds_real_encapsulation_and_aad() {
    roundtrip(HpkeKemType::DhKemP256);
}
#[test]
fn provider_psk_p384_callback_binds_real_encapsulation_and_aad() {
    roundtrip(HpkeKemType::DhKemP384);
}

#[derive(Debug, PartialEq)]
enum AadRefusal {
    Expected,
}

#[test]
fn provider_psk_callback_error_is_typed_and_no_ciphertext_is_returned() {
    for kem in [
        HpkeKemType::DhKem25519,
        HpkeKemType::DhKemP256,
        HpkeKemType::DhKemP384,
    ] {
        roundtrip(kem);
        let crypto = RustCrypto::default();
        let ikm = fresh(&crypto, 64);
        let recipient = crypto
            .derive_hpke_keypair(config(kem), ikm.as_slice())
            .expect("fresh recipient");
        let psk = fresh(&crypto, 32);
        let calls = Cell::new(0);
        let result = crypto.hpke_seal_psk_resolved_aad(
            config(kem),
            &recipient.public,
            INFO,
            MESSAGE,
            psk.as_slice(),
            PSK_ID,
            |_enc| {
                calls.set(calls.get() + 1);
                Err::<Vec<u8>, _>(AadRefusal::Expected)
            },
        );
        assert_eq!(calls.get(), 1);
        assert!(matches!(
            result,
            Err(HpkeSealPskResolvedAadError::AadBuildError(
                AadRefusal::Expected
            ))
        ));
    }
}

#[test]
fn provider_psk_malformed_recipient_refuses_before_callback_without_panic() {
    for kem in [
        HpkeKemType::DhKem25519,
        HpkeKemType::DhKemP256,
        HpkeKemType::DhKemP384,
    ] {
        roundtrip(kem);
        let crypto = RustCrypto::default();
        let ikm = fresh(&crypto, 64);
        let recipient = crypto
            .derive_hpke_keypair(config(kem), ikm.as_slice())
            .expect("fresh recipient");
        let psk = fresh(&crypto, 32);
        let calls = Cell::new(0);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crypto.hpke_seal_psk_resolved_aad(
                config(kem),
                &recipient.public[..recipient.public.len() - 1],
                INFO,
                MESSAGE,
                psk.as_slice(),
                PSK_ID,
                |enc| {
                    calls.set(calls.get() + 1);
                    Ok::<_, ()>(aad(enc))
                },
            )
        }));
        match result {
            Ok(Err(HpkeSealPskResolvedAadError::CryptoError(error))) => {
                assert_eq!(error, CryptoError::SenderSetupError)
            }
            Ok(_) => panic!("malformed PSK recipient was not refused with setup error"),
            Err(_) => panic!("malformed PSK recipient panicked"),
        }
        assert_eq!(calls.get(), 0);
    }
}
