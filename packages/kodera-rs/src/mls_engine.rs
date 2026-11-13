//! RFC 9420 group operations backed by OpenMLS, with staged state on every refusal boundary.

use std::collections::HashSet;
use std::fmt;

use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use tls_codec::{Deserialize as _, Serialize as _};

use crate::{
    CoreError, CryptoAlgorithm, Ed25519PublicKey, MlsCiphertextEnvelope, MlsGroupSession,
    NativeCryptoError, NativeRoomScope, MAX_NATIVE_MESSAGE_BYTES,
};

const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
const MAX_MEMBERS: usize = 128;
const MAX_STORAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_HANDSHAKE_BYTES: usize = 256 * 1024;

fn failed<T>(_: T) -> NativeCryptoError {
    NativeCryptoError::AuthenticationFailed
}

/// Ephemeral software credentials and one real HPKE key package. This does not attest hardware.
pub struct OpenMlsMember {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
    key_package: Vec<u8>,
}

impl fmt::Debug for OpenMlsMember {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("OpenMlsMember([redacted])")
    }
}

impl OpenMlsMember {
    pub fn new(public_device_identity: &[u8]) -> Result<Self, NativeCryptoError> {
        if public_device_identity.is_empty() || public_device_identity.len() > 128 {
            return Err(NativeCryptoError::InvalidInput);
        }
        let provider = OpenMlsRustCrypto::default();
        let signer = SignatureKeyPair::new(SUITE.signature_algorithm()).map_err(failed)?;
        signer.store(provider.storage()).map_err(failed)?;
        let credential = CredentialWithKey {
            credential: BasicCredential::new(public_device_identity.to_vec()).into(),
            signature_key: signer.public().into(),
        };
        let package = KeyPackage::builder()
            .build(SUITE, &provider, &signer, credential.clone())
            .map_err(failed)?;
        let key_package = package
            .key_package()
            .tls_serialize_detached()
            .map_err(failed)?;
        Ok(Self {
            provider,
            signer,
            credential,
            key_package,
        })
    }

    pub fn device_key(&self) -> Ed25519PublicKey {
        self.signer
            .public()
            .try_into()
            .expect("the selected ciphersuite uses 32-byte Ed25519 keys")
    }

    pub fn key_package(&self) -> &[u8] {
        &self.key_package
    }

    pub fn create(self, scope: NativeRoomScope) -> Result<OpenMlsSession, NativeCryptoError> {
        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(SUITE)
            .use_ratchet_tree_extension(true)
            .max_past_epochs(0)
            .build();
        let group = MlsGroup::new_with_group_id(
            &self.provider,
            &self.signer,
            &config,
            GroupId::from_slice(&scope.binding()),
            self.credential.clone(),
        )
        .map_err(failed)?;
        let authorised = HashSet::from([self.device_key()]);
        Ok(OpenMlsSession {
            scope,
            provider: self.provider,
            signer: self.signer,
            group,
            authorised,
        })
    }

    /// The caller obtains this roster from its trusted membership/device admission boundary.
    pub fn join(
        self,
        scope: NativeRoomScope,
        welcome: &[u8],
        authorised: HashSet<Ed25519PublicKey>,
    ) -> Result<OpenMlsSession, NativeCryptoError> {
        if welcome.is_empty()
            || welcome.len() > MAX_HANDSHAKE_BYTES
            || authorised.is_empty()
            || authorised.len() > MAX_MEMBERS
            || !authorised.contains(&self.device_key())
        {
            return Err(NativeCryptoError::InvalidInput);
        }
        let input = MlsMessageIn::tls_deserialize_exact(welcome).map_err(failed)?;
        let MlsMessageBodyIn::Welcome(welcome) = input.extract() else {
            return Err(NativeCryptoError::InvalidInput);
        };
        let config = MlsGroupJoinConfig::builder()
            .use_ratchet_tree_extension(true)
            .max_past_epochs(0)
            .build();
        let group = StagedWelcome::new_from_welcome(&self.provider, &config, welcome, None)
            .map_err(failed)?
            .into_group(&self.provider)
            .map_err(failed)?;
        if group.ciphersuite() != SUITE {
            return Err(NativeCryptoError::AuthenticationFailed);
        }
        if group.group_id().as_slice() != scope.binding() {
            return Err(NativeCryptoError::ScopeMismatch);
        }
        let session = OpenMlsSession {
            scope,
            provider: self.provider,
            signer: self.signer,
            group,
            authorised,
        };
        session.check_members(&session.group)?;
        Ok(session)
    }
}

