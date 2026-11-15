//! Durable, bounded MLS application delivery. This is an internal host seam,
//! not a platform store, HTTP client, media provider or rollback oracle.

use std::cell::Cell;
use std::collections::{BTreeMap, HashSet};
use std::future::Future;

use aes_gcm::{aead::AeadInPlace, Aes256Gcm, KeyInit, Nonce, Tag};
use base64::{engine::general_purpose::STANDARD, Engine};
use openmls_traits::{crypto::OpenMlsCrypto, random::OpenMlsRand};

use super::persistence::{take, CheckpointBuffer};
use super::relay_statement::MAX_JSON_INTEGER;
use super::*;

const MAGIC: &[u8; 4] = b"KDR1";
const FRAME: &[u8; 4] = b"KMA1";
const MAX_BODY: usize = 40 * 1024;
const FRAME_OVERHEAD: usize = 45;
const MAX_HTTP: usize = 64 * 1024;
const MAX_INNER: usize = 14 * 1024 * 1024;
const MAX_COMPOUND: usize = 17 * 1024 * 1024;
const MAX_RECEIPTS: usize = 32;
const MAX_RECEIPT_BYTES: usize = 512 * 1024;
const MAX_HISTORY: usize = 64;
const MAX_CATCH_UP: u8 = 64;

#[derive(Debug, PartialEq, Eq)]
pub enum DurableMlsError {
    Crypto(NativeCryptoError),
    InvalidInput,
    Capacity,
    ContextChanged,
    RequiresRestore,
    Conflict,
    Storage,
    ReusedOperationId,
    PendingRequest,
    RecoveryRequired,
}
impl From<NativeCryptoError> for DurableMlsError {
    fn from(error: NativeCryptoError) -> Self {
        Self::Crypto(error)
    }
}
type Result<T> = std::result::Result<T, DurableMlsError>;

/// Public immutable scope. The host authenticates every value independently.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DurableMlsBinding {
    pub owner: RelayId,
    pub room: NativeRoomScope,
    pub membership: RelayId,
    pub device: RelayId,
    pub signing_key: Ed25519PublicKey,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DurableMlsRoster(BTreeMap<RelayId, Ed25519PublicKey>);
impl DurableMlsRoster {
    pub fn new(devices: Vec<(RelayId, Ed25519PublicKey)>) -> Result<Self> {
        if devices.is_empty() || devices.len() > MAX_MEMBERS {
            return Err(DurableMlsError::Capacity);
        }
        let mut map = BTreeMap::new();
        let mut keys = HashSet::new();
        for (id, key) in devices {
            if !keys.insert(key) || map.insert(id, key).is_some() {
                return Err(DurableMlsError::InvalidInput);
            }
        }
        Ok(Self(map))
    }
    pub fn devices(&self) -> &BTreeMap<RelayId, Ed25519PublicKey> {
        &self.0
    }
    fn keys(&self) -> HashSet<Ed25519PublicKey> {
        self.0.values().copied().collect()
    }
    fn contains(&self, id: &RelayId, key: &Ed25519PublicKey) -> bool {
        self.0.get(id) == Some(key)
    }
    fn eligible_in(&self, eligible: &Self) -> bool {
        self.0.iter().all(|(id, key)| eligible.contains(id, key))
    }
}

/// Fresh authenticated Core snapshot, bound to the host's current ticket.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DurableMlsAuthority {
    pub epoch: u64,
    pub room_roster: DurableMlsRoster,
    pub eligible: DurableMlsRoster,
    pub rekey_required: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DurableMlsCapability {
    Read,
    Write,
    RetryCommit,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DurableMlsLogicalId {
    pub sender: Ed25519PublicKey,
    pub operation: RelayId,
}

/// A trusted host assertion, not cryptographic attestation of an external cache.
/// The exact encrypted record must remain pinned across cleanup and restarts,
/// including after retirement, until explicit history deletion/discard policy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DurableMlsCacheHandoff {
    pub logical: DurableMlsLogicalId,
    pub digest: [u8; 32],
    pub cache_record: RelayId,
    pub cache_generation: u64,
}
pub enum DurableMlsRetirement<'a> {
    PinnedEncryptedCache(&'a DurableMlsCacheHandoff),
    ExplicitDiscard,
}

/// Final signed body and stable idempotency identity; no access token or URL.
#[derive(Clone, PartialEq, Eq)]
pub struct DurableMlsRequest {
    operation: RelayId,
    kind: IntentKind,
    room: NativeRoomScope,
    body: Vec<u8>,
}
impl fmt::Debug for DurableMlsRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DurableMlsRequest([redacted])")
    }
}
impl DurableMlsRequest {
    pub fn operation_id(&self) -> &RelayId {
        &self.operation
    }
    pub fn operation(&self) -> &'static str {
        if self.kind == IntentKind::Application {
            "send-application"
        } else {
            "commit-epoch"
        }
    }
    pub fn room(&self) -> &NativeRoomScope {
        &self.room
    }
    pub fn body(&self) -> &[u8] {
        &self.body
    }
}

/// Local logical-message recovery, including pending and not-delivered own
/// sends. This type does NOT prove remote delivery or a server acknowledgement.
pub struct DurableMlsDelivery {
    logical: DurableMlsLogicalId,
    body: CheckpointBuffer,
}
impl fmt::Debug for DurableMlsDelivery {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DurableMlsDelivery([redacted])")
    }
}
impl DurableMlsDelivery {
    pub fn logical_id(&self) -> &DurableMlsLogicalId {
        &self.logical
    }
    pub fn body(&self) -> &[u8] {
        &self.body.0
    }
}
#[derive(Clone)]
pub struct SealedDurableMlsRoom(Vec<u8>);
impl fmt::Debug for SealedDurableMlsRoom {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SealedDurableMlsRoom([redacted])")
    }
}
impl SealedDurableMlsRoom {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_COMPOUND {
            return Err(DurableMlsError::Capacity);
        }
        if bytes.len() < 33 || !bytes.starts_with(MAGIC) {
            return Err(DurableMlsError::InvalidInput);
        }
        Ok(Self(bytes.to_vec()))
    }
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

/// Untrusted bytes read from host persistence, not a publishable ReadyRequest.
/// Restore authenticates exact manifest equality before returning any request.
#[derive(Clone, PartialEq, Eq)]
pub struct DurableMlsPendingSend {
    operation: RelayId,
    body: Vec<u8>,
}
impl fmt::Debug for DurableMlsPendingSend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DurableMlsPendingSend([redacted])")
    }
}
impl DurableMlsPendingSend {
    pub fn from_bytes(operation: RelayId, body: &[u8]) -> Result<Self> {
        if body.is_empty() || body.len() > MAX_HTTP {
            return Err(DurableMlsError::Capacity);
        }
        Ok(Self {
            operation,
            body: body.to_vec(),
        })
    }
    pub fn operation_id(&self) -> &RelayId {
        &self.operation
    }
    pub fn body(&self) -> &[u8] {
        &self.body
    }
    fn from_request(request: &DurableMlsRequest) -> Self {
        Self {
            operation: request.operation.clone(),
            body: request.body.clone(),
        }
    }
}

