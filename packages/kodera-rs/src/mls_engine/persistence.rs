//! Encrypted, bounded OpenMLS provider checkpoints, without a plaintext export API.
//!
//! The host must atomically store ciphertext with its independently trusted epoch
//! and strictly increasing generation. It must compare-and-swap that record and
//! supply the same metadata when restoring. AEAD cannot detect rollback of both
//! the ciphertext and every host-side rollback fence. No filesystem, OS keyring,
//! browser storage or generated platform binding is provided here.

use std::fmt;

use aes_gcm::{aead::AeadInOut, Aes256Gcm, KeyInit, Nonce, Tag};
use openmls_traits::{crypto::OpenMlsCrypto, random::OpenMlsRand};
use tls_codec::SecretVLBytes;

use super::*;

const MAGIC: &[u8; 4] = b"KMS1";
const NONCE_BYTES: usize = 12;
const HEADER_BYTES: usize = MAGIC.len() + NONCE_BYTES;
const TAG_BYTES: usize = 16;
const MAX_RECORDS: usize = 16_384;
const MAX_KEY_BYTES: usize = 65_536;
const MAX_PLAINTEXT_BYTES: usize = 4 + MAX_RECORDS * 8 + MAX_STORAGE_BYTES;
const MAX_SEALED_BYTES: usize = HEADER_BYTES + MAX_PLAINTEXT_BYTES + TAG_BYTES;

/// Ciphertext suitable for host persistence. Debug never prints stored bytes.
#[derive(Clone)]
pub struct SealedMlsState(Vec<u8>);

impl fmt::Debug for SealedMlsState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SealedMlsState([redacted])")
    }
}

impl SealedMlsState {
    /// Admit a bounded encrypted record before copying any externally supplied bytes.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, NativeCryptoError> {
        if bytes.len() > MAX_SEALED_BYTES {
            return Err(NativeCryptoError::Capacity);
        }
        if bytes.len() < HEADER_BYTES + 4 + TAG_BYTES || !bytes.starts_with(MAGIC) {
            return Err(NativeCryptoError::InvalidInput);
        }
        Ok(Self(bytes.to_vec()))
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }
}

fn aad(scope: &NativeRoomScope, device: &Ed25519PublicKey, epoch: u64, generation: u64) -> Vec<u8> {
    let mut output = b"kodera-native-mls-checkpoint-v1\0".to_vec();
    output.extend_from_slice(&scope.binding());
    output.extend_from_slice(device);
    output.extend_from_slice(&epoch.to_be_bytes());
    output.extend_from_slice(&generation.to_be_bytes());
    output
}

// This buffer is never formatted or exported. Moving its allocation into the
// existing zeroizing wrapper avoids a second plaintext allocation on cleanup.
pub(super) struct CheckpointBuffer(pub(super) Vec<u8>);

impl Drop for CheckpointBuffer {
    fn drop(&mut self) {
        drop(SecretVLBytes::new(std::mem::take(&mut self.0)));
    }
}

// A failed restore must also clear copies already admitted to provisional
// provider storage. Active OpenMLS state and upstream internal allocations have
// their own lifetimes; this is not a universal or forensic memory-wipe guarantee.
pub(super) struct RestoringProvider(Option<OpenMlsRustCrypto>);

impl RestoringProvider {
    pub(super) fn new() -> Self {
        Self(Some(OpenMlsRustCrypto::default()))
    }

    pub(super) fn provider(&self) -> &OpenMlsRustCrypto {
        self.0.as_ref().expect("provisional provider is present")
    }

    pub(super) fn accept(mut self) -> OpenMlsRustCrypto {
        self.0.take().expect("provisional provider is present")
    }
}

impl Drop for RestoringProvider {
    fn drop(&mut self) {
        if let Some(provider) = &self.0 {
            let mut values = provider
                .storage()
                .values
                .write()
                .unwrap_or_else(|error| error.into_inner());
            for (key, value) in values.drain() {
                drop(SecretVLBytes::new(key));
                drop(SecretVLBytes::new(value));
            }
        }
    }
}

fn encode_store(session: &OpenMlsSession) -> Result<CheckpointBuffer, NativeCryptoError> {
    encode_provider(&session.provider)
}