/// Serialized real MLS commit and optional encrypted welcome, not an epoch counter command.
#[derive(Debug, Clone)]
pub struct MlsCommitBundle {
    pub commit: Vec<u8>,
    pub welcome: Option<Vec<u8>>,
    pub epoch: u64,
}

/// An in-memory RFC 9420 session. No OS keyring, durable rollback protection or IPC is supplied.
pub struct OpenMlsSession {
    scope: NativeRoomScope,
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    group: MlsGroup,
    authorised: HashSet<Ed25519PublicKey>,
}

impl fmt::Debug for OpenMlsSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("OpenMlsSession([redacted])")
    }
}

impl OpenMlsSession {
    pub fn scope(&self) -> &NativeRoomScope {
        &self.scope
    }
    pub fn epoch(&self) -> u64 {
        self.group.epoch().as_u64()
    }
    pub fn device_key(&self) -> Ed25519PublicKey {
        self.signer
            .public()
            .try_into()
            .expect("the selected ciphersuite uses 32-byte Ed25519 keys")
    }

    /// Missing local authority fails closed, including if the caller ignores the error.
    pub fn replace_authorised_roster(
        &mut self,
        authorised: HashSet<Ed25519PublicKey>,
    ) -> Result<(), NativeCryptoError> {
        if authorised.is_empty()
            || authorised.len() > MAX_MEMBERS
            || !authorised.contains(&self.device_key())
        {
            self.authorised.clear();
            return Err(NativeCryptoError::UnauthorisedDevice);
        }
        self.authorised = authorised;
        Ok(())
    }

    fn check_members(&self, group: &MlsGroup) -> Result<(), NativeCryptoError> {
        if group.members().count() > MAX_MEMBERS
            || group.members().any(|member| {
                let key: Result<Ed25519PublicKey, _> = member.signature_key.as_slice().try_into();
                !key.is_ok_and(|key| self.authorised.contains(&key))
            })
        {
            return Err(NativeCryptoError::UnauthorisedDevice);
        }
        Ok(())
    }

    /// Stage a bounded copy of the provider store, load its real MLS state and only
    /// publish it after the entire authenticated operation succeeds. No test-util
    /// cloning or plaintext diagnostic feature is enabled in the dependencies.
    fn transaction<T>(
        &mut self,
        operation: impl FnOnce(&Self, &OpenMlsRustCrypto, &mut MlsGroup) -> Result<T, NativeCryptoError>,
    ) -> Result<T, NativeCryptoError> {
        let staged_provider = OpenMlsRustCrypto::default();
        {
            let values = self
                .provider
                .storage()
                .values
                .read()
                .map_err(|_| NativeCryptoError::Storage)?;
            let size = values.iter().try_fold(0usize, |total, (key, value)| {
                total.checked_add(key.len())?.checked_add(value.len())
            });
            if !size.is_some_and(|size| size <= MAX_STORAGE_BYTES) {
                return Err(NativeCryptoError::Capacity);
            }
            *staged_provider
                .storage()
                .values
                .write()
                .map_err(|_| NativeCryptoError::Storage)? = values.clone();
        }
        let mut staged_group = MlsGroup::load(staged_provider.storage(), self.group.group_id())
            .map_err(|_| NativeCryptoError::Storage)?
            .ok_or(NativeCryptoError::Storage)?;
        let result = operation(self, &staged_provider, &mut staged_group)?;
        self.provider = staged_provider;
        self.group = staged_group;
        Ok(result)
    }

