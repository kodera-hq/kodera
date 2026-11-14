//! Stable software device identity and pending-package persistence boundary.
//!
//! The host authenticates Core admission and supplies independent rollback
//! fences, wrapping keys and an atomic durable store. No platform store, HTTP
//! admission, hardware attestation or generated binding is provided here.

use std::collections::BTreeMap;
use std::future::Future;

use aes_gcm::{aead::AeadInPlace, Aes256Gcm, KeyInit, Nonce, Tag};
use openmls::ciphersuite::hash_ref::make_key_package_ref;
use openmls_traits::{
    crypto::OpenMlsCrypto, random::OpenMlsRand, signatures::Signer, storage::StorageProvider,
};

use super::persistence::{
    decode_provider, encode_provider, number, take, validate_store, CheckpointBuffer,
    RestoringProvider,
};
use super::relay_statement::{RelayId, MAX_JSON_INTEGER};
use super::*;
use crate::OrganisationId;

const MAGIC: &[u8; 4] = b"KDV1";
const NONCE_BYTES: usize = 12;
const HEADER_BYTES: usize = 16;
const TAG_BYTES: usize = 16;
const MAX_PENDING: usize = 16;
const MAX_PACKAGE_BYTES: usize = 16_384;
const MAX_PROVIDER_RECORDS: usize = 16_384;
pub const MAX_SEALED_MLS_DEVICE_BYTES: usize = 17 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MlsDeviceScope {
    organisation: OrganisationId,
    membership: RelayId,
}

impl MlsDeviceScope {
    pub fn new(organisation: OrganisationId, membership: RelayId) -> Self {
        Self {
            organisation,
            membership,
        }
    }
    pub fn organisation(&self) -> &OrganisationId {
        &self.organisation
    }
    pub fn membership(&self) -> &RelayId {
        &self.membership
    }
}

/// Actual MLS KeyPackageRef, distinct from the relay's SHA256(wire) or UUID.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PendingMlsPackageId([u8; 32]);

impl PendingMlsPackageId {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

pub struct PreparedMlsKeyPackage {
    id: PendingMlsPackageId,
    wire: Vec<u8>,
}

impl fmt::Debug for PreparedMlsKeyPackage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PreparedMlsKeyPackage([redacted])")
    }
}

impl PreparedMlsKeyPackage {
    pub fn id(&self) -> PendingMlsPackageId {
        self.id
    }
    pub fn as_bytes(&self) -> &[u8] {
        &self.wire
    }
}

#[derive(Clone)]
pub struct SealedMlsDeviceState(Vec<u8>);

impl fmt::Debug for SealedMlsDeviceState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SealedMlsDeviceState([redacted])")
    }
}

impl SealedMlsDeviceState {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, NativeCryptoError> {
        if bytes.len() > MAX_SEALED_MLS_DEVICE_BYTES {
            return Err(NativeCryptoError::Capacity);
        }
        if bytes.len() < HEADER_BYTES + TAG_BYTES + 4 || !bytes.starts_with(MAGIC) {
            return Err(NativeCryptoError::InvalidInput);
        }
        Ok(Self(bytes.to_vec()))
    }
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MlsDeviceStoreError {
    Conflict,
    Unavailable,
}

/// The trusted host must commit ALL supplied records in one durable CAS. It must
/// also fence owner deletion/incarnation and compare independently stored current
/// generations. A dishonest store or rollback of every fence is undetectable.
pub trait MlsDeviceStore {
    fn compare_and_swap<'a>(
        &'a mut self,
        write: &'a MlsDeviceWrite<'_>,
    ) -> impl Future<Output = Result<(), MlsDeviceStoreError>> + 'a;
}

pub struct InitialMlsRoomWrite<'a> {
    pub scope: &'a NativeRoomScope,
    pub epoch: u64,
    pub expected_generation: u64,
    pub generation: u64,
    pub sealed: &'a SealedMlsState,
}

pub struct MlsDeviceWrite<'a> {
    pub scope: &'a MlsDeviceScope,
    pub device_key: Ed25519PublicKey,
    pub expected_generation: u64,
    pub generation: u64,
    pub sealed: &'a SealedMlsDeviceState,
    pub initial_room: Option<InitialMlsRoomWrite<'a>>,
}

pub struct MlsDeviceWrappingKeys<'a> {
    pub device: &'a [u8; 32],
    pub room: &'a [u8; 32],
}

pub struct PendingMlsWelcome<'a> {
    pub package: PendingMlsPackageId,
    pub scope: NativeRoomScope,
    pub expected_epoch: u64,
    pub welcome: &'a [u8],
    pub authorised: HashSet<Ed25519PublicKey>,
}

struct PendingPackage {
    id: PendingMlsPackageId,
    wire: Vec<u8>,
    provider: RestoringProvider,
}

/// One immutable admitted identity, reused across independent room providers.
/// Its state is private; no external alias can mutate a checkpoint snapshot.
pub struct OpenMlsDevice {
    scope: MlsDeviceScope,
    generation: u64,
    admitted: Option<RelayId>,
    public_identity: Vec<u8>,
    identity: RestoringProvider,
    signer: SignatureKeyPair,
    pending: BTreeMap<PendingMlsPackageId, PendingPackage>,
    // Set before awaiting the host. Failure/cancellation may follow a durable
    // commit; only explicit authoritative restore creates a usable handle again.
    quarantined: bool,
}

impl fmt::Debug for OpenMlsDevice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("OpenMlsDevice([redacted])")
    }
}

fn credential(identity: &[u8], key: Ed25519PublicKey) -> CredentialWithKey {
    CredentialWithKey {
        credential: BasicCredential::new(identity.to_vec()).into(),
        signature_key: key.to_vec().into(),
    }
}

fn signer(
    provider: &OpenMlsRustCrypto,
    expected: &Ed25519PublicKey,
) -> Result<SignatureKeyPair, NativeCryptoError> {
    let signer = SignatureKeyPair::read(provider.storage(), expected, SUITE.signature_algorithm())
        .ok_or(NativeCryptoError::Storage)?;
    let challenge = b"kodera-native-mls-device-possession-v1\0";
    let signature = signer.sign(challenge).map_err(failed)?;
    provider
        .crypto()
        .verify_signature(SUITE.signature_algorithm(), challenge, expected, &signature)
        .map_err(failed)?;
    if signer.public() != expected {
        return Err(NativeCryptoError::AuthenticationFailed);
    }
    Ok(signer)
}