pub(super) fn encode_provider(
    provider: &OpenMlsRustCrypto,
) -> Result<CheckpointBuffer, NativeCryptoError> {
    // The provider is private to this session. The immutable session borrow and
    // store read guard prevent a checkpoint assembled from different mutations.
    let values = provider
        .storage()
        .values
        .read()
        .map_err(|_| NativeCryptoError::Storage)?;
    if values.is_empty() || values.len() > MAX_RECORDS {
        return Err(NativeCryptoError::Capacity);
    }
    let raw_bytes = values
        .iter()
        .try_fold(0usize, |total, (key, value)| {
            if key.is_empty() || key.len() > MAX_KEY_BYTES || value.len() > MAX_STORAGE_BYTES {
                return None;
            }
            total.checked_add(key.len())?.checked_add(value.len())
        })
        .filter(|total| *total <= MAX_STORAGE_BYTES)
        .ok_or(NativeCryptoError::Capacity)?;
    let length = 4 + values.len() * 8 + raw_bytes;
    // SecretVLBytes already comes from the locked tls_codec dependency and
    // zeroizes on drop. Exact capacity avoids reallocating the serialized secret.
    let mut output = CheckpointBuffer(Vec::with_capacity(length));
    output
        .0
        .extend_from_slice(&(values.len() as u32).to_be_bytes());
    let mut sorted: Vec<_> = values.iter().collect();
    sorted.sort_unstable_by(|left, right| left.0.cmp(right.0));
    for (key, value) in sorted {
        output
            .0
            .extend_from_slice(&(key.len() as u32).to_be_bytes());
        output
            .0
            .extend_from_slice(&(value.len() as u32).to_be_bytes());
        output.0.extend_from_slice(key);
        output.0.extend_from_slice(value);
    }
    Ok(output)
}

pub(super) fn take<'a>(input: &mut &'a [u8], length: usize) -> Result<&'a [u8], NativeCryptoError> {
    if input.len() < length {
        return Err(NativeCryptoError::InvalidInput);
    }
    let (taken, rest) = input.split_at(length);
    *input = rest;
    Ok(taken)
}

pub(super) fn number(input: &mut &[u8]) -> Result<usize, NativeCryptoError> {
    let value: [u8; 4] = take(input, 4)?
        .try_into()
        .map_err(|_| NativeCryptoError::InvalidInput)?;
    Ok(u32::from_be_bytes(value) as usize)
}

type Records<'a> = Vec<(&'a [u8], &'a [u8])>;

pub(super) fn validate_store(mut input: &[u8]) -> Result<Records<'_>, NativeCryptoError> {
    if input.len() > MAX_PLAINTEXT_BYTES {
        return Err(NativeCryptoError::Capacity);
    }
    let count = number(&mut input)?;
    if count == 0 || count > MAX_RECORDS {
        return Err(NativeCryptoError::Capacity);
    }
    let mut rows: Records<'_> = Vec::with_capacity(count);
    let mut total = 0usize;
    for _ in 0..count {
        let key_length = number(&mut input)?;
        let value_length = number(&mut input)?;
        total = total
            .checked_add(key_length)
            .and_then(|v| v.checked_add(value_length))
            .ok_or(NativeCryptoError::Capacity)?;
        if key_length == 0
            || key_length > MAX_KEY_BYTES
            || value_length > MAX_STORAGE_BYTES
            || total > MAX_STORAGE_BYTES
        {
            return Err(NativeCryptoError::Capacity);
        }
        let key = take(&mut input, key_length)?;
        let value = take(&mut input, value_length)?;
        // Canonical order simultaneously refuses duplicates, without copying a
        // private key/value before the complete framing validation has passed.
        if rows.last().is_some_and(|last| last.0 >= key) {
            return Err(NativeCryptoError::InvalidInput);
        }
        rows.push((key, value));
    }
    if !input.is_empty() {
        return Err(NativeCryptoError::InvalidInput);
    }
    Ok(rows)
}

pub(super) fn decode_provider(input: &[u8]) -> Result<RestoringProvider, NativeCryptoError> {
    let records = validate_store(input)?;
    let provisional = RestoringProvider::new();
    {
        let mut values = provisional
            .provider()
            .storage()
            .values
            .write()
            .map_err(|_| NativeCryptoError::Storage)?;
        values.extend(
            records
                .into_iter()
                .map(|(key, value)| (key.to_vec(), value.to_vec())),
        );
    }
    Ok(provisional)
}