/// Historical bootstrap witness, protected with the generation-one room by
/// the trusted host. A bare latest/headSequence is never an initial anchor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DurableMlsInitialCursor {
    Creator,
    Welcome {
        epoch: u64,
        sequence: u64,
        envelope: RelayId,
        digest: [u8; 32],
    },
}
impl DurableMlsInitialCursor {
    fn cursor(&self) -> u64 {
        match self {
            Self::Creator => 0,
            Self::Welcome { sequence, .. } => *sequence,
        }
    }
    fn epoch(&self) -> u64 {
        match self {
            Self::Creator => 0,
            Self::Welcome { epoch, .. } => *epoch,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DurableMlsReadItem {
    pub envelope: RelayId,
    pub sequence: u64,
    pub epoch: u64,
    pub sender_device: RelayId,
    pub sender_key: Ed25519PublicKey,
    pub kind: DurableMlsEnvelopeKind,
    pub digest: [u8; 32],
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DurableMlsReadObligation {
    Initial(DurableMlsInitialCursor),
    NextVisible {
        previous_cursor: u64,
        item: DurableMlsReadItem,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DurableMlsCommitMarker {
    pub item: DurableMlsReadItem,
    pub roster: DurableMlsRoster,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DurableMlsCommitResolution {
    Accepted(DurableMlsCommitMarker),
    DefiniteNonAcceptance(DurableMlsCommitMarker),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DurableMlsCommitObligation {
    pub operation: RelayId,
    pub body_digest: [u8; 32],
    pub own_wire_digest: [u8; 32],
    pub previous_epoch: u64,
    pub target_epoch: u64,
    pub target: DurableMlsRoster,
    pub resolution: DurableMlsCommitResolution,
}

pub struct DurableMlsWrite<'a> {
    pub binding: &'a DurableMlsBinding,
    pub expected_generation: u64,
    pub generation: u64,
    pub epoch: u64,
    pub cursor: u64,
    pub sealed: &'a SealedDurableMlsRoom,
    /// Exactly the same complete request bytes authenticated inside `sealed`.
    pub pending_sends: &'a [DurableMlsPendingSend],
}

/// The trusted host owns current accepted Core/worker/workspace tickets, durable
/// atomic CAS and owner-incarnation fences. Ticket checks must consult LIVE host
/// state, never echo candidate/checkpoint fields. Cache checks verify a durable
/// retention pin enforced by all cache actors; a past commit is insufficient.
pub trait DurableMlsStore {
    type AuthorityTicket;
    type ReadOrderTicket;
    type CommitOutcomeTicket;
    /// Must consult actual authenticated Core page/head state, never echo the
    /// requested predecessor or choose an arbitrary later visible envelope.
    fn check_read_order(
        &self,
        context: &Self::AuthorityTicket,
        ticket: &Self::ReadOrderTicket,
        binding: &DurableMlsBinding,
        obligation: &DurableMlsReadObligation,
    ) -> Result<()>;
    /// After restart reissue ONLY from fresh authenticated immutable Core outcome
    /// and canonical-slot evidence. KDR1 metadata itself cannot mint this ticket.
    fn check_commit_outcome(
        &self,
        context: &Self::AuthorityTicket,
        ticket: &Self::CommitOutcomeTicket,
        binding: &DurableMlsBinding,
        obligation: &DurableMlsCommitObligation,
    ) -> Result<()>;
    fn check_current(
        &self,
        ticket: &Self::AuthorityTicket,
        binding: &DurableMlsBinding,
        authority: &DurableMlsAuthority,
        capability: DurableMlsCapability,
    ) -> Result<()>;
    fn check_cache_handoff(
        &self,
        ticket: &Self::AuthorityTicket,
        binding: &DurableMlsBinding,
        handoff: &DurableMlsCacheHandoff,
    ) -> Result<()>;
    fn compare_and_swap<'a>(
        &'a mut self,
        write: &'a DurableMlsWrite<'_>,
    ) -> impl Future<Output = Result<()>> + 'a;
}
pub struct DurableMlsAccess<'a, S: DurableMlsStore> {
    pub store: &'a mut S,
    pub ticket: &'a S::AuthorityTicket,
    pub authority: &'a DurableMlsAuthority,
    pub wrapping_key: &'a [u8; 32],
    pub order_ticket: Option<S::ReadOrderTicket>,
    pub outcome_ticket: Option<S::CommitOutcomeTicket>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DurableMlsEnvelopeKind {
    Application,
    Commit,
}
pub struct DurableMlsIncoming<'a> {
    pub envelope: RelayId,
    pub sequence: u64,
    pub epoch: u64,
    pub sender_device: RelayId,
    pub sender_key: Ed25519PublicKey,
    pub kind: DurableMlsEnvelopeKind,
    pub ciphertext: &'a [u8],
}
pub enum DurableMlsChange<'a> {
    Add {
        key_package: &'a [u8],
        device: RelayId,
        key: Ed25519PublicKey,
    },
    Remove {
        devices: &'a [RelayId],
    },
    Rotate,
}
pub enum DurableMlsOutcome {
    ApplicationAccepted {
        envelope: RelayId,
        sequence: u64,
        epoch: u64,
    },
    ApplicationNotDelivered,
    CommitAccepted {
        envelope: RelayId,
        sequence: u64,
        epoch: u64,
    },
    CommitNotAccepted {
        winner: DurableMlsCommitMarker,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum IntentKind {
    Application = 1,
    Add = 2,
    Remove = 3,
    Rotate = 4,
}
impl IntentKind {
    fn read(byte: u8) -> Result<Self> {
        match byte {
            1 => Ok(Self::Application),
            2 => Ok(Self::Add),
            3 => Ok(Self::Remove),
            4 => Ok(Self::Rotate),
            _ => Err(DurableMlsError::InvalidInput),
        }
    }
}
struct HistoricalBranch {
    sealed: SealedMlsState,
    generation: u64,
    epoch: u64,
    origin_cursor: u64,
    envelopes: u8,
}
struct Pending {
    request: DurableMlsRequest,
    intent: [u8; 32],
    wire: [u8; 32],
    previous: u64,
    target_epoch: u64,
    prior: DurableMlsRoster,
    target: DurableMlsRoster,
    historical: Option<HistoricalBranch>,
    resolution: Option<DurableMlsCommitResolution>,
}
struct Receipt {
    logical: DurableMlsLogicalId,
    epoch: u64,
    sender_device: RelayId,
    wire: [u8; 32],
    body: CheckpointBuffer,
    own: bool,
    transport: Option<(RelayId, u64)>,
}
struct Retired {
    logical: Option<DurableMlsLogicalId>,
    epoch: u64,
    wire: [u8; 32],
    sender: Ed25519PublicKey,
    sender_device: RelayId,
    kind: DurableMlsEnvelopeKind,
    transport: Option<(RelayId, u64)>,
    intent: Option<(RelayId, IntentKind, [u8; 32])>,
    cache: Option<DurableMlsCacheHandoff>,
}
#[derive(Clone)]
struct CatchUp {
    origin_epoch: u64,
    origin_cursor: u64,
    envelopes: u8,
    transitions: u8,
}
#[derive(Clone)]
enum Mode {
    Live,
    CatchingUp(CatchUp),
    Recovery,
}

/// Exclusive durable owner of private MLS state. No raw-session escape exists.
pub struct DurableMlsRoom {
    binding: DurableMlsBinding,
    session: OpenMlsSession,
    known_roster: DurableMlsRoster,
    generation: u64,
    cursor: u64,
    initial: DurableMlsInitialCursor,
    mode: Mode,
    pending: Option<Pending>,
    receipts: Vec<Receipt>,
    retired: Vec<Retired>,
    quarantined: Cell<bool>,
}
impl fmt::Debug for DurableMlsRoom {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DurableMlsRoom([redacted])")
    }
}
impl Drop for DurableMlsRoom {
    fn drop(&mut self) {
        let mut map = self
            .session
            .provider
            .storage()
            .values
            .write()
            .unwrap_or_else(|e| e.into_inner());
        for (key, value) in map.drain() {
            drop(tls_codec::SecretVLBytes::new(key));
            drop(tls_codec::SecretVLBytes::new(value));
        }
    }
}

fn hash(input: &[u8]) -> Result<[u8; 32]> {
    OpenMlsRustCrypto::default()
        .crypto()
        .hash(SUITE.hash_algorithm(), input)
        .map_err(failed)?
        .try_into()
        .map_err(|_| DurableMlsError::InvalidInput)
}
fn canonical_id(bytes: &[u8]) -> Result<RelayId> {
    RelayId::parse(std::str::from_utf8(bytes).map_err(|_| DurableMlsError::InvalidInput)?)
        .map_err(Into::into)
}
fn frame(id: &RelayId, body: &[u8]) -> Result<CheckpointBuffer> {
    if body.len() > MAX_BODY || std::str::from_utf8(body).is_err() {
        return Err(DurableMlsError::InvalidInput);
    }
    let mut bytes = Vec::with_capacity(FRAME_OVERHEAD + body.len());
    bytes.extend_from_slice(FRAME);
    bytes.push(1);
    bytes.extend_from_slice(id.as_str().as_bytes());
    bytes.extend_from_slice(&(body.len() as u32).to_be_bytes());
    bytes.extend_from_slice(body);
    Ok(CheckpointBuffer(bytes))
}
fn unframe(bytes: &[u8]) -> Result<(RelayId, &[u8])> {
    if bytes.len() < FRAME_OVERHEAD
        || bytes.len() > FRAME_OVERHEAD + MAX_BODY
        || &bytes[..4] != FRAME
        || bytes[4] != 1
    {
        return Err(DurableMlsError::InvalidInput);
    }
    let id = canonical_id(&bytes[5..41])?;
    let size = u32::from_be_bytes(
        bytes[41..45]
            .try_into()
            .map_err(|_| DurableMlsError::InvalidInput)?,
    ) as usize;
    if size != bytes.len() - FRAME_OVERHEAD || std::str::from_utf8(&bytes[45..]).is_err() {
        return Err(DurableMlsError::InvalidInput);
    }
    Ok((id, &bytes[45..]))
}
fn group_keys(session: &OpenMlsSession) -> Result<HashSet<Ed25519PublicKey>> {
    if session.group.members().count() > MAX_MEMBERS {
        return Err(DurableMlsError::Capacity);
    }
    session
        .group
        .members()
        .map(|m| {
            m.signature_key
                .as_slice()
                .try_into()
                .map_err(|_| DurableMlsError::InvalidInput)
        })
        .collect()
}
fn valid_number(n: u64) -> Result<()> {
    if n > MAX_JSON_INTEGER {
        Err(DurableMlsError::InvalidInput)
    } else {
        Ok(())
    }
}

impl DurableMlsRoom {
    pub fn binding(&self) -> &DurableMlsBinding {
        &self.binding
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn epoch(&self) -> u64 {
        self.session.epoch()
    }
    pub fn cursor(&self) -> u64 {
        self.cursor
    }
    pub fn requires_restore(&self) -> bool {
        self.quarantined.get()
    }
    pub fn is_catching_up(&self) -> bool {
        matches!(self.mode, Mode::CatchingUp(_))
    }
    fn check<S: DurableMlsStore>(
        &self,
        access: &DurableMlsAccess<'_, S>,
        capability: DurableMlsCapability,
    ) -> Result<()> {
        if self.quarantined.get() {
            return Err(DurableMlsError::RequiresRestore);
        }
        self.fence(access, capability)
    }
    fn fence<S: DurableMlsStore>(
        &self,
        access: &DurableMlsAccess<'_, S>,
        capability: DurableMlsCapability,
    ) -> Result<()> {
        let result =
            access
                .store
                .check_current(access.ticket, &self.binding, access.authority, capability);
        if result.is_err() {
            self.quarantined.set(true);
        }
        result
    }
    fn guards<S: DurableMlsStore>(
        &self,
        access: &DurableMlsAccess<'_, S>,
        read: Option<&DurableMlsReadObligation>,
        outcome: Option<&DurableMlsCommitObligation>,
    ) -> Result<()> {
        if let Some(read) = read {
            let ticket = access
                .order_ticket
                .as_ref()
                .ok_or(DurableMlsError::ContextChanged)?;
            access
                .store
                .check_read_order(access.ticket, ticket, &self.binding, read)?;
        }
        if let Some(outcome) = outcome {
            let ticket = access
                .outcome_ticket
                .as_ref()
                .ok_or(DurableMlsError::ContextChanged)?;
            access
                .store
                .check_commit_outcome(access.ticket, ticket, &self.binding, outcome)?;
        }
        Ok(())
    }
    fn outcome_obligation(&self) -> Result<Option<DurableMlsCommitObligation>> {
        self.pending
            .as_ref()
            .filter(|p| p.request.kind != IntentKind::Application)
            .and_then(|p| p.resolution.clone().map(|r| (p, r)))
            .map(|(p, resolution)| {
                Ok(DurableMlsCommitObligation {
                    operation: p.request.operation.clone(),
                    body_digest: hash(&p.request.body)?,
                    own_wire_digest: p.wire,
                    previous_epoch: p.previous,
                    target_epoch: p.target_epoch,
                    target: p.target.clone(),
                    resolution,
                })
            })
            .transpose()
    }
    pub fn commit_outcome_obligation<S: DurableMlsStore>(
        &self,
        access: &DurableMlsAccess<'_, S>,
    ) -> Result<Option<DurableMlsCommitObligation>> {
        self.check(access, DurableMlsCapability::Read)?;
        let result = self.outcome_obligation()?;
        self.fence(access, DurableMlsCapability::Read)?;
        Ok(result)
    }
    fn own_eligible(&self, a: &DurableMlsAuthority) -> Result<()> {
        valid_number(a.epoch)?;
        if !a
            .eligible
            .contains(&self.binding.device, &self.binding.signing_key)
        {
            return Err(DurableMlsError::ContextChanged);
        }
        Ok(())
    }
    fn classify(&self, a: &DurableMlsAuthority) -> Result<Mode> {
        self.own_eligible(a)?;
        if matches!(self.mode, Mode::Recovery) {
            return Ok(Mode::Recovery);
        }
        let keys = group_keys(&self.session)?;
        if let Some(p) = &self.pending {
            if p.request.kind != IntentKind::Application {
                let old = p.historical.as_ref().ok_or(DurableMlsError::InvalidInput)?;
                if p.target_epoch
                    != p.previous
                        .checked_add(1)
                        .ok_or(DurableMlsError::InvalidInput)?
                    || self.epoch() != p.target_epoch
                    || keys != p.target.keys()
                    || old.epoch != p.previous
                    || old.origin_cursor > self.cursor
                    || old.envelopes > MAX_CATCH_UP
                    || a.epoch < p.previous
                    || a.epoch - p.previous > u64::from(MAX_CATCH_UP)
                {
                    return Err(DurableMlsError::RecoveryRequired);
                }
                return Ok(Mode::Live); // pending blocks all new own crypto
            }
            if self.epoch() != p.previous || a.epoch < self.epoch() {
                return Err(DurableMlsError::RecoveryRequired);
            }
            return Ok(Mode::Live);
        }
        if a.epoch == self.epoch() {
            if keys == a.room_roster.keys() && a.room_roster.eligible_in(&a.eligible) {
                return Ok(Mode::Live);
            }
            // A freshly observed revoked leaf may be removed, never used to send.
            if a.rekey_required
                && a.room_roster.keys().is_subset(&keys)
                && a.room_roster.eligible_in(&a.eligible)
            {
                return Ok(Mode::Live);
            }
            return Err(DurableMlsError::ContextChanged);
        }
        if a.epoch < self.epoch() {
            return Err(DurableMlsError::RecoveryRequired);
        }
        let catch = match &self.mode {
            Mode::CatchingUp(c) => c.clone(),
            _ => CatchUp {
                origin_epoch: self.epoch(),
                origin_cursor: self.cursor,
                envelopes: 0,
                transitions: 0,
            },
        };
        if a.epoch - catch.origin_epoch > u64::from(MAX_CATCH_UP)
            || catch.envelopes > MAX_CATCH_UP
            || catch.transitions > MAX_CATCH_UP
        {
            return Err(DurableMlsError::RecoveryRequired);
        }
        Ok(Mode::CatchingUp(catch))
    }
    fn ready_write<S: DurableMlsStore>(&self, access: &DurableMlsAccess<'_, S>) -> Result<()> {
        self.check(access, DurableMlsCapability::Write)?;
        self.own_eligible(access.authority)?;
        if self.pending.is_some() {
            return Err(DurableMlsError::PendingRequest);
        }
        if !matches!(self.classify(access.authority)?, Mode::Live) {
            return Err(DurableMlsError::RecoveryRequired);
        }
        Ok(())
    }
    fn new_operation(&self, id: &RelayId) -> Result<()> {
        if self
            .pending
            .as_ref()
            .is_some_and(|p| &p.request.operation == id)
            || self
                .receipts
                .iter()
                .any(|r| r.own && &r.logical.operation == id)
            || self
                .retired
                .iter()
                .any(|r| r.intent.as_ref().is_some_and(|(old, _, _)| old == id))
        {
            return Err(DurableMlsError::ReusedOperationId);
        }
        Ok(())
    }
    fn device(&self, device: &OpenMlsDevice) -> Result<()> {
        device.ensure_live()?;
        if device.scope().organisation() != self.binding.room.organisation()
            || device.scope().membership() != &self.binding.membership
            || device.admitted_id() != Some(&self.binding.device)
            || device.device_key() != self.binding.signing_key
        {
            return Err(DurableMlsError::ContextChanged);
        }
        Ok(())
    }
    fn receipt_capacity(&self, length: usize) -> Result<()> {
        let used = self
            .receipts
            .iter()
            .try_fold(length, |sum, r| sum.checked_add(r.body.0.len()))
            .ok_or(DurableMlsError::Capacity)?;
        if length > MAX_BODY || self.receipts.len() >= MAX_RECEIPTS || used > MAX_RECEIPT_BYTES {
            return Err(DurableMlsError::Capacity);
        }
        Ok(())
    }
    fn retire_record(&mut self, record: Retired) {
        if self.retired.len() == MAX_HISTORY {
            self.retired.remove(0);
        }
        self.retired.push(record);
    }
    fn request(&self) -> Result<DurableMlsRequest> {
        self.pending
            .as_ref()
            .map(|p| p.request.clone())
            .ok_or(DurableMlsError::InvalidInput)
    }

    /// The host admits only its exact generation-one initial KMS1 room record.
    /// This consumes the session; no raw session or usable controller escapes
    /// before the generation-two compound upgrade has committed and been fenced.
    pub async fn adopt_initial_and_persist<S: DurableMlsStore>(
        session: OpenMlsSession,
        binding: DurableMlsBinding,
        initial: DurableMlsInitialCursor,
        access: &mut DurableMlsAccess<'_, S>,
    ) -> Result<Self> {
        let mut own = Self {
            binding,
            session,
            known_roster: access.authority.room_roster.clone(),
            generation: 1,
            cursor: initial.cursor(),
            initial: initial.clone(),
            mode: Mode::Live,
            pending: None,
            receipts: Vec::new(),
            retired: Vec::new(),
            quarantined: Cell::new(true),
        };
        if own.session.scope() != &own.binding.room
            || own.session.device_key() != own.binding.signing_key
        {
            return Err(DurableMlsError::ContextChanged);
        }
        own.fence(access, DurableMlsCapability::Read)?;
        if initial.epoch() != own.epoch()
            || matches!(
                &initial,
                DurableMlsInitialCursor::Welcome { sequence: 0, .. }
                    | DurableMlsInitialCursor::Welcome { epoch: 0, .. }
            )
        {
            return Err(DurableMlsError::InvalidInput);
        }
        valid_number(initial.cursor())?;
        let order = DurableMlsReadObligation::Initial(initial);
        own.guards(access, Some(&order), None)?;
        own.mode = own.classify(access.authority)?;
        own.persist_guarded(access, DurableMlsCapability::Read, None, Some(&order), None)
            .await?;
        Ok(own)
    }

    pub async fn prepare_send_and_persist<S: DurableMlsStore>(
        &mut self,
        id: RelayId,
        body: &[u8],
        device: &OpenMlsDevice,
        access: &mut DurableMlsAccess<'_, S>,
    ) -> Result<DurableMlsRequest> {
        self.check(access, DurableMlsCapability::Write)?;
        self.new_operation(&id)?;
        self.ready_write(access)?;
        self.device(device)?;
        if access.authority.rekey_required
            || group_keys(&self.session)? != access.authority.room_roster.keys()
            || !access
                .authority
                .room_roster
                .eligible_in(&access.authority.eligible)
        {
            return Err(DurableMlsError::ContextChanged);
        }
        self.receipt_capacity(body.len())?;
        let framed = frame(&id, body)?;
        let intent = hash(&framed.0)?;
        self.quarantined.set(true);
        self.session.authorised = access.authority.room_roster.keys();
        let encrypted = self.session.seal(&framed.0)?;
        let signed = device.sign_relay_request(RelayStatement::SendApplication {
            room: &self.binding.room,
            epoch: self.epoch(),
            ciphertext: &encrypted.ciphertext,
        })?;
        let wire = hash(&encrypted.ciphertext)?;
        let request = admit_request(
            id.clone(),
            IntentKind::Application,
            &self.binding.room,
            signed,
        )?;
        self.receipts.push(Receipt {
            logical: DurableMlsLogicalId {
                sender: self.binding.signing_key,
                operation: id,
            },
            epoch: self.epoch(),
            sender_device: self.binding.device.clone(),
            wire,
            body: CheckpointBuffer(body.to_vec()),
            own: true,
            transport: None,
        });
        self.pending = Some(Pending {
            request,
            intent,
            wire,
            previous: self.epoch(),
            target_epoch: self.epoch(),
            prior: access.authority.room_roster.clone(),
            target: access.authority.room_roster.clone(),
            historical: None,
            resolution: None,
        });
        self.persist(access, DurableMlsCapability::Write, None)
            .await?;
        self.request()
    }

    pub async fn prepare_commit_and_persist<S: DurableMlsStore>(
        &mut self,
        id: RelayId,
        change: DurableMlsChange<'_>,
        device: &OpenMlsDevice,
        access: &mut DurableMlsAccess<'_, S>,
    ) -> Result<DurableMlsRequest> {
        self.check(access, DurableMlsCapability::Write)?;
        self.new_operation(&id)?;
        self.ready_write(access)?;
        self.device(device)?;
        let previous = self.epoch();
        let before = group_keys(&self.session)?;
        let mut target = self.known_roster.clone();
        if target.keys() != before {
            return Err(DurableMlsError::ContextChanged);
        }
        let kind = match &change {
            DurableMlsChange::Add {
                device: id,
                key,
                key_package,
            } => {
                if access.authority.rekey_required
                    || target.0.len() >= MAX_MEMBERS
                    || target.0.contains_key(id)
                    || target.0.values().any(|old| old == key)
                    || !access.authority.eligible.contains(id, key)
                    || key_package.is_empty()
                    || key_package.len() > 16_384
                {
                    return Err(DurableMlsError::InvalidInput);
                }
                target.0.insert(id.clone(), *key);
                IntentKind::Add
            }
            DurableMlsChange::Remove { devices } => {
                if devices.is_empty() || devices.len() > MAX_MEMBERS {
                    return Err(DurableMlsError::InvalidInput);
                }
                let mut seen = HashSet::new();
                for id in *devices {
                    if id == &self.binding.device
                        || !seen.insert(id)
                        || target.0.remove(id).is_none()
                    {
                        return Err(DurableMlsError::InvalidInput);
                    }
                }
                IntentKind::Remove
            }
            DurableMlsChange::Rotate => {
                if access.authority.rekey_required {
                    return Err(DurableMlsError::ContextChanged);
                }
                IntentKind::Rotate
            }
        };
        if !target.eligible_in(&access.authority.eligible)
            || !target.contains(&self.binding.device, &self.binding.signing_key)
        {
            return Err(DurableMlsError::ContextChanged);
        }
        let mut intent_bytes = vec![kind as u8];
        put_roster(&mut intent_bytes, &target);
        if let DurableMlsChange::Add { key_package, .. } = &change {
            intent_bytes.extend_from_slice(&hash(key_package)?);
        }
        let intent = hash(&intent_bytes)?;
        self.quarantined.set(true);
        self.session.authorised = group_keys(&self.session)?;
        let historical = HistoricalBranch {
            sealed: self
                .session
                .seal_checkpoint(self.generation, access.wrapping_key)?,
            generation: self.generation,
            epoch: previous,
            origin_cursor: self.cursor,
            envelopes: 0,
        };
        self.session.authorised = target.keys();
        let bundle = match change {
            DurableMlsChange::Add {
                key_package, key, ..
            } => self.session.add_member(key_package, &key)?,
            DurableMlsChange::Remove { .. } => {
                let removed: Vec<_> = before.difference(&target.keys()).copied().collect();
                self.session.remove_members(&removed)?
            }
            DurableMlsChange::Rotate => self.session.rotate()?,
        };
        if bundle.epoch
            != previous
                .checked_add(1)
                .ok_or(DurableMlsError::InvalidInput)?
            || group_keys(&self.session)? != target.keys()
        {
            return Err(DurableMlsError::RecoveryRequired);
        }
        let ids: Vec<_> = target.0.keys().cloned().collect();
        let signed = device.sign_relay_request(RelayStatement::CommitEpoch {
            room: &self.binding.room,
            epoch: previous,
            devices: &ids,
            ciphertext: &bundle.commit,
            welcome: bundle.welcome.as_deref(),
        })?;
        let request = admit_request(id, kind, &self.binding.room, signed)?;
        self.pending = Some(Pending {
            request,
            intent,
            wire: hash(&bundle.commit)?,
            previous,
            target_epoch: bundle.epoch,
            prior: self.known_roster.clone(),
            target: target.clone(),
            historical: Some(historical),
            resolution: None,
        });
        self.known_roster = target;
        self.persist(access, DurableMlsCapability::Write, None)
            .await?;
        self.request()
    }

    pub fn pending_request<S: DurableMlsStore>(
        &self,
        access: &DurableMlsAccess<'_, S>,
    ) -> Result<DurableMlsRequest> {
        let pending = self.pending.as_ref().ok_or(DurableMlsError::InvalidInput)?;
        if pending.resolution.is_some() {
            return Err(DurableMlsError::PendingRequest);
        }
        let capability = if pending.request.kind == IntentKind::Application {
            DurableMlsCapability::Write
        } else {
            DurableMlsCapability::RetryCommit
        };
        self.check(access, capability)?;
        self.classify(access.authority)?;
        if matches!(self.mode, Mode::Recovery) || access.authority.epoch != pending.previous {
            return Err(DurableMlsError::RecoveryRequired);
        }
        if pending.request.kind == IntentKind::Application
            && (access.authority.rekey_required
                || group_keys(&self.session)? != access.authority.room_roster.keys()
                || !access
                    .authority
                    .room_roster
                    .eligible_in(&access.authority.eligible))
        {
            return Err(DurableMlsError::ContextChanged);
        }
        if pending.request.kind != IntentKind::Application
            && !pending.target.eligible_in(&access.authority.eligible)
        {
            return Err(DurableMlsError::ContextChanged);
        }
        let request = pending.request.clone();
        self.fence(access, capability)?;
        Ok(request)
    }

    pub fn recover_deliveries<S: DurableMlsStore>(
        &self,
        access: &DurableMlsAccess<'_, S>,
    ) -> Result<Vec<DurableMlsDelivery>> {
        self.check(access, DurableMlsCapability::Read)?;
        self.own_eligible(access.authority)?;
        let deliveries = self
            .receipts
            .iter()
            .map(|r| DurableMlsDelivery {
                logical: r.logical.clone(),
                body: CheckpointBuffer(r.body.0.clone()),
            })
            .collect();
        self.fence(access, DurableMlsCapability::Read)?;
        Ok(deliveries)
    }

    pub async fn reconcile_request_and_persist<S: DurableMlsStore>(
        &mut self,
        id: &RelayId,
        outcome: DurableMlsOutcome,
        access: &mut DurableMlsAccess<'_, S>,
    ) -> Result<()> {
        self.check(access, DurableMlsCapability::Read)?;
        self.own_eligible(access.authority)?;
        let p = self.pending.as_ref().ok_or(DurableMlsError::InvalidInput)?;
        if &p.request.operation != id {
            return Err(DurableMlsError::InvalidInput);
        }
        if p.request.kind == IntentKind::Application {
            let transport = match outcome {
                DurableMlsOutcome::ApplicationAccepted {
                    envelope,
                    sequence,
                    epoch,
                } => {
                    valid_number(sequence)?;
                    if sequence == 0 || epoch != p.previous {
                        return Err(DurableMlsError::InvalidInput);
                    }
                    Some((envelope, sequence))
                }
                DurableMlsOutcome::ApplicationNotDelivered => None,
                _ => return Err(DurableMlsError::InvalidInput),
            };
            self.quarantined.set(true);
            let p = self.pending.take().ok_or(DurableMlsError::InvalidInput)?;
            let receipt = self
                .receipts
                .iter_mut()
                .find(|r| r.own && r.logical.operation == p.request.operation)
                .ok_or(DurableMlsError::InvalidInput)?;
            receipt.transport = transport;
            self.mode = self.classify(access.authority)?;
            return self.persist(access, DurableMlsCapability::Read, None).await;
        }
        let resolution = match outcome {
            DurableMlsOutcome::CommitAccepted {
                envelope,
                sequence,
                epoch,
            } => {
                valid_number(sequence)?;
                if sequence <= self.cursor
                    || epoch != p.target_epoch
                    || access.authority.epoch < epoch
                {
                    return Err(DurableMlsError::InvalidInput);
                }
                DurableMlsCommitResolution::Accepted(DurableMlsCommitMarker {
                    item: DurableMlsReadItem {
                        envelope,
                        sequence,
                        epoch,
                        sender_device: self.binding.device.clone(),
                        sender_key: self.binding.signing_key,
                        kind: DurableMlsEnvelopeKind::Commit,
                        digest: p.wire,
                    },
                    roster: p.target.clone(),
                })
            }
            DurableMlsOutcome::CommitNotAccepted { winner } => {
                valid_number(winner.item.sequence)?;
                if winner.item.sequence <= self.cursor
                    || winner.item.epoch != p.target_epoch
                    || winner.item.kind != DurableMlsEnvelopeKind::Commit
                    || winner.item.digest == p.wire
                    || access.authority.epoch < winner.item.epoch
                {
                    return Err(DurableMlsError::InvalidInput);
                }
                DurableMlsCommitResolution::DefiniteNonAcceptance(winner)
            }
            _ => return Err(DurableMlsError::InvalidInput),
        };
        if p.resolution.as_ref().is_some_and(|old| old != &resolution) {
            return Err(DurableMlsError::RecoveryRequired);
        }
        let proof = DurableMlsCommitObligation {
            operation: id.clone(),
            body_digest: hash(&p.request.body)?,
            own_wire_digest: p.wire,
            previous_epoch: p.previous,
            target_epoch: p.target_epoch,
            target: p.target.clone(),
            resolution: resolution.clone(),
        };
        self.guards(access, None, Some(&proof))?;
        self.quarantined.set(true);
        self.pending
            .as_mut()
            .ok_or(DurableMlsError::InvalidInput)?
            .resolution = Some(resolution);
        self.persist_guarded(access, DurableMlsCapability::Read, None, None, Some(&proof))
            .await
    }

    pub async fn retire_delivery_and_persist<S: DurableMlsStore>(
        &mut self,
        logical: &DurableMlsLogicalId,
        policy: DurableMlsRetirement<'_>,
        access: &mut DurableMlsAccess<'_, S>,
    ) -> Result<()> {
        self.check(access, DurableMlsCapability::Read)?;
        self.own_eligible(access.authority)?;
        let index = self
            .receipts
            .iter()
            .position(|r| &r.logical == logical)
            .ok_or(DurableMlsError::InvalidInput)?;
        if self.pending.as_ref().is_some_and(|p| {
            p.request.kind == IntentKind::Application
                && p.request.operation == logical.operation
                && logical.sender == self.binding.signing_key
        }) {
            return Err(DurableMlsError::PendingRequest);
        }
        let receipt = &self.receipts[index];
        let cache = match policy {
            DurableMlsRetirement::ExplicitDiscard => None,
            DurableMlsRetirement::PinnedEncryptedCache(handoff) => {
                if &handoff.logical != logical
                    || handoff.digest != hash(&receipt.body.0)?
                    || handoff.cache_generation == 0
                    || handoff.cache_generation > MAX_JSON_INTEGER
                {
                    return Err(DurableMlsError::InvalidInput);
                }
                access
                    .store
                    .check_cache_handoff(access.ticket, &self.binding, handoff)?;
                Some(handoff.clone())
            }
        };
        self.quarantined.set(true);
        let receipt = self.receipts.remove(index);
        let intent = if receipt.own {
            Some((
                receipt.logical.operation.clone(),
                IntentKind::Application,
                hash(&frame(&receipt.logical.operation, &receipt.body.0)?.0)?,
            ))
        } else {
            None
        };
        self.retire_record(Retired {
            logical: Some(receipt.logical),
            epoch: receipt.epoch,
            wire: receipt.wire,
            sender: logical.sender,
            sender_device: receipt.sender_device,
            kind: DurableMlsEnvelopeKind::Application,
            transport: receipt.transport,
            intent,
            cache: cache.clone(),
        });
        self.persist(access, DurableMlsCapability::Read, cache.as_ref())
            .await
    }

    /// Processes one actual ordered envelope. None means a peer Commit or known
    /// retired transport alias, never a silently discarded user message.
    pub async fn receive_and_persist<S: DurableMlsStore>(
        &mut self,
        input: DurableMlsIncoming<'_>,
        access: &mut DurableMlsAccess<'_, S>,
    ) -> Result<Option<DurableMlsDelivery>> {
        self.check(access, DurableMlsCapability::Read)?;
        self.own_eligible(access.authority)?;
        if self
            .pending
            .as_ref()
            .is_some_and(|p| p.historical.is_some())
        {
            return self.receive_own_transition(input, access).await;
        }
        if self.pending.is_some() {
            return Err(DurableMlsError::PendingRequest);
        }
        let next_mode = self.classify(access.authority)?;
        if matches!(next_mode, Mode::Recovery) {
            return Err(DurableMlsError::RecoveryRequired);
        }
        valid_number(input.sequence)?;
        valid_number(input.epoch)?;
        if input.sequence == 0
            || input.ciphertext.is_empty()
            || input.ciphertext.len() > MAX_HANDSHAKE_BYTES
        {
            return Err(DurableMlsError::InvalidInput);
        }
        if input.sequence > self.cursor {
            if let Mode::CatchingUp(c) = &next_mode {
                if c.envelopes >= MAX_CATCH_UP {
                    return Err(DurableMlsError::RecoveryRequired);
                }
            }
        }
        let wire = hash(input.ciphertext)?;
        let order = DurableMlsReadObligation::NextVisible {
            previous_cursor: self.cursor,
            item: read_item(&input, wire),
        };
        if input.sequence > self.cursor {
            self.guards(access, Some(&order), None)?;
        }
        let same_transport = self
            .receipts
            .iter()
            .filter_map(|r| {
                r.transport.as_ref().map(|t| {
                    (
                        t,
                        r.wire,
                        r.epoch,
                        r.logical.sender,
                        DurableMlsEnvelopeKind::Application,
                    )
                })
            })
            .chain(self.retired.iter().filter_map(|r| {
                r.transport
                    .as_ref()
                    .map(|t| (t, r.wire, r.epoch, r.sender, r.kind))
            }))
            .find(|(t, ..)| t.0 == input.envelope);
        if let Some((t, old, epoch, sender, kind)) = same_transport {
            if old != wire
                || epoch != input.epoch
                || sender != input.sender_key
                || kind != input.kind
                || t.1 != input.sequence
            {
                return Err(DurableMlsError::InvalidInput);
            }
        }
        let known_receipt = self.receipts.iter().position(|r| r.wire == wire);
        let known_retired = self.retired.iter().position(|r| r.wire == wire);
        if let Some(index) = known_receipt {
            let receipt = &self.receipts[index];
            if input.kind != DurableMlsEnvelopeKind::Application
                || input.sender_device != receipt.sender_device
                || input.sender_key != receipt.logical.sender
                || input.epoch != receipt.epoch
            {
                return Err(DurableMlsError::InvalidInput);
            }
            let logical = receipt.logical.clone();
            if input.sequence > self.cursor {
                self.quarantined.set(true);
                self.mode = next_mode;
                if let Mode::CatchingUp(c) = &mut self.mode {
                    c.envelopes += 1;
                }
                self.cursor = input.sequence;
                self.receipts[index].transport = Some((input.envelope, input.sequence));
                self.persist_guarded(access, DurableMlsCapability::Read, None, Some(&order), None)
                    .await?;
            }
            return self.delivery(&logical, access).map(Some);
        }
        if let Some(index) = known_retired {
            let retired = &self.retired[index];
            if input.kind != retired.kind
                || input.sender_device != retired.sender_device
                || input.sender_key != retired.sender
                || input.epoch != retired.epoch
            {
                return Err(DurableMlsError::InvalidInput);
            }
            if input.sequence <= self.cursor {
                return Err(DurableMlsError::InvalidInput);
            }
            self.quarantined.set(true);
            self.mode = next_mode;
            if let Mode::CatchingUp(c) = &mut self.mode {
                c.envelopes += 1;
            }
            self.cursor = input.sequence;
            self.retired[index].transport = Some((input.envelope, input.sequence));
            self.persist_guarded(access, DurableMlsCapability::Read, None, Some(&order), None)
                .await?;
            return Ok(None);
        }
        if input.sequence <= self.cursor {
            return Err(DurableMlsError::InvalidInput);
        }
        if let Mode::CatchingUp(c) = &next_mode {
            if c.envelopes >= MAX_CATCH_UP
                || (input.kind == DurableMlsEnvelopeKind::Commit && c.transitions >= MAX_CATCH_UP)
            {
                return Err(DurableMlsError::RecoveryRequired);
            }
        }
        let historical = matches!(next_mode, Mode::CatchingUp(_));
        if !historical
            && !access
                .authority
                .room_roster
                .contains(&input.sender_device, &input.sender_key)
        {
            return Err(DurableMlsError::ContextChanged);
        }
        match input.kind {
            DurableMlsEnvelopeKind::Application => {
                if input.epoch != self.epoch() || input.ciphertext.len() > MAX_HTTP {
                    return Err(DurableMlsError::InvalidInput);
                }
                self.receipt_capacity(0)?;
            }
            DurableMlsEnvelopeKind::Commit => {
                if input.epoch
                    != self
                        .epoch()
                        .checked_add(1)
                        .ok_or(DurableMlsError::InvalidInput)?
                    || !historical
                {
                    return Err(DurableMlsError::InvalidInput);
                }
            }
        }
        self.quarantined.set(true);
        self.mode = next_mode;
        // Historical keys authenticate only this private processing path. No raw
        // session or live-grant operation can escape the controller's mode gate.
        self.session.authorised = group_keys(&self.session)?;
        let logical = match input.kind {
            DurableMlsEnvelopeKind::Application => {
                let envelope = MlsCiphertextEnvelope {
                    algorithm: CryptoAlgorithm::OpenMlsDraft,
                    channel_id: self.binding.room.room(),
                    epoch: input.epoch,
                    sender_device_key: input.sender_key,
                    ciphertext: input.ciphertext.to_vec(),
                };
                let plaintext = CheckpointBuffer(self.session.open(&envelope)?);
                let (id, body) = unframe(&plaintext.0)?;
                self.receipt_capacity(body.len())?;
                let logical = DurableMlsLogicalId {
                    sender: input.sender_key,
                    operation: id,
                };
                if self.receipts.iter().any(|r| r.logical == logical)
                    || self
                        .retired
                        .iter()
                        .any(|r| r.logical.as_ref() == Some(&logical))
                {
                    return Err(DurableMlsError::ReusedOperationId);
                }
                self.receipts.push(Receipt {
                    logical: logical.clone(),
                    epoch: input.epoch,
                    sender_device: input.sender_device.clone(),
                    wire,
                    body: CheckpointBuffer(body.to_vec()),
                    own: false,
                    transport: Some((input.envelope.clone(), input.sequence)),
                });
                Some(logical)
            }
            DurableMlsEnvelopeKind::Commit => {
                self.apply_historical_commit(input.ciphertext, &input.sender_key)?;
                self.retire_record(Retired {
                    logical: None,
                    epoch: input.epoch,
                    wire,
                    sender: input.sender_key,
                    sender_device: input.sender_device.clone(),
                    kind: input.kind,
                    transport: Some((input.envelope.clone(), input.sequence)),
                    intent: None,
                    cache: None,
                });
                None
            }
        };
        self.cursor = input.sequence;
        if let Mode::CatchingUp(c) = &mut self.mode {
            c.envelopes = c
                .envelopes
                .checked_add(1)
                .ok_or(DurableMlsError::Capacity)?;
            if input.kind == DurableMlsEnvelopeKind::Commit {
                c.transitions = c
                    .transitions
                    .checked_add(1)
                    .ok_or(DurableMlsError::Capacity)?;
            }
        }
        self.mode = self.classify(access.authority)?;
        if matches!(self.mode, Mode::Live) {
            self.known_roster = access.authority.room_roster.clone();
        }
        self.persist_guarded(access, DurableMlsCapability::Read, None, Some(&order), None)
            .await?;
        match logical {
            Some(id) => self.delivery(&id, access).map(Some),
            None => Ok(None),
        }
    }

    pub async fn catch_up_and_persist<S: DurableMlsStore>(
        &mut self,
        input: DurableMlsIncoming<'_>,
        access: &mut DurableMlsAccess<'_, S>,
    ) -> Result<Option<DurableMlsDelivery>> {
        if !matches!(self.classify(access.authority)?, Mode::CatchingUp(_)) {
            return Err(DurableMlsError::InvalidInput);
        }
        self.receive_and_persist(input, access).await
    }

    fn delivery<S: DurableMlsStore>(
        &self,
        id: &DurableMlsLogicalId,
        access: &DurableMlsAccess<'_, S>,
    ) -> Result<DurableMlsDelivery> {
        self.check(access, DurableMlsCapability::Read)?;
        let receipt = self
            .receipts
            .iter()
            .find(|r| &r.logical == id)
            .ok_or(DurableMlsError::InvalidInput)?;
        let delivery = DurableMlsDelivery {
            logical: id.clone(),
            body: CheckpointBuffer(receipt.body.0.clone()),
        };
        self.fence(access, DurableMlsCapability::Read)?;
        Ok(delivery)
    }

    fn apply_historical_commit(&mut self, bytes: &[u8], sender: &Ed25519PublicKey) -> Result<()> {
        apply_private_commit(&mut self.session, bytes, sender)
    }

    fn check_transport(&self, input: &DurableMlsIncoming<'_>, wire: [u8; 32]) -> Result<()> {
        for r in &self.receipts {
            if r.transport
                .as_ref()
                .is_some_and(|(id, _)| id == &input.envelope)
                && (r.transport.as_ref().map(|(_, seq)| *seq) != Some(input.sequence)
                    || r.wire != wire
                    || r.epoch != input.epoch
                    || r.sender_device != input.sender_device
                    || r.logical.sender != input.sender_key
                    || input.kind != DurableMlsEnvelopeKind::Application)
            {
                return Err(DurableMlsError::InvalidInput);
            }
        }
        for r in &self.retired {
            if r.transport
                .as_ref()
                .is_some_and(|(id, _)| id == &input.envelope)
                && (r.transport.as_ref().map(|(_, seq)| *seq) != Some(input.sequence)
                    || r.wire != wire
                    || r.epoch != input.epoch
                    || r.sender_device != input.sender_device
                    || r.sender != input.sender_key
                    || r.kind != input.kind)
            {
                return Err(DurableMlsError::InvalidInput);
            }
        }
        Ok(())
    }
    fn old_session(&self, key: &[u8; 32]) -> Result<PrivateSession> {
        let p = self.pending.as_ref().ok_or(DurableMlsError::InvalidInput)?;
        let old = p.historical.as_ref().ok_or(DurableMlsError::InvalidInput)?;
        let session = OpenMlsSession::restore_checkpoint(
            self.binding.room.clone(),
            self.binding.signing_key,
            old.epoch,
            old.generation,
            HashSet::from([self.binding.signing_key]),
            &old.sealed,
            key,
        )?;
        let mut guarded = PrivateSession(Some(session));
        let keys = group_keys(guarded.session())?;
        if keys != p.prior.keys() || old.epoch != p.previous {
            return Err(DurableMlsError::InvalidInput);
        }
        guarded.session_mut().authorised = keys;
        Ok(guarded)
    }

    async fn receive_own_transition<S: DurableMlsStore>(
        &mut self,
        input: DurableMlsIncoming<'_>,
        access: &mut DurableMlsAccess<'_, S>,
    ) -> Result<Option<DurableMlsDelivery>> {
        self.check(access, DurableMlsCapability::Read)?;
        self.own_eligible(access.authority)?;
        self.classify(access.authority)?;
        valid_number(input.sequence)?;
        valid_number(input.epoch)?;
        if input.sequence == 0
            || input.ciphertext.is_empty()
            || input.ciphertext.len() > MAX_HANDSHAKE_BYTES
        {
            return Err(DurableMlsError::InvalidInput);
        }
        let wire = hash(input.ciphertext)?;
        let item = read_item(&input, wire);
        self.check_transport(&input, wire)?;
        if input.sequence <= self.cursor {
            let receipt = self
                .receipts
                .iter()
                .find(|r| {
                    r.wire == wire
                        && r.transport.as_ref() == Some(&(input.envelope.clone(), input.sequence))
                        && r.logical.sender == input.sender_key
                        && r.sender_device == input.sender_device
                        && r.epoch == input.epoch
                        && input.kind == DurableMlsEnvelopeKind::Application
                })
                .ok_or(DurableMlsError::InvalidInput)?;
            return self.delivery(&receipt.logical, access).map(Some);
        }
        let order = DurableMlsReadObligation::NextVisible {
            previous_cursor: self.cursor,
            item: item.clone(),
        };
        let outcome = self.outcome_obligation()?;
        self.guards(access, Some(&order), outcome.as_ref())?;
        let p = self.pending.as_ref().ok_or(DurableMlsError::InvalidInput)?;
        let old = p.historical.as_ref().ok_or(DurableMlsError::InvalidInput)?;
        if old.envelopes >= MAX_CATCH_UP {
            return Err(DurableMlsError::RecoveryRequired);
        }
        if input.kind == DurableMlsEnvelopeKind::Application {
            if input.epoch != p.previous
                || !p.prior.contains(&input.sender_device, &input.sender_key)
                || input.ciphertext.len() > MAX_HTTP
            {
                return Err(DurableMlsError::InvalidInput);
            }
            if let Some(resolution) = &p.resolution {
                let marker = resolution_marker(resolution);
                if input.sequence >= marker.item.sequence {
                    return Err(DurableMlsError::InvalidInput);
                }
            }
            let known = self.receipts.iter().position(|r| r.wire == wire);
            let retired = self.retired.iter().position(|r| r.wire == wire);
            if let Some(index) = known {
                let r = &self.receipts[index];
                if r.epoch != input.epoch
                    || r.sender_device != input.sender_device
                    || r.logical.sender != input.sender_key
                {
                    return Err(DurableMlsError::InvalidInput);
                }
            } else if let Some(index) = retired {
                let r = &self.retired[index];
                if r.epoch != input.epoch
                    || r.sender_device != input.sender_device
                    || r.sender != input.sender_key
                    || r.kind != input.kind
                {
                    return Err(DurableMlsError::InvalidInput);
                }
            } else {
                self.receipt_capacity(0)?;
            }
            self.quarantined.set(true);
            let mut historical = self.old_session(access.wrapping_key)?;
            let logical = if let Some(index) = known {
                let r = &mut self.receipts[index];
                r.transport = Some((input.envelope.clone(), input.sequence));
                Some(r.logical.clone())
            } else if let Some(index) = retired {
                self.retired[index].transport = Some((input.envelope.clone(), input.sequence));
                None
            } else {
                let envelope = MlsCiphertextEnvelope {
                    algorithm: CryptoAlgorithm::OpenMlsDraft,
                    channel_id: self.binding.room.room(),
                    epoch: input.epoch,
                    sender_device_key: input.sender_key,
                    ciphertext: input.ciphertext.to_vec(),
                };
                let plain = CheckpointBuffer(historical.session_mut().open(&envelope)?);
                let (id, body) = unframe(&plain.0)?;
                self.receipt_capacity(body.len())?;
                let logical = DurableMlsLogicalId {
                    sender: input.sender_key,
                    operation: id,
                };
                if self.receipts.iter().any(|r| r.logical == logical)
                    || self
                        .retired
                        .iter()
                        .any(|r| r.logical.as_ref() == Some(&logical))
                {
                    return Err(DurableMlsError::ReusedOperationId);
                }
                self.receipts.push(Receipt {
                    logical: logical.clone(),
                    epoch: input.epoch,
                    sender_device: input.sender_device.clone(),
                    wire,
                    body: CheckpointBuffer(body.to_vec()),
                    own: false,
                    transport: Some((input.envelope.clone(), input.sequence)),
                });
                Some(logical)
            };
            let next = self
                .generation
                .checked_add(1)
                .filter(|n| *n <= MAX_JSON_INTEGER)
                .ok_or(DurableMlsError::Capacity)?;
            let updated = historical
                .session()
                .seal_checkpoint(next, access.wrapping_key)?;
            let old = self
                .pending
                .as_mut()
                .and_then(|p| p.historical.as_mut())
                .ok_or(DurableMlsError::InvalidInput)?;
            old.sealed = updated;
            old.generation = next;
            old.envelopes += 1;
            self.cursor = input.sequence;
            self.persist_guarded(
                access,
                DurableMlsCapability::Read,
                None,
                Some(&order),
                outcome.as_ref(),
            )
            .await?;
            return match logical {
                Some(id) => self.delivery(&id, access).map(Some),
                None => Ok(None),
            };
        }
        let resolution = p
            .resolution
            .as_ref()
            .ok_or(DurableMlsError::PendingRequest)?;
        let marker = resolution_marker(resolution);
        if marker.item != item
            || marker.item.kind != DurableMlsEnvelopeKind::Commit
            || marker.item.epoch != p.target_epoch
        {
            return Err(DurableMlsError::RecoveryRequired);
        }
        let origin = CatchUp {
            origin_epoch: p.previous,
            origin_cursor: old.origin_cursor,
            envelopes: old.envelopes + 1,
            transitions: 1,
        };
        self.quarantined.set(true);
        match resolution {
            DurableMlsCommitResolution::Accepted(marker) => {
                if item.digest != p.wire
                    || item.sender_device != self.binding.device
                    || item.sender_key != self.binding.signing_key
                    || marker.roster != p.target
                    || group_keys(&self.session)? != p.target.keys()
                {
                    return Err(DurableMlsError::RecoveryRequired);
                }
                // Exact own Commit already produced this target: never apply it twice.
            }
            DurableMlsCommitResolution::DefiniteNonAcceptance(marker) => {
                if item.digest == p.wire {
                    return Err(DurableMlsError::RecoveryRequired);
                }
                let mut historical = self.old_session(access.wrapping_key)?;
                apply_private_commit(
                    historical.session_mut(),
                    input.ciphertext,
                    &input.sender_key,
                )?;
                if historical.session().epoch() != p.target_epoch
                    || group_keys(historical.session())? != marker.roster.keys()
                {
                    return Err(DurableMlsError::RecoveryRequired);
                }
                let rejected = std::mem::replace(&mut self.session, historical.accept());
                drop(PrivateSession(Some(rejected)));
            }
        }
        let pending = self.pending.take().ok_or(DurableMlsError::InvalidInput)?;
        let marker = resolution_marker(
            pending
                .resolution
                .as_ref()
                .ok_or(DurableMlsError::InvalidInput)?,
        );
        self.known_roster = marker.roster.clone();
        self.cursor = input.sequence;
        self.mode = Mode::CatchingUp(origin);
        self.retire_record(Retired {
            logical: None,
            epoch: input.epoch,
            wire,
            sender: input.sender_key,
            sender_device: input.sender_device,
            kind: input.kind,
            transport: Some((input.envelope, input.sequence)),
            intent: Some((
                pending.request.operation,
                pending.request.kind,
                pending.intent,
            )),
            cache: None,
        });
        self.mode = self.classify(access.authority)?;
        self.persist_guarded(
            access,
            DurableMlsCapability::Read,
            None,
            Some(&order),
            outcome.as_ref(),
        )
        .await?;
        Ok(None)
    }

    fn aad(binding: &DurableMlsBinding, epoch: u64, generation: u64) -> Vec<u8> {
        let mut out = b"kodera-durable-mls-room-v1\0".to_vec();
        out.extend_from_slice(binding.owner.as_str().as_bytes());
        out.extend_from_slice(&binding.room.binding());
        out.extend_from_slice(binding.membership.as_str().as_bytes());
        out.extend_from_slice(binding.device.as_str().as_bytes());
        out.extend_from_slice(&binding.signing_key);
        out.extend_from_slice(&epoch.to_be_bytes());
        out.extend_from_slice(&generation.to_be_bytes());
        out
    }
    fn encoded_size(&self, inner: usize) -> Result<usize> {
        if inner > MAX_INNER
            || self.receipts.len() > MAX_RECEIPTS
            || self.retired.len() > MAX_HISTORY
        {
            return Err(DurableMlsError::Capacity);
        }
        let roster_size = |r: &DurableMlsRoster| 2 + 68 * r.0.len();
        let mut size = 1usize
            + 16
            + initial_size(&self.initial)
            + 4
            + inner
            + 8
            + roster_size(&self.known_roster)
            + 1
            + 1
            + 1
            + 1;
        let mut add = |n: usize| -> Result<()> {
            size = size.checked_add(n).ok_or(DurableMlsError::Capacity)?;
            Ok(())
        };
        if matches!(self.mode, Mode::CatchingUp(_)) {
            add(18)?;
        }
        if let Some(p) = &self.pending {
            if p.request.body.len() > MAX_HTTP {
                return Err(DurableMlsError::Capacity);
            }
            add(36
                + 1
                + 4
                + p.request.body.len()
                + 32
                + 32
                + 8
                + 8
                + roster_size(&p.prior)
                + roster_size(&p.target))?;
            add(2)?; // historical-present plus exact resolution tag
            if let Some(old) = &p.historical {
                if old.sealed.as_bytes().len() > MAX_INNER - inner {
                    return Err(DurableMlsError::Capacity);
                }
                add(29 + old.sealed.as_bytes().len())?;
            }
            if let Some(resolution) = &p.resolution {
                add(153 + roster_size(&resolution_marker(resolution).roster))?;
            }
        }
        let mut body_bytes = 0usize;
        for r in &self.receipts {
            body_bytes = body_bytes
                .checked_add(r.body.0.len())
                .ok_or(DurableMlsError::Capacity)?;
            if r.body.0.len() > MAX_BODY || body_bytes > MAX_RECEIPT_BYTES {
                return Err(DurableMlsError::Capacity);
            }
            add(150 + r.body.0.len() + if r.transport.is_some() { 44 } else { 0 })?;
        }
        for r in &self.retired {
            add(113
                + if r.logical.is_some() { 68 } else { 0 }
                + if r.transport.is_some() { 44 } else { 0 }
                + if r.intent.is_some() { 69 } else { 0 }
                + if r.cache.is_some() { 76 } else { 0 })?;
        }
        if size > MAX_COMPOUND - 32 {
            return Err(DurableMlsError::Capacity);
        }
        Ok(size)
    }

    fn encode(&self, generation: u64, key: &[u8; 32]) -> Result<SealedDurableMlsRoom> {
        let inner = self.session.seal_checkpoint(generation, key)?;
        if inner.as_bytes().len() > MAX_INNER {
            return Err(DurableMlsError::Capacity);
        }
        let size = self.encoded_size(inner.as_bytes().len())?;
        // Allocate the exact admitted size before copying any private receipt.
        // Incremental Vec growth would leave earlier plaintext allocations behind.
        let mut plain = CheckpointBuffer(Vec::with_capacity(size));
        let out = &mut plain.0;
        out.push(2); // unpublished version-one anchorless records are refused
        put_u64(out, self.epoch());
        put_u64(out, generation);
        put_initial(out, &self.initial);
        put_blob(out, inner.as_bytes())?;
        put_u64(out, self.cursor);
        put_roster(out, &self.known_roster);
        match &self.mode {
            Mode::Live => out.push(0),
            Mode::Recovery => out.push(2),
            Mode::CatchingUp(c) => {
                out.push(1);
                put_u64(out, c.origin_epoch);
                put_u64(out, c.origin_cursor);
                out.push(c.envelopes);
                out.push(c.transitions);
            }
        }
        out.push(u8::from(self.pending.is_some()));
        if let Some(p) = &self.pending {
            put_id(out, &p.request.operation);
            out.push(p.request.kind as u8);
            put_blob(out, &p.request.body)?;
            out.extend_from_slice(&p.intent);
            out.extend_from_slice(&p.wire);
            put_u64(out, p.previous);
            put_u64(out, p.target_epoch);
            put_roster(out, &p.prior);
            put_roster(out, &p.target);
            out.push(u8::from(p.historical.is_some()));
            if let Some(old) = &p.historical {
                put_u64(out, old.epoch);
                put_u64(out, old.generation);
                put_u64(out, old.origin_cursor);
                out.push(old.envelopes);
                put_blob(out, old.sealed.as_bytes())?;
            }
            match &p.resolution {
                None => out.push(0),
                Some(DurableMlsCommitResolution::Accepted(m)) => {
                    out.push(1);
                    put_marker(out, m);
                }
                Some(DurableMlsCommitResolution::DefiniteNonAcceptance(m)) => {
                    out.push(2);
                    put_marker(out, m);
                }
            }
        }
        if self.receipts.len() > MAX_RECEIPTS || self.retired.len() > MAX_HISTORY {
            return Err(DurableMlsError::Capacity);
        }
        out.push(self.receipts.len() as u8);
        let mut total = 0usize;
        for r in &self.receipts {
            total = total
                .checked_add(r.body.0.len())
                .ok_or(DurableMlsError::Capacity)?;
            if r.body.0.len() > MAX_BODY || total > MAX_RECEIPT_BYTES {
                return Err(DurableMlsError::Capacity);
            }
            put_logical(out, &r.logical);
            put_u64(out, r.epoch);
            put_id(out, &r.sender_device);
            out.extend_from_slice(&r.wire);
            out.push(u8::from(r.own));
            put_transport(out, &r.transport);
            put_blob(out, &r.body.0)?;
        }
        out.push(self.retired.len() as u8);
        for r in &self.retired {
            out.push(u8::from(r.logical.is_some()));
            if let Some(id) = &r.logical {
                put_logical(out, id);
            }
            put_u64(out, r.epoch);
            out.extend_from_slice(&r.wire);
            out.extend_from_slice(&r.sender);
            put_id(out, &r.sender_device);
            out.push(kind_byte(r.kind));
            put_transport(out, &r.transport);
            out.push(u8::from(r.intent.is_some()));
            if let Some((id, kind, digest)) = &r.intent {
                put_id(out, id);
                out.push(*kind as u8);
                out.extend_from_slice(digest);
            }
            out.push(u8::from(r.cache.is_some()));
            if let Some(cache) = &r.cache {
                out.extend_from_slice(&cache.digest);
                put_id(out, &cache.cache_record);
                put_u64(out, cache.cache_generation);
            }
        }
        if out.len() != size {
            return Err(DurableMlsError::InvalidInput);
        }
        if out.len() > MAX_COMPOUND - 32 {
            return Err(DurableMlsError::Capacity);
        }
        let nonce = self
            .session
            .provider
            .rand()
            .random_array::<12>()
            .map_err(|_| DurableMlsError::Storage)?;
        let cipher = Aes256Gcm::new_from_slice(key).map_err(failed)?;
        let aad = Self::aad(&self.binding, self.epoch(), generation);
        let tag = cipher
            .encrypt_in_place_detached(Nonce::from_slice(&nonce), &aad, &mut plain.0)
            .map_err(failed)?;
        let mut out = Vec::with_capacity(32 + plain.0.len());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&plain.0);
        out.extend_from_slice(&tag);
        SealedDurableMlsRoom::from_bytes(&out)
    }
    async fn persist<S: DurableMlsStore>(
        &mut self,
        access: &mut DurableMlsAccess<'_, S>,
        capability: DurableMlsCapability,
        cache: Option<&DurableMlsCacheHandoff>,
    ) -> Result<()> {
        self.persist_guarded(access, capability, cache, None, None)
            .await
    }
    async fn persist_guarded<S: DurableMlsStore>(
        &mut self,
        access: &mut DurableMlsAccess<'_, S>,
        capability: DurableMlsCapability,
        cache: Option<&DurableMlsCacheHandoff>,
        read: Option<&DurableMlsReadObligation>,
        outcome: Option<&DurableMlsCommitObligation>,
    ) -> Result<()> {
        // The caller already quarantines BEFORE any possible ratchet mutation.
        self.quarantined.set(true);
        self.fence(access, capability)?;
        self.guards(access, read, outcome)?;
        if let Some(cache) = cache {
            access
                .store
                .check_cache_handoff(access.ticket, &self.binding, cache)?;
        }
        let next = self
            .generation
            .checked_add(1)
            .filter(|n| *n <= MAX_JSON_INTEGER)
            .ok_or(DurableMlsError::Capacity)?;
        self.session.authorised = group_keys(&self.session)?;
        let sealed = self.encode(next, access.wrapping_key)?;
        let pending_sends: Vec<_> = self
            .pending
            .iter()
            .filter(|p| p.resolution.is_none())
            .map(|p| DurableMlsPendingSend::from_request(&p.request))
            .collect();
        let write = DurableMlsWrite {
            binding: &self.binding,
            expected_generation: self.generation,
            generation: next,
            epoch: self.epoch(),
            cursor: self.cursor,
            sealed: &sealed,
            pending_sends: &pending_sends,
        };
        access.store.compare_and_swap(&write).await?;
        // A durable commit does not establish that accepted owner/RPC context
        // survived the await. These are synchronous live checks, not echoes.
        if let Some(cache) = cache {
            access
                .store
                .check_cache_handoff(access.ticket, &self.binding, cache)?;
        }
        self.guards(access, read, outcome)?;
        self.fence(access, capability)?;
        self.generation = next;
        self.quarantined.set(false);
        Ok(())
    }

    /// Expected epoch/generation and accepted context come from current trusted
    /// host records. The record cannot authenticate its own rollback fences.
    pub fn restore<S: DurableMlsStore>(
        binding: DurableMlsBinding,
        expected_epoch: u64,
        expected_generation: u64,
        sealed: &SealedDurableMlsRoom,
        external_pending: &[DurableMlsPendingSend],
        access: &DurableMlsAccess<'_, S>,
    ) -> Result<Self> {
        access.store.check_current(
            access.ticket,
            &binding,
            access.authority,
            DurableMlsCapability::Read,
        )?;
        valid_number(expected_epoch)?;
        valid_number(expected_generation)?;
        if expected_generation < 2 || external_pending.len() > 1 {
            return Err(DurableMlsError::InvalidInput);
        }
        let end = sealed.0.len() - 16;
        let mut plaintext = CheckpointBuffer(sealed.0[16..end].to_vec());
        Aes256Gcm::new_from_slice(access.wrapping_key)
            .map_err(failed)?
            .decrypt_in_place_detached(
                Nonce::from_slice(&sealed.0[4..16]),
                &Self::aad(&binding, expected_epoch, expected_generation),
                &mut plaintext.0,
                Tag::from_slice(&sealed.0[end..]),
            )
            .map_err(failed)?;
        let mut reader = Reader(&plaintext.0);
        if reader.byte()? != 2 {
            return Err(DurableMlsError::InvalidInput);
        }
        let inner_epoch = reader.u64()?;
        let inner_generation = reader.u64()?;
        if inner_epoch != expected_epoch
            || inner_generation == 0
            || inner_generation > expected_generation
        {
            return Err(DurableMlsError::InvalidInput);
        }
        let initial = reader.initial()?;
        let inner = SealedMlsState::from_bytes(reader.blob(MAX_INNER)?)?;
        let cursor = reader.u64()?;
        if cursor < initial.cursor() || initial.epoch() > expected_epoch {
            return Err(DurableMlsError::InvalidInput);
        }
        let known_roster = reader.roster()?;
        let mode = match reader.byte()? {
            0 => Mode::Live,
            2 => Mode::Recovery,
            1 => {
                let c = CatchUp {
                    origin_epoch: reader.u64()?,
                    origin_cursor: reader.u64()?,
                    envelopes: reader.byte()?,
                    transitions: reader.byte()?,
                };
                if c.origin_epoch > expected_epoch
                    || expected_epoch - c.origin_epoch > u64::from(MAX_CATCH_UP)
                    || c.origin_cursor > cursor
                    || c.envelopes > MAX_CATCH_UP
                    || c.transitions > MAX_CATCH_UP
                    || c.transitions > c.envelopes
                    || expected_epoch - c.origin_epoch != u64::from(c.transitions)
                {
                    return Err(DurableMlsError::InvalidInput);
                }
                Mode::CatchingUp(c)
            }
            _ => return Err(DurableMlsError::InvalidInput),
        };
        let pending = if reader.boolean()? {
            let operation = reader.id()?;
            let kind = IntentKind::read(reader.byte()?)?;
            let body = reader.blob(MAX_HTTP)?.to_vec();
            let intent = reader.array()?;
            let wire = reader.array()?;
            let previous = reader.u64()?;
            let target_epoch = reader.u64()?;
            let prior = reader.roster()?;
            let target = reader.roster()?;
            let historical = if reader.boolean()? {
                let epoch = reader.u64()?;
                let generation = reader.u64()?;
                let origin_cursor = reader.u64()?;
                let envelopes = reader.byte()?;
                if generation == 0
                    || generation > expected_generation
                    || epoch != previous
                    || origin_cursor > cursor
                    || origin_cursor < initial.cursor()
                    || envelopes > MAX_CATCH_UP
                {
                    return Err(DurableMlsError::InvalidInput);
                }
                let sealed =
                    SealedMlsState::from_bytes(reader.blob(MAX_INNER - inner.as_bytes().len())?)?;
                Some(HistoricalBranch {
                    sealed,
                    generation,
                    epoch,
                    origin_cursor,
                    envelopes,
                })
            } else {
                None
            };
            let resolution = match reader.byte()? {
                0 => None,
                1 => Some(DurableMlsCommitResolution::Accepted(reader.marker()?)),
                2 => Some(DurableMlsCommitResolution::DefiniteNonAcceptance(
                    reader.marker()?,
                )),
                _ => return Err(DurableMlsError::InvalidInput),
            };
            if kind == IntentKind::Application {
                if historical.is_some() || resolution.is_some() {
                    return Err(DurableMlsError::InvalidInput);
                }
            } else if historical.is_none() || previous.checked_add(1) != Some(target_epoch) {
                return Err(DurableMlsError::InvalidInput);
            }
            if let Some(r) = &resolution {
                let marker = resolution_marker(r);
                if marker.item.sequence <= cursor
                    || marker.item.epoch != target_epoch
                    || marker.item.kind != DurableMlsEnvelopeKind::Commit
                {
                    return Err(DurableMlsError::InvalidInput);
                }
                match r {
                    DurableMlsCommitResolution::Accepted(_) => {
                        if marker.item.digest != wire
                            || marker.item.sender_device != binding.device
                            || marker.item.sender_key != binding.signing_key
                            || marker.roster != target
                        {
                            return Err(DurableMlsError::InvalidInput);
                        }
                    }
                    DurableMlsCommitResolution::DefiniteNonAcceptance(_) => {
                        if marker.item.digest == wire {
                            return Err(DurableMlsError::InvalidInput);
                        }
                    }
                }
            }
            Some(Pending {
                request: DurableMlsRequest {
                    operation,
                    kind,
                    room: binding.room.clone(),
                    body,
                },
                intent,
                wire,
                previous,
                target_epoch,
                prior,
                target,
                historical,
                resolution,
            })
        } else {
            None
        };
        let count = usize::from(reader.byte()?);
        if count > MAX_RECEIPTS {
            return Err(DurableMlsError::Capacity);
        }
        let mut receipts = Vec::with_capacity(count);
        let mut total = 0usize;
        let mut logical_ids = HashSet::new();
        let mut wire_hashes = HashSet::new();
        let mut transport_ids = HashSet::new();
        for _ in 0..count {
            let logical = reader.logical()?;
            let epoch = reader.u64()?;
            let sender_device = reader.id()?;
            let wire = reader.array()?;
            let own = reader.boolean()?;
            let transport = reader.transport()?;
            let body = reader.blob(MAX_BODY)?;
            total = total
                .checked_add(body.len())
                .ok_or(DurableMlsError::Capacity)?;
            if total > MAX_RECEIPT_BYTES
                || std::str::from_utf8(body).is_err()
                || !logical_ids.insert((logical.sender, logical.operation.clone()))
                || !wire_hashes.insert(wire)
                || (own
                    && (logical.sender != binding.signing_key || sender_device != binding.device))
                || epoch > expected_epoch
                || transport
                    .as_ref()
                    .is_some_and(|(id, _)| !transport_ids.insert(id.clone()))
            {
                return Err(DurableMlsError::InvalidInput);
            }
            receipts.push(Receipt {
                logical,
                epoch,
                sender_device,
                wire,
                body: CheckpointBuffer(body.to_vec()),
                own,
                transport,
            });
        }
        let count = usize::from(reader.byte()?);
        if count > MAX_HISTORY {
            return Err(DurableMlsError::Capacity);
        }
        let mut retired = Vec::with_capacity(count);
        let mut own_ids = HashSet::new();
        for _ in 0..count {
            let logical = if reader.boolean()? {
                Some(reader.logical()?)
            } else {
                None
            };
            let epoch = reader.u64()?;
            let wire = reader.array()?;
            let sender = reader.array()?;
            let sender_device = reader.id()?;
            let kind = read_kind(reader.byte()?)?;
            let transport = reader.transport()?;
            let intent = if reader.boolean()? {
                Some((
                    reader.id()?,
                    IntentKind::read(reader.byte()?)?,
                    reader.array()?,
                ))
            } else {
                None
            };
            let cache = if reader.boolean()? {
                let logical = logical.clone().ok_or(DurableMlsError::InvalidInput)?;
                let digest = reader.array()?;
                let cache_record = reader.id()?;
                let cache_generation = reader.u64()?;
                if cache_generation == 0 {
                    return Err(DurableMlsError::InvalidInput);
                }
                Some(DurableMlsCacheHandoff {
                    logical,
                    digest,
                    cache_record,
                    cache_generation,
                })
            } else {
                None
            };
            if epoch > expected_epoch
                || logical.as_ref().is_some_and(|id| {
                    id.sender != sender || !logical_ids.insert((id.sender, id.operation.clone()))
                })
                || !wire_hashes.insert(wire)
                || transport
                    .as_ref()
                    .is_some_and(|(id, _)| !transport_ids.insert(id.clone()))
                || intent
                    .as_ref()
                    .is_some_and(|(id, _, _)| !own_ids.insert(id.clone()))
            {
                return Err(DurableMlsError::InvalidInput);
            }
            retired.push(Retired {
                logical,
                epoch,
                wire,
                sender,
                sender_device,
                kind,
                transport,
                intent,
                cache,
            });
        }
        if !reader.0.is_empty() {
            return Err(DurableMlsError::InvalidInput);
        }
        let expected_requests: Vec<_> = pending
            .iter()
            .filter(|p| p.resolution.is_none())
            .map(|p| DurableMlsPendingSend::from_request(&p.request))
            .collect();
        if expected_requests != external_pending {
            return Err(DurableMlsError::InvalidInput);
        }
        if let Some(p) = &pending {
            validate_request(&binding, p)?;
            if own_ids.contains(&p.request.operation) {
                return Err(DurableMlsError::ReusedOperationId);
            }
            if p.request.kind == IntentKind::Application {
                let receipt = receipts
                    .iter()
                    .find(|r| r.own && r.logical.operation == p.request.operation)
                    .ok_or(DurableMlsError::InvalidInput)?;
                if receipt.wire != p.wire
                    || hash(&frame(&receipt.logical.operation, &receipt.body.0)?.0)? != p.intent
                    || p.previous != p.target_epoch
                {
                    return Err(DurableMlsError::InvalidInput);
                }
            }
        }
        // All private framing/aggregate/duplicate checks precede OpenMLS decode.
        let session = OpenMlsSession::restore_checkpoint(
            binding.room.clone(),
            binding.signing_key,
            inner_epoch,
            inner_generation,
            HashSet::from([binding.signing_key]),
            &inner,
            access.wrapping_key,
        )?;
        let mut own = Self {
            binding,
            session,
            known_roster,
            generation: expected_generation,
            cursor,
            initial,
            mode,
            pending,
            receipts,
            retired,
            quarantined: Cell::new(true),
        };
        own.mode = own.classify(access.authority)?;
        if own.pending.as_ref().is_some_and(|p| p.historical.is_some()) {
            drop(own.old_session(access.wrapping_key)?);
        }
        own.session.authorised = group_keys(&own.session)?;
        own.fence(access, DurableMlsCapability::Read)?;
        own.quarantined.set(false);
        Ok(own)
    }
}

fn read_item(input: &DurableMlsIncoming<'_>, digest: [u8; 32]) -> DurableMlsReadItem {
    DurableMlsReadItem {
        envelope: input.envelope.clone(),
        sequence: input.sequence,
        epoch: input.epoch,
        sender_device: input.sender_device.clone(),
        sender_key: input.sender_key,
        kind: input.kind,
        digest,
    }
}
fn resolution_marker(resolution: &DurableMlsCommitResolution) -> &DurableMlsCommitMarker {
    match resolution {
        DurableMlsCommitResolution::Accepted(m)
        | DurableMlsCommitResolution::DefiniteNonAcceptance(m) => m,
    }
}
struct PrivateSession(Option<OpenMlsSession>);
impl PrivateSession {
    fn session(&self) -> &OpenMlsSession {
        self.0.as_ref().expect("private session present")
    }
    fn session_mut(&mut self) -> &mut OpenMlsSession {
        self.0.as_mut().expect("private session present")
    }
    fn accept(mut self) -> OpenMlsSession {
        self.0.take().expect("private session present")
    }
}
impl Drop for PrivateSession {
    fn drop(&mut self) {
        if let Some(session) = &self.0 {
            let mut map = session
                .provider
                .storage()
                .values
                .write()
                .unwrap_or_else(|e| e.into_inner());
            for (key, value) in map.drain() {
                drop(tls_codec::SecretVLBytes::new(key));
                drop(tls_codec::SecretVLBytes::new(value));
            }
        }
    }
}
fn apply_private_commit(
    session: &mut OpenMlsSession,
    bytes: &[u8],
    expected_sender: &Ed25519PublicKey,
) -> Result<()> {
    let scope = session.scope.binding();
    session.transaction(|_, provider, group| {
        let before = group.epoch().as_u64();
        let message = MlsMessageIn::tls_deserialize_exact(bytes)
            .map_err(failed)?
            .try_into_protocol_message()
            .map_err(failed)?;
        let processed = group.process_message(provider, message).map_err(failed)?;
        if processed.epoch().as_u64() != before {
            return Err(NativeCryptoError::EpochMismatch);
        }
        if !processed.aad().is_empty() && processed.aad() != scope {
            return Err(NativeCryptoError::ScopeMismatch);
        }
        let Sender::Member(index) = processed.sender() else {
            return Err(NativeCryptoError::UnauthorisedDevice);
        };
        let member = group
            .member_at(*index)
            .ok_or(NativeCryptoError::UnauthorisedDevice)?;
        if member.signature_key.as_slice() != expected_sender {
            return Err(NativeCryptoError::UnauthorisedDevice);
        }
        let ProcessedMessageContent::StagedCommitMessage(commit) = processed.into_content() else {
            return Err(NativeCryptoError::InvalidInput);
        };
        group
            .merge_staged_commit(provider, *commit)
            .map_err(failed)?;
        if before.checked_add(1) != Some(group.epoch().as_u64())
            || group.members().count() > MAX_MEMBERS
        {
            return Err(NativeCryptoError::EpochMismatch);
        }
        Ok(())
    })?;
    session.authorised = group_keys(session)?;
    if !session.authorised.contains(&session.device_key()) {
        return Err(DurableMlsError::ContextChanged);
    }
    Ok(())
}

fn initial_size(initial: &DurableMlsInitialCursor) -> usize {
    match initial {
        DurableMlsInitialCursor::Creator => 1,
        DurableMlsInitialCursor::Welcome { .. } => 85,
    }
}
fn put_initial(out: &mut Vec<u8>, initial: &DurableMlsInitialCursor) {
    match initial {
        DurableMlsInitialCursor::Creator => out.push(0),
        DurableMlsInitialCursor::Welcome {
            epoch,
            sequence,
            envelope,
            digest,
        } => {
            out.push(1);
            put_u64(out, *epoch);
            put_u64(out, *sequence);
            put_id(out, envelope);
            out.extend_from_slice(digest);
        }
    }
}
fn put_marker(out: &mut Vec<u8>, marker: &DurableMlsCommitMarker) {
    let i = &marker.item;
    put_id(out, &i.envelope);
    put_u64(out, i.sequence);
    put_u64(out, i.epoch);
    put_id(out, &i.sender_device);
    out.extend_from_slice(&i.sender_key);
    out.push(kind_byte(i.kind));
    out.extend_from_slice(&i.digest);
    put_roster(out, &marker.roster);
}
fn put_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_be_bytes());
}
fn put_id(out: &mut Vec<u8>, id: &RelayId) {
    out.extend_from_slice(id.as_str().as_bytes());
}
fn put_blob(out: &mut Vec<u8>, value: &[u8]) -> Result<()> {
    let size = u32::try_from(value.len()).map_err(|_| DurableMlsError::Capacity)?;
    out.extend_from_slice(&size.to_be_bytes());
    out.extend_from_slice(value);
    Ok(())
}
fn put_roster(out: &mut Vec<u8>, roster: &DurableMlsRoster) {
    out.extend_from_slice(&(roster.0.len() as u16).to_be_bytes());
    for (id, key) in &roster.0 {
        put_id(out, id);
        out.extend_from_slice(key);
    }
}
fn put_logical(out: &mut Vec<u8>, id: &DurableMlsLogicalId) {
    out.extend_from_slice(&id.sender);
    put_id(out, &id.operation);
}
fn put_transport(out: &mut Vec<u8>, transport: &Option<(RelayId, u64)>) {
    out.push(u8::from(transport.is_some()));
    if let Some((id, seq)) = transport {
        put_id(out, id);
        put_u64(out, *seq);
    }
}
fn kind_byte(kind: DurableMlsEnvelopeKind) -> u8 {
    match kind {
        DurableMlsEnvelopeKind::Application => 1,
        DurableMlsEnvelopeKind::Commit => 2,
    }
}
fn read_kind(byte: u8) -> Result<DurableMlsEnvelopeKind> {
    match byte {
        1 => Ok(DurableMlsEnvelopeKind::Application),
        2 => Ok(DurableMlsEnvelopeKind::Commit),
        _ => Err(DurableMlsError::InvalidInput),
    }
}
struct Reader<'a>(&'a [u8]);
impl<'a> Reader<'a> {
    fn initial(&mut self) -> Result<DurableMlsInitialCursor> {
        match self.byte()? {
            0 => Ok(DurableMlsInitialCursor::Creator),
            1 => {
                let epoch = self.u64()?;
                let sequence = self.u64()?;
                if epoch == 0 || sequence == 0 {
                    return Err(DurableMlsError::InvalidInput);
                }
                Ok(DurableMlsInitialCursor::Welcome {
                    epoch,
                    sequence,
                    envelope: self.id()?,
                    digest: self.array()?,
                })
            }
            _ => Err(DurableMlsError::InvalidInput),
        }
    }
    fn marker(&mut self) -> Result<DurableMlsCommitMarker> {
        let envelope = self.id()?;
        let sequence = self.u64()?;
        let epoch = self.u64()?;
        let sender_device = self.id()?;
        let sender_key = self.array()?;
        let kind = read_kind(self.byte()?)?;
        let digest = self.array()?;
        if sequence == 0 {
            return Err(DurableMlsError::InvalidInput);
        }
        Ok(DurableMlsCommitMarker {
            item: DurableMlsReadItem {
                envelope,
                sequence,
                epoch,
                sender_device,
                sender_key,
                kind,
                digest,
            },
            roster: self.roster()?,
        })
    }

    fn bytes(&mut self, n: usize) -> Result<&'a [u8]> {
        take(&mut self.0, n).map_err(Into::into)
    }
    fn array<const N: usize>(&mut self) -> Result<[u8; N]> {
        self.bytes(N)?
            .try_into()
            .map_err(|_| DurableMlsError::InvalidInput)
    }
    fn byte(&mut self) -> Result<u8> {
        Ok(self.array::<1>()?[0])
    }
    fn boolean(&mut self) -> Result<bool> {
        match self.byte()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(DurableMlsError::InvalidInput),
        }
    }
    fn u64(&mut self) -> Result<u64> {
        let n = u64::from_be_bytes(self.array()?);
        valid_number(n)?;
        Ok(n)
    }
    fn id(&mut self) -> Result<RelayId> {
        canonical_id(self.bytes(36)?)
    }
    fn blob(&mut self, max: usize) -> Result<&'a [u8]> {
        let length = u32::from_be_bytes(self.array()?) as usize;
        if length > max {
            return Err(DurableMlsError::Capacity);
        }
        self.bytes(length)
    }
    fn roster(&mut self) -> Result<DurableMlsRoster> {
        let count = usize::from(u16::from_be_bytes(self.array()?));
        if count == 0 || count > MAX_MEMBERS {
            return Err(DurableMlsError::Capacity);
        }
        let mut devices = Vec::with_capacity(count);
        let mut last = None;
        for _ in 0..count {
            let id = self.id()?;
            if last.as_ref().is_some_and(|old| old >= &id) {
                return Err(DurableMlsError::InvalidInput);
            }
            last = Some(id.clone());
            devices.push((id, self.array()?));
        }
        DurableMlsRoster::new(devices)
    }
    fn logical(&mut self) -> Result<DurableMlsLogicalId> {
        Ok(DurableMlsLogicalId {
            sender: self.array()?,
            operation: self.id()?,
        })
    }
    fn transport(&mut self) -> Result<Option<(RelayId, u64)>> {
        if self.boolean()? {
            let id = self.id()?;
            let seq = self.u64()?;
            if seq == 0 {
                return Err(DurableMlsError::InvalidInput);
            }
            Ok(Some((id, seq)))
        } else {
            Ok(None)
        }
    }
}