fn binding(scope: &MlsDeviceScope, key: &Ed25519PublicKey, generation: u64) -> Vec<u8> {
    let mut out = b"kodera-native-mls-device-vault-v1\0".to_vec();
    out.extend_from_slice(scope.organisation.as_str().as_bytes());
    out.extend_from_slice(scope.membership.as_str().as_bytes());
    out.extend_from_slice(key);
    out.extend_from_slice(&generation.to_be_bytes());
    out
}

fn field(out: &mut CheckpointBuffer, value: &[u8]) {
    out.0.extend_from_slice(&(value.len() as u32).to_be_bytes());
    out.0.extend_from_slice(value);
}

impl OpenMlsDevice {
    /// Persist the fresh private identity before exposing the usable device.
    pub async fn create_and_persist(
        scope: MlsDeviceScope,
        public_identity: &[u8],
        key: &[u8; 32],
        store: &mut impl MlsDeviceStore,
    ) -> Result<Self, NativeCryptoError> {
        if public_identity.is_empty() || public_identity.len() > 128 {
            return Err(NativeCryptoError::InvalidInput);
        }
        let identity = RestoringProvider::new();
        let signer = SignatureKeyPair::new(SUITE.signature_algorithm()).map_err(failed)?;
        signer
            .store(identity.provider().storage())
            .map_err(failed)?;
        let mut own = Self {
            scope,
            generation: 0,
            admitted: None,
            public_identity: public_identity.to_vec(),
            identity,
            signer,
            pending: BTreeMap::new(),
            quarantined: false,
        };
        let sealed = own.seal_device(1, None, &[], key)?;
        own.persist(&sealed, None, store).await?;
        own.generation = 1;
        own.quarantined = false;
        Ok(own)
    }