impl OpenMlsSession {
    /// Seal provider state with existing RustCrypto AES-256-GCM and fresh OS
    /// randomness. The host supplies its next CAS generation and wrapping key.
    /// Cached roster authority is deliberately not persisted as a fresh grant.
    pub fn seal_checkpoint(
        &self,
        generation: u64,
        key: &[u8; 32],
    ) -> Result<SealedMlsState, NativeCryptoError> {
        if generation == 0 {
            return Err(NativeCryptoError::InvalidInput);
        }
        if !self.authorised.contains(&self.device_key()) {
            return Err(NativeCryptoError::UnauthorisedDevice);
        }
        self.check_members(&self.group)?;
        let mut plaintext = encode_store(self)?;
        let nonce = self
            .provider
            .rand()
            .random_array::<NONCE_BYTES>()
            .map_err(|_| NativeCryptoError::Storage)?;
        let binding = aad(&self.scope, &self.device_key(), self.epoch(), generation);
        let cipher = Aes256Gcm::new_from_slice(key).map_err(failed)?;
        let tag = cipher
            .encrypt_inout_detached(
                &Nonce::from(nonce),
                &binding,
                plaintext.0.as_mut_slice().into(),
            )
            .map_err(failed)?;
        let mut sealed = Vec::with_capacity(HEADER_BYTES + plaintext.0.len() + TAG_BYTES);
        sealed.extend_from_slice(MAGIC);
        sealed.extend_from_slice(&nonce);
        sealed.extend_from_slice(&plaintext.0);
        sealed.extend_from_slice(&tag);
        Ok(SealedMlsState(sealed))
    }