    pub fn add_member(
        &mut self,
        key_package: &[u8],
        expected_key: &Ed25519PublicKey,
    ) -> Result<MlsCommitBundle, NativeCryptoError> {
        if key_package.is_empty() || key_package.len() > 16_384 {
            return Err(NativeCryptoError::InvalidInput);
        }
        if !self.authorised.contains(expected_key) || self.group.members().count() >= MAX_MEMBERS {
            return Err(NativeCryptoError::UnauthorisedDevice);
        }
        self.transaction(|own, provider, group| {
            own.check_members(group)?;
            let package = KeyPackageIn::tls_deserialize_exact(key_package)
                .map_err(failed)?
                .validate(provider.crypto(), ProtocolVersion::Mls10)
                .map_err(failed)?;
            if package.leaf_node().signature_key().as_slice() != expected_key {
                return Err(NativeCryptoError::UnauthorisedDevice);
            }
            let (commit, welcome, _) = group
                .add_members(provider, &own.signer, &[package])
                .map_err(failed)?;
            let commit = commit.tls_serialize_detached().map_err(failed)?;
            let welcome = welcome.tls_serialize_detached().map_err(failed)?;
            group.merge_pending_commit(provider).map_err(failed)?;
            own.check_members(group)?;
            Ok(MlsCommitBundle {
                commit,
                welcome: Some(welcome),
                epoch: group.epoch().as_u64(),
            })
        })
    }

    pub fn rotate(&mut self) -> Result<MlsCommitBundle, NativeCryptoError> {
        self.transaction(|own, provider, group| {
            own.check_members(group)?;
            let previous = group.epoch().as_u64();
            let commit = group
                .self_update(provider, &own.signer, LeafNodeParameters::default())
                .map_err(failed)?
                .into_commit()
                .tls_serialize_detached()
                .map_err(failed)?;
            group.merge_pending_commit(provider).map_err(failed)?;
            if previous.checked_add(1) != Some(group.epoch().as_u64()) {
                return Err(NativeCryptoError::EpochMismatch);
            }
            Ok(MlsCommitBundle {
                commit,
                welcome: None,
                epoch: group.epoch().as_u64(),
            })
        })
    }

    /// First replace the trusted roster to revoke the device. Encryption remains
    /// blocked while a revoked member still holds a leaf in the current group.
    pub fn remove_member(
        &mut self,
        key: &Ed25519PublicKey,
    ) -> Result<MlsCommitBundle, NativeCryptoError> {
        if key == &self.device_key() || self.authorised.contains(key) {
            return Err(NativeCryptoError::UnauthorisedDevice);
        }
        let index = self
            .group
            .members()
            .find(|member| member.signature_key.as_slice() == key)
            .ok_or(NativeCryptoError::InvalidInput)?
            .index;
        self.transaction(|own, provider, group| {
            let (commit, _, _) = group
                .remove_members(provider, &own.signer, &[index])
                .map_err(failed)?;
            let commit = commit.tls_serialize_detached().map_err(failed)?;
            group.merge_pending_commit(provider).map_err(failed)?;
            own.check_members(group)?;
            Ok(MlsCommitBundle {
                commit,
                welcome: None,
                epoch: group.epoch().as_u64(),
            })
        })
    }

    pub fn apply_commit(&mut self, bytes: &[u8]) -> Result<(), NativeCryptoError> {
        if bytes.is_empty() || bytes.len() > MAX_HANDSHAKE_BYTES {
            return Err(NativeCryptoError::InvalidInput);
        }
        self.transaction(|own, provider, group| {
            let before = group.epoch().as_u64();
            let message = MlsMessageIn::tls_deserialize_exact(bytes)
                .map_err(failed)?
                .try_into_protocol_message()
                .map_err(failed)?;
            let processed = group.process_message(provider, message).map_err(failed)?;
            let Sender::Member(index) = processed.sender() else {
                return Err(NativeCryptoError::UnauthorisedDevice);
            };
            let member = group
                .member_at(*index)
                .ok_or(NativeCryptoError::UnauthorisedDevice)?;
            let key: Ed25519PublicKey =
                member.signature_key.as_slice().try_into().map_err(failed)?;
            if !own.authorised.contains(&key) {
                return Err(NativeCryptoError::UnauthorisedDevice);
            }
            let ProcessedMessageContent::StagedCommitMessage(commit) = processed.into_content()
            else {
                return Err(NativeCryptoError::InvalidInput);
            };
            group
                .merge_staged_commit(provider, *commit)
                .map_err(failed)?;
            if before.checked_add(1) != Some(group.epoch().as_u64()) {
                return Err(NativeCryptoError::EpochMismatch);
            }
            own.check_members(group)
        })
    }