    pub fn scope(&self) -> &MlsDeviceScope {
        &self.scope
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn device_key(&self) -> Ed25519PublicKey {
        self.signer
            .public()
            .try_into()
            .expect("the selected ciphersuite uses 32-byte Ed25519 keys")
    }
    pub fn admitted_id(&self) -> Option<&RelayId> {
        self.admitted.as_ref()
    }

    pub fn requires_restore(&self) -> bool {
        self.quarantined
    }

    /// Recover public packages after an uncertain creation acknowledgement by
    /// first restoring the authoritative vault. No private HPKE state is exposed.
    pub fn pending_key_packages(&self) -> Result<Vec<PreparedMlsKeyPackage>, NativeCryptoError> {
        self.ensure_live()?;
        Ok(self
            .pending
            .values()
            .map(|record| PreparedMlsKeyPackage {
                id: record.id,
                wire: record.wire.clone(),
            })
            .collect())
    }

    pub fn registration_request(
        &self,
    ) -> Result<super::relay_statement::SignedRelayRequest, NativeCryptoError> {
        self.sign_relay_request(super::relay_statement::RelayStatement::RegisterDevice)
    }

    pub(super) fn sign_relay_statement(
        &self,
        statement: &[u8],
    ) -> Result<Vec<u8>, NativeCryptoError> {
        self.ensure_live()?;
        self.signer.sign(statement).map_err(failed)
    }

    pub(super) fn pending_wire(&self, id: PendingMlsPackageId) -> Result<&[u8], NativeCryptoError> {
        self.ensure_live()?;
        self.pending
            .get(&id)
            .map(|p| p.wire.as_slice())
            .ok_or(NativeCryptoError::Replay)
    }

    fn next_generation(&self) -> Result<u64, NativeCryptoError> {
        self.generation
            .checked_add(1)
            .filter(|n| *n <= MAX_JSON_INTEGER)
            .ok_or(NativeCryptoError::Capacity)
    }

    fn persisted_pending(&self) -> Vec<&PendingPackage> {
        self.pending.values().collect()
    }

    pub(super) fn ensure_live(&self) -> Result<(), NativeCryptoError> {
        if self.quarantined {
            Err(NativeCryptoError::Storage)
        } else {
            Ok(())
        }
    }

    /// Only the host may treat a freshly authenticated Core response as admission.
    /// This binding is immutable; it does not itself confer server authority.
    pub async fn admit_and_persist(
        &mut self,
        admitted: RelayId,
        expected_key: Ed25519PublicKey,
        key: &[u8; 32],
        store: &mut impl MlsDeviceStore,
    ) -> Result<(), NativeCryptoError> {
        self.ensure_live()?;
        if expected_key != self.device_key() {
            return Err(NativeCryptoError::UnauthorisedDevice);
        }
        if let Some(existing) = &self.admitted {
            return if existing == &admitted {
                Ok(())
            } else {
                Err(NativeCryptoError::UnauthorisedDevice)
            };
        }
        let generation = self.next_generation()?;
        let sealed =
            self.seal_device(generation, Some(&admitted), &self.persisted_pending(), key)?;
        self.persist(&sealed, None, store).await?;
        self.admitted = Some(admitted);
        self.generation = generation;
        self.quarantined = false;
        Ok(())
    }

    /// Fresh HPKE state is durable before any publishable package is returned.
    pub async fn prepare_key_package_and_persist(
        &mut self,
        key: &[u8; 32],
        store: &mut impl MlsDeviceStore,
    ) -> Result<PreparedMlsKeyPackage, NativeCryptoError> {
        self.ensure_live()?;
        if self.admitted.is_none() {
            return Err(NativeCryptoError::UnauthorisedDevice);
        }
        if self.pending.len() >= MAX_PENDING {
            return Err(NativeCryptoError::Capacity);
        }
        let provider = RestoringProvider::new();
        self.signer
            .store(provider.provider().storage())
            .map_err(failed)?;
        let bundle = KeyPackage::builder()
            .build(
                SUITE,
                provider.provider(),
                &self.signer,
                credential(&self.public_identity, self.device_key()),
            )
            .map_err(failed)?;
        let reference = bundle
            .key_package()
            .hash_ref(provider.provider().crypto())
            .map_err(failed)?;
        let id = PendingMlsPackageId(reference.as_slice().try_into().map_err(failed)?);
        let wire = bundle
            .key_package()
            .tls_serialize_detached()
            .map_err(failed)?;
        if wire.len() > MAX_PACKAGE_BYTES || self.pending.contains_key(&id) {
            return Err(NativeCryptoError::Capacity);
        }
        let pending = PendingPackage { id, wire, provider };
        let generation = self.next_generation()?;
        let mut records = self.persisted_pending();
        records.push(&pending);
        let sealed = self.seal_device(generation, self.admitted.as_ref(), &records, key)?;
        self.persist(&sealed, None, store).await?;
        let result = PreparedMlsKeyPackage {
            id,
            wire: pending.wire.clone(),
        };
        self.pending.insert(id, pending);
        self.generation = generation;
        self.quarantined = false;
        Ok(result)
    }

    /// Local discard only. The host must also suppress any queued publication;
    /// this does not cancel a previously published server-side directory lease.
    pub async fn cancel_package_and_persist(
        &mut self,
        package: PendingMlsPackageId,
        key: &[u8; 32],
        store: &mut impl MlsDeviceStore,
    ) -> Result<(), NativeCryptoError> {
        self.ensure_live()?;
        if !self.pending.contains_key(&package) {
            return Err(NativeCryptoError::Replay);
        }
        let generation = self.next_generation()?;
        let records = self
            .pending
            .values()
            .filter(|p| p.id != package)
            .collect::<Vec<_>>();
        let sealed = self.seal_device(generation, self.admitted.as_ref(), &records, key)?;
        self.persist(&sealed, None, store).await?;
        self.pending.remove(&package);
        self.generation = generation;
        self.quarantined = false;
        Ok(())
    }

    pub async fn create_room_and_persist(
        &mut self,
        scope: NativeRoomScope,
        keys: MlsDeviceWrappingKeys<'_>,
        store: &mut impl MlsDeviceStore,
    ) -> Result<OpenMlsSession, NativeCryptoError> {
        self.check_scope(&scope)?;
        let provider = RestoringProvider::new();
        self.signer
            .store(provider.provider().storage())
            .map_err(failed)?;
        let local_signer = signer(provider.provider(), &self.device_key())?;
        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(SUITE)
            .use_ratchet_tree_extension(true)
            .max_past_epochs(0)
            .build();
        let group = MlsGroup::new_with_group_id(
            provider.provider(),
            &local_signer,
            &config,
            GroupId::from_slice(&scope.binding()),
            credential(&self.public_identity, self.device_key()),
        )
        .map_err(failed)?;
        let staged = StagedSession(Some(OpenMlsSession {
            scope,
            provider: provider.accept(),
            signer: local_signer,
            group,
            authorised: HashSet::from([self.device_key()]),
        }));
        self.persist_session(staged, None, keys, store).await
    }

    pub async fn join_and_persist(
        &mut self,
        input: PendingMlsWelcome<'_>,
        keys: MlsDeviceWrappingKeys<'_>,
        store: &mut impl MlsDeviceStore,
    ) -> Result<OpenMlsSession, NativeCryptoError> {
        self.check_scope(&input.scope)?;
        if input.welcome.is_empty()
            || input.welcome.len() > MAX_HANDSHAKE_BYTES
            || input.expected_epoch > MAX_JSON_INTEGER
            || input.authorised.is_empty()
            || input.authorised.len() > MAX_MEMBERS
            || !input.authorised.contains(&self.device_key())
        {
            return Err(NativeCryptoError::InvalidInput);
        }
        let pending = self
            .pending
            .get(&input.package)
            .ok_or(NativeCryptoError::Replay)?;
        let encoded = encode_provider(pending.provider.provider())?;
        let provider = decode_provider(&encoded.0)?;
        let local_signer = signer(provider.provider(), &self.device_key())?;
        let incoming = MlsMessageIn::tls_deserialize_exact(input.welcome).map_err(failed)?;
        let MlsMessageBodyIn::Welcome(welcome) = incoming.extract() else {
            return Err(NativeCryptoError::InvalidInput);
        };
        if welcome.ciphersuite() != SUITE
            || !welcome
                .secrets()
                .iter()
                .any(|secret| secret.new_member().as_slice() == input.package.0)
        {
            return Err(NativeCryptoError::AuthenticationFailed);
        }
        let config = MlsGroupJoinConfig::builder()
            .use_ratchet_tree_extension(true)
            .max_past_epochs(0)
            .build();
        let group = StagedWelcome::new_from_welcome(provider.provider(), &config, welcome, None)
            .map_err(failed)?
            .into_group(provider.provider())
            .map_err(failed)?;
        if group.group_id().as_slice() != input.scope.binding() || group.ciphersuite() != SUITE {
            return Err(NativeCryptoError::ScopeMismatch);
        }
        if group.epoch().as_u64() != input.expected_epoch {
            return Err(NativeCryptoError::EpochMismatch);
        }
        if group.own_leaf().map_or(true, |leaf| {
            leaf.signature_key().as_slice() != self.device_key()
        }) {
            return Err(NativeCryptoError::UnauthorisedDevice);
        }
        let staged = StagedSession(Some(OpenMlsSession {
            scope: input.scope,
            provider: provider.accept(),
            signer: local_signer,
            group,
            authorised: input.authorised,
        }));
        staged.session().check_members(&staged.session().group)?;
        self.persist_session(staged, Some(input.package), keys, store)
            .await
    }

    fn check_scope(&self, scope: &NativeRoomScope) -> Result<(), NativeCryptoError> {
        self.ensure_live()?;
        if self.admitted.is_none() {
            return Err(NativeCryptoError::UnauthorisedDevice);
        }
        if scope.organisation() != &self.scope.organisation {
            return Err(NativeCryptoError::ScopeMismatch);
        }
        Ok(())
    }

    async fn persist_session(
        &mut self,
        staged: StagedSession,
        consumed: Option<PendingMlsPackageId>,
        keys: MlsDeviceWrappingKeys<'_>,
        store: &mut impl MlsDeviceStore,
    ) -> Result<OpenMlsSession, NativeCryptoError> {
        let generation = self.next_generation()?;
        let records = self
            .pending
            .values()
            .filter(|p| Some(p.id) != consumed)
            .collect::<Vec<_>>();
        let device = self.seal_device(generation, self.admitted.as_ref(), &records, keys.device)?;
        let session = staged.session();
        let room = session.seal_checkpoint(1, keys.room)?;
        self.persist(
            &device,
            Some(InitialMlsRoomWrite {
                scope: &session.scope,
                epoch: session.epoch(),
                expected_generation: 0,
                generation: 1,
                sealed: &room,
            }),
            store,
        )
        .await?;
        if let Some(package) = consumed {
            self.pending.remove(&package);
        }
        self.generation = generation;
        self.quarantined = false;
        Ok(staged.accept())
    }

    async fn persist(
        &mut self,
        sealed: &SealedMlsDeviceState,
        initial_room: Option<InitialMlsRoomWrite<'_>>,
        store: &mut impl MlsDeviceStore,
    ) -> Result<(), NativeCryptoError> {
        let generation = self.next_generation()?;
        self.quarantined = true;
        let write = MlsDeviceWrite {
            scope: &self.scope,
            device_key: self.device_key(),
            expected_generation: self.generation,
            generation,
            sealed,
            initial_room,
        };
        store
            .compare_and_swap(&write)
            .await
            .map_err(|error| match error {
                MlsDeviceStoreError::Conflict => NativeCryptoError::Replay,
                MlsDeviceStoreError::Unavailable => NativeCryptoError::Storage,
            })
    }

    fn seal_device(
        &self,
        generation: u64,
        admitted: Option<&RelayId>,
        pending: &[&PendingPackage],
        key: &[u8; 32],
    ) -> Result<SealedMlsDeviceState, NativeCryptoError> {
        let mut encoded = vec![encode_provider(self.identity.provider())?];
        let mut sorted = pending.to_vec();
        sorted.sort_unstable_by_key(|p| p.id);
        for record in &sorted {
            encoded.push(encode_provider(record.provider.provider())?);
        }
        let total = encoded
            .iter()
            .try_fold(0usize, |sum, value| sum.checked_add(value.0.len()))
            .ok_or(NativeCryptoError::Capacity)?;
        let mut count = 0usize;
        for value in &encoded {
            let mut input = value.0.as_slice();
            count = count
                .checked_add(number(&mut input)?)
                .ok_or(NativeCryptoError::Capacity)?;
        }
        if sorted.len() > MAX_PENDING || total > MAX_STORAGE_BYTES || count > MAX_PROVIDER_RECORDS {
            return Err(NativeCryptoError::Capacity);
        }
        let length = 4
            + self.public_identity.len()
            + 4
            + admitted.map_or(0, |id| id.as_str().len())
            + 4
            + encoded[0].0.len()
            + 4
            + sorted
                .iter()
                .zip(encoded.iter().skip(1))
                .map(|(p, value)| 32 + 4 + p.wire.len() + 4 + value.0.len())
                .sum::<usize>();
        if length + HEADER_BYTES + TAG_BYTES > MAX_SEALED_MLS_DEVICE_BYTES {
            return Err(NativeCryptoError::Capacity);
        }
        let mut plain = CheckpointBuffer(Vec::with_capacity(length));
        field(&mut plain, &self.public_identity);
        field(
            &mut plain,
            admitted.map_or(&[][..], |id| id.as_str().as_bytes()),
        );
        field(&mut plain, &encoded[0].0);
        plain
            .0
            .extend_from_slice(&(sorted.len() as u32).to_be_bytes());
        for (record, value) in sorted.iter().zip(encoded.iter().skip(1)) {
            plain.0.extend_from_slice(&record.id.0);
            field(&mut plain, &record.wire);
            field(&mut plain, &value.0);
        }
        let nonce = self
            .identity
            .provider()
            .rand()
            .random_array::<NONCE_BYTES>()
            .map_err(|_| NativeCryptoError::Storage)?;
        let aad = binding(&self.scope, &self.device_key(), generation);
        let cipher = Aes256Gcm::new_from_slice(key).map_err(failed)?;
        let tag = cipher
            .encrypt_in_place_detached(Nonce::from_slice(&nonce), &aad, &mut plain.0)
            .map_err(failed)?;
        let mut sealed = Vec::with_capacity(HEADER_BYTES + plain.0.len() + TAG_BYTES);
        sealed.extend_from_slice(MAGIC);
        sealed.extend_from_slice(&nonce);
        sealed.extend_from_slice(&plain.0);
        sealed.extend_from_slice(&tag);
        Ok(SealedMlsDeviceState(sealed))
    }

    /// Expected metadata must come from the current independent host fence, not
    /// the candidate ciphertext. Core admission remains a trusted host input.
    pub fn restore_device(
        scope: MlsDeviceScope,
        expected_key: Ed25519PublicKey,
        expected_admitted: Option<RelayId>,
        expected_generation: u64,
        sealed: &SealedMlsDeviceState,
        key: &[u8; 32],
    ) -> Result<Self, NativeCryptoError> {
        if expected_generation == 0 || expected_generation > MAX_JSON_INTEGER {
            return Err(NativeCryptoError::InvalidInput);
        }
        let aad = binding(&scope, &expected_key, expected_generation);
        let tag_start = sealed.0.len() - TAG_BYTES;
        let mut plain = CheckpointBuffer(sealed.0[HEADER_BYTES..tag_start].to_vec());
        Aes256Gcm::new_from_slice(key)
            .map_err(failed)?
            .decrypt_in_place_detached(
                Nonce::from_slice(&sealed.0[MAGIC.len()..HEADER_BYTES]),
                &aad,
                &mut plain.0,
                Tag::from_slice(&sealed.0[tag_start..]),
            )
            .map_err(failed)?;

        // Complete outer and inner framing validation precedes any provider
        // restoration or OpenMLS deserialization of private stored values.
        let mut input = plain.0.as_slice();
        let identity = bounded_field(&mut input, 128)?;
        if identity.is_empty() {
            return Err(NativeCryptoError::InvalidInput);
        }
        let admitted = bounded_field(&mut input, 36)?;
        let admitted = if admitted.is_empty() {
            None
        } else {
            Some(RelayId::parse(
                std::str::from_utf8(admitted).map_err(failed)?,
            )?)
        };
        if admitted != expected_admitted {
            return Err(NativeCryptoError::UnauthorisedDevice);
        }
        let identity_store = bounded_field(&mut input, MAX_STORAGE_BYTES)?;
        let mut records = validate_store(identity_store)?.len();
        let mut total = identity_store.len();
        let count = number(&mut input)?;
        if count > MAX_PENDING || (count > 0 && admitted.is_none()) {
            return Err(NativeCryptoError::Capacity);
        }
        let mut decoded: Vec<(PendingMlsPackageId, &[u8], &[u8])> = Vec::with_capacity(count);
        for _ in 0..count {
            let id = PendingMlsPackageId(take(&mut input, 32)?.try_into().map_err(failed)?);
            if decoded
                .last()
                .is_some_and(|(previous, _, _)| previous >= &id)
            {
                return Err(NativeCryptoError::InvalidInput);
            }
            let wire = bounded_field(&mut input, MAX_PACKAGE_BYTES)?;
            if wire.is_empty() {
                return Err(NativeCryptoError::InvalidInput);
            }
            let store = bounded_field(&mut input, MAX_STORAGE_BYTES)?;
            records = records
                .checked_add(validate_store(store)?.len())
                .ok_or(NativeCryptoError::Capacity)?;
            total = total
                .checked_add(store.len())
                .ok_or(NativeCryptoError::Capacity)?;
            if records > MAX_PROVIDER_RECORDS || total > MAX_STORAGE_BYTES {
                return Err(NativeCryptoError::Capacity);
            }
            decoded.push((id, wire, store));
        }
        if !input.is_empty() || records > MAX_PROVIDER_RECORDS || total > MAX_STORAGE_BYTES {
            return Err(NativeCryptoError::InvalidInput);
        }
        let identity_provider = decode_provider(identity_store)?;
        let local_signer = signer(identity_provider.provider(), &expected_key)?;
        let expected_credential = credential(identity, expected_key);
        let mut pending = BTreeMap::new();
        for (id, wire, store) in decoded {
            let provider = decode_provider(store)?;
            // This is authenticated recovery of our already-created package,
            // not a fresh publication/admission or an expiry extension. OpenMLS
            // and Core still validate a later Add/Welcome and directory lease.
            let reference =
                make_key_package_ref(wire, SUITE, provider.provider().crypto()).map_err(failed)?;
            if reference.as_slice() != id.0 {
                return Err(NativeCryptoError::AuthenticationFailed);
            }
            let bundle: KeyPackageBundle = provider
                .provider()
                .storage()
                .key_package(&reference)
                .map_err(|_| NativeCryptoError::Storage)?
                .ok_or(NativeCryptoError::Storage)?;
            let public = bundle.key_package();
            if public.ciphersuite() != SUITE
                || public.last_resort()
                || public.leaf_node().signature_key().as_slice() != expected_key
                || public.leaf_node().credential() != &expected_credential.credential
                || public.tls_serialize_detached().map_err(failed)?.as_slice() != wire
            {
                return Err(NativeCryptoError::AuthenticationFailed);
            }
            drop(signer(provider.provider(), &expected_key)?);
            pending.insert(
                id,
                PendingPackage {
                    id,
                    wire: wire.to_vec(),
                    provider,
                },
            );
        }
        Ok(Self {
            scope,
            generation: expected_generation,
            admitted,
            public_identity: identity.to_vec(),
            identity: identity_provider,
            signer: local_signer,
            pending,
            quarantined: false,
        })
    }
}

fn bounded_field<'a>(input: &mut &'a [u8], maximum: usize) -> Result<&'a [u8], NativeCryptoError> {
    let length = number(input)?;
    if length > maximum {
        return Err(NativeCryptoError::Capacity);
    }
    take(input, length)
}