    /// Restore into a new session without mutating an old session or host record.
    /// Expected epoch/generation must come from independently trusted host CAS
    /// metadata, and the roster from fresh authenticated device admission.
    /// Revoked peer leaves may remain solely for processing their removal Commit;
    /// existing message sealing and media export refuse those leaves meanwhile.
    pub fn restore_checkpoint(
        scope: NativeRoomScope,
        expected_device: Ed25519PublicKey,
        expected_epoch: u64,
        expected_generation: u64,
        authorised: HashSet<Ed25519PublicKey>,
        sealed: &SealedMlsState,
        key: &[u8; 32],
    ) -> Result<Self, NativeCryptoError> {
        if expected_generation == 0 {
            return Err(NativeCryptoError::InvalidInput);
        }
        if authorised.is_empty()
            || authorised.len() > MAX_MEMBERS
            || !authorised.contains(&expected_device)
        {
            return Err(NativeCryptoError::UnauthorisedDevice);
        }
        let binding = aad(
            &scope,
            &expected_device,
            expected_epoch,
            expected_generation,
        );
        // Authenticate the expected binding in the same owned allocation before
        // any provider/group decode, including on authentication failure.
        let tag_start = sealed.0.len() - TAG_BYTES;
        let mut plaintext = CheckpointBuffer(sealed.0[HEADER_BYTES..tag_start].to_vec());
        let cipher = Aes256Gcm::new_from_slice(key).map_err(failed)?;
        cipher
            .decrypt_inout_detached(
                &Nonce::from(
                    <[u8; 12]>::try_from(&sealed.0[MAGIC.len()..HEADER_BYTES]).map_err(failed)?,
                ),
                &binding,
                plaintext.0.as_mut_slice().into(),
                &Tag::from(<[u8; 16]>::try_from(&sealed.0[tag_start..]).map_err(failed)?),
            )
            .map_err(failed)?;
        let provisional = decode_provider(&plaintext.0)?;
        let provider = provisional.provider();
        let signer = SignatureKeyPair::read(
            provider.storage(),
            &expected_device,
            SUITE.signature_algorithm(),
        )
        .ok_or(NativeCryptoError::Storage)?;
        let mut possession = b"kodera-native-mls-checkpoint-possession-v1\0".to_vec();
        possession.extend_from_slice(&binding);
        let signature = checked_possession_signature(&signer, &expected_device, &possession)?;
        provider
            .crypto()
            .verify_signature(
                SUITE.signature_algorithm(),
                &possession,
                &expected_device,
                &signature,
            )
            .map_err(failed)?;
        let group = MlsGroup::load(provider.storage(), &GroupId::from_slice(&scope.binding()))
            .map_err(|_| NativeCryptoError::Storage)?
            .ok_or(NativeCryptoError::Storage)?;
        if group.group_id().as_slice() != scope.binding() || group.ciphersuite() != SUITE {
            return Err(NativeCryptoError::ScopeMismatch);
        }
        if group.epoch().as_u64() != expected_epoch {
            return Err(NativeCryptoError::EpochMismatch);
        }
        if group.members().count() > MAX_MEMBERS
            || group.own_leaf().map_or(true, |leaf| {
                leaf.signature_key().as_slice() != expected_device
            })
        {
            return Err(NativeCryptoError::UnauthorisedDevice);
        }
        Ok(Self {
            scope,
            provider: provisional.accept(),
            signer,
            group,
            authorised,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{OrganisationId, UuidV7};
    use openmls_traits::types::AeadType;

    fn wrapping_key() -> [u8; 32] {
        OpenMlsRustCrypto::default()
            .rand()
            .random_array::<32>()
            .unwrap()
    }

    fn scope(index: u8) -> NativeRoomScope {
        NativeRoomScope::new(
            OrganisationId::parse("00000000-0000-4000-8000-000000000001").unwrap(),
            UuidV7::from_parts(1000, [index; 10]),
        )
    }

    fn pair() -> (OpenMlsSession, OpenMlsSession, HashSet<Ed25519PublicKey>) {
        let alice = OpenMlsMember::new(b"public-checkpoint-a").unwrap();
        let bob = OpenMlsMember::new(b"public-checkpoint-b").unwrap();
        let roster = HashSet::from([alice.device_key(), bob.device_key()]);
        let bob_key = bob.device_key();
        let mut a = alice.create(scope(1)).unwrap();
        a.replace_authorised_roster(roster.clone()).unwrap();
        let welcome = a
            .add_member(bob.key_package(), &bob_key)
            .unwrap()
            .welcome
            .unwrap();
        let b = bob.join(scope(1), &welcome, roster.clone()).unwrap();
        (a, b, roster)
    }

    #[test]
    fn aes256_gcm_public_nist_vectors_keep_detached_bytes_and_refuse_tampering() {
        fn bytes(value: &str) -> Vec<u8> {
            value
                .as_bytes()
                .chunks_exact(2)
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect()
        }

        // Public NIST CAVS gcmEncryptExtIV256.rsp vectors retained in the
        // published aes-gcm 0.11.1 tests/aes256gcm.rs; no production key/state.
        for (key, nonce, plaintext, aad, ciphertext, tag) in [
            (
                "b52c505a37d78eda5dd34f20c22540ea1b58963cf8e5bf8ffa85f9f2492505b4",
                "516c33929df5a3284ff463d7",
                "",
                "",
                "",
                "bdc1ac884d332457a1d2664f168c76f0",
            ),
            (
                "92e11dcdaa866f5ce790fd24501f92509aacf4cb8b1339d50c9c1240935dd08b",
                "ac93a1a6145299bde902f21a",
                "2d71bcfa914e4ac045b2aa60955fad24",
                "1e0889016f67601c8ebea4943bc23ad6",
                "8995ae2e6df3dbf96fac7b7137bae67f",
                "eca5aa77d51d4a0a14d9c51e1da474ab",
            ),
        ] {
            let key = bytes(key);
            let nonce_bytes: [u8; 12] = bytes(nonce).try_into().unwrap();
            let tag_bytes: [u8; 16] = bytes(tag).try_into().unwrap();
            let nonce = Nonce::from(nonce_bytes);
            let tag = Tag::from(tag_bytes);
            let plaintext = bytes(plaintext);
            let aad = bytes(aad);
            let ciphertext = bytes(ciphertext);
            let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
            let mut actual = plaintext.clone();
            let actual_tag = cipher
                .encrypt_inout_detached(&nonce, &aad, actual.as_mut_slice().into())
                .unwrap();
            assert_eq!(actual, ciphertext);
            assert_eq!(actual_tag, tag);
            let mut restored = ciphertext.clone();
            cipher
                .decrypt_inout_detached(&nonce, &aad, restored.as_mut_slice().into(), &tag)
                .unwrap();
            assert_eq!(restored, plaintext);
            let mut wrong_tag = tag;
            wrong_tag[0] ^= 1;
            let mut rejected = ciphertext.clone();
            assert!(cipher
                .decrypt_inout_detached(&nonce, &aad, rejected.as_mut_slice().into(), &wrong_tag)
                .is_err());
            let mut wrong_nonce = nonce;
            wrong_nonce[0] ^= 1;
            let mut rejected = ciphertext.clone();
            assert!(cipher
                .decrypt_inout_detached(&wrong_nonce, &aad, rejected.as_mut_slice().into(), &tag)
                .is_err());
            let mut wrong_aad = aad.clone();
            wrong_aad.push(1);
            let mut rejected = ciphertext.clone();
            assert!(cipher
                .decrypt_inout_detached(&nonce, &wrong_aad, rejected.as_mut_slice().into(), &tag)
                .is_err());
            if !ciphertext.is_empty() {
                let mut rejected = ciphertext.clone();
                rejected[0] ^= 1;
                assert!(cipher
                    .decrypt_inout_detached(&nonce, &aad, rejected.as_mut_slice().into(), &tag)
                    .is_err());
            }
        }
    }

    #[test]
    fn real_mls_checkpoint_roundtrip_preserves_ratchets_signer_and_replay_state() {
        let (mut alice, mut bob, roster) = pair();
        let key = wrapping_key();
        let message = alice.seal(b"private message before checkpoint").unwrap();
        assert_eq!(
            bob.open(&message).unwrap(),
            b"private message before checkpoint"
        );
        let device = bob.device_key();
        let epoch = bob.epoch();
        let sealed = bob.seal_checkpoint(9, &key).unwrap();
        let imported = SealedMlsState::from_bytes(sealed.as_bytes()).unwrap();
        let mut restored =
            OpenMlsSession::restore_checkpoint(scope(1), device, epoch, 9, roster, &imported, &key)
                .unwrap();
        assert!(restored.open(&message).is_err());
        let next = alice.seal(b"private message after checkpoint").unwrap();
        assert_eq!(
            restored.open(&next).unwrap(),
            b"private message after checkpoint"
        );
        let reply = restored.seal(b"restored signer works").unwrap();
        assert_eq!(alice.open(&reply).unwrap(), b"restored signer works");
        assert_eq!(
            restored.export_media_key().unwrap(),
            alice.export_media_key().unwrap()
        );
    }

    #[test]
    fn checkpoint_exposes_only_ciphertext_and_uses_fresh_nonces() {
        let (alice, _, _) = pair();
        let key = wrapping_key();
        let storage = alice.provider.storage().values.read().unwrap();
        let private_record = storage.values().max_by_key(|value| value.len()).unwrap();
        assert!(private_record.len() >= 64);
        let first = alice.seal_checkpoint(1, &key).unwrap();
        let second = alice.seal_checkpoint(1, &key).unwrap();
        assert_ne!(
            &first.as_bytes()[MAGIC.len()..HEADER_BYTES],
            &second.as_bytes()[MAGIC.len()..HEADER_BYTES]
        );
        assert!(!first
            .as_bytes()
            .windows(private_record.len())
            .any(|part| part == private_record));
        assert_eq!(format!("{first:?}"), "SealedMlsState([redacted])");
        assert_eq!(format!("{alice:?}"), "OpenMlsSession([redacted])");
    }

    #[test]
    fn expected_scope_device_epoch_generation_key_and_ciphertext_are_authenticated() {
        let (alice, bob, roster) = pair();
        let key = wrapping_key();
        let mut wrong_key = key;
        wrong_key[0] ^= 1;
        let sealed = alice.seal_checkpoint(3, &key).unwrap();
        let device = alice.device_key();
        let epoch = alice.epoch();
        for (wanted_scope, wanted_device, wanted_epoch, wanted_generation, key) in [
            (scope(2), device, epoch, 3, key),
            (scope(1), bob.device_key(), epoch, 3, key),
            (scope(1), device, epoch + 1, 3, key),
            (scope(1), device, epoch, 4, key),
            (scope(1), device, epoch, 3, wrong_key),
        ] {
            assert!(matches!(
                OpenMlsSession::restore_checkpoint(
                    wanted_scope,
                    wanted_device,
                    wanted_epoch,
                    wanted_generation,
                    roster.clone(),
                    &sealed,
                    &key
                ),
                Err(NativeCryptoError::AuthenticationFailed)
            ));
        }
        let mut damaged = sealed.as_bytes().to_vec();
        let end = damaged.len() - 1;
        damaged[end] ^= 1;
        let damaged = SealedMlsState::from_bytes(&damaged).unwrap();
        assert!(OpenMlsSession::restore_checkpoint(
            scope(1),
            device,
            epoch,
            3,
            roster.clone(),
            &damaged,
            &key
        )
        .is_err());
        let truncated =
            SealedMlsState::from_bytes(&sealed.as_bytes()[..sealed.as_bytes().len() - 1]).unwrap();
        assert!(OpenMlsSession::restore_checkpoint(
            scope(1),
            device,
            epoch,
            3,
            roster,
            &truncated,
            &key
        )
        .is_err());
        let mut wrong_magic = sealed.as_bytes().to_vec();
        wrong_magic[0] ^= 1;
        assert!(matches!(
            SealedMlsState::from_bytes(&wrong_magic),
            Err(NativeCryptoError::InvalidInput)
        ));
        assert!(matches!(
            alice.seal_checkpoint(0, &key),
            Err(NativeCryptoError::InvalidInput)
        ));
        // A failed restore does not consume or mutate the original session.
        assert!(alice.export_media_key().is_ok());
    }

    #[test]
    fn authenticated_peer_store_cannot_impersonate_another_local_signer() {
        let (alice, bob, roster) = pair();
        let key = wrapping_key();
        let plaintext = encode_store(&bob).unwrap();
        let nonce = bob.provider.rand().random_array::<NONCE_BYTES>().unwrap();
        let binding = aad(&scope(1), &alice.device_key(), alice.epoch(), 1);
        let cipher = bob
            .provider
            .crypto()
            .aead_encrypt(AeadType::Aes256Gcm, &key, &plaintext.0, &nonce, &binding)
            .unwrap();
        let mut bytes = MAGIC.to_vec();
        bytes.extend_from_slice(&nonce);
        bytes.extend_from_slice(&cipher);
        let sealed = SealedMlsState::from_bytes(&bytes).unwrap();
        assert!(OpenMlsSession::restore_checkpoint(
            scope(1),
            alice.device_key(),
            alice.epoch(),
            1,
            roster,
            &sealed,
            &key
        )
        .is_err());
    }

    #[test]
    fn authenticated_foreign_scheme_checkpoint_refuses_before_private_signing() {
        let (alice, mut bob, roster) = pair();
        let key = wrapping_key();
        let expected = alice.device_key();
        let epoch = alice.epoch();
        let original = alice.seal_checkpoint(1, &key).unwrap();
        let provider = &alice.provider;
        let malformed = SignatureKeyPair::from_raw(
            SignatureScheme::ECDSA_SECP256R1_SHA256,
            provider.rand().random_array::<31>().unwrap().to_vec(),
            expected.to_vec(),
        );
        let (p256_private, _) = provider
            .crypto()
            .signature_key_gen(SignatureScheme::ECDSA_SECP256R1_SHA256)
            .unwrap();
        let foreign_scheme = SignatureKeyPair::from_raw(
            SignatureScheme::ECDSA_SECP256R1_SHA256,
            p256_private,
            expected.to_vec(),
        );
        let foreign_public = SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap();
        assert_ne!(foreign_public.public(), expected);
        let stored_signer_id = {
            let values = provider.storage().values.read().unwrap();
            values
                .iter()
                .find(|(_, value)| {
                    serde_json::from_slice::<SignatureKeyPair>(value).is_ok_and(|signer| {
                        signer.public() == expected
                            && signer.signature_scheme() == SUITE.signature_algorithm()
                    })
                })
                .map(|(id, _)| id.clone())
                .unwrap()
        };
        for (poison, healthy_private) in [
            (foreign_scheme, true),
            (foreign_public, true),
            (malformed, false),
        ] {
            {
                let mut values = provider.storage().values.write().unwrap();
                // Change only the value beneath the genuine Ed25519 storage ID.
                *values.get_mut(&stored_signer_id).unwrap() = serde_json::to_vec(&poison).unwrap();
            }
            let loaded =
                SignatureKeyPair::read(provider.storage(), &expected, SUITE.signature_algorithm())
                    .unwrap();
            assert_eq!(loaded.public(), poison.public());
            assert_eq!(loaded.signature_scheme(), poison.signature_scheme());
            if healthy_private {
                // Exercise the actual private leaf: a disabled/disconnected
                // observer must fail this positive control, not report zero.
                let observed = possession_observation::Scope::start();
                assert!(possession_signature(&loaded, b"public possession control").is_ok());
                assert_eq!(observed.calls(), 1);
            }
            // Reseal the actual poisoned map with correct scope/key/epoch/
            // generation and a fresh CSPRNG nonce, retaining the genuine state.
            let malformed = alice.seal_checkpoint(1, &key).unwrap();
            let observed = possession_observation::Scope::start();
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                OpenMlsSession::restore_checkpoint(
                    scope(1),
                    expected,
                    epoch,
                    1,
                    roster.clone(),
                    &malformed,
                    &key,
                )
            }));
            assert!(matches!(
                outcome,
                Ok(Err(NativeCryptoError::AuthenticationFailed))
            ));
            assert_eq!(observed.calls(), 0);
        }
        let observed = possession_observation::Scope::start();
        let mut restored = OpenMlsSession::restore_checkpoint(
            scope(1),
            expected,
            epoch,
            1,
            roster,
            &original,
            &key,
        )
        .unwrap();
        assert_eq!(observed.calls(), 1);
        drop(observed);
        let message = restored
            .seal(b"valid signer survives foreign-scheme refusal")
            .unwrap();
        assert_eq!(
            bob.open(&message).unwrap(),
            b"valid signer survives foreign-scheme refusal"
        );
    }