    pub fn seal(&mut self, plaintext: &[u8]) -> Result<MlsCiphertextEnvelope, NativeCryptoError> {
        if plaintext.len() > MAX_NATIVE_MESSAGE_BYTES {
            return Err(NativeCryptoError::InvalidInput);
        }
        self.transaction(|own, provider, group| {
            if !own.authorised.contains(&own.device_key()) {
                return Err(NativeCryptoError::UnauthorisedDevice);
            }
            own.check_members(group)?;
            group.set_aad(own.scope.binding());
            let ciphertext = group
                .create_message(provider, &own.signer, plaintext)
                .map_err(failed)?
                .tls_serialize_detached()
                .map_err(failed)?;
            Ok(MlsCiphertextEnvelope {
                algorithm: CryptoAlgorithm::OpenMlsDraft,
                channel_id: own.scope.room(),
                epoch: group.epoch().as_u64(),
                sender_device_key: own.device_key(),
                ciphertext,
            })
        })
    }

    pub fn open(&mut self, envelope: &MlsCiphertextEnvelope) -> Result<Vec<u8>, NativeCryptoError> {
        if envelope.algorithm != CryptoAlgorithm::OpenMlsDraft
            || envelope.channel_id != self.scope.room()
        {
            return Err(NativeCryptoError::ScopeMismatch);
        }
        if envelope.epoch != self.epoch() {
            return Err(NativeCryptoError::EpochMismatch);
        }
        if !self.authorised.contains(&envelope.sender_device_key) {
            return Err(NativeCryptoError::UnauthorisedDevice);
        }
        if envelope.ciphertext.is_empty()
            || envelope.ciphertext.len() > MAX_NATIVE_MESSAGE_BYTES + 16_384
        {
            return Err(NativeCryptoError::InvalidInput);
        }
        self.transaction(|own, provider, group| {
            let input =
                MlsMessageIn::tls_deserialize_exact(&envelope.ciphertext).map_err(failed)?;
            if input.wire_format() != WireFormat::PrivateMessage {
                return Err(NativeCryptoError::InvalidInput);
            }
            let message = input.try_into_protocol_message().map_err(failed)?;
            let processed = group.process_message(provider, message).map_err(failed)?;
            if processed.aad() != own.scope.binding()
                || processed.epoch().as_u64() != envelope.epoch
            {
                return Err(NativeCryptoError::ScopeMismatch);
            }
            let Sender::Member(index) = processed.sender() else {
                return Err(NativeCryptoError::UnauthorisedDevice);
            };
            let member = group
                .member_at(*index)
                .ok_or(NativeCryptoError::UnauthorisedDevice)?;
            if member.signature_key.as_slice() != envelope.sender_device_key {
                return Err(NativeCryptoError::UnauthorisedDevice);
            }
            let ProcessedMessageContent::ApplicationMessage(application) = processed.into_content()
            else {
                return Err(NativeCryptoError::InvalidInput);
            };
            let plaintext = application.into_bytes();
            if plaintext.len() > MAX_NATIVE_MESSAGE_BYTES {
                return Err(NativeCryptoError::InvalidInput);
            }
            Ok(plaintext)
        })
    }
}