// Provisional group storage is cleaned when validation or the host CAS fails.
// Internal OpenMLS allocations retain upstream lifetimes, not a universal wipe.
struct StagedSession(Option<OpenMlsSession>);

impl StagedSession {
    fn session(&self) -> &OpenMlsSession {
        self.0.as_ref().expect("staged session is present")
    }
    fn accept(mut self) -> OpenMlsSession {
        self.0.take().expect("staged session is present")
    }
}

impl Drop for StagedSession {
    fn drop(&mut self) {
        if let Some(session) = &self.0 {
            let mut values = session
                .provider
                .storage()
                .values
                .write()
                .unwrap_or_else(|error| error.into_inner());
            for (key, value) in values.drain() {
                drop(tls_codec::SecretVLBytes::new(key));
                drop(tls_codec::SecretVLBytes::new(value));
            }
        }
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::UuidV7;
    use std::sync::Arc;
    use std::task::{Context, Poll, Wake, Waker};

    struct TestWake;
    impl Wake for TestWake {
        fn wake(self: Arc<Self>) {}
    }

    pub(in crate::mls_engine) fn finish<F: Future>(future: F) -> F::Output {
        let waker = Waker::from(Arc::new(TestWake));
        let mut context = Context::from_waker(&waker);
        let mut future = std::pin::pin!(future);
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => value,
            Poll::Pending => panic!("ready host fixture unexpectedly suspended"),
        }
    }