fn admit_request(
    id: RelayId,
    kind: IntentKind,
    room: &NativeRoomScope,
    signed: SignedRelayRequest,
) -> Result<DurableMlsRequest> {
    let expected = if kind == IntentKind::Application {
        "send-application"
    } else {
        "commit-epoch"
    };
    if signed.body().len() > MAX_HTTP {
        return Err(DurableMlsError::Capacity);
    }
    if signed.operation() != expected
        || signed.room().map(RelayId::as_str) != Some(room.room().to_string().as_str())
    {
        return Err(DurableMlsError::InvalidInput);
    }
    Ok(DurableMlsRequest {
        operation: id,
        kind,
        room: room.clone(),
        body: signed.body().to_vec(),
    })
}

fn validate_request(binding: &DurableMlsBinding, p: &Pending) -> Result<()> {
    let mut body: BTreeMap<String, serde_json::Value> =
        serde_json::from_slice(&p.request.body).map_err(failed)?;
    if serde_json::to_vec(&body).map_err(failed)? != p.request.body {
        return Err(DurableMlsError::InvalidInput);
    }
    let value = body
        .remove("signature")
        .and_then(|v| v.as_str().map(str::to_owned))
        .ok_or(DurableMlsError::InvalidInput)?;
    let signature = STANDARD.decode(&value).map_err(failed)?;
    if signature.len() != 64 || STANDARD.encode(&signature) != value {
        return Err(DurableMlsError::InvalidInput);
    }
    let operation = p.request.operation();
    let mut transcript = b"kodera-e2ee-relay-v1\0".to_vec();
    transcript.extend_from_slice(
        &serde_json::to_vec(&(
            operation,
            binding.room.organisation().as_str(),
            binding.membership.as_str(),
            Some(binding.room.room().to_string()),
            &body,
        ))
        .map_err(failed)?,
    );
    OpenMlsRustCrypto::default()
        .crypto()
        .verify_signature(
            SUITE.signature_algorithm(),
            &transcript,
            &binding.signing_key,
            &signature,
        )
        .map_err(failed)?;
    if body.get("deviceId").and_then(|v| v.as_str()) != Some(binding.device.as_str())
        || body.get("epoch").and_then(|v| v.as_u64()) != Some(p.previous)
    {
        return Err(DurableMlsError::InvalidInput);
    }
    let encoded = body
        .get("ciphertext")
        .and_then(|v| v.as_str())
        .ok_or(DurableMlsError::InvalidInput)?;
    let wire = STANDARD.decode(encoded).map_err(failed)?;
    if wire.len() < 16 || STANDARD.encode(&wire) != encoded || hash(&wire)? != p.wire {
        return Err(DurableMlsError::InvalidInput);
    }
    let keys: Vec<_> = body.keys().map(String::as_str).collect();
    if p.request.kind == IntentKind::Application {
        if keys != ["ciphertext", "deviceId", "epoch"]
            || wire.len() > 81_920
            || p.target_epoch != p.previous
        {
            return Err(DurableMlsError::InvalidInput);
        }
    } else {
        let expected: Vec<_> = p
            .target
            .0
            .keys()
            .map(|id| serde_json::Value::String(id.as_str().to_owned()))
            .collect();
        if body.get("deviceIds").and_then(|v| v.as_array()) != Some(&expected)
            || p.target_epoch
                != p.previous
                    .checked_add(1)
                    .ok_or(DurableMlsError::InvalidInput)?
        {
            return Err(DurableMlsError::InvalidInput);
        }
        if p.request.kind == IntentKind::Add {
            if keys != ["ciphertext", "deviceId", "deviceIds", "epoch", "welcome"] {
                return Err(DurableMlsError::InvalidInput);
            }
            let welcome = body
                .get("welcome")
                .and_then(|v| v.as_str())
                .ok_or(DurableMlsError::InvalidInput)?;
            let decoded = STANDARD.decode(welcome).map_err(failed)?;
            if !(16..=MAX_HANDSHAKE_BYTES).contains(&decoded.len())
                || STANDARD.encode(&decoded) != welcome
            {
                return Err(DurableMlsError::InvalidInput);
            }
        } else if keys != ["ciphertext", "deviceId", "deviceIds", "epoch"] {
            return Err(DurableMlsError::InvalidInput);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::device::tests::{admitted, finish, room, scope};
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::Arc;
    use std::task::{Context, Poll, Wake, Waker};

    fn random_key() -> [u8; 32] {
        OpenMlsRustCrypto::default()
            .rand()
            .random_array::<32>()
            .unwrap()
    }
    struct InitialRecord {
        epoch: u64,
        anchor: DurableMlsInitialCursor,
        sealed: SealedMlsState,
    }
    #[derive(Default)]
    struct DeviceStore {
        generation: u64,
        sealed: Option<SealedMlsDeviceState>,
        rooms: BTreeMap<String, InitialRecord>,
        captured: Option<DurableMlsInitialCursor>,
    }
    impl MlsDeviceStore for DeviceStore {
        async fn compare_and_swap<'a>(
            &'a mut self,
            write: &'a MlsDeviceWrite<'_>,
        ) -> std::result::Result<(), MlsDeviceStoreError> {
            if write.expected_generation != self.generation
                || write.generation != self.generation + 1
            {
                return Err(MlsDeviceStoreError::Conflict);
            }
            let initial = write
                .initial_room
                .as_ref()
                .map(|r| {
                    let anchor = self
                        .captured
                        .clone()
                        .ok_or(MlsDeviceStoreError::Unavailable)?;
                    if r.expected_generation != 0
                        || r.generation != 1
                        || anchor.epoch() != r.epoch
                        || self.rooms.contains_key(&r.scope.room().to_string())
                    {
                        return Err(MlsDeviceStoreError::Conflict);
                    }
                    Ok((
                        r.scope.room().to_string(),
                        InitialRecord {
                            epoch: r.epoch,
                            anchor,
                            sealed: r.sealed.clone(),
                        },
                    ))
                })
                .transpose()?;
            self.sealed = Some(write.sealed.clone());
            self.generation = write.generation;
            if let Some((id, record)) = initial {
                self.rooms.insert(id, record);
            }
            Ok(())
        }
    }
    struct DeviceHost {
        vault_key: [u8; 32],
        room_key: [u8; 32],
        store: DeviceStore,
    }
    fn fixture(index: u8) -> (OpenMlsDevice, DeviceHost) {
        let vault_key = random_key();
        let room_key = random_key();
        let mut store = DeviceStore::default();
        let mut device = finish(OpenMlsDevice::create_and_persist(
            scope(),
            b"public durable lifecycle fixture",
            &vault_key,
            &mut store,
        ))
        .unwrap();
        let public = device.device_key();
        finish(device.admit_and_persist(admitted(index), public, &vault_key, &mut store)).unwrap();
        (
            device,
            DeviceHost {
                vault_key,
                room_key,
                store,
            },
        )
    }
    fn package(device: &mut OpenMlsDevice, host: &mut DeviceHost) -> PreparedMlsKeyPackage {
        finish(device.prepare_key_package_and_persist(&host.vault_key, &mut host.store)).unwrap()
    }
    fn create(device: &mut OpenMlsDevice, host: &mut DeviceHost) -> OpenMlsSession {
        host.store.captured = Some(DurableMlsInitialCursor::Creator);
        finish(device.create_room_and_persist(
            room(1),
            MlsDeviceWrappingKeys {
                device: &host.vault_key,
                room: &host.room_key,
            },
            &mut host.store,
        ))
        .unwrap()
    }
    #[derive(Clone)]
    struct Event {
        item: DurableMlsReadItem,
        wire: Vec<u8>,
        recipient: Option<RelayId>,
        welcome: bool,
    }
    impl Event {
        fn input(&self) -> DurableMlsIncoming<'_> {
            DurableMlsIncoming {
                envelope: self.item.envelope.clone(),
                sequence: self.item.sequence,
                epoch: self.item.epoch,
                sender_device: self.item.sender_device.clone(),
                sender_key: self.item.sender_key,
                kind: self.item.kind,
                ciphertext: &self.wire,
            }
        }
        fn anchor(&self) -> DurableMlsInitialCursor {
            assert!(self.welcome);
            DurableMlsInitialCursor::Welcome {
                epoch: self.item.epoch,
                sequence: self.item.sequence,
                envelope: self.item.envelope.clone(),
                digest: self.item.digest,
            }
        }
    }
    #[derive(Clone)]
    struct OutcomeEvidence {
        revision: u64,
        binding: DurableMlsBinding,
        facts: DurableMlsCommitObligation,
    }
    struct Core {
        events: Vec<Event>,
        epoch: u64,
        roster: DurableMlsRoster,
        eligible: DurableMlsRoster,
        outcomes: BTreeMap<RelayId, OutcomeEvidence>,
    }
    fn wire(request: &DurableMlsRequest, field: &str) -> Vec<u8> {
        let body: serde_json::Value = serde_json::from_slice(request.body()).unwrap();
        STANDARD.decode(body[field].as_str().unwrap()).unwrap()
    }
    impl Core {
        fn append(
            &mut self,
            sender: &DurableMlsBinding,
            kind: DurableMlsEnvelopeKind,
            bytes: Vec<u8>,
            recipient: Option<RelayId>,
            welcome: bool,
        ) -> Event {
            let seq = self.events.last().map_or(1, |e| e.item.sequence + 1);
            let item = DurableMlsReadItem {
                envelope: RelayId::parse(&format!("00000000-0000-4000-8000-{seq:012}")).unwrap(),
                sequence: seq,
                epoch: self.epoch,
                sender_device: sender.device.clone(),
                sender_key: sender.signing_key,
                kind,
                digest: hash(&bytes).unwrap(),
            };
            let event = Event {
                item,
                wire: bytes,
                recipient,
                welcome,
            };
            self.events.push(event.clone());
            event
        }
        // Explicit simulated authenticated Core acceptance, independent from
        // opaque KDR1 storage. It is not an HTTP/production-admission test.
        fn application(
            &mut self,
            request: &DurableMlsRequest,
            sender: &DurableMlsBinding,
        ) -> Event {
            let value: serde_json::Value = serde_json::from_slice(request.body()).unwrap();
            assert_eq!(value["epoch"].as_u64(), Some(self.epoch));
            self.append(
                sender,
                DurableMlsEnvelopeKind::Application,
                wire(request, "ciphertext"),
                None,
                false,
            )
        }
        fn target(&self, request: &DurableMlsRequest) -> DurableMlsRoster {
            let body: serde_json::Value = serde_json::from_slice(request.body()).unwrap();
            DurableMlsRoster::new(
                body["deviceIds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|id| {
                        let id = RelayId::parse(id.as_str().unwrap()).unwrap();
                        let key = self.eligible.0[&id];
                        (id, key)
                    })
                    .collect(),
            )
            .unwrap()
        }
        fn commit(&mut self, request: &DurableMlsRequest, sender: &DurableMlsBinding) -> Event {
            let body: serde_json::Value = serde_json::from_slice(request.body()).unwrap();
            let previous = body["epoch"].as_u64().unwrap();
            assert_eq!(previous, self.epoch);
            let target = self.target(request);
            let prior = self.roster.clone();
            self.epoch += 1;
            self.roster = target.clone();
            let event = self.append(
                sender,
                DurableMlsEnvelopeKind::Commit,
                wire(request, "ciphertext"),
                None,
                false,
            );
            if body.get("welcome").is_some() {
                for id in target.0.keys().filter(|id| !prior.0.contains_key(*id)) {
                    self.append(
                        sender,
                        DurableMlsEnvelopeKind::Commit,
                        wire(request, "welcome"),
                        Some(id.clone()),
                        true,
                    );
                }
            }
            let facts = DurableMlsCommitObligation {
                operation: request.operation.clone(),
                body_digest: hash(request.body()).unwrap(),
                own_wire_digest: event.item.digest,
                previous_epoch: previous,
                target_epoch: self.epoch,
                target,
                resolution: DurableMlsCommitResolution::Accepted(DurableMlsCommitMarker {
                    item: event.item.clone(),
                    roster: self.roster.clone(),
                }),
            };
            self.outcomes.insert(
                request.operation.clone(),
                OutcomeEvidence {
                    revision: self.outcomes.len() as u64 + 1,
                    binding: sender.clone(),
                    facts,
                },
            );
            event
        }
        fn definite_loser(
            &mut self,
            request: &DurableMlsRequest,
            sender: &DurableMlsBinding,
            winner: &Event,
        ) {
            let body: serde_json::Value = serde_json::from_slice(request.body()).unwrap();
            let previous = body["epoch"].as_u64().unwrap();
            assert_eq!(winner.item.epoch, previous + 1);
            assert!(!winner.welcome);
            assert!(self.events.iter().any(|e| e.item == winner.item));
            let own_wire_digest = hash(&wire(request, "ciphertext")).unwrap();
            assert_ne!(own_wire_digest, winner.item.digest);
            let facts = DurableMlsCommitObligation {
                operation: request.operation.clone(),
                body_digest: hash(request.body()).unwrap(),
                own_wire_digest,
                previous_epoch: previous,
                target_epoch: previous + 1,
                target: self.target(request),
                resolution: DurableMlsCommitResolution::DefiniteNonAcceptance(
                    DurableMlsCommitMarker {
                        item: winner.item.clone(),
                        roster: self.roster.clone(),
                    },
                ),
            };
            self.outcomes.insert(
                request.operation.clone(),
                OutcomeEvidence {
                    revision: self.outcomes.len() as u64 + 1,
                    binding: sender.clone(),
                    facts,
                },
            );
        }
        fn next(&self, host: &HostStore, after: u64) -> Option<&Event> {
            self.events.iter().find(|e| {
                e.item.sequence > after
                    && e.item.epoch >= host.initial.epoch()
                    && if e.welcome {
                        e.recipient.as_ref() == Some(&host.binding.device)
                    } else {
                        e.item.kind == DurableMlsEnvelopeKind::Application
                            || e.item.epoch > host.initial.epoch()
                    }
            })
        }
    }
    #[derive(Clone, Copy, Default)]
    enum WriteMode {
        #[default]
        Normal,
        Abort,
        Conflict,
        Pending,
        CommitPending,
        CommitError,
        OwnerChanged,
        WorkspaceChanged,
        AuthorityChanged,
        PinLost,
        OrderLost,
        OutcomeLost,
    }
    struct Cached {
        handoff: DurableMlsCacheHandoff,
        bytes: Vec<u8>,
        pinned: bool,
    }
    #[derive(Clone)]
    struct ReadTicket {
        serial: u64,
        generation: u64,
        proof: DurableMlsReadObligation,
    }
    #[derive(Clone)]
    struct OutcomeTicket {
        context: u64,
        operation: RelayId,
    }
    struct HostStore {
        binding: DurableMlsBinding,
        authority: DurableMlsAuthority,
        initial: DurableMlsInitialCursor,
        generation: u64,
        epoch: u64,
        cursor: u64,
        sealed: Option<SealedDurableMlsRoom>,
        pending: Vec<DurableMlsPendingSend>,
        core: Rc<RefCell<Core>>,
        ticket: u64,
        order_serial: u64,
        read: bool,
        write: bool,
        hide_outcome: bool,
        mode: WriteMode,
        attempts: usize,
        caches: Rc<RefCell<BTreeMap<RelayId, Cached>>>,
        cache_key: [u8; 32],
    }
    struct Host {
        store: HostStore,
        wrapping_key: [u8; 32],
    }
    impl std::ops::Deref for Host {
        type Target = HostStore;
        fn deref(&self) -> &Self::Target {
            &self.store
        }
    }
    impl std::ops::DerefMut for Host {
        fn deref_mut(&mut self) -> &mut Self::Target {
            &mut self.store
        }
    }
    impl Host {
        fn new(
            binding: DurableMlsBinding,
            authority: DurableMlsAuthority,
            initial: &InitialRecord,
            key: [u8; 32],
            core: Rc<RefCell<Core>>,
        ) -> Self {
            assert_eq!(initial.epoch, initial.anchor.epoch());
            assert!(initial.sealed.as_bytes().starts_with(b"KMS1"));
            Self {
                wrapping_key: key,
                store: HostStore {
                    binding,
                    authority,
                    initial: initial.anchor.clone(),
                    generation: 1,
                    epoch: initial.epoch,
                    cursor: initial.anchor.cursor(),
                    sealed: None,
                    pending: Vec::new(),
                    core,
                    ticket: 1,
                    order_serial: 1,
                    read: true,
                    write: true,
                    hide_outcome: false,
                    mode: WriteMode::Normal,
                    attempts: 0,
                    caches: Rc::new(RefCell::new(BTreeMap::new())),
                    cache_key: random_key(),
                },
            }
        }
    }
    impl HostStore {
        fn read_ticket(&self) -> Option<ReadTicket> {
            let proof = if self.generation == 1 {
                DurableMlsReadObligation::Initial(self.initial.clone())
            } else {
                let core = self.core.borrow();
                let event = core.next(self, self.cursor)?;
                if event.welcome {
                    return None;
                }
                DurableMlsReadObligation::NextVisible {
                    previous_cursor: self.cursor,
                    item: event.item.clone(),
                }
            };
            Some(ReadTicket {
                serial: self.order_serial,
                generation: self.generation,
                proof,
            })
        }
        fn outcome_ticket(&self) -> Option<OutcomeTicket> {
            if self.hide_outcome {
                return None;
            }
            self.core
                .borrow()
                .outcomes
                .values()
                .filter(|e| e.binding == self.binding)
                .max_by_key(|e| e.revision)
                .map(|e| OutcomeTicket {
                    context: self.ticket,
                    operation: e.facts.operation.clone(),
                })
        }
        fn apply(&mut self, write: &DurableMlsWrite<'_>) -> Result<()> {
            if write.binding != &self.binding
                || write.expected_generation != self.generation
                || write.generation != self.generation + 1
            {
                return Err(DurableMlsError::Conflict);
            }
            assert!(write.pending_sends.len() <= 1);
            assert!(write
                .pending_sends
                .iter()
                .all(|p| p.body().len() <= MAX_HTTP));
            self.generation = write.generation;
            self.epoch = write.epoch;
            self.cursor = write.cursor;
            self.sealed = Some(write.sealed.clone());
            self.pending = write.pending_sends.to_vec();
            Ok(())
        }
        fn pin(&mut self, delivery: &DurableMlsDelivery) -> DurableMlsCacheHandoff {
            let handoff = DurableMlsCacheHandoff {
                logical: delivery.logical.clone(),
                digest: hash(delivery.body()).unwrap(),
                cache_record: admitted(240),
                cache_generation: 1,
            };
            let nonce = OpenMlsRustCrypto::default()
                .rand()
                .random_array::<12>()
                .unwrap();
            let mut bytes = delivery.body().to_vec();
            let tag = Aes256Gcm::new_from_slice(&self.cache_key)
                .unwrap()
                .encrypt_in_place_detached(
                    Nonce::from_slice(&nonce),
                    b"test encrypted history",
                    &mut bytes,
                )
                .unwrap();
            let mut sealed = nonce.to_vec();
            sealed.extend_from_slice(&bytes);
            sealed.extend_from_slice(&tag);
            self.caches.borrow_mut().insert(
                handoff.cache_record.clone(),
                Cached {
                    handoff: handoff.clone(),
                    bytes: sealed,
                    pinned: true,
                },
            );
            handoff
        }
        fn cached_body(&self, h: &DurableMlsCacheHandoff) -> Vec<u8> {
            let cache = self.caches.borrow();
            let row = &cache[&h.cache_record];
            let end = row.bytes.len() - 16;
            let mut bytes = row.bytes[12..end].to_vec();
            Aes256Gcm::new_from_slice(&self.cache_key)
                .unwrap()
                .decrypt_in_place_detached(
                    Nonce::from_slice(&row.bytes[..12]),
                    b"test encrypted history",
                    &mut bytes,
                    Tag::from_slice(&row.bytes[end..]),
                )
                .unwrap();
            bytes
        }
    }
    fn cleanup(cache: &Rc<RefCell<BTreeMap<RelayId, Cached>>>, id: &RelayId) -> Result<()> {
        let mut rows = cache.borrow_mut();
        if rows.get(id).is_some_and(|r| r.pinned) {
            return Err(DurableMlsError::Conflict);
        }
        rows.remove(id);
        Ok(())
    }
    impl DurableMlsStore for HostStore {
        type AuthorityTicket = u64;
        type ReadOrderTicket = ReadTicket;
        type CommitOutcomeTicket = OutcomeTicket;
        fn check_current(
            &self,
            ticket: &u64,
            binding: &DurableMlsBinding,
            authority: &DurableMlsAuthority,
            capability: DurableMlsCapability,
        ) -> Result<()> {
            if *ticket != self.ticket
                || binding != &self.binding
                || authority != &self.authority
                || !self.read
                || (capability != DurableMlsCapability::Read && !self.write)
            {
                return Err(DurableMlsError::ContextChanged);
            }
            Ok(())
        }
        fn check_read_order(
            &self,
            context: &u64,
            ticket: &ReadTicket,
            binding: &DurableMlsBinding,
            proof: &DurableMlsReadObligation,
        ) -> Result<()> {
            if *context != self.ticket
                || binding != &self.binding
                || ticket.serial != self.order_serial
                || &ticket.proof != proof
            {
                return Err(DurableMlsError::ContextChanged);
            }
            let (before, after) = match proof {
                DurableMlsReadObligation::Initial(anchor) => {
                    if anchor != &self.initial {
                        return Err(DurableMlsError::ContextChanged);
                    }
                    (anchor.cursor(), anchor.cursor())
                }
                DurableMlsReadObligation::NextVisible {
                    previous_cursor,
                    item,
                } => {
                    let core = self.core.borrow();
                    let actual = core
                        .next(self, *previous_cursor)
                        .ok_or(DurableMlsError::ContextChanged)?;
                    if actual.welcome || actual.item != *item {
                        return Err(DurableMlsError::ContextChanged);
                    }
                    (*previous_cursor, item.sequence)
                }
            };
            if !((self.generation == ticket.generation && self.cursor == before)
                || (self.generation == ticket.generation + 1 && self.cursor == after))
            {
                return Err(DurableMlsError::ContextChanged);
            }
            Ok(())
        }
        fn check_commit_outcome(
            &self,
            context: &u64,
            ticket: &OutcomeTicket,
            binding: &DurableMlsBinding,
            proof: &DurableMlsCommitObligation,
        ) -> Result<()> {
            if self.hide_outcome
                || *context != self.ticket
                || ticket.context != self.ticket
                || binding != &self.binding
                || ticket.operation != proof.operation
            {
                return Err(DurableMlsError::ContextChanged);
            }
            let core = self.core.borrow();
            let evidence = core
                .outcomes
                .get(&ticket.operation)
                .ok_or(DurableMlsError::ContextChanged)?;
            if evidence.binding != *binding || evidence.facts != *proof {
                return Err(DurableMlsError::ContextChanged);
            }
            Ok(())
        }
        fn check_cache_handoff(
            &self,
            ticket: &u64,
            binding: &DurableMlsBinding,
            h: &DurableMlsCacheHandoff,
        ) -> Result<()> {
            if *ticket != self.ticket
                || binding != &self.binding
                || !self
                    .caches
                    .borrow()
                    .get(&h.cache_record)
                    .is_some_and(|r| r.pinned && r.handoff == *h)
            {
                return Err(DurableMlsError::ContextChanged);
            }
            Ok(())
        }
        async fn compare_and_swap<'a>(&'a mut self, write: &'a DurableMlsWrite<'_>) -> Result<()> {
            self.attempts += 1;
            match self.mode {
                WriteMode::Abort => return Err(DurableMlsError::Storage),
                WriteMode::Conflict => return Err(DurableMlsError::Conflict),
                WriteMode::Pending => {
                    std::future::pending::<()>().await;
                    return Ok(());
                }
                _ => {}
            }
            self.apply(write)?;
            match self.mode {
                WriteMode::CommitPending => std::future::pending::<()>().await,
                WriteMode::CommitError => return Err(DurableMlsError::Storage),
                WriteMode::OwnerChanged | WriteMode::WorkspaceChanged => self.ticket += 1,
                WriteMode::AuthorityChanged => self.read = false,
                WriteMode::PinLost => {
                    for row in self.caches.borrow_mut().values_mut() {
                        row.pinned = false;
                    }
                }
                WriteMode::OrderLost => self.order_serial += 1,
                WriteMode::OutcomeLost => self.hide_outcome = true,
                _ => {}
            }
            Ok(())
        }
    }
    fn access<'a>(
        host: &'a mut Host,
        ticket: &'a u64,
        authority: &'a DurableMlsAuthority,
    ) -> DurableMlsAccess<'a, HostStore> {
        let order_ticket = host.store.read_ticket();
        let outcome_ticket = host.store.outcome_ticket();
        DurableMlsAccess {
            store: &mut host.store,
            ticket,
            authority,
            wrapping_key: &host.wrapping_key,
            order_ticket,
            outcome_ticket,
        }
    }
    fn roster(devices: &[&OpenMlsDevice]) -> DurableMlsRoster {
        DurableMlsRoster::new(
            devices
                .iter()
                .map(|d| (d.admitted_id().unwrap().clone(), d.device_key()))
                .collect(),
        )
        .unwrap()
    }
    fn binding(device: &OpenMlsDevice) -> DurableMlsBinding {
        DurableMlsBinding {
            owner: admitted(230),
            room: room(1),
            membership: device.scope().membership().clone(),
            device: device.admitted_id().unwrap().clone(),
            signing_key: device.device_key(),
        }
    }
    fn restore(host: &mut Host) -> DurableMlsRoom {
        let authority = host.authority.clone();
        let ticket = host.ticket;
        let binding = host.binding.clone();
        let epoch = host.epoch;
        let generation = host.generation;
        let sealed = host.sealed.clone().unwrap();
        let pending = host.pending.clone();
        let room = DurableMlsRoom::restore(
            binding,
            epoch,
            generation,
            &sealed,
            &pending,
            &access(host, &ticket, &authority),
        )
        .unwrap();
        assert_eq!(room.cursor(), host.cursor);
        room
    }
    fn resolve(
        room: &mut DurableMlsRoom,
        host: &mut Host,
        request: &DurableMlsRequest,
        event: &Event,
    ) {
        let authority = host.authority.clone();
        let ticket = host.ticket;
        finish(room.reconcile_request_and_persist(
            request.operation_id(),
            DurableMlsOutcome::CommitAccepted {
                envelope: event.item.envelope.clone(),
                sequence: event.item.sequence,
                epoch: event.item.epoch,
            },
            &mut access(host, &ticket, &authority),
        ))
        .unwrap();
    }
    fn consume(
        room: &mut DurableMlsRoom,
        host: &mut Host,
        event: &Event,
    ) -> Result<Option<DurableMlsDelivery>> {
        let authority = host.authority.clone();
        let ticket = host.ticket;
        finish(room.receive_and_persist(event.input(), &mut access(host, &ticket, &authority)))
    }
    struct Peers {
        alice: OpenMlsDevice,
        bob: OpenMlsDevice,
        a: DurableMlsRoom,
        b: DurableMlsRoom,
        ah: Host,
        bh: Host,
        core: Rc<RefCell<Core>>,
    }
    fn peers() -> Peers {
        let (mut alice, mut ad) = fixture(10);
        let (mut bob, mut bd) = fixture(11);
        let kp = package(&mut bob, &mut bd);
        let initial = create(&mut alice, &mut ad);
        let single = roster(&[&alice]);
        let both = roster(&[&alice, &bob]);
        let core = Rc::new(RefCell::new(Core {
            events: Vec::new(),
            epoch: 0,
            roster: single.clone(),
            eligible: both.clone(),
            outcomes: BTreeMap::new(),
        }));
        let old = DurableMlsAuthority {
            epoch: 0,
            room_roster: single,
            eligible: both.clone(),
            rekey_required: false,
        };
        let mut ah = Host::new(
            binding(&alice),
            old.clone(),
            &ad.store.rooms[&room(1).room().to_string()],
            ad.room_key,
            core.clone(),
        );
        let ticket = ah.ticket;
        let bind = ah.binding.clone();
        let anchor = ah.initial.clone();
        let mut a = finish(DurableMlsRoom::adopt_initial_and_persist(
            initial,
            bind,
            anchor,
            &mut access(&mut ah, &ticket, &old),
        ))
        .unwrap();
        let add = finish(a.prepare_commit_and_persist(
            admitted(40),
            DurableMlsChange::Add {
                key_package: kp.as_bytes(),
                device: bob.admitted_id().unwrap().clone(),
                key: bob.device_key(),
            },
            &alice,
            &mut access(&mut ah, &ticket, &old),
        ))
        .unwrap();
        let commit = core.borrow_mut().commit(&add, &ah.binding);
        let current = DurableMlsAuthority {
            epoch: 1,
            room_roster: both.clone(),
            eligible: both.clone(),
            rekey_required: false,
        };
        ah.authority = current.clone();
        resolve(&mut a, &mut ah, &add, &commit);
        consume(&mut a, &mut ah, &commit).unwrap();
        let welcome = core
            .borrow()
            .events
            .iter()
            .find(|e| e.welcome && e.recipient.as_ref() == bob.admitted_id())
            .unwrap()
            .clone();
        bd.store.captured = Some(welcome.anchor());
        let bsession = finish(bob.join_and_persist(
            PendingMlsWelcome {
                package: kp.id(),
                scope: room(1),
                expected_epoch: 1,
                welcome: &welcome.wire,
                authorised: both.keys(),
            },
            MlsDeviceWrappingKeys {
                device: &bd.vault_key,
                room: &bd.room_key,
            },
            &mut bd.store,
        ))
        .unwrap();
        let mut bh = Host::new(
            binding(&bob),
            current.clone(),
            &bd.store.rooms[&room(1).room().to_string()],
            bd.room_key,
            core.clone(),
        );
        let ticket = bh.ticket;
        let bind = bh.binding.clone();
        let anchor = bh.initial.clone();
        let b = finish(DurableMlsRoom::adopt_initial_and_persist(
            bsession,
            bind,
            anchor,
            &mut access(&mut bh, &ticket, &current),
        ))
        .unwrap();
        Peers {
            alice,
            bob,
            a,
            b,
            ah,
            bh,
            core,
        }
    }
    fn prepare(
        room: &mut DurableMlsRoom,
        host: &mut Host,
        device: &OpenMlsDevice,
        id: RelayId,
        body: &[u8],
    ) -> DurableMlsRequest {
        let a = host.authority.clone();
        let t = host.ticket;
        finish(room.prepare_send_and_persist(id, body, device, &mut access(host, &t, &a))).unwrap()
    }
    fn send(p: &mut Peers, id: RelayId, body: &[u8]) -> (DurableMlsRequest, Event) {
        let request = prepare(&mut p.a, &mut p.ah, &p.alice, id, body);
        let event = p.core.borrow_mut().application(&request, &p.ah.binding);
        (request, event)
    }
    fn ack(room: &mut DurableMlsRoom, host: &mut Host, request: &DurableMlsRequest, event: &Event) {
        let a = host.authority.clone();
        let t = host.ticket;
        finish(room.reconcile_request_and_persist(
            request.operation_id(),
            DurableMlsOutcome::ApplicationAccepted {
                envelope: event.item.envelope.clone(),
                sequence: event.item.sequence,
                epoch: event.item.epoch,
            },
            &mut access(host, &t, &a),
        ))
        .unwrap();
    }
    fn discard(room: &mut DurableMlsRoom, host: &mut Host, logical: &DurableMlsLogicalId) {
        let a = host.authority.clone();
        let t = host.ticket;
        finish(room.retire_delivery_and_persist(
            logical,
            DurableMlsRetirement::ExplicitDiscard,
            &mut access(host, &t, &a),
        ))
        .unwrap();
    }
    struct NoWake;
    impl Wake for NoWake {
        fn wake(self: Arc<Self>) {}
    }
    fn cancel<F: Future>(future: F, on_pending: impl FnOnce()) {
        let w = Waker::from(Arc::new(NoWake));
        let mut cx = Context::from_waker(&w);
        let mut f = std::pin::pin!(future);
        assert!(matches!(f.as_mut().poll(&mut cx), Poll::Pending));
        on_pending();
    }

    fn rotate(p: &mut Peers, id: RelayId) -> (DurableMlsRequest, Event) {
        let a = p.ah.authority.clone();
        let t = p.ah.ticket;
        let request = finish(p.a.prepare_commit_and_persist(
            id,
            DurableMlsChange::Rotate,
            &p.alice,
            &mut access(&mut p.ah, &t, &a),
        ))
        .unwrap();
        let event = p.core.borrow_mut().commit(&request, &p.ah.binding);
        let mut current = a;
        current.epoch = event.item.epoch;
        current.room_roster = p.core.borrow().roster.clone();
        p.ah.authority = current.clone();
        p.bh.authority = current;
        (request, event)
    }
    fn accepted_race() -> (Peers, Event, Event) {
        let mut p = peers();
        let request = prepare(
            &mut p.b,
            &mut p.bh,
            &p.bob,
            admitted(41),
            b"genuine old epoch peer text",
        );
        let before = p.core.borrow_mut().application(&request, &p.bh.binding);
        ack(&mut p.b, &mut p.bh, &request, &before);
        let (rotation, marker) = rotate(&mut p, admitted(42));
        p.a = restore(&mut p.ah);
        resolve(&mut p.a, &mut p.ah, &rotation, &marker);
        p.a = restore(&mut p.ah);
        (p, before, marker)
    }

    #[test]
    fn genuine_lifecycle_anchor_filtered_gaps_restart_and_exact_lost_ack_retry() {
        let mut p = peers();
        assert_eq!(p.a.cursor(), 1);
        assert_eq!(p.b.cursor(), 2);
        assert!(matches!(
            p.b.initial,
            DurableMlsInitialCursor::Welcome { sequence: 2, .. }
        ));
        let (request, event) = send(&mut p, admitted(41), b"private durable text");
        p.a = restore(&mut p.ah);
        let a = p.ah.authority.clone();
        let t = p.ah.ticket;
        assert_eq!(
            p.a.pending_request(&access(&mut p.ah, &t, &a)).unwrap(),
            request
        );
        assert_eq!(
            p.a.pending_request(&access(&mut p.ah, &t, &a)).unwrap(),
            request
        );
        let delivered = consume(&mut p.b, &mut p.bh, &event).unwrap().unwrap();
        assert_eq!(delivered.body(), b"private durable text");
        p.b = restore(&mut p.bh);
        let a = p.bh.authority.clone();
        let t = p.bh.ticket;
        assert_eq!(
            p.b.recover_deliveries(&access(&mut p.bh, &t, &a)).unwrap()[0].logical_id(),
            delivered.logical_id()
        );
        // Own local receipt is recoverable even before remote acknowledgement;
        // its type is deliberately not evidence of remote delivery.
        let a = p.ah.authority.clone();
        let t = p.ah.ticket;
        assert_eq!(
            p.a.recover_deliveries(&access(&mut p.ah, &t, &a)).unwrap()[0].body(),
            delivered.body()
        );
        ack(&mut p.a, &mut p.ah, &request, &event);
        consume(&mut p.a, &mut p.ah, &event).unwrap(); // legitimate gap: filtered Welcome2
        assert_eq!(p.a.cursor(), 3);
    }

    #[test]
    fn second_valid_frame_and_retained_alias_cannot_skip_the_next_visible_frame() {
        let mut p = peers();
        let (first, e1) = send(&mut p, admitted(41), b"first");
        ack(&mut p.a, &mut p.ah, &first, &e1);
        let (second, e2) = send(&mut p, admitted(42), b"second");
        ack(&mut p.a, &mut p.ah, &second, &e2);
        let before = p.bh.generation;
        assert!(consume(&mut p.b, &mut p.bh, &e2).is_err());
        assert!(!p.b.requires_restore());
        assert_eq!(p.b.cursor(), 2);
        assert_eq!(p.bh.generation, before);
        let d1 = consume(&mut p.b, &mut p.bh, &e1).unwrap().unwrap();
        let alias = p.core.borrow_mut().application(&first, &p.ah.binding);
        assert!(consume(&mut p.b, &mut p.bh, &alias).is_err());
        assert_eq!(p.b.cursor(), e1.item.sequence);
        let mut huge = alias.clone();
        huge.item.sequence = 100;
        assert!(consume(&mut p.b, &mut p.bh, &huge).is_err());
        assert_eq!(
            consume(&mut p.b, &mut p.bh, &e2).unwrap().unwrap().body(),
            b"second"
        );
        assert_eq!(
            consume(&mut p.b, &mut p.bh, &alias)
                .unwrap()
                .unwrap()
                .logical_id(),
            d1.logical_id()
        );
        assert_eq!(p.b.receipts.len(), 2);
    }

    #[test]
    fn stale_overlapping_page_ticket_is_not_a_successor_or_post_cas_admission() {
        let mut p = peers();
        let (_, event) = send(&mut p, admitted(41), b"one ordered page");
        let old_ticket = p.bh.store.read_ticket().unwrap();
        consume(&mut p.b, &mut p.bh, &event).unwrap();
        let a = p.bh.authority.clone();
        let t = p.bh.ticket;
        let request = p.a.request().unwrap();
        ack(&mut p.a, &mut p.ah, &request, &event);
        let (_, next) = send(&mut p, admitted(42), b"later");
        let mut ctx = access(&mut p.bh, &t, &a);
        ctx.order_ticket = Some(old_ticket);
        assert!(finish(p.b.receive_and_persist(next.input(), &mut ctx)).is_err());
        assert_eq!(p.b.cursor(), event.item.sequence);
        p.b = restore(&mut p.bh);
        assert_eq!(
            consume(&mut p.b, &mut p.bh, &next).unwrap().unwrap().body(),
            b"later"
        );
    }

    #[test]
    fn accepted_own_commit_keeps_unseen_prior_epoch_message_until_exact_marker() {
        let (mut p, before, marker) = accepted_race();
        assert!(p.a.pending.as_ref().unwrap().historical.is_some());
        assert!(consume(&mut p.a, &mut p.ah, &marker).is_err());
        assert_eq!(
            consume(&mut p.a, &mut p.ah, &before)
                .unwrap()
                .unwrap()
                .body(),
            b"genuine old epoch peer text"
        );
        p.a = restore(&mut p.ah);
        assert_eq!(p.a.cursor(), before.item.sequence);
        assert_eq!(p.a.epoch(), marker.item.epoch);
        assert!(consume(&mut p.a, &mut p.ah, &marker).unwrap().is_none());
        assert!(p.a.pending.is_none());
        assert_eq!(p.a.cursor(), marker.item.sequence);
        consume(&mut p.b, &mut p.bh, &before).unwrap();
        p.b = restore(&mut p.bh);
        consume(&mut p.b, &mut p.bh, &marker).unwrap();
        let (_, next) = send(&mut p, admitted(43), b"actual target epoch");
        assert_eq!(
            consume(&mut p.b, &mut p.bh, &next).unwrap().unwrap().body(),
            b"actual target epoch"
        );
    }

    #[test]
    fn old_branch_receive_cas_abort_commit_cancel_and_context_refusal_preserve_truth() {
        for mode in [
            WriteMode::Abort,
            WriteMode::Conflict,
            WriteMode::Pending,
            WriteMode::CommitPending,
            WriteMode::CommitError,
            WriteMode::OwnerChanged,
            WriteMode::WorkspaceChanged,
            WriteMode::AuthorityChanged,
            WriteMode::OrderLost,
            WriteMode::OutcomeLost,
        ] {
            let (mut p, before, marker) = accepted_race();
            let previous = p.a.cursor();
            let a = p.ah.authority.clone();
            let t = p.ah.ticket;
            p.ah.mode = mode;
            let mut ctx = access(&mut p.ah, &t, &a);
            let f = p.a.receive_and_persist(before.input(), &mut ctx);
            if matches!(mode, WriteMode::Pending | WriteMode::CommitPending) {
                cancel(f, || {});
            } else {
                assert!(finish(f).is_err());
            }
            assert!(p.a.requires_restore());
            let committed = !matches!(
                mode,
                WriteMode::Abort | WriteMode::Conflict | WriteMode::Pending
            );
            assert_eq!(
                p.ah.cursor,
                if committed {
                    before.item.sequence
                } else {
                    previous
                }
            );
            p.ah.mode = WriteMode::Normal;
            p.ah.read = true;
            p.ah.hide_outcome = false;
            p.a = restore(&mut p.ah);
            if !committed {
                consume(&mut p.a, &mut p.ah, &before).unwrap();
            }
            let a = p.ah.authority.clone();
            let t = p.ah.ticket;
            let views = p.a.recover_deliveries(&access(&mut p.ah, &t, &a)).unwrap();
            assert_eq!(views.len(), 1);
            assert_eq!(views[0].body(), b"genuine old epoch peer text");
            consume(&mut p.a, &mut p.ah, &marker).unwrap();
            assert!(p.a.pending.is_none());
        }
    }

    #[test]
    fn accepted_marker_requires_pre_and_post_outcome_order_and_current_fences() {
        for mode in [
            WriteMode::Abort,
            WriteMode::Pending,
            WriteMode::CommitPending,
            WriteMode::CommitError,
            WriteMode::OrderLost,
            WriteMode::OutcomeLost,
            WriteMode::OwnerChanged,
        ] {
            let (mut p, before, marker) = accepted_race();
            consume(&mut p.a, &mut p.ah, &before).unwrap();
            let a = p.ah.authority.clone();
            let t = p.ah.ticket;
            p.ah.mode = mode;
            let mut ctx = access(&mut p.ah, &t, &a);
            let f = p.a.receive_and_persist(marker.input(), &mut ctx);
            if matches!(mode, WriteMode::Pending | WriteMode::CommitPending) {
                cancel(f, || {});
            } else {
                assert!(finish(f).is_err());
            }
            assert!(p.a.requires_restore());
            let committed = !matches!(mode, WriteMode::Abort | WriteMode::Pending);
            p.ah.mode = WriteMode::Normal;
            p.ah.hide_outcome = false;
            p.a = restore(&mut p.ah);
            assert_eq!(p.a.pending.is_none(), committed);
            if !committed {
                consume(&mut p.a, &mut p.ah, &marker).unwrap();
            }
            assert_eq!(p.a.epoch(), marker.item.epoch);
            assert_eq!(p.a.cursor(), marker.item.sequence);
        }
    }

    #[test]
    fn restored_kdr_outcome_metadata_cannot_mint_a_fresh_core_outcome_ticket() {
        let (mut p, before, marker) = accepted_race();
        let evidence = p.core.borrow_mut().outcomes.remove(&admitted(42)).unwrap();
        p.a = restore(&mut p.ah);
        assert!(consume(&mut p.a, &mut p.ah, &before).is_err());
        assert_eq!(p.a.cursor(), 1);
        let a = p.ah.authority.clone();
        let t = p.ah.ticket;
        let echoed =
            p.a.commit_outcome_obligation(&access(&mut p.ah, &t, &a))
                .unwrap()
                .unwrap();
        let mut ctx = access(&mut p.ah, &t, &a);
        ctx.outcome_ticket = Some(OutcomeTicket {
            context: t,
            operation: echoed.operation.clone(),
        });
        assert!(finish(p.a.receive_and_persist(before.input(), &mut ctx)).is_err());
        p.core
            .borrow_mut()
            .outcomes
            .insert(evidence.facts.operation.clone(), evidence);
        consume(&mut p.a, &mut p.ah, &before).unwrap();
        consume(&mut p.a, &mut p.ah, &marker).unwrap();
    }

    fn competing() -> (Peers, DurableMlsRequest, Event, Event) {
        let mut p = peers();
        let old_request = prepare(
            &mut p.b,
            &mut p.bh,
            &p.bob,
            admitted(41),
            b"before competing transitions",
        );
        let before = p.core.borrow_mut().application(&old_request, &p.bh.binding);
        ack(&mut p.b, &mut p.bh, &old_request, &before);
        let a = p.ah.authority.clone();
        let t = p.ah.ticket;
        let losing = finish(p.a.prepare_commit_and_persist(
            admitted(42),
            DurableMlsChange::Rotate,
            &p.alice,
            &mut access(&mut p.ah, &t, &a),
        ))
        .unwrap();
        let b = p.bh.authority.clone();
        let t = p.bh.ticket;
        let winning = finish(p.b.prepare_commit_and_persist(
            admitted(43),
            DurableMlsChange::Rotate,
            &p.bob,
            &mut access(&mut p.bh, &t, &b),
        ))
        .unwrap();
        let event = p.core.borrow_mut().commit(&winning, &p.bh.binding);
        let mut current = a;
        current.epoch = event.item.epoch;
        p.ah.authority = current.clone();
        p.bh.authority = current;
        resolve(&mut p.b, &mut p.bh, &winning, &event);
        consume(&mut p.b, &mut p.bh, &before).unwrap();
        consume(&mut p.b, &mut p.bh, &event).unwrap();
        (p, losing, event, before)
    }
    #[test]
    fn exact_definite_nonacceptance_promotes_actual_winner_never_a_bare_http_error() {
        let (mut p, losing, winner, before) = competing();
        let a = p.ah.authority.clone();
        let t = p.ah.ticket;
        let marker = DurableMlsCommitMarker {
            item: winner.item.clone(),
            roster: p.core.borrow().roster.clone(),
        };
        assert!(finish(p.a.reconcile_request_and_persist(
            losing.operation_id(),
            DurableMlsOutcome::CommitNotAccepted {
                winner: marker.clone()
            },
            &mut access(&mut p.ah, &t, &a)
        ))
        .is_err());
        assert!(p.a.pending.as_ref().unwrap().resolution.is_none());
        p.core
            .borrow_mut()
            .definite_loser(&losing, &p.ah.binding, &winner);
        finish(p.a.reconcile_request_and_persist(
            losing.operation_id(),
            DurableMlsOutcome::CommitNotAccepted { winner: marker },
            &mut access(&mut p.ah, &t, &a),
        ))
        .unwrap();
        p.a = restore(&mut p.ah);
        assert_eq!(
            consume(&mut p.a, &mut p.ah, &before)
                .unwrap()
                .unwrap()
                .body(),
            b"before competing transitions"
        );
        consume(&mut p.a, &mut p.ah, &winner).unwrap();
        assert!(p.a.pending.is_none());
        let request = prepare(
            &mut p.b,
            &mut p.bh,
            &p.bob,
            admitted(44),
            b"canonical winning branch text",
        );
        let event = p.core.borrow_mut().application(&request, &p.bh.binding);
        assert_eq!(
            consume(&mut p.a, &mut p.ah, &event)
                .unwrap()
                .unwrap()
                .body(),
            b"canonical winning branch text"
        );
        assert_eq!(
            finish(p.a.prepare_commit_and_persist(
                admitted(42),
                DurableMlsChange::Rotate,
                &p.alice,
                &mut access(&mut p.ah, &t, &a)
            ))
            .unwrap_err(),
            DurableMlsError::ReusedOperationId
        );
    }

    #[test]
    fn winner_promotion_post_commit_outcome_loss_keeps_quarantine_until_restore() {
        for mode in [
            WriteMode::Abort,
            WriteMode::CommitPending,
            WriteMode::OutcomeLost,
            WriteMode::OrderLost,
        ] {
            let (mut p, losing, winner, before) = competing();
            p.core
                .borrow_mut()
                .definite_loser(&losing, &p.ah.binding, &winner);
            let a = p.ah.authority.clone();
            let t = p.ah.ticket;
            let marker = DurableMlsCommitMarker {
                item: winner.item.clone(),
                roster: p.core.borrow().roster.clone(),
            };
            finish(p.a.reconcile_request_and_persist(
                losing.operation_id(),
                DurableMlsOutcome::CommitNotAccepted { winner: marker },
                &mut access(&mut p.ah, &t, &a),
            ))
            .unwrap();
            consume(&mut p.a, &mut p.ah, &before).unwrap();
            p.ah.mode = mode;
            let mut ctx = access(&mut p.ah, &t, &a);
            let f = p.a.receive_and_persist(winner.input(), &mut ctx);
            if matches!(mode, WriteMode::CommitPending) {
                cancel(f, || {});
            } else {
                assert!(finish(f).is_err());
            }
            assert!(p.a.requires_restore());
            p.ah.mode = WriteMode::Normal;
            p.ah.hide_outcome = false;
            p.a = restore(&mut p.ah);
            if p.a.pending.is_some() {
                consume(&mut p.a, &mut p.ah, &winner).unwrap();
            }
            assert!(p.a.pending.is_none());
        }
    }

    #[test]
    fn ordinary_send_and_receive_uncertainty_never_makes_old_handles_retryable() {
        for mode in [
            WriteMode::Abort,
            WriteMode::Conflict,
            WriteMode::Pending,
            WriteMode::CommitPending,
            WriteMode::CommitError,
            WriteMode::OwnerChanged,
            WriteMode::AuthorityChanged,
        ] {
            let mut p = peers();
            let a = p.ah.authority.clone();
            let t = p.ah.ticket;
            p.ah.mode = mode;
            let before = p.ah.generation;
            let mut ctx = access(&mut p.ah, &t, &a);
            let f = p.a.prepare_send_and_persist(
                admitted(41),
                b"wait for durable acknowledgement",
                &p.alice,
                &mut ctx,
            );
            if matches!(mode, WriteMode::Pending | WriteMode::CommitPending) {
                cancel(f, || {});
            } else {
                assert!(finish(f).is_err());
            }
            assert!(p.a.requires_restore());
            let committed = !matches!(
                mode,
                WriteMode::Abort | WriteMode::Conflict | WriteMode::Pending
            );
            assert_eq!(p.ah.generation, before + u64::from(committed));
            p.ah.mode = WriteMode::Normal;
            p.ah.read = true;
            p.a = restore(&mut p.ah);
            assert_eq!(p.a.pending.is_some(), committed);
            if committed {
                let a = p.ah.authority.clone();
                let t = p.ah.ticket;
                let request = p.a.pending_request(&access(&mut p.ah, &t, &a)).unwrap();
                assert_eq!(request.body(), p.ah.pending[0].body());
            }
        }
        for mode in [
            WriteMode::Abort,
            WriteMode::Pending,
            WriteMode::CommitPending,
            WriteMode::CommitError,
            WriteMode::OwnerChanged,
        ] {
            let mut p = peers();
            let (_, event) = send(&mut p, admitted(41), b"receive durability");
            let a = p.bh.authority.clone();
            let t = p.bh.ticket;
            p.bh.mode = mode;
            let mut ctx = access(&mut p.bh, &t, &a);
            let f = p.b.receive_and_persist(event.input(), &mut ctx);
            if matches!(mode, WriteMode::Pending | WriteMode::CommitPending) {
                cancel(f, || {});
            } else {
                assert!(finish(f).is_err());
            }
            assert!(p.b.requires_restore());
            p.bh.mode = WriteMode::Normal;
            p.b = restore(&mut p.bh);
            if p.b.cursor() < event.item.sequence {
                consume(&mut p.b, &mut p.bh, &event).unwrap();
            }
            assert_eq!(p.b.receipts.len(), 1);
            assert_eq!(p.b.receipts[0].body.0, b"receive durability");
        }
    }

    #[test]
    fn synchronous_stale_context_cannot_reactivate_with_a_new_ticket() {
        let mut p = peers();
        let (request, _) = send(&mut p, admitted(41), b"accepted context only");
        let a = p.ah.authority.clone();
        let old = p.ah.ticket;
        p.ah.ticket += 1;
        assert_eq!(
            p.a.pending_request(&access(&mut p.ah, &old, &a)),
            Err(DurableMlsError::ContextChanged)
        );
        let current = p.ah.ticket;
        assert_eq!(
            p.a.pending_request(&access(&mut p.ah, &current, &a)),
            Err(DurableMlsError::RequiresRestore)
        );
        p.a = restore(&mut p.ah);
        assert_eq!(
            p.a.pending_request(&access(&mut p.ah, &current, &a))
                .unwrap(),
            request
        );
    }

    #[test]
    fn logical_id_reuse_and_unknown_control_frames_are_not_user_delivery() {
        let mut p = peers();
        let (first, event) = send(&mut p, admitted(41), b"first logical intent");
        let a = p.ah.authority.clone();
        let t = p.ah.ticket;
        let before = p.ah.attempts;
        assert_eq!(
            finish(p.a.prepare_send_and_persist(
                admitted(41),
                b"changed",
                &p.alice,
                &mut access(&mut p.ah, &t, &a)
            ))
            .unwrap_err(),
            DurableMlsError::ReusedOperationId
        );
        assert_eq!(
            finish(p.a.prepare_commit_and_persist(
                admitted(41),
                DurableMlsChange::Rotate,
                &p.alice,
                &mut access(&mut p.ah, &t, &a)
            ))
            .unwrap_err(),
            DurableMlsError::ReusedOperationId
        );
        assert_eq!(p.ah.attempts, before);
        let delivery = consume(&mut p.b, &mut p.bh, &event).unwrap().unwrap();
        ack(&mut p.a, &mut p.ah, &first, &event);
        let logical = p.a.receipts[0].logical.clone();
        discard(&mut p.a, &mut p.ah, &logical);
        p.a = restore(&mut p.ah);
        assert_eq!(
            finish(p.a.prepare_send_and_persist(
                admitted(41),
                b"retired reuse",
                &p.alice,
                &mut access(&mut p.ah, &t, &a)
            ))
            .unwrap_err(),
            DurableMlsError::ReusedOperationId
        );
        assert_eq!(delivery.logical.operation, admitted(41));
        for variant in 0..7 {
            let mut p = peers();
            let mut framed = frame(&admitted(41), b"never a key/control view").unwrap();
            match variant {
                0 => framed.0[..4].copy_from_slice(b"KEY1"),
                1 => framed.0[4] = 2,
                2 => framed.0[4] = 255,
                3 => framed.0[5] = b'G',
                4 => framed.0[44] = 0,
                5 => framed.0.push(0),
                _ => framed.0[45] = 255,
            }
            let encrypted = p.a.session.seal(&framed.0).unwrap();
            let event = p.core.borrow_mut().append(
                &p.ah.binding,
                DurableMlsEnvelopeKind::Application,
                encrypted.ciphertext,
                None,
                false,
            );
            let before = p.bh.generation;
            assert!(consume(&mut p.b, &mut p.bh, &event).is_err());
            assert!(p.b.requires_restore());
            assert_eq!(p.bh.generation, before);
            p.b = restore(&mut p.bh);
            assert!(p.b.receipts.is_empty());
        }
    }

    #[test]
    fn same_authenticated_logical_id_with_changed_ciphertext_refuses() {
        let mut p = peers();
        let (_, event) = send(&mut p, admitted(41), b"one identity");
        consume(&mut p.b, &mut p.bh, &event).unwrap();
        let bytes = frame(&admitted(41), b"changed authenticated payload").unwrap();
        let encrypted = p.a.session.seal(&bytes.0).unwrap();
        let duplicate = p.core.borrow_mut().append(
            &p.ah.binding,
            DurableMlsEnvelopeKind::Application,
            encrypted.ciphertext,
            None,
            false,
        );
        assert_eq!(
            consume(&mut p.b, &mut p.bh, &duplicate).unwrap_err(),
            DurableMlsError::ReusedOperationId
        );
        assert!(p.b.requires_restore());
    }

    #[test]
    fn pinned_encrypted_cache_survives_pending_retirement_and_second_actor_cleanup() {
        for mode in [
            WriteMode::Normal,
            WriteMode::Abort,
            WriteMode::CommitPending,
            WriteMode::CommitError,
            WriteMode::OwnerChanged,
            WriteMode::PinLost,
        ] {
            let mut p = peers();
            let (_, event) = send(&mut p, admitted(41), b"needed history after render");
            let d = consume(&mut p.b, &mut p.bh, &event).unwrap().unwrap();
            p.b = restore(&mut p.bh);
            let a = p.bh.authority.clone();
            let t = p.bh.ticket;
            assert_eq!(
                p.b.recover_deliveries(&access(&mut p.bh, &t, &a)).unwrap()[0].body(),
                d.body()
            );
            let handoff = p.bh.pin(&d);
            let second = p.bh.caches.clone();
            assert_eq!(
                cleanup(&second, &handoff.cache_record),
                Err(DurableMlsError::Conflict)
            );
            p.bh.mode = mode;
            let mut ctx = access(&mut p.bh, &t, &a);
            let f = p.b.retire_delivery_and_persist(
                d.logical_id(),
                DurableMlsRetirement::PinnedEncryptedCache(&handoff),
                &mut ctx,
            );
            if matches!(mode, WriteMode::CommitPending) {
                cancel(f, || {
                    assert_eq!(
                        cleanup(&second, &handoff.cache_record),
                        Err(DurableMlsError::Conflict)
                    )
                });
            } else if matches!(mode, WriteMode::Normal) {
                finish(f).unwrap();
            } else {
                assert!(finish(f).is_err());
            }
            assert_eq!(p.bh.cached_body(&handoff), d.body());
            if !matches!(mode, WriteMode::PinLost) {
                assert_eq!(
                    cleanup(&second, &handoff.cache_record),
                    Err(DurableMlsError::Conflict)
                );
            }
            p.bh.mode = WriteMode::Normal;
            p.b = restore(&mut p.bh);
            if !matches!(mode, WriteMode::Abort) {
                assert!(p.b.receipts.is_empty());
            } else {
                assert_eq!(p.b.receipts.len(), 1);
            }
        }
    }

    #[test]
    fn ciphertext_tamper_routing_change_and_wrong_expected_aad_preserve_good_record() {
        let mut p = peers();
        let (_, event) = send(&mut p, admitted(41), b"authenticated at rest");
        let mut changed = event.clone();
        let index = changed.wire.len() / 2;
        changed.wire[index] ^= 1;
        // A registered Core item hash cannot be changed by the receive caller.
        assert!(consume(&mut p.b, &mut p.bh, &changed).is_err());
        assert!(!p.b.requires_restore());
        let mut forged = event.clone();
        forged.item.digest = hash(&changed.wire).unwrap();
        forged.wire = changed.wire;
        p.core
            .borrow_mut()
            .events
            .last_mut()
            .unwrap()
            .clone_from(&forged);
        let before = p.bh.sealed.clone().unwrap();
        assert!(consume(&mut p.b, &mut p.bh, &forged).is_err());
        assert!(p.b.requires_restore());
        assert_eq!(p.bh.sealed.as_ref().unwrap().as_bytes(), before.as_bytes());
        p.core
            .borrow_mut()
            .events
            .last_mut()
            .unwrap()
            .clone_from(&event);
        p.b = restore(&mut p.bh);
        consume(&mut p.b, &mut p.bh, &event).unwrap();
        let b = p.bh.binding.clone();
        let e = p.bh.epoch;
        let g = p.bh.generation;
        let sealed = p.bh.sealed.clone().unwrap();
        let pending = p.bh.pending.clone();
        let a = p.bh.authority.clone();
        let t = p.bh.ticket;
        for case in 0..8 {
            let mut expected = b.clone();
            match case {
                0 => expected.owner = admitted(200),
                1 => expected.membership = admitted(201),
                2 => expected.device = admitted(202),
                3 => expected.signing_key[0] ^= 1,
                4 => expected.room = room(2),
                5 => {
                    expected.room = NativeRoomScope::new(
                        crate::OrganisationId::parse(admitted(203).as_str()).unwrap(),
                        room(1).room(),
                    )
                }
                _ => {}
            }
            p.bh.binding = expected.clone();
            assert!(DurableMlsRoom::restore(
                expected,
                e + u64::from(case == 6),
                g + u64::from(case == 7),
                &sealed,
                &pending,
                &access(&mut p.bh, &t, &a)
            )
            .is_err());
            p.bh.binding = b.clone();
        }
        let mut wrong = p.bh.wrapping_key;
        wrong[0] ^= 1;
        let mut ctx = access(&mut p.bh, &t, &a);
        ctx.wrapping_key = &wrong;
        assert!(DurableMlsRoom::restore(b, e, g, &sealed, &pending, &ctx).is_err());
    }

    #[test]
    fn exact_plaintext_frame_and_complete_signed_http_body_limits() {
        let mut p = peers();
        let a = p.ah.authority.clone();
        let t = p.ah.ticket;
        assert!(finish(p.a.prepare_send_and_persist(
            admitted(41),
            &vec![b'x'; MAX_BODY + 1],
            &p.alice,
            &mut access(&mut p.ah, &t, &a)
        ))
        .is_err());
        assert!(!p.a.requires_restore());
        let (request, event) = send(&mut p, admitted(41), &vec![b'x'; MAX_BODY]);
        assert!(request.body().len() <= MAX_HTTP);
        assert_eq!(
            consume(&mut p.b, &mut p.bh, &event)
                .unwrap()
                .unwrap()
                .body()
                .len(),
            MAX_BODY
        );
        for maximum in [MAX_HTTP, MAX_HTTP + 1] {
            let mut tested = false;
            for epoch in [1, 10, 100, 1000] {
                let short = p
                    .alice
                    .sign_relay_request(RelayStatement::SendApplication {
                        room: &room(1),
                        epoch,
                        ciphertext: &[1; 16],
                    })
                    .unwrap();
                let base = short.body().len() - 24;
                if maximum > base && (maximum - base) % 4 == 0 {
                    let bytes = vec![1; 3 * ((maximum - base) / 4)];
                    let signed = p
                        .alice
                        .sign_relay_request(RelayStatement::SendApplication {
                            room: &room(1),
                            epoch,
                            ciphertext: &bytes,
                        })
                        .unwrap();
                    assert_eq!(signed.body().len(), maximum);
                    let result =
                        admit_request(admitted(50), IntentKind::Application, &room(1), signed);
                    assert_eq!(result.is_ok(), maximum == MAX_HTTP);
                    tested = true;
                    break;
                }
            }
            assert!(tested);
        }
    }

    #[test]
    fn receipt_count_and_byte_backpressure_do_not_advance_or_discard_needed_content() {
        for large in [false, true] {
            let mut p = peers();
            let count = if large { 13u8 } else { 33 };
            let body = vec![b'x'; if large { MAX_BODY } else { 8 }];
            let mut last = None;
            for index in 0..count {
                let (request, event) = send(&mut p, admitted(100 + index), &body);
                ack(&mut p.a, &mut p.ah, &request, &event);
                let logical = p.a.receipts[0].logical.clone();
                discard(&mut p.a, &mut p.ah, &logical);
                if index < count - 1 {
                    consume(&mut p.b, &mut p.bh, &event).unwrap();
                } else {
                    last = Some(event);
                }
            }
            let last = last.unwrap();
            let old = p.bh.generation;
            assert_eq!(
                consume(&mut p.b, &mut p.bh, &last).unwrap_err(),
                DurableMlsError::Capacity
            );
            assert_eq!(p.bh.generation, old);
            if large {
                assert!(p.b.requires_restore());
                p.b = restore(&mut p.bh);
            } else {
                assert!(!p.b.requires_restore());
            }
            let logical = p.b.receipts[0].logical.clone();
            discard(&mut p.b, &mut p.bh, &logical);
            assert_eq!(
                consume(&mut p.b, &mut p.bh, &last).unwrap().unwrap().body(),
                body
            );
        }
    }

    #[test]
    fn private_drain_and_catchup_share_cumulative_sixty_four_budget_across_restart() {
        for count in [63u8, 64] {
            let mut p = peers();
            let mut old_events = Vec::new();
            for index in 0..count {
                let r = prepare(
                    &mut p.b,
                    &mut p.bh,
                    &p.bob,
                    admitted(100 + index),
                    b"old epoch backlog",
                );
                let event = p.core.borrow_mut().application(&r, &p.bh.binding);
                ack(&mut p.b, &mut p.bh, &r, &event);
                let logical = p.b.receipts[0].logical.clone();
                discard(&mut p.b, &mut p.bh, &logical);
                old_events.push(event);
            }
            let (rotation, marker) = rotate(&mut p, admitted(210));
            resolve(&mut p.a, &mut p.ah, &rotation, &marker);
            for (index, event) in old_events.iter().enumerate() {
                let d = consume(&mut p.a, &mut p.ah, event).unwrap().unwrap();
                discard(&mut p.a, &mut p.ah, d.logical_id());
                if index == 31 {
                    p.a = restore(&mut p.ah);
                }
            }
            p.a = restore(&mut p.ah);
            let result = consume(&mut p.a, &mut p.ah, &marker);
            if count == 63 {
                assert!(result.unwrap().is_none());
                assert!(p.a.pending.is_none());
            } else {
                assert_eq!(result.unwrap_err(), DurableMlsError::RecoveryRequired);
                assert!(p.a.pending.is_some());
            }
        }
    }

    fn malformed(host: &Host, change: impl FnOnce(&mut Vec<u8>)) -> SealedDurableMlsRoom {
        let old = host.sealed.as_ref().unwrap();
        let end = old.0.len() - 16;
        let aad = DurableMlsRoom::aad(&host.binding, host.epoch, host.generation);
        let mut plain = CheckpointBuffer(old.0[16..end].to_vec());
        let cipher = Aes256Gcm::new_from_slice(&host.wrapping_key).unwrap();
        cipher
            .decrypt_in_place_detached(
                Nonce::from_slice(&old.0[4..16]),
                &aad,
                &mut plain.0,
                Tag::from_slice(&old.0[end..]),
            )
            .unwrap();
        change(&mut plain.0);
        let nonce = OpenMlsRustCrypto::default()
            .rand()
            .random_array::<12>()
            .unwrap();
        let tag = cipher
            .encrypt_in_place_detached(Nonce::from_slice(&nonce), &aad, &mut plain.0)
            .unwrap();
        let mut bytes = MAGIC.to_vec();
        bytes.extend_from_slice(&nonce);
        bytes.extend_from_slice(&plain.0);
        bytes.extend_from_slice(&tag);
        SealedDurableMlsRoom::from_bytes(&bytes).unwrap()
    }
    #[test]
    fn malformed_compound_and_external_pending_manifest_refuse_without_replacing_state() {
        let mut p = peers();
        let (request, _) = send(&mut p, admitted(41), b"private recovery body");
        for case in 0..4 {
            let bad = malformed(&p.ah, |bytes| match case {
                0 => bytes[0] = 1,
                1 => bytes.push(0),
                2 => bytes.truncate(bytes.len() - 1),
                _ => bytes[1..9].copy_from_slice(&MAX_JSON_INTEGER.to_be_bytes()),
            });
            let a = p.ah.authority.clone();
            let t = p.ah.ticket;
            let b = p.ah.binding.clone();
            let e = p.ah.epoch;
            let g = p.ah.generation;
            let pending = p.ah.pending.clone();
            let good = p.ah.sealed.clone().unwrap();
            assert!(
                DurableMlsRoom::restore(b, e, g, &bad, &pending, &access(&mut p.ah, &t, &a))
                    .is_err()
            );
            assert_eq!(p.ah.sealed.as_ref().unwrap().as_bytes(), good.as_bytes());
        }
        let a = p.ah.authority.clone();
        let t = p.ah.ticket;
        let b = p.ah.binding.clone();
        let e = p.ah.epoch;
        let g = p.ah.generation;
        let good = p.ah.sealed.clone().unwrap();
        let mut pending = p.ah.pending.clone();
        pending[0].body.push(b' ');
        assert!(
            DurableMlsRoom::restore(b, e, g, &good, &pending, &access(&mut p.ah, &t, &a)).is_err()
        );
        p.a = restore(&mut p.ah);
        assert_eq!(
            p.a.pending_request(&access(&mut p.ah, &t, &a)).unwrap(),
            request
        );
    }

    #[test]
    fn exhausted_generation_and_future_gap_never_expose_a_mutated_handle() {
        let mut p = peers();
        p.a.generation = MAX_JSON_INTEGER;
        p.ah.generation = MAX_JSON_INTEGER;
        let a = p.ah.authority.clone();
        let t = p.ah.ticket;
        assert_eq!(
            finish(p.a.prepare_send_and_persist(
                admitted(41),
                b"no generation wrap",
                &p.alice,
                &mut access(&mut p.ah, &t, &a)
            ))
            .unwrap_err(),
            DurableMlsError::Capacity
        );
        assert!(p.a.requires_restore());
        assert!(p.ah.pending.is_empty());
        let mut p = peers();
        let mut a = p.bh.authority.clone();
        a.epoch += 65;
        p.bh.authority = a.clone();
        let t = p.bh.ticket;
        let b = p.bh.binding.clone();
        let e = p.bh.epoch;
        let g = p.bh.generation;
        let sealed = p.bh.sealed.clone().unwrap();
        assert!(
            DurableMlsRoom::restore(b, e, g, &sealed, &[], &access(&mut p.bh, &t, &a)).is_err()
        );
    }

    #[test]
    fn exact_consumed_welcome_anchor_is_required_before_upgrade_and_after_restart() {
        let (mut alice, mut ad) = fixture(10);
        let (mut bob, mut bd) = fixture(11);
        let kp = package(&mut bob, &mut bd);
        let mut a = create(&mut alice, &mut ad);
        let both = roster(&[&alice, &bob]);
        a.replace_authorised_roster(both.keys()).unwrap();
        let bundle = a.add_member(kp.as_bytes(), &bob.device_key()).unwrap();
        let core = Rc::new(RefCell::new(Core {
            events: Vec::new(),
            epoch: 1,
            roster: both.clone(),
            eligible: both.clone(),
            outcomes: BTreeMap::new(),
        }));
        core.borrow_mut().append(
            &binding(&alice),
            DurableMlsEnvelopeKind::Commit,
            bundle.commit,
            None,
            false,
        );
        let welcome = core.borrow_mut().append(
            &binding(&alice),
            DurableMlsEnvelopeKind::Commit,
            bundle.welcome.unwrap(),
            Some(bob.admitted_id().unwrap().clone()),
            true,
        );
        bd.store.captured = Some(welcome.anchor());
        let initial = finish(bob.join_and_persist(
            PendingMlsWelcome {
                package: kp.id(),
                scope: room(1),
                expected_epoch: 1,
                welcome: &welcome.wire,
                authorised: both.keys(),
            },
            MlsDeviceWrappingKeys {
                device: &bd.vault_key,
                room: &bd.room_key,
            },
            &mut bd.store,
        ))
        .unwrap();
        let auth = DurableMlsAuthority {
            epoch: 1,
            room_roster: both.clone(),
            eligible: both.clone(),
            rekey_required: false,
        };
        let record = &bd.store.rooms[&room(1).room().to_string()];
        let mut host = Host::new(binding(&bob), auth.clone(), record, bd.room_key, core);
        let t = host.ticket;
        let bind = host.binding.clone();
        let mut wrong = welcome.anchor();
        if let DurableMlsInitialCursor::Welcome {
            sequence, digest, ..
        } = &mut wrong
        {
            *sequence = 100;
            digest[0] ^= 1;
        }
        assert!(finish(DurableMlsRoom::adopt_initial_and_persist(
            initial,
            bind.clone(),
            wrong,
            &mut access(&mut host, &t, &auth)
        ))
        .is_err());
        assert_eq!(host.generation, 1);
        assert!(host.sealed.is_none());
        let initial = OpenMlsSession::restore_checkpoint(
            room(1),
            bob.device_key(),
            1,
            1,
            both.keys(),
            &record.sealed,
            &bd.room_key,
        )
        .unwrap();
        let good = finish(DurableMlsRoom::adopt_initial_and_persist(
            initial,
            bind,
            welcome.anchor(),
            &mut access(&mut host, &t, &auth),
        ))
        .unwrap();
        assert_eq!(good.cursor(), welcome.item.sequence);
        drop(good);
        let restored = restore(&mut host);
        assert_eq!(restored.initial, welcome.anchor());
        assert_eq!(restored.cursor(), welcome.item.sequence);
    }

    #[test]
    fn independent_nested_generations_survive_outer_receipt_retirement() {
        let (mut p, before, marker) = accepted_race();
        let d = consume(&mut p.a, &mut p.ah, &before).unwrap().unwrap();
        let generation =
            p.a.pending
                .as_ref()
                .unwrap()
                .historical
                .as_ref()
                .unwrap()
                .generation;
        discard(&mut p.a, &mut p.ah, d.logical_id());
        assert!(p.a.generation() > generation);
        p.a = restore(&mut p.ah);
        assert_eq!(
            p.a.pending
                .as_ref()
                .unwrap()
                .historical
                .as_ref()
                .unwrap()
                .generation,
            generation
        );
        consume(&mut p.a, &mut p.ah, &marker).unwrap();
        assert!(p.a.pending.is_none());
    }

    #[test]
    fn ordinary_peer_catchup_can_verify_a_departed_historical_sender() {
        let mut p = peers();
        let (mut charlie, mut cd) = fixture(12);
        let kp = package(&mut charlie, &mut cd);
        let triple = roster(&[&p.alice, &p.bob, &charlie]);
        p.core.borrow_mut().eligible = triple.clone();
        let mut old = p.ah.authority.clone();
        old.eligible = triple.clone();
        p.ah.authority = old.clone();
        let t = p.ah.ticket;
        let add = finish(p.a.prepare_commit_and_persist(
            admitted(42),
            DurableMlsChange::Add {
                key_package: kp.as_bytes(),
                device: charlie.admitted_id().unwrap().clone(),
                key: charlie.device_key(),
            },
            &p.alice,
            &mut access(&mut p.ah, &t, &old),
        ))
        .unwrap();
        let add_marker = p.core.borrow_mut().commit(&add, &p.ah.binding);
        let middle = DurableMlsAuthority {
            epoch: 2,
            room_roster: triple.clone(),
            eligible: triple.clone(),
            rekey_required: false,
        };
        p.ah.authority = middle.clone();
        resolve(&mut p.a, &mut p.ah, &add, &add_marker);
        consume(&mut p.a, &mut p.ah, &add_marker).unwrap();
        let welcome = p
            .core
            .borrow()
            .events
            .iter()
            .find(|e| e.welcome && e.recipient.as_ref() == charlie.admitted_id())
            .unwrap()
            .clone();
        cd.store.captured = Some(welcome.anchor());
        let cs = finish(charlie.join_and_persist(
            PendingMlsWelcome {
                package: kp.id(),
                scope: room(1),
                expected_epoch: 2,
                welcome: &welcome.wire,
                authorised: triple.keys(),
            },
            MlsDeviceWrappingKeys {
                device: &cd.vault_key,
                room: &cd.room_key,
            },
            &mut cd.store,
        ))
        .unwrap();
        let mut ch = Host::new(
            binding(&charlie),
            middle.clone(),
            &cd.store.rooms[&room(1).room().to_string()],
            cd.room_key,
            p.core.clone(),
        );
        let ct = ch.ticket;
        let cb = ch.binding.clone();
        let ca = ch.initial.clone();
        let mut c = finish(DurableMlsRoom::adopt_initial_and_persist(
            cs,
            cb,
            ca,
            &mut access(&mut ch, &ct, &middle),
        ))
        .unwrap();
        let cm = prepare(
            &mut c,
            &mut ch,
            &charlie,
            admitted(43),
            b"historically authenticated Charlie",
        );
        let historical = p.core.borrow_mut().application(&cm, &ch.binding);
        let both = roster(&[&p.alice, &p.bob]);
        p.core.borrow_mut().eligible = both.clone();
        let removal = DurableMlsAuthority {
            epoch: 2,
            room_roster: both.clone(),
            eligible: both.clone(),
            rekey_required: true,
        };
        p.ah.authority = removal.clone();
        let ids = [charlie.admitted_id().unwrap().clone()];
        let remove = finish(p.a.prepare_commit_and_persist(
            admitted(44),
            DurableMlsChange::Remove { devices: &ids },
            &p.alice,
            &mut access(&mut p.ah, &t, &removal),
        ))
        .unwrap();
        let removed = p.core.borrow_mut().commit(&remove, &p.ah.binding);
        let current = DurableMlsAuthority {
            epoch: 3,
            room_roster: both.clone(),
            eligible: both,
            rekey_required: false,
        };
        p.ah.authority = current.clone();
        p.bh.authority = current;
        resolve(&mut p.a, &mut p.ah, &remove, &removed);
        consume(&mut p.a, &mut p.ah, &historical).unwrap();
        consume(&mut p.a, &mut p.ah, &removed).unwrap();
        p.b = restore(&mut p.bh);
        assert!(p.b.is_catching_up());
        consume(&mut p.b, &mut p.bh, &add_marker).unwrap();
        assert_eq!(
            consume(&mut p.b, &mut p.bh, &historical)
                .unwrap()
                .unwrap()
                .body(),
            b"historically authenticated Charlie"
        );
        p.b = restore(&mut p.bh);
        consume(&mut p.b, &mut p.bh, &removed).unwrap();
        assert!(!p.b.is_catching_up());
        let (_, later) = send(&mut p, admitted(45), b"after Charlie removal");
        assert_eq!(
            consume(&mut p.b, &mut p.bh, &later)
                .unwrap()
                .unwrap()
                .body(),
            b"after Charlie removal"
        );
        let old_header = MlsCiphertextEnvelope {
            algorithm: CryptoAlgorithm::OpenMlsDraft,
            channel_id: room(1).room(),
            epoch: c.epoch(),
            sender_device_key: p.alice.device_key(),
            ciphertext: later.wire,
        };
        assert!(c.session.open(&old_header).is_err());
    }

    #[test]
    fn initial_anchor_upgrade_uncertainty_uses_the_authoritative_record_format() {
        for mode in [
            WriteMode::Abort,
            WriteMode::CommitPending,
            WriteMode::OrderLost,
        ] {
            let (mut device, mut dh) = fixture(10);
            let initial = create(&mut device, &mut dh);
            let one = roster(&[&device]);
            let core = Rc::new(RefCell::new(Core {
                events: Vec::new(),
                epoch: 0,
                roster: one.clone(),
                eligible: one.clone(),
                outcomes: BTreeMap::new(),
            }));
            let a = DurableMlsAuthority {
                epoch: 0,
                room_roster: one.clone(),
                eligible: one.clone(),
                rekey_required: false,
            };
            let record = &dh.store.rooms[&room(1).room().to_string()];
            let mut host = Host::new(binding(&device), a.clone(), record, dh.room_key, core);
            host.mode = mode;
            let t = host.ticket;
            let bind = host.binding.clone();
            let mut ctx = access(&mut host, &t, &a);
            let f = DurableMlsRoom::adopt_initial_and_persist(
                initial,
                bind.clone(),
                DurableMlsInitialCursor::Creator,
                &mut ctx,
            );
            if matches!(mode, WriteMode::CommitPending) {
                cancel(f, || {});
            } else {
                assert!(finish(f).is_err());
            }
            host.mode = WriteMode::Normal;
            if host.generation == 1 {
                let initial = OpenMlsSession::restore_checkpoint(
                    room(1),
                    device.device_key(),
                    0,
                    1,
                    one.keys(),
                    &record.sealed,
                    &dh.room_key,
                )
                .unwrap();
                finish(DurableMlsRoom::adopt_initial_and_persist(
                    initial,
                    bind,
                    DurableMlsInitialCursor::Creator,
                    &mut access(&mut host, &t, &a),
                ))
                .unwrap();
            } else {
                let room = restore(&mut host);
                assert_eq!(room.cursor(), 0);
                assert_eq!(room.initial, DurableMlsInitialCursor::Creator);
            }
        }
    }

    #[test]
    fn retained_marker_survives_history_churn_and_old_snapshot_authentication_is_required() {
        let (mut p, before, marker) = accepted_race();
        for index in 0..MAX_HISTORY + 1 {
            p.a.retire_record(Retired {
                logical: None,
                epoch: 1,
                wire: hash(&index.to_be_bytes()).unwrap(),
                sender: p.alice.device_key(),
                sender_device: p.ah.binding.device.clone(),
                kind: DurableMlsEnvelopeKind::Commit,
                transport: None,
                intent: None,
                cache: None,
            });
        }
        assert_eq!(p.a.retired.len(), MAX_HISTORY);
        assert!(p.a.pending.as_ref().unwrap().resolution.is_some());
        assert_eq!(
            p.a.encoded_size(MAX_INNER).unwrap_err(),
            DurableMlsError::Capacity
        );
        let old = p.a.pending.as_mut().unwrap().historical.as_mut().unwrap();
        old.generation += 1;
        let bad = p.a.encode(p.ah.generation, &p.ah.wrapping_key).unwrap();
        let a = p.ah.authority.clone();
        let t = p.ah.ticket;
        let b = p.ah.binding.clone();
        let e = p.ah.epoch;
        let g = p.ah.generation;
        let external = p.ah.pending.clone();
        let good = p.ah.sealed.clone().unwrap();
        assert!(
            DurableMlsRoom::restore(b, e, g, &bad, &external, &access(&mut p.ah, &t, &a)).is_err()
        );
        assert_eq!(p.ah.sealed.as_ref().unwrap().as_bytes(), good.as_bytes());
        p.a = restore(&mut p.ah);
        consume(&mut p.a, &mut p.ah, &before).unwrap();
        consume(&mut p.a, &mut p.ah, &marker).unwrap();
        assert!(p.a.pending.is_none());
    }

    #[test]
    fn accepted_core_lost_ack_unknown_transition_drains_old_text_without_publishing_new_crypto() {
        let mut p = peers();
        let prior = prepare(
            &mut p.b,
            &mut p.bh,
            &p.bob,
            admitted(41),
            b"old text before lost acknowledgement",
        );
        let before = p.core.borrow_mut().application(&prior, &p.bh.binding);
        ack(&mut p.b, &mut p.bh, &prior, &before);
        // Core has genuinely accepted the rotation, but the local controller
        // receives no outcome and restarts with its persisted Unknown branch.
        let (rotation, marker) = rotate(&mut p, admitted(42));
        p.a = restore(&mut p.ah);
        assert!(p.a.pending.as_ref().unwrap().resolution.is_none());
        assert_eq!(p.a.epoch(), marker.item.epoch);
        let initial_cursor = p.a.cursor();
        let a = p.ah.authority.clone();
        let t = p.ah.ticket;
        let attempts = p.ah.attempts;
        assert_eq!(
            finish(p.a.prepare_send_and_persist(
                admitted(43),
                b"no new crypto while unknown",
                &p.alice,
                &mut access(&mut p.ah, &t, &a)
            ))
            .unwrap_err(),
            DurableMlsError::PendingRequest
        );
        assert_eq!(
            finish(p.a.prepare_commit_and_persist(
                admitted(43),
                DurableMlsChange::Rotate,
                &p.alice,
                &mut access(&mut p.ah, &t, &a)
            ))
            .unwrap_err(),
            DurableMlsError::PendingRequest
        );
        assert_eq!(
            p.a.pending_request(&access(&mut p.ah, &t, &a)),
            Err(DurableMlsError::RecoveryRequired)
        );
        assert_eq!(p.ah.attempts, attempts);
        assert_eq!(p.a.cursor(), initial_cursor);
        let delivery = consume(&mut p.a, &mut p.ah, &before).unwrap().unwrap();
        assert_eq!(delivery.body(), b"old text before lost acknowledgement");
        assert_eq!(p.a.cursor(), before.item.sequence);
        assert!(p.a.pending.as_ref().unwrap().resolution.is_none());
        p.a = restore(&mut p.ah);
        let generation = p.ah.generation;
        let attempts = p.ah.attempts;
        let sealed = p.ah.sealed.clone().unwrap();
        assert_eq!(
            consume(&mut p.a, &mut p.ah, &marker).unwrap_err(),
            DurableMlsError::PendingRequest
        );
        assert_eq!(p.a.cursor(), before.item.sequence);
        assert_eq!(p.ah.generation, generation);
        assert_eq!(p.ah.attempts, attempts);
        assert_eq!(p.ah.sealed.as_ref().unwrap().as_bytes(), sealed.as_bytes());
        assert!(!p.a.requires_restore());
        assert_eq!(
            p.a.pending_request(&access(&mut p.ah, &t, &a)),
            Err(DurableMlsError::RecoveryRequired)
        );
        // Fresh external immutable Core evidence now resolves the exact request;
        // neither the saved Unknown metadata nor a bare status supplied it.
        resolve(&mut p.a, &mut p.ah, &rotation, &marker);
        consume(&mut p.a, &mut p.ah, &marker).unwrap();
        assert!(p.a.pending.is_none());
        assert_eq!(p.a.cursor(), marker.item.sequence);
        let recovered = p.a.recover_deliveries(&access(&mut p.ah, &t, &a)).unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].logical_id(), delivery.logical_id());
        assert_eq!(recovered[0].body(), delivery.body());
        consume(&mut p.b, &mut p.bh, &before).unwrap();
        consume(&mut p.b, &mut p.bh, &marker).unwrap();
        let (_, target) = send(
            &mut p,
            admitted(43),
            b"real target after outcome resolution",
        );
        assert_eq!(
            consume(&mut p.b, &mut p.bh, &target)
                .unwrap()
                .unwrap()
                .body(),
            b"real target after outcome resolution"
        );
    }

    #[test]
    fn exact_outcome_digest_operation_and_marker_negatives_never_reconcile_or_cas() {
        let mut p = peers();
        let (rotation, marker) = rotate(&mut p, admitted(42));
        p.a = restore(&mut p.ah);
        let a = p.ah.authority.clone();
        let t = p.ah.ticket;
        let generation = p.ah.generation;
        let attempts = p.ah.attempts;
        let cursor = p.a.cursor();
        let saved = p.ah.sealed.clone().unwrap();
        let authentic = p.core.borrow().outcomes[rotation.operation_id()].clone();
        // Inject a mismatched external assertion; do not rewrite KDR1 metadata.
        let mut wrong_digest = authentic.clone();
        wrong_digest.facts.body_digest[0] ^= 1;
        p.core
            .borrow_mut()
            .outcomes
            .insert(rotation.operation.clone(), wrong_digest);
        assert_eq!(
            finish(p.a.reconcile_request_and_persist(
                rotation.operation_id(),
                DurableMlsOutcome::CommitAccepted {
                    envelope: marker.item.envelope.clone(),
                    sequence: marker.item.sequence,
                    epoch: marker.item.epoch
                },
                &mut access(&mut p.ah, &t, &a)
            ))
            .unwrap_err(),
            DurableMlsError::ContextChanged
        );
        p.core
            .borrow_mut()
            .outcomes
            .insert(rotation.operation.clone(), authentic.clone());
        let mut wrong_ticket = access(&mut p.ah, &t, &a);
        wrong_ticket.outcome_ticket = Some(OutcomeTicket {
            context: t,
            operation: admitted(40),
        });
        assert_eq!(
            finish(p.a.reconcile_request_and_persist(
                rotation.operation_id(),
                DurableMlsOutcome::CommitAccepted {
                    envelope: marker.item.envelope.clone(),
                    sequence: marker.item.sequence,
                    epoch: marker.item.epoch
                },
                &mut wrong_ticket
            ))
            .unwrap_err(),
            DurableMlsError::ContextChanged
        );
        assert_eq!(
            finish(p.a.reconcile_request_and_persist(
                rotation.operation_id(),
                DurableMlsOutcome::CommitAccepted {
                    envelope: admitted(220),
                    sequence: marker.item.sequence,
                    epoch: marker.item.epoch
                },
                &mut access(&mut p.ah, &t, &a)
            ))
            .unwrap_err(),
            DurableMlsError::ContextChanged
        );
        // The same own ciphertext cannot attest a distinct canonical winner.
        let equal_wire = DurableMlsCommitMarker {
            item: marker.item.clone(),
            roster: authentic.facts.target.clone(),
        };
        assert_eq!(
            finish(p.a.reconcile_request_and_persist(
                rotation.operation_id(),
                DurableMlsOutcome::CommitNotAccepted { winner: equal_wire },
                &mut access(&mut p.ah, &t, &a)
            ))
            .unwrap_err(),
            DurableMlsError::InvalidInput
        );
        assert!(p.a.pending.as_ref().unwrap().resolution.is_none());
        assert!(!p.a.requires_restore());
        assert_eq!(p.ah.attempts, attempts);
        assert_eq!(p.ah.generation, generation);
        assert_eq!(p.a.cursor(), cursor);
        assert_eq!(p.ah.sealed.as_ref().unwrap().as_bytes(), saved.as_bytes());
        assert_eq!(p.ah.pending.len(), 1);
        assert_eq!(p.ah.pending[0].body(), rotation.body());
        resolve(&mut p.a, &mut p.ah, &rotation, &marker);
        let accepted = p.a.pending.as_ref().unwrap().resolution.clone();
        let generation = p.ah.generation;
        let attempts = p.ah.attempts;
        let saved = p.ah.sealed.clone().unwrap();
        // A conflicting assertion cannot overwrite a previously exact acceptance.
        assert_eq!(
            finish(p.a.reconcile_request_and_persist(
                rotation.operation_id(),
                DurableMlsOutcome::CommitAccepted {
                    envelope: admitted(221),
                    sequence: marker.item.sequence,
                    epoch: marker.item.epoch
                },
                &mut access(&mut p.ah, &t, &a)
            ))
            .unwrap_err(),
            DurableMlsError::RecoveryRequired
        );
        assert_eq!(p.a.pending.as_ref().unwrap().resolution, accepted);
        assert!(!p.a.requires_restore());
        assert_eq!(p.ah.attempts, attempts);
        assert_eq!(p.ah.generation, generation);
        assert_eq!(p.a.cursor(), cursor);
        assert_eq!(p.ah.sealed.as_ref().unwrap().as_bytes(), saved.as_bytes());
        consume(&mut p.a, &mut p.ah, &marker).unwrap();
        consume(&mut p.b, &mut p.bh, &marker).unwrap();
        assert!(p.a.pending.is_none());
        let (_, target) = send(
            &mut p,
            admitted(43),
            b"genuine state after binding refusals",
        );
        assert_eq!(
            consume(&mut p.b, &mut p.bh, &target)
                .unwrap()
                .unwrap()
                .body(),
            b"genuine state after binding refusals"
        );
    }
}