impl MlsGroupSession for OpenMlsSession {
    fn current_epoch(&self) -> u64 {
        self.epoch()
    }
    fn seal_application_message(
        &mut self,
        plaintext: &[u8],
    ) -> Result<MlsCiphertextEnvelope, CoreError> {
        self.seal(plaintext).map_err(|_| CoreError::CryptoFailure)
    }
    fn open_application_message(
        &mut self,
        envelope: &MlsCiphertextEnvelope,
    ) -> Result<Vec<u8>, CoreError> {
        self.open(envelope).map_err(|_| CoreError::CryptoFailure)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{OrganisationId, UuidV7};

    fn scope(index: u8) -> NativeRoomScope {
        NativeRoomScope::new(
            OrganisationId::parse("00000000-0000-4000-8000-000000000001").unwrap(),
            UuidV7::from_parts(1000, [index; 10]),
        )
    }

    fn pair() -> (OpenMlsSession, OpenMlsSession) {
        let alice = OpenMlsMember::new(b"public-device-a").unwrap();
        let bob = OpenMlsMember::new(b"public-device-b").unwrap();
        let roster = HashSet::from([alice.device_key(), bob.device_key()]);
        let key = bob.device_key();
        let mut a = alice.create(scope(1)).unwrap();
        a.replace_authorised_roster(roster.clone()).unwrap();
        let welcome = a
            .add_member(bob.key_package(), &key)
            .unwrap()
            .welcome
            .unwrap();
        let b = bob.join(scope(1), &welcome, roster).unwrap();
        (a, b)
    }

    #[test]
    fn actual_welcome_application_authentication_commit_and_epoch_rekey() {
        let (mut a, mut b) = pair();
        let first = a.seal(b"MLS confidential message").unwrap();
        assert!(!first
            .ciphertext
            .windows(12)
            .any(|part| part == b"confidential"));
        let mut corrupt = first.clone();
        let last = corrupt.ciphertext.len() - 1;
        corrupt.ciphertext[last] ^= 1;
        assert!(b.open(&corrupt).is_err());
        assert_eq!(b.open(&first).unwrap(), b"MLS confidential message");
        assert!(b.open(&first).is_err());
        let before = a.epoch();
        let rotated = a.rotate().unwrap();
        assert_eq!(a.epoch(), before + 1);
        let current = a.seal(b"new HPKE update-path secrets").unwrap();
        assert_eq!(b.open(&current), Err(NativeCryptoError::EpochMismatch));
        let mut tampered = rotated.commit.clone();
        let end = tampered.len() - 1;
        tampered[end] ^= 1;
        assert!(b.apply_commit(&tampered).is_err());
        assert_eq!(b.epoch(), before);
        b.apply_commit(&rotated.commit).unwrap();
        assert_eq!(b.open(&current).unwrap(), b"new HPKE update-path secrets");
        assert_eq!(b.open(&first), Err(NativeCryptoError::EpochMismatch));
        assert!(b.apply_commit(&rotated.commit).is_err());
    }

    #[test]
    fn metadata_scope_and_roster_refusals_do_not_burn_the_real_message() {
        let (mut a, mut b) = pair();
        let message = a
            .seal(b"only the authenticated sender owns this message")
            .unwrap();
        let mut corrupt = message.clone();
        corrupt.sender_device_key = b.device_key();
        assert_eq!(b.open(&corrupt), Err(NativeCryptoError::UnauthorisedDevice));
        corrupt = message.clone();
        corrupt.channel_id = scope(2).room();
        assert_eq!(b.open(&corrupt), Err(NativeCryptoError::ScopeMismatch));
        assert_eq!(
            b.open(&message).unwrap(),
            b"only the authenticated sender owns this message"
        );
        b.replace_authorised_roster(HashSet::from([b.device_key()]))
            .unwrap();
        assert_eq!(
            b.open(&a.seal(b"revoked sender").unwrap()),
            Err(NativeCryptoError::UnauthorisedDevice)
        );
        assert_eq!(
            b.seal(b"must not encrypt to the revoked member"),
            Err(NativeCryptoError::UnauthorisedDevice)
        );
    }

    #[test]
    fn a_removed_member_cannot_read_fresh_group_secrets() {
        let (mut a, mut b) = pair();
        let before = a.epoch();
        a.replace_authorised_roster(HashSet::from([a.device_key()]))
            .unwrap();
        let removed = a.remove_member(&b.device_key()).unwrap();
        assert_eq!(removed.epoch, before + 1);
        let current = a.seal(b"after membership removal").unwrap();
        let mut relabelled = current;
        relabelled.epoch = b.epoch();
        assert!(b.open(&relabelled).is_err());
    }

    #[test]
    fn a_cryptographically_valid_welcome_cannot_change_the_admitted_ciphersuite() {
        let alice = OpenMlsMember::new(b"public-device-a").unwrap();
        let bob = OpenMlsMember::new(b"public-device-b").unwrap();
        let suite = Ciphersuite::MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519;
        let package = KeyPackage::builder()
            .build(suite, &bob.provider, &bob.signer, bob.credential.clone())
            .unwrap();
        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(suite)
            .use_ratchet_tree_extension(true)
            .build();
        let mut group = MlsGroup::new_with_group_id(
            &alice.provider,
            &alice.signer,
            &config,
            GroupId::from_slice(&scope(1).binding()),
            alice.credential.clone(),
        )
        .unwrap();
        let (_, welcome, _) = group
            .add_members(
                &alice.provider,
                &alice.signer,
                &[package.key_package().clone()],
            )
            .unwrap();
        let welcome = welcome.tls_serialize_detached().unwrap();
        let roster = HashSet::from([alice.device_key(), bob.device_key()]);
        assert!(matches!(
            bob.join(scope(1), &welcome, roster),
            Err(NativeCryptoError::AuthenticationFailed)
        ));
    }
}