    fn poll_pending_once<F: Future>(future: F) {
        let waker = Waker::from(Arc::new(TestWake));
        let mut context = Context::from_waker(&waker);
        let mut future = std::pin::pin!(future);
        assert!(future.as_mut().poll(&mut context).is_pending());
        // Dropping the future here must quarantine the borrowed live device.
    }

    #[derive(Clone, Copy, Default)]
    pub(in crate::mls_engine) enum WriteMode {
        #[default]
        Normal,
        Abort,
        Conflict,
        Pending,
        CommitThenPending,
        CommitThenError,
    }

    #[derive(Default)]
    pub(in crate::mls_engine) struct TestStore {
        pub(super) generation: u64,
        pub(super) sealed: Option<SealedMlsDeviceState>,
        scope: Option<MlsDeviceScope>,
        device_key: Option<Ed25519PublicKey>,
        pub(super) rooms: BTreeMap<String, (u64, SealedMlsState)>,
        pub(super) mode: WriteMode,
        attempts: usize,
    }

    impl TestStore {
        fn apply(&mut self, write: &MlsDeviceWrite<'_>) -> Result<(), MlsDeviceStoreError> {
            if write.expected_generation != self.generation
                || write.generation != self.generation + 1
                || self
                    .scope
                    .as_ref()
                    .is_some_and(|scope| scope != write.scope)
                || self.device_key.is_some_and(|key| key != write.device_key)
            {
                return Err(MlsDeviceStoreError::Conflict);
            }
            if let Some(room) = &write.initial_room {
                if room.expected_generation != 0
                    || room.generation != 1
                    || room.scope.organisation() != write.scope.organisation()
                    || self.rooms.contains_key(&room.scope.room().to_string())
                {
                    return Err(MlsDeviceStoreError::Conflict);
                }
            }
            // Every refusal is checked before any record is changed.
            if let Some(room) = &write.initial_room {
                self.rooms.insert(
                    room.scope.room().to_string(),
                    (room.epoch, room.sealed.clone()),
                );
            }
            self.sealed = Some(write.sealed.clone());
            self.generation = write.generation;
            self.scope = Some(write.scope.clone());
            self.device_key = Some(write.device_key);
            Ok(())
        }
    }