    #[test]
    fn restore_needs_fresh_local_authority_and_keeps_revoked_leaves_blocked_until_removal() {
        let (alice, bob, _) = pair();
        let key = wrapping_key();
        let a = alice.device_key();
        let b = bob.device_key();
        let old_epoch = alice.epoch();
        let old_media = alice.export_media_key().unwrap();
        let checkpoint = alice.seal_checkpoint(1, &key).unwrap();
        let revoked = HashSet::from([a]);
        assert!(matches!(
            OpenMlsSession::restore_checkpoint(
                scope(1),
                a,
                old_epoch,
                1,
                HashSet::from([b]),
                &checkpoint,
                &key
            ),
            Err(NativeCryptoError::UnauthorisedDevice)
        ));
        let mut restored = OpenMlsSession::restore_checkpoint(
            scope(1),
            a,
            old_epoch,
            1,
            revoked.clone(),
            &checkpoint,
            &key,
        )
        .unwrap();
        assert_eq!(
            restored.export_media_key(),
            Err(NativeCryptoError::UnauthorisedDevice)
        );
        assert!(matches!(
            restored.seal(b"must not publish"),
            Err(NativeCryptoError::UnauthorisedDevice)
        ));
        restored.remove_member(&b).unwrap();
        assert_ne!(restored.export_media_key().unwrap(), old_media);
        let current = restored.seal_checkpoint(2, &key).unwrap();
        assert!(OpenMlsSession::restore_checkpoint(
            scope(1),
            a,
            restored.epoch(),
            2,
            revoked.clone(),
            &checkpoint,
            &key
        )
        .is_err());
        let final_state = OpenMlsSession::restore_checkpoint(
            scope(1),
            a,
            restored.epoch(),
            2,
            revoked,
            &current,
            &key,
        )
        .unwrap();
        assert_eq!(
            final_state.export_media_key().unwrap(),
            restored.export_media_key().unwrap()
        );
    }