    impl MlsDeviceStore for TestStore {
        fn compare_and_swap<'a>(
            &'a mut self,
            write: &'a MlsDeviceWrite<'_>,
        ) -> impl Future<Output = Result<(), MlsDeviceStoreError>> + 'a {
            async move {
                self.attempts += 1;
                match std::mem::take(&mut self.mode) {
                    WriteMode::Normal => self.apply(write),
                    WriteMode::Abort => Err(MlsDeviceStoreError::Unavailable),
                    WriteMode::Conflict => Err(MlsDeviceStoreError::Conflict),
                    WriteMode::Pending => std::future::pending().await,
                    WriteMode::CommitThenPending => {
                        self.apply(write)?;
                        std::future::pending().await
                    }
                    WriteMode::CommitThenError => {
                        self.apply(write)?;
                        Err(MlsDeviceStoreError::Unavailable)
                    }
                }
            }
        }
    }

    pub(in crate::mls_engine) fn scope() -> MlsDeviceScope {
        MlsDeviceScope::new(
            OrganisationId::parse("00000000-0000-4000-8000-000000000001").unwrap(),
            RelayId::parse("00000000-0000-4000-8000-000000000002").unwrap(),
        )
    }
    pub(in crate::mls_engine) fn admitted(index: u8) -> RelayId {
        RelayId::parse(&format!("00000000-0000-4000-8000-{index:012}")).unwrap()
    }
    pub(in crate::mls_engine) fn room(index: u8) -> NativeRoomScope {
        NativeRoomScope::new(
            scope().organisation.clone(),
            UuidV7::from_parts(1000, [index; 10]),
        )
    }
    pub(in crate::mls_engine) fn fixture(index: u8) -> (OpenMlsDevice, TestStore) {
        let mut store = TestStore::default();
        let mut own = finish(OpenMlsDevice::create_and_persist(
            scope(),
            b"public lifecycle fixture",
            &[7; 32],
            &mut store,
        ))
        .unwrap();
        let public = own.device_key();
        finish(own.admit_and_persist(admitted(index), public, &[7; 32], &mut store)).unwrap();
        (own, store)
    }
    pub(in crate::mls_engine) fn keys() -> MlsDeviceWrappingKeys<'static> {
        MlsDeviceWrappingKeys {
            device: &[7; 32],
            room: &[8; 32],
        }
    }

    fn restore(own: &OpenMlsDevice, store: &TestStore) -> OpenMlsDevice {
        OpenMlsDevice::restore_device(
            own.scope.clone(),
            own.device_key(),
            own.admitted.clone(),
            store.generation,
            store.sealed.as_ref().unwrap(),
            &[7; 32],
        )
        .unwrap()
    }

    #[test]
    fn one_admitted_signer_and_independent_packages_work_in_two_real_rooms_after_restart() {
        let (mut alice, mut a_store) = fixture(10);
        let (mut bob, mut b_store) = fixture(11);
        let a = alice.device_key();
        let b = bob.device_key();
        let roster = HashSet::from([a, b]);
        let first = finish(bob.prepare_key_package_and_persist(&[7; 32], &mut b_store)).unwrap();
        let second = finish(bob.prepare_key_package_and_persist(&[7; 32], &mut b_store)).unwrap();
        assert_ne!(first.id(), second.id());
        drop(bob);
        let mut bob = OpenMlsDevice::restore_device(
            scope(),
            b,
            Some(admitted(11)),
            b_store.generation,
            b_store.sealed.as_ref().unwrap(),
            &[7; 32],
        )
        .unwrap();
        for (scope, package) in [(room(1), first), (room(2), second)] {
            let mut a_session =
                finish(alice.create_room_and_persist(scope.clone(), keys(), &mut a_store)).unwrap();
            assert_eq!(a_session.device_key(), a);
            a_session.replace_authorised_roster(roster.clone()).unwrap();
            let addition = a_session.add_member(package.as_bytes(), &b).unwrap();
            let mut b_session = finish(bob.join_and_persist(
                PendingMlsWelcome {
                    package: package.id(),
                    scope: scope.clone(),
                    expected_epoch: addition.epoch,
                    welcome: addition.welcome.as_ref().unwrap(),
                    authorised: roster.clone(),
                },
                keys(),
                &mut b_store,
            ))
            .unwrap();
            assert_eq!(b_session.device_key(), b);
            let encrypted = a_session
                .seal(b"real shared-identity room message")
                .unwrap();
            assert_eq!(
                b_session.open(&encrypted).unwrap(),
                b"real shared-identity room message"
            );
            assert_eq!(
                a_session.export_media_key().unwrap(),
                b_session.export_media_key().unwrap()
            );
            assert!(matches!(
                finish(bob.join_and_persist(
                    PendingMlsWelcome {
                        package: package.id(),
                        scope,
                        expected_epoch: addition.epoch,
                        welcome: addition.welcome.as_ref().unwrap(),
                        authorised: roster.clone()
                    },
                    keys(),
                    &mut b_store
                )),
                Err(NativeCryptoError::Replay)
            ));
        }
        assert!(bob.pending.is_empty());
        assert_eq!(bob.device_key(), b);
        assert_eq!(b_store.rooms.len(), 2);
    }

    #[test]
    fn malformed_or_wrong_scope_welcome_is_retryable_before_any_host_cas() {
        let (mut alice, mut a_store) = fixture(10);
        let (mut bob, mut b_store) = fixture(11);
        let package = finish(bob.prepare_key_package_and_persist(&[7; 32], &mut b_store)).unwrap();
        let roster = HashSet::from([alice.device_key(), bob.device_key()]);
        let mut session =
            finish(alice.create_room_and_persist(room(1), keys(), &mut a_store)).unwrap();
        session.replace_authorised_roster(roster.clone()).unwrap();
        let addition = session
            .add_member(package.as_bytes(), &bob.device_key())
            .unwrap();
        let before = b_store.attempts;
        for (scope, epoch, welcome) in [
            (room(1), addition.epoch, &b"invalid welcome"[..]),
            (
                room(2),
                addition.epoch,
                addition.welcome.as_ref().unwrap().as_slice(),
            ),
            (
                room(1),
                addition.epoch + 1,
                addition.welcome.as_ref().unwrap().as_slice(),
            ),
        ] {
            assert!(finish(bob.join_and_persist(
                PendingMlsWelcome {
                    package: package.id(),
                    scope,
                    expected_epoch: epoch,
                    welcome,
                    authorised: roster.clone()
                },
                keys(),
                &mut b_store
            ))
            .is_err());
            assert_eq!(b_store.attempts, before);
            assert!(!bob.quarantined);
            assert!(bob.pending.contains_key(&package.id()));
        }
        assert!(finish(bob.join_and_persist(
            PendingMlsWelcome {
                package: package.id(),
                scope: room(1),
                expected_epoch: addition.epoch,
                welcome: addition.welcome.as_ref().unwrap(),
                authorised: roster
            },
            keys(),
            &mut b_store
        ))
        .is_ok());
    }

    #[test]
    fn every_failed_or_cancelled_cas_quarantines_until_authoritative_restore() {
        for mode in [
            WriteMode::Abort,
            WriteMode::Conflict,
            WriteMode::Pending,
            WriteMode::CommitThenPending,
            WriteMode::CommitThenError,
        ] {
            let (mut own, mut store) = fixture(10);
            let before = own.generation;
            store.mode = mode;
            match mode {
                WriteMode::Pending | WriteMode::CommitThenPending => {
                    poll_pending_once(own.prepare_key_package_and_persist(&[7; 32], &mut store))
                }
                _ => assert!(
                    finish(own.prepare_key_package_and_persist(&[7; 32], &mut store)).is_err()
                ),
            }
            assert!(own.quarantined);
            assert!(own.requires_restore());
            assert_eq!(own.generation, before);
            assert!(own.pending.is_empty());
            assert!(matches!(
                own.registration_request(),
                Err(NativeCryptoError::Storage)
            ));
            assert!(matches!(
                own.pending_key_packages(),
                Err(NativeCryptoError::Storage)
            ));
            assert!(matches!(
                finish(own.prepare_key_package_and_persist(&[7; 32], &mut store)),
                Err(NativeCryptoError::Storage)
            ));
            let mut current = restore(&own, &store);
            assert!(!current.quarantined);
            let committed = matches!(
                mode,
                WriteMode::CommitThenPending | WriteMode::CommitThenError
            );
            assert_eq!(current.pending.len(), usize::from(committed));
            let recovered = current.pending_key_packages().unwrap();
            assert_eq!(recovered.len(), usize::from(committed));
            for public in recovered {
                assert!(!public.as_bytes().is_empty());
                assert!(current
                    .sign_relay_request(
                        super::super::relay_statement::RelayStatement::PublishKeyPackage {
                            package: public.id()
                        }
                    )
                    .is_ok());
            }
            assert_eq!(current.generation, before + u64::from(committed));
            assert!(finish(current.prepare_key_package_and_persist(&[7; 32], &mut store)).is_ok());
        }
    }

    #[test]
    fn committed_but_cancelled_join_recovers_room_and_consumed_package_atomically() {
        let (mut alice, mut a_store) = fixture(10);
        let (mut bob, mut b_store) = fixture(11);
        let package = finish(bob.prepare_key_package_and_persist(&[7; 32], &mut b_store)).unwrap();
        let old = b_store.sealed.as_ref().unwrap().clone();
        let roster = HashSet::from([alice.device_key(), bob.device_key()]);
        let mut a_session =
            finish(alice.create_room_and_persist(room(1), keys(), &mut a_store)).unwrap();
        a_session.replace_authorised_roster(roster.clone()).unwrap();
        let addition = a_session
            .add_member(package.as_bytes(), &bob.device_key())
            .unwrap();
        b_store.mode = WriteMode::CommitThenPending;
        poll_pending_once(bob.join_and_persist(
            PendingMlsWelcome {
                package: package.id(),
                scope: room(1),
                expected_epoch: addition.epoch,
                welcome: addition.welcome.as_ref().unwrap(),
                authorised: roster.clone(),
            },
            keys(),
            &mut b_store,
        ));
        assert!(bob.quarantined);
        assert!(bob.pending.contains_key(&package.id())); // inert old memory, not durable authority
        assert_eq!(b_store.rooms.len(), 1);
        assert!(OpenMlsDevice::restore_device(
            scope(),
            bob.device_key(),
            Some(admitted(11)),
            b_store.generation,
            &old,
            &[7; 32]
        )
        .is_err());
        let mut current = restore(&bob, &b_store);
        assert!(current.pending.is_empty());
        assert!(matches!(
            finish(current.join_and_persist(
                PendingMlsWelcome {
                    package: package.id(),
                    scope: room(1),
                    expected_epoch: addition.epoch,
                    welcome: addition.welcome.as_ref().unwrap(),
                    authorised: roster.clone()
                },
                keys(),
                &mut b_store
            )),
            Err(NativeCryptoError::Replay)
        ));
        let (epoch, checkpoint) = b_store.rooms.get(&room(1).room().to_string()).unwrap();
        let mut recovered = OpenMlsSession::restore_checkpoint(
            room(1),
            bob.device_key(),
            *epoch,
            1,
            roster,
            checkpoint,
            &[8; 32],
        )
        .unwrap();
        let message = a_session
            .seal(b"survives committed callback cancellation")
            .unwrap();
        assert_eq!(
            recovered.open(&message).unwrap(),
            b"survives committed callback cancellation"
        );
    }

    #[test]
    fn pending_cancellation_and_room_conflict_preserve_host_atomicity() {
        let (mut own, mut store) = fixture(10);
        let package = finish(own.prepare_key_package_and_persist(&[7; 32], &mut store)).unwrap();
        let old = store.sealed.as_ref().unwrap().clone();
        finish(own.cancel_package_and_persist(package.id(), &[7; 32], &mut store)).unwrap();
        assert!(own.pending.is_empty());
        assert!(OpenMlsDevice::restore_device(
            scope(),
            own.device_key(),
            Some(admitted(10)),
            store.generation,
            &old,
            &[7; 32]
        )
        .is_err());
        assert!(matches!(
            finish(own.cancel_package_and_persist(package.id(), &[7; 32], &mut store)),
            Err(NativeCryptoError::Replay)
        ));
        let _session = finish(own.create_room_and_persist(room(1), keys(), &mut store)).unwrap();
        let generation = store.generation;
        let sealed = store.sealed.as_ref().unwrap().as_bytes().to_vec();
        assert!(matches!(
            finish(own.create_room_and_persist(room(1), keys(), &mut store)),
            Err(NativeCryptoError::Replay)
        ));
        assert!(own.quarantined);
        assert_eq!(store.generation, generation);
        assert_eq!(store.sealed.as_ref().unwrap().as_bytes(), sealed);
        assert_eq!(store.rooms.len(), 1);
    }

    #[test]
    fn vault_ciphertext_is_bound_redacted_bounded_and_never_rebinds_admission() {
        let (mut own, mut store) = fixture(10);
        let package = finish(own.prepare_key_package_and_persist(&[7; 32], &mut store)).unwrap();
        let sealed = store.sealed.as_ref().unwrap();
        assert_eq!(format!("{own:?}"), "OpenMlsDevice([redacted])");
        assert_eq!(format!("{sealed:?}"), "SealedMlsDeviceState([redacted])");
        let raw = encode_provider(own.pending[&package.id()].provider.provider()).unwrap();
        assert!(!sealed
            .as_bytes()
            .windows(raw.0.len())
            .any(|window| window == raw.0.as_slice()));
        for (wanted_scope, wanted_key, wanted_admitted, generation, key) in [
            (
                MlsDeviceScope::new(scope().organisation.clone(), admitted(99)),
                own.device_key(),
                Some(admitted(10)),
                store.generation,
                [7; 32],
            ),
            (
                scope(),
                [0; 32],
                Some(admitted(10)),
                store.generation,
                [7; 32],
            ),
            (
                scope(),
                own.device_key(),
                Some(admitted(99)),
                store.generation,
                [7; 32],
            ),
            (
                scope(),
                own.device_key(),
                Some(admitted(10)),
                store.generation + 1,
                [7; 32],
            ),
            (
                scope(),
                own.device_key(),
                Some(admitted(10)),
                store.generation,
                [9; 32],
            ),
        ] {
            assert!(OpenMlsDevice::restore_device(
                wanted_scope,
                wanted_key,
                wanted_admitted,
                generation,
                sealed,
                &key
            )
            .is_err());
        }
        let mut damaged = sealed.as_bytes().to_vec();
        let last = damaged.len() - 1;
        damaged[last] ^= 1;
        let damaged = SealedMlsDeviceState::from_bytes(&damaged).unwrap();
        assert!(OpenMlsDevice::restore_device(
            scope(),
            own.device_key(),
            Some(admitted(10)),
            store.generation,
            &damaged,
            &[7; 32]
        )
        .is_err());
        assert!(
            SealedMlsDeviceState::from_bytes(&vec![0; MAX_SEALED_MLS_DEVICE_BYTES + 1]).is_err()
        );
        let own_key = own.device_key();
        assert!(matches!(
            finish(own.admit_and_persist(admitted(99), own_key, &[7; 32], &mut store)),
            Err(NativeCryptoError::UnauthorisedDevice)
        ));
        assert!(!own.quarantined);
    }

    #[test]
    fn unadmitted_device_never_exposes_packages_or_rooms_and_capacity_refuses_before_cas() {
        let mut store = TestStore::default();
        let mut own = finish(OpenMlsDevice::create_and_persist(
            scope(),
            b"public fixture",
            &[7; 32],
            &mut store,
        ))
        .unwrap();
        assert!(own.registration_request().is_ok());
        let before = store.attempts;
        assert!(matches!(
            finish(own.prepare_key_package_and_persist(&[7; 32], &mut store)),
            Err(NativeCryptoError::UnauthorisedDevice)
        ));
        assert!(matches!(
            finish(own.create_room_and_persist(room(1), keys(), &mut store)),
            Err(NativeCryptoError::UnauthorisedDevice)
        ));
        assert_eq!(store.attempts, before);
        let key = own.device_key();
        finish(own.admit_and_persist(admitted(10), key, &[7; 32], &mut store)).unwrap();
        assert!(own.registration_request().is_err());
        for _ in 0..MAX_PENDING {
            finish(own.prepare_key_package_and_persist(&[7; 32], &mut store)).unwrap();
        }
        let before = store.attempts;
        assert!(matches!(
            finish(own.prepare_key_package_and_persist(&[7; 32], &mut store)),
            Err(NativeCryptoError::Capacity)
        ));
        assert_eq!(store.attempts, before);
        assert_eq!(own.pending.len(), MAX_PENDING);
    }

    #[test]
    fn authenticated_malformed_vault_framing_is_refused_before_private_decode() {
        let (mut own, mut store) = fixture(10);
        for _ in 0..2 {
            finish(own.prepare_key_package_and_persist(&[7; 32], &mut store)).unwrap();
        }
        let sealed = store.sealed.as_ref().unwrap();
        let tag_start = sealed.0.len() - TAG_BYTES;
        let mut plain = CheckpointBuffer(sealed.0[HEADER_BYTES..tag_start].to_vec());
        let aad = binding(&scope(), &own.device_key(), store.generation);
        Aes256Gcm::new_from_slice(&[7; 32])
            .unwrap()
            .decrypt_in_place_detached(
                Nonce::from_slice(&sealed.0[MAGIC.len()..HEADER_BYTES]),
                &aad,
                &mut plain.0,
                Tag::from_slice(&sealed.0[tag_start..]),
            )
            .unwrap();
        let mut input = plain.0.as_slice();
        bounded_field(&mut input, 128).unwrap();
        bounded_field(&mut input, 36).unwrap();
        let provider_start = plain.0.len() - input.len() + 4;
        bounded_field(&mut input, MAX_STORAGE_BYTES).unwrap();
        let count_start = plain.0.len() - input.len();
        assert_eq!(number(&mut input).unwrap(), 2);
        let first_start = plain.0.len() - input.len();
        take(&mut input, 32).unwrap();
        bounded_field(&mut input, MAX_PACKAGE_BYTES).unwrap();
        bounded_field(&mut input, MAX_STORAGE_BYTES).unwrap();
        let second_start = plain.0.len() - input.len();
        let mut trailing = CheckpointBuffer(plain.0.clone());
        trailing.0.push(0);
        let mut duplicate = CheckpointBuffer(plain.0[..first_start].to_vec());
        duplicate
            .0
            .extend_from_slice(&plain.0[first_start..second_start]);
        duplicate
            .0
            .extend_from_slice(&plain.0[first_start..second_start]);
        let mut unordered = CheckpointBuffer(plain.0[..first_start].to_vec());
        unordered.0.extend_from_slice(&plain.0[second_start..]);
        unordered
            .0
            .extend_from_slice(&plain.0[first_start..second_start]);
        let mut excessive = CheckpointBuffer(plain.0.clone());
        excessive.0[count_start..count_start + 4]
            .copy_from_slice(&(MAX_PENDING as u32 + 1).to_be_bytes());
        let mut excessive_map = CheckpointBuffer(plain.0.clone());
        excessive_map.0[provider_start..provider_start + 4]
            .copy_from_slice(&(MAX_PROVIDER_RECORDS as u32 + 1).to_be_bytes());
        for (mut broken, expected) in [
            (trailing, NativeCryptoError::InvalidInput),
            (duplicate, NativeCryptoError::InvalidInput),
            (unordered, NativeCryptoError::InvalidInput),
            (excessive, NativeCryptoError::Capacity),
            (excessive_map, NativeCryptoError::Capacity),
        ] {
            // Fixed nonce belongs only to distinct malformed test records, never
            // to the public sealing path. The fixture key is public test data.
            let nonce = [41; NONCE_BYTES];
            let tag = Aes256Gcm::new_from_slice(&[7; 32])
                .unwrap()
                .encrypt_in_place_detached(Nonce::from_slice(&nonce), &aad, &mut broken.0)
                .unwrap();
            let mut bytes = MAGIC.to_vec();
            bytes.extend_from_slice(&nonce);
            bytes.extend_from_slice(&broken.0);
            bytes.extend_from_slice(&tag);
            let broken = SealedMlsDeviceState::from_bytes(&bytes).unwrap();
            assert!(
                matches!(OpenMlsDevice::restore_device(scope(),own.device_key(),Some(admitted(10)),store.generation,&broken,&[7;32]),Err(error) if error==expected)
            );
        }
        // The original authenticated state remains usable after all refusals.
        assert_eq!(restore(&own, &store).pending.len(), 2);
        assert!(!own.quarantined);
    }
}