    #[test]
    fn restored_three_member_group_can_atomically_remove_two_revoked_devices() {
        let (mut alice, mut bob, mut roster) = pair();
        let key = wrapping_key();
        let charlie = OpenMlsMember::new(b"public-checkpoint-c").unwrap();
        let c = charlie.device_key();
        let a = alice.device_key();
        let b = bob.device_key();
        roster.insert(c);
        alice.replace_authorised_roster(roster.clone()).unwrap();
        bob.replace_authorised_roster(roster.clone()).unwrap();
        let addition = alice.add_member(charlie.key_package(), &c).unwrap();
        bob.apply_commit(&addition.commit).unwrap();
        let mut charlie = charlie
            .join(scope(1), &addition.welcome.unwrap(), roster)
            .unwrap();
        let before_epoch = alice.epoch();
        let before_media = alice.export_media_key().unwrap();
        let checkpoint = alice.seal_checkpoint(1, &key).unwrap();
        let mut restored = OpenMlsSession::restore_checkpoint(
            scope(1),
            a,
            before_epoch,
            1,
            HashSet::from([a]),
            &checkpoint,
            &key,
        )
        .unwrap();
        for keys in [vec![], vec![b, b], vec![a], vec![[0; 32]]] {
            assert!(restored.remove_members(&keys).is_err());
            assert_eq!(restored.epoch(), before_epoch);
        }
        // Removing only one peer cannot leave another revoked peer usable. The
        // failed transaction preserves the state for a complete batch retry.
        assert!(restored.remove_member(&b).is_err());
        assert_eq!(restored.epoch(), before_epoch);
        assert!(restored.seal(b"blocked until both removals").is_err());
        assert!(restored.export_media_key().is_err());
        assert!(restored.seal_checkpoint(2, &key).is_err());
        let removal = restored.remove_members(&[b, c]).unwrap();
        assert_eq!(removal.epoch, before_epoch + 1);
        assert_ne!(restored.export_media_key().unwrap(), before_media);
        let after = restored.seal(b"only the remaining device").unwrap();
        assert!(bob.open(&after).is_err());
        assert!(charlie.open(&after).is_err());
        let updated = restored.seal_checkpoint(2, &key).unwrap();
        assert!(OpenMlsSession::restore_checkpoint(
            scope(1),
            a,
            restored.epoch(),
            2,
            HashSet::from([a]),
            &updated,
            &key,
        )
        .is_ok());
    }

    #[test]
    fn corrupt_record_framing_is_rejected_before_openmls_decode() {
        let mut oversized_count = (MAX_RECORDS as u32 + 1).to_be_bytes().to_vec();
        assert!(matches!(
            validate_store(&oversized_count),
            Err(NativeCryptoError::Capacity)
        ));
        let mut oversized_value = 1u32.to_be_bytes().to_vec();
        oversized_value.extend_from_slice(&1u32.to_be_bytes());
        oversized_value.extend_from_slice(&(MAX_STORAGE_BYTES as u32 + 1).to_be_bytes());
        oversized_value.push(b'a');
        oversized_value.resize(oversized_value.len() + MAX_STORAGE_BYTES + 1, 0);
        assert!(matches!(
            validate_store(&oversized_value),
            Err(NativeCryptoError::Capacity)
        ));
        let mut excessive_total = 2u32.to_be_bytes().to_vec();
        for key in *b"ab" {
            excessive_total.extend_from_slice(&1u32.to_be_bytes());
            excessive_total.extend_from_slice(&((MAX_STORAGE_BYTES / 2) as u32).to_be_bytes());
            excessive_total.push(key);
            excessive_total.resize(excessive_total.len() + MAX_STORAGE_BYTES / 2, 0);
        }
        assert!(matches!(
            validate_store(&excessive_total),
            Err(NativeCryptoError::Capacity)
        ));
        oversized_count.clear();
        oversized_count.extend_from_slice(&1u32.to_be_bytes());
        oversized_count.extend_from_slice(&(MAX_KEY_BYTES as u32 + 1).to_be_bytes());
        oversized_count.extend_from_slice(&0u32.to_be_bytes());
        oversized_count.resize(oversized_count.len() + MAX_KEY_BYTES + 1, b'a');
        assert!(matches!(
            validate_store(&oversized_count),
            Err(NativeCryptoError::Capacity)
        ));
        let mut duplicate = 2u32.to_be_bytes().to_vec();
        for _ in 0..2 {
            duplicate.extend_from_slice(&1u32.to_be_bytes());
            duplicate.extend_from_slice(&1u32.to_be_bytes());
            duplicate.extend_from_slice(b"ab");
        }
        assert!(validate_store(&duplicate).is_err());
        let mut valid = 1u32.to_be_bytes().to_vec();
        valid.extend_from_slice(&1u32.to_be_bytes());
        valid.extend_from_slice(&1u32.to_be_bytes());
        valid.extend_from_slice(b"ab");
        assert!(validate_store(&valid).is_ok());
        let truncated = &valid[..valid.len() - 1];
        assert!(validate_store(truncated).is_err());
        valid.push(0);
        assert!(validate_store(&valid).is_err());
        assert!(SealedMlsState::from_bytes(b"unframed plaintext state").is_err());
        assert!(SealedMlsState::from_bytes(&vec![0; MAX_SEALED_BYTES + 1]).is_err());
    }
}
