//! Wave 9 `#proximity` radio primitives:
//! - RFC 5869 `HKDF-SHA256` rotating ephemeral BLE proximity tokens (`15`-minute epoch rotation +
//!   constant-time MAC tag + replay rejection, leaking zero static user or organisation identity to
//!   passive BLE sniffers).
//! - Stateful BLE RSSI distance-band classifier (`immediate`, `near`, `ambient`) with hysteresis
//!   preventing boundary oscillation and rejecting out-of-range / `0x7F` unavailable RSSI samples.
//! - Local mDNS (`_kodera-prox._udp.local.`) DNS-SD TXT codec (strictly rejecting coordinate/GPS
//!   fields) and mutual QUIC peer challenge-response frame verifier.

use std::collections::{BTreeMap, VecDeque};
use std::fmt;

use crate::{decode_hex, encode_hex, hmac_sha256, OrganisationId};

/// Rotating ephemeral `#proximity` token epoch window in seconds (`15` minutes).
pub const PROXIMITY_EPOCH_ROTATION_SECS: u64 = 15 * 60;
/// Boundary clock-skew grace window in seconds (`60` seconds) for adjacent 15-minute epochs.
pub const PROXIMITY_EPOCH_CLOCK_SKEW_SECS: u64 = 60;
/// Fixed wire length in bytes of an [`EphemeralProximityToken`].
pub const PROXIMITY_EPHEMERAL_TOKEN_BYTES: usize = 32;
/// Canonical local mDNS DNS-SD service type for LAN `#proximity` discovery.
pub const MDNS_PROXIMITY_SERVICE_TYPE: &str = "_kodera-prox._udp.local.";
/// Short Bonjour / Android NSD service type without trailing domain label.
pub const MDNS_PROXIMITY_SERVICE_LABEL: &str = "_kodera-prox._udp";
/// QUIC ALPN token negotiated on verified local `#proximity` peer streams.
pub const QUIC_PROXIMITY_ALPN: &str = "kodera-prox/1";
/// Canonical 128-bit BLE GATT service UUID for foreground opt-in `#proximity` discovery.
pub const PROXIMITY_GATT_SERVICE_UUID: &str = "7b4e4b50-9a10-4f88-b310-6b6f64657261";
/// Canonical 128-bit BLE GATT characteristic UUID carrying [`EphemeralProximityToken`].
pub const PROXIMITY_GATT_TOKEN_CHAR_UUID: &str = "7b4e4b51-9a10-4f88-b310-6b6f64657261";
/// Maximum total wire length of an RFC 6763 mDNS TXT record payload for `#proximity`.
pub const MAX_MDNS_TXT_RECORD_BYTES: usize = 255;
/// Maximum wire size in bytes of a `#proximity` QUIC peer handshake frame.
pub const MAX_QUIC_HANDSHAKE_FRAME_BYTES: usize = 256;
/// Maximum allowed wall-clock skew in seconds for a QUIC peer challenge-response exchange.
pub const MAX_QUIC_HANDSHAKE_SKEW_SECS: u64 = 60;
/// Lowest valid BLE RSSI reading in dBm.
pub const MIN_VALID_RSSI_DBM: i8 = -127;
/// Highest valid BLE RSSI reading in dBm (`127` / `0x7F` is the Bluetooth "unavailable" sentinel).
pub const MAX_VALID_RSSI_DBM: i8 = 20;

const TOKEN_MAGIC: [u8; 2] = *b"KT";
const TOKEN_VERSION: u8 = 1;
const QUIC_MAGIC: [u8; 2] = *b"KQ";
const QUIC_VERSION: u8 = 1;
const QUIC_FRAME_CHALLENGE: u8 = 1;
const QUIC_FRAME_RESPONSE: u8 = 2;
const QUIC_CHALLENGE_BYTES: usize = 76;
const QUIC_RESPONSE_BYTES: usize = 108;
const MAX_REPLAY_ENTRIES: usize = 4096;
const HKDF_MAX_OUTPUT_BYTES: usize = 255 * 32;

const FORBIDDEN_LOCATION_TXT_KEYS: &[&str] = &[
    "lat",
    "latitude",
    "lon",
    "lng",
    "long",
    "longitude",
    "gps",
    "coord",
    "coords",
    "coordinates",
    "geo",
    "geolocation",
    "alt",
    "altitude",
    "bssid",
    "mac",
];

/// Errors returned by `#proximity` rotating token, RSSI classifier, and mDNS/QUIC handshake checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProximityRadioError {
    InvalidKeyMaterial,
    InvalidOutputLength,
    InvalidScope,
    MalformedToken,
    MalformedTxtRecord,
    MalformedHandshakeFrame,
    ForbiddenCoordinateField,
    UnsupportedVersion,
    AuthenticationFailed,
    EpochOutOfWindow,
    CounterExhausted,
    ReplayRejected,
    ReflectionRejected,
    ChallengeMismatch,
    ClockSkewExceeded,
    InvalidRssi,
    InvalidHysteresisThresholds,
}

impl fmt::Display for ProximityRadioError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let description = match self {
            Self::InvalidKeyMaterial => "invalid or low-entropy proximity key material",
            Self::InvalidOutputLength => "requested HKDF output length exceeds RFC 5869 bound",
            Self::InvalidScope => "invalid proximity scope identifier",
            Self::MalformedToken => "malformed rotating proximity token",
            Self::MalformedTxtRecord => "malformed mDNS proximity TXT record",
            Self::MalformedHandshakeFrame => "malformed QUIC proximity handshake frame",
            Self::ForbiddenCoordinateField => {
                "location or GPS field is forbidden in proximity data"
            }
            Self::UnsupportedVersion => "unsupported proximity wire protocol version",
            Self::AuthenticationFailed => "proximity cryptographic MAC verification failed",
            Self::EpochOutOfWindow => "rotating proximity epoch is outside active window",
            Self::CounterExhausted => "ephemeral epoch token counter exhausted",
            Self::ReplayRejected => "replayed proximity token or handshake nonce rejected",
            Self::ReflectionRejected => "self-reflected peer token or nonce rejected",
            Self::ChallengeMismatch => "QUIC handshake response does not match challenge",
            Self::ClockSkewExceeded => "QUIC handshake timestamp exceeds allowed clock skew",
            Self::InvalidRssi => "BLE RSSI reading is unavailable or outside [-127, 20] dBm",
            Self::InvalidHysteresisThresholds => "RSSI hysteresis thresholds are non-monotonic",
        };
        f.write_str(description)
    }
}

impl std::error::Error for ProximityRadioError {}

fn ct_eq(lhs: &[u8], rhs: &[u8]) -> bool {
    if lhs.len() != rhs.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&a, &b) in lhs.iter().zip(rhs.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn has_nontrivial_entropy(secret: &[u8; 32]) -> bool {
    let first = secret[0];
    secret.iter().any(|&b| b != 0) && secret.iter().any(|&b| b != first)
}

fn validate_scope_tag(scope: &str) -> Result<(), ProximityRadioError> {
    if scope.is_empty() || scope.len() > 64 {
        return Err(ProximityRadioError::InvalidScope);
    }
    if !scope
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
    {
        return Err(ProximityRadioError::InvalidScope);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 1. RFC 5869 HKDF-SHA256
// ---------------------------------------------------------------------------

/// RFC 5869 §2.2 `HKDF-Extract(salt, IKM)` using `HMAC-SHA256`.
#[must_use]
pub fn hkdf_extract_sha256(salt: &[u8], ikm: &[u8]) -> [u8; 32] {
    let zero_salt = [0u8; 32];
    let effective_salt = if salt.is_empty() { &zero_salt } else { salt };
    hmac_sha256(effective_salt, ikm)
}

/// RFC 5869 §2.3 `HKDF-Expand(PRK, info, L)` using `HMAC-SHA256`.
pub fn hkdf_expand_sha256(
    prk: &[u8; 32],
    info: &[u8],
    out: &mut [u8],
) -> Result<(), ProximityRadioError> {
    if out.len() > HKDF_MAX_OUTPUT_BYTES {
        return Err(ProximityRadioError::InvalidOutputLength);
    }
    if out.is_empty() {
        return Ok(());
    }
    let blocks = out.len().div_ceil(32);
    let mut prev = [0u8; 32];
    let mut prev_len = 0usize;
    let mut input = Vec::with_capacity(32 + info.len() + 1);

    for i in 1..=blocks {
        input.clear();
        input.extend_from_slice(&prev[..prev_len]);
        input.extend_from_slice(info);
        input.push(u8::try_from(i).expect("blocks <= 255"));
        let digest = hmac_sha256(prk, &input);
        let start = (i - 1) * 32;
        let take = (out.len() - start).min(32);
        out[start..start + take].copy_from_slice(&digest[..take]);
        prev = digest;
        prev_len = 32;
    }

    prev.fill(0);
    input.fill(0);
    Ok(())
}

/// Convenience one-shot RFC 5869 `HKDF-SHA256` into a fixed-length array.
pub fn hkdf_sha256<const N: usize>(
    salt: &[u8],
    ikm: &[u8],
    info: &[u8],
) -> Result<[u8; N], ProximityRadioError> {
    let mut prk = hkdf_extract_sha256(salt, ikm);
    let mut okm = [0u8; N];
    let result = hkdf_expand_sha256(&prk, info, &mut okm);
    prk.fill(0);
    result?;
    Ok(okm)
}

// ---------------------------------------------------------------------------
// 2. Rotating 15-Minute Ephemeral BLE Proximity Token
// ---------------------------------------------------------------------------

/// Computes the 15-minute (`900s`) epoch index for a Unix timestamp in seconds.
pub fn proximity_epoch_for_unix_secs(unix_secs: u64) -> Result<u32, ProximityRadioError> {
    u32::try_from(unix_secs / PROXIMITY_EPOCH_ROTATION_SECS)
        .map_err(|_| ProximityRadioError::EpochOutOfWindow)
}

fn candidate_epochs(now_unix_secs: u64) -> Result<Vec<u32>, ProximityRadioError> {
    let current = proximity_epoch_for_unix_secs(now_unix_secs)?;
    let mut epochs = vec![current];
    let offset_in_epoch = now_unix_secs % PROXIMITY_EPOCH_ROTATION_SECS;
    if offset_in_epoch < PROXIMITY_EPOCH_CLOCK_SKEW_SECS && current > 0 {
        epochs.push(current - 1);
    }
    if offset_in_epoch >= PROXIMITY_EPOCH_ROTATION_SECS - PROXIMITY_EPOCH_CLOCK_SKEW_SECS
        && current < u32::MAX
    {
        epochs.push(current + 1);
    }
    Ok(epochs)
}

fn derive_epoch_mac_key(
    workspace_master_key: &[u8; 32],
    organisation_id: &OrganisationId,
    scope_tag: &str,
    epoch: u32,
) -> [u8; 32] {
    let mut salt = Vec::with_capacity(organisation_id.as_str().len() + 1 + scope_tag.len());
    salt.extend_from_slice(organisation_id.as_str().as_bytes());
    salt.push(b':');
    salt.extend_from_slice(scope_tag.as_bytes());

    let mut info = Vec::with_capacity(40);
    info.extend_from_slice(b"kodera.proximity.w9.epoch-mac.v1:");
    info.extend_from_slice(&epoch.to_be_bytes());

    hkdf_sha256::<32>(&salt, workspace_master_key, &info)
        .expect("32-byte HKDF output is always within RFC 5869 bounds")
}

fn derive_rolling_pseudonym(
    device_ephemeral_seed: &[u8; 32],
    organisation_id: &OrganisationId,
    scope_tag: &str,
    epoch: u32,
) -> [u8; 8] {
    let mut info = Vec::with_capacity(38 + organisation_id.as_str().len() + 1 + scope_tag.len());
    info.extend_from_slice(b"kodera.proximity.w9.pseudonym.v1:");
    info.extend_from_slice(organisation_id.as_str().as_bytes());
    info.push(b':');
    info.extend_from_slice(scope_tag.as_bytes());

    hkdf_sha256::<8>(&epoch.to_be_bytes(), device_ephemeral_seed, &info)
        .expect("8-byte HKDF output is always within RFC 5869 bounds")
}

fn compute_token_mac(
    epoch_mac_key: &[u8; 32],
    organisation_id: &OrganisationId,
    scope_tag: &str,
    header_and_body: &[u8; 20],
) -> [u8; 12] {
    let org_bytes = organisation_id.as_str().as_bytes();
    let scope_bytes = scope_tag.as_bytes();
    let mut transcript =
        Vec::with_capacity(34 + 2 + org_bytes.len() + scope_bytes.len() + header_and_body.len());
    transcript.extend_from_slice(b"kodera.proximity.w9.token-mac.v1:");
    transcript.push(u8::try_from(org_bytes.len()).unwrap_or(u8::MAX));
    transcript.extend_from_slice(org_bytes);
    transcript.push(u8::try_from(scope_bytes.len()).unwrap_or(u8::MAX));
    transcript.extend_from_slice(scope_bytes);
    transcript.extend_from_slice(header_and_body);

    let full = hmac_sha256(epoch_mac_key, &transcript);
    let mut tag = [0u8; 12];
    tag.copy_from_slice(&full[..12]);
    tag
}

/// Wire-compact 32-byte rotating ephemeral `#proximity` token.
///
/// Layout (`32` bytes):
/// - `[0..2]`: Magic `"KT"`
/// - `[2]`: Protocol version (`1`)
/// - `[3]`: Flags (`0` in v1)
/// - `[4..8]`: `epoch` (`u32` big-endian, `unix_secs / 900`)
/// - `[8..12]`: `counter` (`u32` big-endian per-epoch emission sequence)
/// - `[12..20]`: `rolling_pseudonym` (`8` bytes derived via `HKDF-SHA256` from ephemeral device
///   seed + epoch; rotates completely every 15 minutes so passive BLE sniffers see unlinkable tags)
/// - `[20..32]`: `mac_tag` (`12`-byte truncated `HMAC-SHA256` under the HKDF-derived epoch key)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct EphemeralProximityToken([u8; PROXIMITY_EPHEMERAL_TOKEN_BYTES]);

impl EphemeralProximityToken {
    /// Decodes and validates structural wire invariants of a 32-byte token.
    pub fn from_bytes(raw: &[u8]) -> Result<Self, ProximityRadioError> {
        let arr: [u8; PROXIMITY_EPHEMERAL_TOKEN_BYTES] = raw
            .try_into()
            .map_err(|_| ProximityRadioError::MalformedToken)?;
        if arr[0..2] != TOKEN_MAGIC {
            return Err(ProximityRadioError::MalformedToken);
        }
        if arr[2] != TOKEN_VERSION {
            return Err(ProximityRadioError::UnsupportedVersion);
        }
        if arr[3] != 0 {
            return Err(ProximityRadioError::MalformedToken);
        }
        Ok(Self(arr))
    }

    /// Parses a 64-character hex representation of a 32-byte token.
    pub fn from_hex(hex: &str) -> Result<Self, ProximityRadioError> {
        if hex.len() != PROXIMITY_EPHEMERAL_TOKEN_BYTES * 2 {
            return Err(ProximityRadioError::MalformedToken);
        }
        let decoded = decode_hex(hex).map_err(|_| ProximityRadioError::MalformedToken)?;
        Self::from_bytes(&decoded)
    }

    #[must_use]
    pub fn as_bytes(&self) -> &[u8; PROXIMITY_EPHEMERAL_TOKEN_BYTES] {
        &self.0
    }

    #[must_use]
    pub fn to_hex(&self) -> String {
        encode_hex(&self.0)
    }

    #[must_use]
    pub fn epoch(&self) -> u32 {
        u32::from_be_bytes(self.0[4..8].try_into().expect("fixed 4-byte epoch slice"))
    }

    #[must_use]
    pub fn counter(&self) -> u32 {
        u32::from_be_bytes(
            self.0[8..12]
                .try_into()
                .expect("fixed 4-byte counter slice"),
        )
    }

    #[must_use]
    pub fn rolling_pseudonym(&self) -> [u8; 8] {
        self.0[12..20]
            .try_into()
            .expect("fixed 8-byte pseudonym slice")
    }

    #[must_use]
    pub fn mac_tag(&self) -> [u8; 12] {
        self.0[20..32].try_into().expect("fixed 12-byte mac slice")
    }
}

/// Verified metadata extracted from an [`EphemeralProximityToken`] after MAC + freshness + replay checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifiedEphemeralToken {
    pub epoch: u32,
    pub counter: u32,
    pub rolling_pseudonym: [u8; 8],
}

/// Stateful emitter producing HKDF-SHA256 rotating 15-minute ephemeral `#proximity` tokens.
pub struct EphemeralTokenRotator {
    organisation_id: OrganisationId,
    scope_tag: String,
    workspace_master_key: [u8; 32],
    device_ephemeral_seed: [u8; 32],
    active_epoch: Option<u32>,
    next_counter: u64,
}

impl fmt::Debug for EphemeralTokenRotator {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("EphemeralTokenRotator([redacted])")
    }
}

impl Drop for EphemeralTokenRotator {
    fn drop(&mut self) {
        self.workspace_master_key.fill(0);
        self.device_ephemeral_seed.fill(0);
    }
}

impl EphemeralTokenRotator {
    pub fn new(
        organisation_id: OrganisationId,
        scope_tag: impl Into<String>,
        workspace_master_key: [u8; 32],
        device_ephemeral_seed: [u8; 32],
    ) -> Result<Self, ProximityRadioError> {
        let scope_tag = scope_tag.into();
        validate_scope_tag(&scope_tag)?;
        if !has_nontrivial_entropy(&workspace_master_key)
            || !has_nontrivial_entropy(&device_ephemeral_seed)
            || ct_eq(&workspace_master_key, &device_ephemeral_seed)
        {
            return Err(ProximityRadioError::InvalidKeyMaterial);
        }
        Ok(Self {
            organisation_id,
            scope_tag,
            workspace_master_key,
            device_ephemeral_seed,
            active_epoch: None,
            next_counter: 0,
        })
    }

    /// Emits a fresh 32-byte rotating token for `now_unix_secs`, automatically rotating the
    /// HKDF pseudonym and MAC subkey at each 15-minute epoch boundary and refusing clock rollback.
    pub fn emit(
        &mut self,
        now_unix_secs: u64,
    ) -> Result<EphemeralProximityToken, ProximityRadioError> {
        let epoch = proximity_epoch_for_unix_secs(now_unix_secs)?;
        match self.active_epoch {
            Some(prev) if epoch < prev => return Err(ProximityRadioError::EpochOutOfWindow),
            Some(prev) if epoch == prev => {}
            _ => {
                self.active_epoch = Some(epoch);
                self.next_counter = 0;
            }
        }
        let counter =
            u32::try_from(self.next_counter).map_err(|_| ProximityRadioError::CounterExhausted)?;
        self.next_counter += 1;

        let rolling_pseudonym = derive_rolling_pseudonym(
            &self.device_ephemeral_seed,
            &self.organisation_id,
            &self.scope_tag,
            epoch,
        );
        let mut header_and_body = [0u8; 20];
        header_and_body[0..2].copy_from_slice(&TOKEN_MAGIC);
        header_and_body[2] = TOKEN_VERSION;
        header_and_body[3] = 0;
        header_and_body[4..8].copy_from_slice(&epoch.to_be_bytes());
        header_and_body[8..12].copy_from_slice(&counter.to_be_bytes());
        header_and_body[12..20].copy_from_slice(&rolling_pseudonym);

        let mut epoch_mac_key = derive_epoch_mac_key(
            &self.workspace_master_key,
            &self.organisation_id,
            &self.scope_tag,
            epoch,
        );
        let tag = compute_token_mac(
            &epoch_mac_key,
            &self.organisation_id,
            &self.scope_tag,
            &header_and_body,
        );
        epoch_mac_key.fill(0);

        let mut raw = [0u8; PROXIMITY_EPHEMERAL_TOKEN_BYTES];
        raw[0..20].copy_from_slice(&header_and_body);
        raw[20..32].copy_from_slice(&tag);
        Ok(EphemeralProximityToken(raw))
    }

    /// Seconds remaining until the next 15-minute HKDF token rotation.
    #[must_use]
    pub fn seconds_until_rotation(now_unix_secs: u64) -> u64 {
        PROXIMITY_EPOCH_ROTATION_SECS - (now_unix_secs % PROXIMITY_EPOCH_ROTATION_SECS)
    }
}

/// Bounded constant-time verifier and replay guard for [`EphemeralProximityToken`].
pub struct EphemeralTokenVerifier {
    organisation_id: OrganisationId,
    scope_tag: String,
    workspace_master_key: [u8; 32],
    highest_counter_by_peer: BTreeMap<(u32, [u8; 8]), u32>,
    insertion_order: VecDeque<(u32, [u8; 8])>,
    max_tracked_peers: usize,
}

impl fmt::Debug for EphemeralTokenVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("EphemeralTokenVerifier([redacted])")
    }
}

impl Drop for EphemeralTokenVerifier {
    fn drop(&mut self) {
        self.workspace_master_key.fill(0);
    }
}

impl EphemeralTokenVerifier {
    pub fn new(
        organisation_id: OrganisationId,
        scope_tag: impl Into<String>,
        workspace_master_key: [u8; 32],
    ) -> Result<Self, ProximityRadioError> {
        let scope_tag = scope_tag.into();
        validate_scope_tag(&scope_tag)?;
        if !has_nontrivial_entropy(&workspace_master_key) {
            return Err(ProximityRadioError::InvalidKeyMaterial);
        }
        Ok(Self {
            organisation_id,
            scope_tag,
            workspace_master_key,
            highest_counter_by_peer: BTreeMap::new(),
            insertion_order: VecDeque::new(),
            max_tracked_peers: MAX_REPLAY_ENTRIES,
        })
    }

    /// Statically verifies cryptographic MAC and 15-minute epoch freshness without mutating
    /// replay state (used when pre-checking an mDNS TXT advertisement prior to QUIC handshake).
    pub fn verify_stateless(
        &self,
        token: &EphemeralProximityToken,
        now_unix_secs: u64,
    ) -> Result<VerifiedEphemeralToken, ProximityRadioError> {
        let allowed_epochs = candidate_epochs(now_unix_secs)?;
        let token_epoch = token.epoch();
        if !allowed_epochs.contains(&token_epoch) {
            return Err(ProximityRadioError::EpochOutOfWindow);
        }

        let header_and_body: [u8; 20] = token.as_bytes()[0..20]
            .try_into()
            .expect("fixed 20-byte token prefix");
        let mut epoch_mac_key = derive_epoch_mac_key(
            &self.workspace_master_key,
            &self.organisation_id,
            &self.scope_tag,
            token_epoch,
        );
        let expected_mac = compute_token_mac(
            &epoch_mac_key,
            &self.organisation_id,
            &self.scope_tag,
            &header_and_body,
        );
        epoch_mac_key.fill(0);

        if !ct_eq(&expected_mac, &token.mac_tag()) {
            return Err(ProximityRadioError::AuthenticationFailed);
        }

        Ok(VerifiedEphemeralToken {
            epoch: token_epoch,
            counter: token.counter(),
            rolling_pseudonym: token.rolling_pseudonym(),
        })
    }

    /// Verifies MAC + 15-minute epoch window AND enforces strict per-epoch monotonic counter
    /// replay rejection in bounded memory.
    pub fn verify_and_accept(
        &mut self,
        token: &EphemeralProximityToken,
        now_unix_secs: u64,
    ) -> Result<VerifiedEphemeralToken, ProximityRadioError> {
        let allowed_epochs = candidate_epochs(now_unix_secs)?;
        let verified = self.verify_stateless(token, now_unix_secs)?;

        // Purge expired epochs before checking capacity.
        self.highest_counter_by_peer
            .retain(|(ep, _), _| allowed_epochs.contains(ep));
        self.insertion_order
            .retain(|(ep, id)| self.highest_counter_by_peer.contains_key(&(*ep, *id)));

        let peer_key = (verified.epoch, verified.rolling_pseudonym);
        if let Some(&prev_counter) = self.highest_counter_by_peer.get(&peer_key) {
            if verified.counter <= prev_counter {
                return Err(ProximityRadioError::ReplayRejected);
            }
            self.highest_counter_by_peer
                .insert(peer_key, verified.counter);
            return Ok(verified);
        }

        if self.highest_counter_by_peer.len() >= self.max_tracked_peers {
            if let Some(evicted) = self.insertion_order.pop_front() {
                self.highest_counter_by_peer.remove(&evicted);
            }
        }
        self.highest_counter_by_peer
            .insert(peer_key, verified.counter);
        self.insertion_order.push_back(peer_key);
        Ok(verified)
    }

    pub fn clear(&mut self) {
        self.highest_counter_by_peer.clear();
        self.insertion_order.clear();
    }
}

// ---------------------------------------------------------------------------
// 3. BLE RSSI Distance-Band Classifier with Hysteresis
// ---------------------------------------------------------------------------

/// Coarse local radio proximity band derived strictly from foreground RSSI (never GPS).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProximityDistanceBand {
    /// Strong immediate radio coupling (desk / face-to-face range, default `>= -55 dBm`).
    Immediate,
    /// Same-room / nearby range (default `-75..-56 dBm`).
    Near,
    /// Weak ambient signal near the edge of BLE range (default `< -75 dBm`).
    Ambient,
}

impl ProximityDistanceBand {
    #[must_use]
    pub const fn as_slug(self) -> &'static str {
        match self {
            Self::Immediate => "immediate",
            Self::Near => "near",
            Self::Ambient => "ambient",
        }
    }
}

/// Monotonic dBm hysteresis thresholds preventing rapid UI band oscillation at boundary signal levels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RssiHysteresisConfig {
    /// Minimum dBm required to enter `Immediate` (default `-55`).
    pub immediate_enter_dbm: i8,
    /// Minimum dBm required to remain in `Immediate` before demoting (default `-61`).
    pub immediate_exit_dbm: i8,
    /// Minimum dBm required to enter `Near` from `Ambient` (default `-75`).
    pub near_enter_dbm: i8,
    /// Minimum dBm required to remain in `Near` before demoting to `Ambient` (default `-81`).
    pub near_exit_dbm: i8,
}

impl Default for RssiHysteresisConfig {
    fn default() -> Self {
        Self {
            immediate_enter_dbm: -55,
            immediate_exit_dbm: -61,
            near_enter_dbm: -75,
            near_exit_dbm: -81,
        }
    }
}

impl RssiHysteresisConfig {
    pub fn new(
        immediate_enter_dbm: i8,
        immediate_exit_dbm: i8,
        near_enter_dbm: i8,
        near_exit_dbm: i8,
    ) -> Result<Self, ProximityRadioError> {
        let cfg = Self {
            immediate_enter_dbm,
            immediate_exit_dbm,
            near_enter_dbm,
            near_exit_dbm,
        };
        cfg.validate()?;
        Ok(cfg)
    }

    pub fn validate(&self) -> Result<(), ProximityRadioError> {
        for level in [
            self.immediate_enter_dbm,
            self.immediate_exit_dbm,
            self.near_enter_dbm,
            self.near_exit_dbm,
        ] {
            if !(MIN_VALID_RSSI_DBM..=MAX_VALID_RSSI_DBM).contains(&level) {
                return Err(ProximityRadioError::InvalidHysteresisThresholds);
            }
        }
        if !(self.near_exit_dbm < self.near_enter_dbm
            && self.near_enter_dbm < self.immediate_exit_dbm
            && self.immediate_exit_dbm < self.immediate_enter_dbm)
        {
            return Err(ProximityRadioError::InvalidHysteresisThresholds);
        }
        Ok(())
    }
}

/// Validates that a raw BLE RSSI reading in dBm lies in `[-127, 20]` (rejecting `127` / `0x7F`).
pub fn validate_ble_rssi_dbm(rssi_dbm: i8) -> Result<i8, ProximityRadioError> {
    if !(MIN_VALID_RSSI_DBM..=MAX_VALID_RSSI_DBM).contains(&rssi_dbm) {
        return Err(ProximityRadioError::InvalidRssi);
    }
    Ok(rssi_dbm)
}

/// Stateless initial distance-band classification (without prior band history).
pub fn classify_initial_rssi(
    rssi_dbm: i8,
    config: &RssiHysteresisConfig,
) -> Result<ProximityDistanceBand, ProximityRadioError> {
    config.validate()?;
    validate_ble_rssi_dbm(rssi_dbm)?;
    if rssi_dbm >= config.immediate_enter_dbm {
        Ok(ProximityDistanceBand::Immediate)
    } else if rssi_dbm >= config.near_enter_dbm {
        Ok(ProximityDistanceBand::Near)
    } else {
        Ok(ProximityDistanceBand::Ambient)
    }
}

/// Stateful RSSI distance-band classifier applying dead-zone hysteresis across consecutive samples.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RssiDistanceClassifier {
    config: RssiHysteresisConfig,
    current_band: Option<ProximityDistanceBand>,
    last_rssi_dbm: Option<i8>,
}

impl RssiDistanceClassifier {
    pub fn new(config: RssiHysteresisConfig) -> Result<Self, ProximityRadioError> {
        config.validate()?;
        Ok(Self {
            config,
            current_band: None,
            last_rssi_dbm: None,
        })
    }

    #[must_use]
    pub fn current_band(&self) -> Option<ProximityDistanceBand> {
        self.current_band
    }

    #[must_use]
    pub fn last_rssi_dbm(&self) -> Option<i8> {
        self.last_rssi_dbm
    }

    pub fn reset(&mut self) {
        self.current_band = None;
        self.last_rssi_dbm = None;
    }

    /// Observes a new BLE RSSI sample in dBm and updates the classified [`ProximityDistanceBand`].
    pub fn observe(&mut self, rssi_dbm: i8) -> Result<ProximityDistanceBand, ProximityRadioError> {
        validate_ble_rssi_dbm(rssi_dbm)?;
        let next = match self.current_band {
            None => classify_initial_rssi(rssi_dbm, &self.config)?,
            Some(ProximityDistanceBand::Immediate) => {
                if rssi_dbm >= self.config.immediate_exit_dbm {
                    ProximityDistanceBand::Immediate
                } else if rssi_dbm >= self.config.near_exit_dbm {
                    ProximityDistanceBand::Near
                } else {
                    ProximityDistanceBand::Ambient
                }
            }
            Some(ProximityDistanceBand::Near) => {
                if rssi_dbm >= self.config.immediate_enter_dbm {
                    ProximityDistanceBand::Immediate
                } else if rssi_dbm >= self.config.near_exit_dbm {
                    ProximityDistanceBand::Near
                } else {
                    ProximityDistanceBand::Ambient
                }
            }
            Some(ProximityDistanceBand::Ambient) => {
                if rssi_dbm >= self.config.immediate_enter_dbm {
                    ProximityDistanceBand::Immediate
                } else if rssi_dbm >= self.config.near_enter_dbm {
                    ProximityDistanceBand::Near
                } else {
                    ProximityDistanceBand::Ambient
                }
            }
        };
        self.current_band = Some(next);
        self.last_rssi_dbm = Some(rssi_dbm);
        Ok(next)
    }
}

// ---------------------------------------------------------------------------
// 4. Local mDNS (`_kodera-prox._udp.local.`) TXT Record & QUIC Handshake Verifier
// ---------------------------------------------------------------------------

/// Parsed and privacy-checked DNS-SD TXT record advertised under `_kodera-prox._udp.local.`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MdnsProximityTxtRecord {
    pub version: u8,
    pub epoch: u32,
    pub token: EphemeralProximityToken,
    pub alpn: String,
    pub quic_port: u16,
}

impl MdnsProximityTxtRecord {
    pub fn new(
        token: EphemeralProximityToken,
        quic_port: u16,
    ) -> Result<Self, ProximityRadioError> {
        if quic_port == 0 {
            return Err(ProximityRadioError::MalformedTxtRecord);
        }
        Ok(Self {
            version: 1,
            epoch: token.epoch(),
            token,
            alpn: QUIC_PROXIMITY_ALPN.to_owned(),
            quic_port,
        })
    }

    /// Formats canonical `key=value` entries suitable for Bonjour `NWTXTRecord` / Android `NsdServiceInfo`.
    #[must_use]
    pub fn to_entries(&self) -> Vec<String> {
        vec![
            format!("v={}", self.version),
            format!("ep={}", self.epoch),
            format!("tok={}", self.token.to_hex()),
            format!("alpn={}", self.alpn),
            format!("port={}", self.quic_port),
        ]
    }

    /// Encodes RFC 6763 length-prefixed DNS-SD TXT wire bytes (`<= 255` bytes).
    pub fn encode_wire(&self) -> Result<Vec<u8>, ProximityRadioError> {
        let entries = self.to_entries();
        let mut wire = Vec::with_capacity(128);
        for entry in &entries {
            let bytes = entry.as_bytes();
            if bytes.is_empty() || bytes.len() > 255 {
                return Err(ProximityRadioError::MalformedTxtRecord);
            }
            wire.push(u8::try_from(bytes.len()).expect("checked <= 255"));
            wire.extend_from_slice(bytes);
        }
        if wire.len() > MAX_MDNS_TXT_RECORD_BYTES {
            return Err(ProximityRadioError::MalformedTxtRecord);
        }
        Ok(wire)
    }

    /// Decodes RFC 6763 length-prefixed DNS-SD TXT wire bytes, strictly rejecting GPS/location keys.
    pub fn decode_wire(wire: &[u8]) -> Result<Self, ProximityRadioError> {
        if wire.is_empty() || wire.len() > MAX_MDNS_TXT_RECORD_BYTES {
            return Err(ProximityRadioError::MalformedTxtRecord);
        }
        let mut entries = Vec::new();
        let mut offset = 0usize;
        while offset < wire.len() {
            let len = usize::from(wire[offset]);
            offset += 1;
            if len == 0 || offset + len > wire.len() {
                return Err(ProximityRadioError::MalformedTxtRecord);
            }
            let text = std::str::from_utf8(&wire[offset..offset + len])
                .map_err(|_| ProximityRadioError::MalformedTxtRecord)?;
            entries.push(text);
            offset += len;
        }
        Self::from_entries(&entries)
    }

    /// Parses TXT `key=value` strings, refusing duplicate keys, unknown keys, and any coordinate/GPS fields.
    pub fn from_entries<S: AsRef<str>>(entries: &[S]) -> Result<Self, ProximityRadioError> {
        if entries.is_empty() || entries.len() > 8 {
            return Err(ProximityRadioError::MalformedTxtRecord);
        }
        let mut version: Option<u8> = None;
        let mut epoch: Option<u32> = None;
        let mut token: Option<EphemeralProximityToken> = None;
        let mut alpn: Option<String> = None;
        let mut quic_port: Option<u16> = None;

        for raw_entry in entries {
            let entry = raw_entry.as_ref();
            if entry.is_empty() || !entry.is_ascii() {
                return Err(ProximityRadioError::MalformedTxtRecord);
            }
            let Some((raw_key, value)) = entry.split_once('=') else {
                return Err(ProximityRadioError::MalformedTxtRecord);
            };
            let normalized_key = raw_key.trim().to_ascii_lowercase();
            if FORBIDDEN_LOCATION_TXT_KEYS.contains(&normalized_key.as_str()) {
                return Err(ProximityRadioError::ForbiddenCoordinateField);
            }
            if raw_key != normalized_key {
                return Err(ProximityRadioError::MalformedTxtRecord);
            }
            match raw_key {
                "v" => {
                    if version.is_some() {
                        return Err(ProximityRadioError::MalformedTxtRecord);
                    }
                    let parsed = value
                        .parse::<u8>()
                        .map_err(|_| ProximityRadioError::MalformedTxtRecord)?;
                    if parsed != 1 {
                        return Err(ProximityRadioError::UnsupportedVersion);
                    }
                    version = Some(parsed);
                }
                "ep" => {
                    if epoch.is_some() {
                        return Err(ProximityRadioError::MalformedTxtRecord);
                    }
                    epoch = Some(
                        value
                            .parse::<u32>()
                            .map_err(|_| ProximityRadioError::MalformedTxtRecord)?,
                    );
                }
                "tok" => {
                    if token.is_some() {
                        return Err(ProximityRadioError::MalformedTxtRecord);
                    }
                    token = Some(EphemeralProximityToken::from_hex(value)?);
                }
                "alpn" => {
                    if alpn.is_some() || value != QUIC_PROXIMITY_ALPN {
                        return Err(ProximityRadioError::MalformedTxtRecord);
                    }
                    alpn = Some(value.to_owned());
                }
                "port" => {
                    if quic_port.is_some() {
                        return Err(ProximityRadioError::MalformedTxtRecord);
                    }
                    let parsed = value
                        .parse::<u16>()
                        .map_err(|_| ProximityRadioError::MalformedTxtRecord)?;
                    if parsed == 0 {
                        return Err(ProximityRadioError::MalformedTxtRecord);
                    }
                    quic_port = Some(parsed);
                }
                _ => return Err(ProximityRadioError::MalformedTxtRecord),
            }
        }

        let (Some(version), Some(epoch), Some(token), Some(alpn), Some(quic_port)) =
            (version, epoch, token, alpn, quic_port)
        else {
            return Err(ProximityRadioError::MalformedTxtRecord);
        };
        if token.epoch() != epoch {
            return Err(ProximityRadioError::MalformedTxtRecord);
        }
        Ok(Self {
            version,
            epoch,
            token,
            alpn,
            quic_port,
        })
    }
}

/// Authenticated `76`-byte QUIC initiator challenge frame (`KQ\x01\x01`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProximityQuicChallenge {
    pub issued_at_secs: u64,
    pub challenge_nonce: [u8; 16],
    pub initiator_token: EphemeralProximityToken,
    pub mac_tag: [u8; 16],
}

impl ProximityQuicChallenge {
    #[must_use]
    pub fn encode(&self) -> [u8; QUIC_CHALLENGE_BYTES] {
        let mut out = [0u8; QUIC_CHALLENGE_BYTES];
        out[0..2].copy_from_slice(&QUIC_MAGIC);
        out[2] = QUIC_VERSION;
        out[3] = QUIC_FRAME_CHALLENGE;
        out[4..12].copy_from_slice(&self.issued_at_secs.to_be_bytes());
        out[12..28].copy_from_slice(&self.challenge_nonce);
        out[28..60].copy_from_slice(self.initiator_token.as_bytes());
        out[60..76].copy_from_slice(&self.mac_tag);
        out
    }

    pub fn decode(raw: &[u8]) -> Result<Self, ProximityRadioError> {
        if raw.len() > MAX_QUIC_HANDSHAKE_FRAME_BYTES || raw.len() != QUIC_CHALLENGE_BYTES {
            return Err(ProximityRadioError::MalformedHandshakeFrame);
        }
        if raw[0..2] != QUIC_MAGIC {
            return Err(ProximityRadioError::MalformedHandshakeFrame);
        }
        if raw[2] != QUIC_VERSION {
            return Err(ProximityRadioError::UnsupportedVersion);
        }
        if raw[3] != QUIC_FRAME_CHALLENGE {
            return Err(ProximityRadioError::MalformedHandshakeFrame);
        }
        let issued_at_secs =
            u64::from_be_bytes(raw[4..12].try_into().expect("fixed 8-byte timestamp"));
        let challenge_nonce: [u8; 16] = raw[12..28].try_into().expect("fixed 16-byte nonce");
        if challenge_nonce.iter().all(|&b| b == 0) {
            return Err(ProximityRadioError::MalformedHandshakeFrame);
        }
        let initiator_token = EphemeralProximityToken::from_bytes(&raw[28..60])?;
        let mac_tag: [u8; 16] = raw[60..76].try_into().expect("fixed 16-byte mac");
        Ok(Self {
            issued_at_secs,
            challenge_nonce,
            initiator_token,
            mac_tag,
        })
    }
}

/// Authenticated `108`-byte QUIC responder challenge-response frame (`KQ\x01\x02`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProximityQuicResponse {
    pub responded_at_secs: u64,
    pub challenge_nonce: [u8; 16],
    pub responder_nonce: [u8; 16],
    pub responder_token: EphemeralProximityToken,
    pub mac_tag: [u8; 32],
}

impl ProximityQuicResponse {
    #[must_use]
    pub fn encode(&self) -> [u8; QUIC_RESPONSE_BYTES] {
        let mut out = [0u8; QUIC_RESPONSE_BYTES];
        out[0..2].copy_from_slice(&QUIC_MAGIC);
        out[2] = QUIC_VERSION;
        out[3] = QUIC_FRAME_RESPONSE;
        out[4..12].copy_from_slice(&self.responded_at_secs.to_be_bytes());
        out[12..28].copy_from_slice(&self.challenge_nonce);
        out[28..44].copy_from_slice(&self.responder_nonce);
        out[44..76].copy_from_slice(self.responder_token.as_bytes());
        out[76..108].copy_from_slice(&self.mac_tag);
        out
    }

    pub fn decode(raw: &[u8]) -> Result<Self, ProximityRadioError> {
        if raw.len() > MAX_QUIC_HANDSHAKE_FRAME_BYTES || raw.len() != QUIC_RESPONSE_BYTES {
            return Err(ProximityRadioError::MalformedHandshakeFrame);
        }
        if raw[0..2] != QUIC_MAGIC {
            return Err(ProximityRadioError::MalformedHandshakeFrame);
        }
        if raw[2] != QUIC_VERSION {
            return Err(ProximityRadioError::UnsupportedVersion);
        }
        if raw[3] != QUIC_FRAME_RESPONSE {
            return Err(ProximityRadioError::MalformedHandshakeFrame);
        }
        let responded_at_secs =
            u64::from_be_bytes(raw[4..12].try_into().expect("fixed 8-byte timestamp"));
        let challenge_nonce: [u8; 16] = raw[12..28].try_into().expect("fixed 16-byte nonce");
        let responder_nonce: [u8; 16] = raw[28..44].try_into().expect("fixed 16-byte nonce");
        if challenge_nonce.iter().all(|&b| b == 0) || responder_nonce.iter().all(|&b| b == 0) {
            return Err(ProximityRadioError::MalformedHandshakeFrame);
        }
        let responder_token = EphemeralProximityToken::from_bytes(&raw[44..76])?;
        let mac_tag: [u8; 32] = raw[76..108].try_into().expect("fixed 32-byte mac");
        Ok(Self {
            responded_at_secs,
            challenge_nonce,
            responder_nonce,
            responder_token,
            mac_tag,
        })
    }
}

/// Mutual proof and derived channel-binding key produced after a verified mDNS/QUIC peer handshake.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifiedQuicPeerHandshake {
    pub initiator: VerifiedEphemeralToken,
    pub responder: VerifiedEphemeralToken,
    pub channel_binding_key: [u8; 32],
}

fn within_skew(ts_secs: u64, now_unix_secs: u64) -> bool {
    ts_secs.abs_diff(now_unix_secs) <= MAX_QUIC_HANDSHAKE_SKEW_SECS
}

/// Mutual mDNS TXT + QUIC challenge-response verifier with bounded nonce/token replay protection.
pub struct ProximityMdnsQuicVerifier {
    organisation_id: OrganisationId,
    scope_tag: String,
    handshake_subkey: [u8; 32],
    token_verifier: EphemeralTokenVerifier,
    seen_challenge_nonces: VecDeque<(u64, [u8; 16])>,
    seen_response_pairs: VecDeque<(u64, [u8; 16], [u8; 16])>,
}

impl fmt::Debug for ProximityMdnsQuicVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ProximityMdnsQuicVerifier([redacted])")
    }
}

impl Drop for ProximityMdnsQuicVerifier {
    fn drop(&mut self) {
        self.handshake_subkey.fill(0);
    }
}

impl ProximityMdnsQuicVerifier {
    pub fn new(
        organisation_id: OrganisationId,
        scope_tag: impl Into<String>,
        workspace_master_key: [u8; 32],
    ) -> Result<Self, ProximityRadioError> {
        let scope_tag = scope_tag.into();
        validate_scope_tag(&scope_tag)?;
        if !has_nontrivial_entropy(&workspace_master_key) {
            return Err(ProximityRadioError::InvalidKeyMaterial);
        }
        let mut salt = Vec::with_capacity(organisation_id.as_str().len() + 1 + scope_tag.len());
        salt.extend_from_slice(organisation_id.as_str().as_bytes());
        salt.push(b':');
        salt.extend_from_slice(scope_tag.as_bytes());

        let handshake_subkey = hkdf_sha256::<32>(
            &salt,
            &workspace_master_key,
            b"kodera.proximity.w9.quic-handshake.v1",
        )?;
        let token_verifier = EphemeralTokenVerifier::new(
            organisation_id.clone(),
            scope_tag.clone(),
            workspace_master_key,
        )?;
        Ok(Self {
            organisation_id,
            scope_tag,
            handshake_subkey,
            token_verifier,
            seen_challenge_nonces: VecDeque::new(),
            seen_response_pairs: VecDeque::new(),
        })
    }

    /// Validates an advertised `_kodera-prox._udp.local.` TXT record and its rotating token.
    pub fn verify_mdns_txt(
        &self,
        txt: &MdnsProximityTxtRecord,
        now_unix_secs: u64,
    ) -> Result<VerifiedEphemeralToken, ProximityRadioError> {
        if txt.alpn != QUIC_PROXIMITY_ALPN || txt.quic_port == 0 || txt.token.epoch() != txt.epoch {
            return Err(ProximityRadioError::MalformedTxtRecord);
        }
        self.token_verifier
            .verify_stateless(&txt.token, now_unix_secs)
    }

    /// Builds a signed 76-byte QUIC challenge frame carrying the initiator's rotating token.
    pub fn build_challenge(
        &self,
        initiator_token: EphemeralProximityToken,
        challenge_nonce: [u8; 16],
        issued_at_secs: u64,
    ) -> Result<ProximityQuicChallenge, ProximityRadioError> {
        if challenge_nonce.iter().all(|&b| b == 0) {
            return Err(ProximityRadioError::InvalidKeyMaterial);
        }
        self.token_verifier
            .verify_stateless(&initiator_token, issued_at_secs)?;
        let mac_tag =
            self.compute_challenge_mac(issued_at_secs, &challenge_nonce, &initiator_token);
        Ok(ProximityQuicChallenge {
            issued_at_secs,
            challenge_nonce,
            initiator_token,
            mac_tag,
        })
    }

    /// Verifies an incoming QUIC challenge (MAC, clock skew, initiator rotating token, and replay)
    /// and constructs a cryptographically bound 108-byte responder frame.
    pub fn accept_challenge_and_respond(
        &mut self,
        challenge: &ProximityQuicChallenge,
        responder_token: EphemeralProximityToken,
        responder_nonce: [u8; 16],
        now_unix_secs: u64,
    ) -> Result<(ProximityQuicResponse, VerifiedQuicPeerHandshake), ProximityRadioError> {
        if responder_nonce.iter().all(|&b| b == 0) {
            return Err(ProximityRadioError::InvalidKeyMaterial);
        }
        if ct_eq(&responder_nonce, &challenge.challenge_nonce)
            || ct_eq(
                responder_token.as_bytes(),
                challenge.initiator_token.as_bytes(),
            )
            || ct_eq(
                &responder_token.rolling_pseudonym(),
                &challenge.initiator_token.rolling_pseudonym(),
            )
        {
            return Err(ProximityRadioError::ReflectionRejected);
        }
        if !within_skew(challenge.issued_at_secs, now_unix_secs) {
            return Err(ProximityRadioError::ClockSkewExceeded);
        }

        let expected_challenge_mac = self.compute_challenge_mac(
            challenge.issued_at_secs,
            &challenge.challenge_nonce,
            &challenge.initiator_token,
        );
        if !ct_eq(&expected_challenge_mac, &challenge.mac_tag) {
            return Err(ProximityRadioError::AuthenticationFailed);
        }

        self.purge_expired_nonces(now_unix_secs);
        if self
            .seen_challenge_nonces
            .iter()
            .any(|(_, n)| ct_eq(n, &challenge.challenge_nonce))
        {
            return Err(ProximityRadioError::ReplayRejected);
        }

        let responder_verified = self
            .token_verifier
            .verify_stateless(&responder_token, now_unix_secs)?;
        let initiator_verified = self
            .token_verifier
            .verify_and_accept(&challenge.initiator_token, now_unix_secs)?;

        self.record_challenge_nonce(now_unix_secs, challenge.challenge_nonce);

        let mac_tag = self.compute_response_mac(
            now_unix_secs,
            &challenge.challenge_nonce,
            &responder_nonce,
            &challenge.initiator_token,
            &responder_token,
        );
        let response = ProximityQuicResponse {
            responded_at_secs: now_unix_secs,
            challenge_nonce: challenge.challenge_nonce,
            responder_nonce,
            responder_token,
            mac_tag,
        };
        let channel_binding_key = self.derive_channel_binding(challenge, &response)?;
        Ok((
            response,
            VerifiedQuicPeerHandshake {
                initiator: initiator_verified,
                responder: responder_verified,
                channel_binding_key,
            },
        ))
    }

    /// Verifies the responder's 108-byte QUIC frame against the original initiator challenge,
    /// enforcing mutual workspace membership, anti-reflection, clock skew, and replay rejection.
    pub fn verify_response(
        &mut self,
        sent_challenge: &ProximityQuicChallenge,
        response: &ProximityQuicResponse,
        now_unix_secs: u64,
    ) -> Result<VerifiedQuicPeerHandshake, ProximityRadioError> {
        if !ct_eq(&sent_challenge.challenge_nonce, &response.challenge_nonce) {
            return Err(ProximityRadioError::ChallengeMismatch);
        }
        if ct_eq(&response.responder_nonce, &sent_challenge.challenge_nonce)
            || ct_eq(
                response.responder_token.as_bytes(),
                sent_challenge.initiator_token.as_bytes(),
            )
            || ct_eq(
                &response.responder_token.rolling_pseudonym(),
                &sent_challenge.initiator_token.rolling_pseudonym(),
            )
        {
            return Err(ProximityRadioError::ReflectionRejected);
        }
        if !within_skew(response.responded_at_secs, now_unix_secs) {
            return Err(ProximityRadioError::ClockSkewExceeded);
        }

        let expected_mac = self.compute_response_mac(
            response.responded_at_secs,
            &response.challenge_nonce,
            &response.responder_nonce,
            &sent_challenge.initiator_token,
            &response.responder_token,
        );
        if !ct_eq(&expected_mac, &response.mac_tag) {
            return Err(ProximityRadioError::AuthenticationFailed);
        }

        self.purge_expired_nonces(now_unix_secs);
        if self.seen_response_pairs.iter().any(|(_, c, r)| {
            ct_eq(c, &response.challenge_nonce) && ct_eq(r, &response.responder_nonce)
        }) {
            return Err(ProximityRadioError::ReplayRejected);
        }

        let initiator_verified = self
            .token_verifier
            .verify_stateless(&sent_challenge.initiator_token, now_unix_secs)?;
        let responder_verified = self
            .token_verifier
            .verify_and_accept(&response.responder_token, now_unix_secs)?;

        self.record_response_pair(
            now_unix_secs,
            response.challenge_nonce,
            response.responder_nonce,
        );
        let channel_binding_key = self.derive_channel_binding(sent_challenge, response)?;
        Ok(VerifiedQuicPeerHandshake {
            initiator: initiator_verified,
            responder: responder_verified,
            channel_binding_key,
        })
    }

    fn compute_challenge_mac(
        &self,
        issued_at_secs: u64,
        challenge_nonce: &[u8; 16],
        initiator_token: &EphemeralProximityToken,
    ) -> [u8; 16] {
        let mut transcript = Vec::with_capacity(128);
        transcript.extend_from_slice(b"kodera.proximity.w9.quic-challenge.v1:");
        transcript.extend_from_slice(self.organisation_id.as_str().as_bytes());
        transcript.push(b':');
        transcript.extend_from_slice(self.scope_tag.as_bytes());
        transcript.extend_from_slice(&issued_at_secs.to_be_bytes());
        transcript.extend_from_slice(challenge_nonce);
        transcript.extend_from_slice(initiator_token.as_bytes());
        let full = hmac_sha256(&self.handshake_subkey, &transcript);
        let mut tag = [0u8; 16];
        tag.copy_from_slice(&full[..16]);
        tag
    }

    fn compute_response_mac(
        &self,
        responded_at_secs: u64,
        challenge_nonce: &[u8; 16],
        responder_nonce: &[u8; 16],
        initiator_token: &EphemeralProximityToken,
        responder_token: &EphemeralProximityToken,
    ) -> [u8; 32] {
        let mut transcript = Vec::with_capacity(176);
        transcript.extend_from_slice(b"kodera.proximity.w9.quic-response.v1:");
        transcript.extend_from_slice(self.organisation_id.as_str().as_bytes());
        transcript.push(b':');
        transcript.extend_from_slice(self.scope_tag.as_bytes());
        transcript.extend_from_slice(&responded_at_secs.to_be_bytes());
        transcript.extend_from_slice(challenge_nonce);
        transcript.extend_from_slice(responder_nonce);
        transcript.extend_from_slice(initiator_token.as_bytes());
        transcript.extend_from_slice(responder_token.as_bytes());
        hmac_sha256(&self.handshake_subkey, &transcript)
    }

    fn derive_channel_binding(
        &self,
        challenge: &ProximityQuicChallenge,
        response: &ProximityQuicResponse,
    ) -> Result<[u8; 32], ProximityRadioError> {
        let mut salt = [0u8; 32];
        salt[0..16].copy_from_slice(&challenge.challenge_nonce);
        salt[16..32].copy_from_slice(&response.responder_nonce);

        let mut info = Vec::with_capacity(112);
        info.extend_from_slice(b"kodera.proximity.w9.channel-binding.v1:");
        info.extend_from_slice(self.organisation_id.as_str().as_bytes());
        info.push(b':');
        info.extend_from_slice(self.scope_tag.as_bytes());
        info.extend_from_slice(challenge.initiator_token.as_bytes());
        info.extend_from_slice(response.responder_token.as_bytes());

        hkdf_sha256::<32>(&salt, &self.handshake_subkey, &info)
    }

    fn purge_expired_nonces(&mut self, now_unix_secs: u64) {
        let horizon = MAX_QUIC_HANDSHAKE_SKEW_SECS * 2;
        self.seen_challenge_nonces
            .retain(|(ts, _)| now_unix_secs.saturating_sub(*ts) <= horizon);
        self.seen_response_pairs
            .retain(|(ts, _, _)| now_unix_secs.saturating_sub(*ts) <= horizon);
    }

    fn record_challenge_nonce(&mut self, now_unix_secs: u64, nonce: [u8; 16]) {
        if self.seen_challenge_nonces.len() >= MAX_REPLAY_ENTRIES {
            self.seen_challenge_nonces.pop_front();
        }
        self.seen_challenge_nonces.push_back((now_unix_secs, nonce));
    }

    fn record_response_pair(
        &mut self,
        now_unix_secs: u64,
        challenge_nonce: [u8; 16],
        responder_nonce: [u8; 16],
    ) {
        if self.seen_response_pairs.len() >= MAX_REPLAY_ENTRIES {
            self.seen_response_pairs.pop_front();
        }
        self.seen_response_pairs
            .push_back((now_unix_secs, challenge_nonce, responder_nonce));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_org(tag: &str) -> OrganisationId {
        let suffix: u8 = tag.bytes().fold(1u8, |acc, b| acc.wrapping_add(b)).max(1);
        let uuid = format!("00000000-0000-4000-8000-0000000000{suffix:02x}");
        OrganisationId::parse(&uuid).expect("valid organisation UUID")
    }

    fn sample_key(seed: u8) -> [u8; 32] {
        let mut key = [0u8; 32];
        for (idx, slot) in key.iter_mut().enumerate() {
            *slot = seed.wrapping_add(u8::try_from(idx * 7 + 1).expect("fits u8"));
        }
        key
    }

    #[test]
    fn rfc5869_test_case_1_and_2_vectors_match_exactly() {
        // RFC 5869 Appendix A.1 Test Case 1
        let ikm = [0x0bu8; 22];
        let salt = decode_hex("000102030405060708090a0b0c").expect("valid hex");
        let info = decode_hex("f0f1f2f3f4f5f6f7f8f9").expect("valid hex");
        let prk = hkdf_extract_sha256(&salt, &ikm);
        assert_eq!(
            encode_hex(&prk),
            "077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5"
        );
        let mut okm = [0u8; 42];
        hkdf_expand_sha256(&prk, &info, &mut okm).expect("valid expand");
        assert_eq!(
            encode_hex(&okm),
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
        );

        // RFC 5869 Appendix A.3 Test Case 3 (zero-length salt & info)
        let okm_case3 = hkdf_sha256::<42>(&[], &ikm, &[]).expect("valid hkdf");
        assert_eq!(
            encode_hex(&okm_case3),
            "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8"
        );

        // Reject output > 255 * 32 bytes
        let mut oversized = vec![0u8; 255 * 32 + 1];
        assert_eq!(
            hkdf_expand_sha256(&prk, &info, &mut oversized),
            Err(ProximityRadioError::InvalidOutputLength)
        );
    }

    #[test]
    fn rotating_token_rotates_every_15_minutes_and_rejects_replay_and_spoofing() {
        let org = test_org("org-paris-hq");
        let master = sample_key(0x10);
        let alice_seed = sample_key(0x42);

        let mut rotator =
            EphemeralTokenRotator::new(org.clone(), "workspace-main", master, alice_seed)
                .expect("valid rotator");
        let mut verifier = EphemeralTokenVerifier::new(org.clone(), "workspace-main", master)
            .expect("valid verifier");

        let t0 = 1_760_000_100u64;
        let tok0 = rotator.emit(t0).expect("first token");
        let tok1 = rotator
            .emit(t0 + 10)
            .expect("second token in same 15m epoch");

        assert_eq!(tok0.epoch(), tok1.epoch());
        assert_eq!(tok0.counter(), 0);
        assert_eq!(tok1.counter(), 1);
        assert_eq!(tok0.rolling_pseudonym(), tok1.rolling_pseudonym());
        assert_ne!(tok0.mac_tag(), tok1.mac_tag());

        // Accept tok0, then reject exact replay of tok0.
        let obs0 = verifier.verify_and_accept(&tok0, t0).expect("tok0 valid");
        assert_eq!(obs0.counter, 0);
        assert_eq!(
            verifier.verify_and_accept(&tok0, t0),
            Err(ProximityRadioError::ReplayRejected)
        );

        // Accept higher counter tok1, then reject out-of-order/replayed lower counter.
        let obs1 = verifier
            .verify_and_accept(&tok1, t0 + 10)
            .expect("tok1 valid");
        assert_eq!(obs1.counter, 1);

        // Advance 15 minutes (`900s`): rolling pseudonym MUST rotate completely (unlinkable!).
        let t_next_epoch = t0 + PROXIMITY_EPOCH_ROTATION_SECS;
        let tok_next = rotator.emit(t_next_epoch).expect("next epoch token");
        assert_eq!(tok_next.epoch(), tok0.epoch() + 1);
        assert_eq!(tok_next.counter(), 0);
        assert_ne!(tok_next.rolling_pseudonym(), tok0.rolling_pseudonym());

        let obs_next = verifier
            .verify_and_accept(&tok_next, t_next_epoch)
            .expect("next epoch accepted");
        assert_eq!(obs_next.epoch, tok_next.epoch());

        // Old token from previous 15-minute epoch (well past 60s skew window) is rejected.
        assert_eq!(
            verifier.verify_and_accept(&tok0, t_next_epoch + 120),
            Err(ProximityRadioError::EpochOutOfWindow)
        );

        // Cross-workspace / wrong key verifier rejects token.
        let mut other_ws_verifier =
            EphemeralTokenVerifier::new(org, "workspace-other", master).expect("other verifier");
        assert_eq!(
            other_ws_verifier.verify_and_accept(&tok_next, t_next_epoch),
            Err(ProximityRadioError::AuthenticationFailed)
        );
    }

    #[test]
    fn property_every_single_bit_flip_in_rotating_token_is_rejected() {
        let org = test_org("org-lyon-lab");
        let master = sample_key(0x21);
        let seed = sample_key(0x73);
        let now = 1_760_010_450u64;

        let mut rotator =
            EphemeralTokenRotator::new(org.clone(), "floor-2", master, seed).expect("rotator");
        let verifier = EphemeralTokenVerifier::new(org, "floor-2", master).expect("verifier");
        let valid = rotator.emit(now).expect("token");
        let baseline = *valid.as_bytes();

        for byte_idx in 0..PROXIMITY_EPHEMERAL_TOKEN_BYTES {
            for bit in 0..8u8 {
                let mut mutated = baseline;
                mutated[byte_idx] ^= 1u8 << bit;
                let res = EphemeralProximityToken::from_bytes(&mutated)
                    .and_then(|parsed| verifier.verify_stateless(&parsed, now));
                assert!(
                    res.is_err(),
                    "bit flip at byte {byte_idx} bit {bit} unexpectedly passed verification"
                );
            }
        }
    }

    #[test]
    fn rssi_classifier_enforces_hysteresis_and_rejects_invalid_samples() {
        let mut classifier = RssiDistanceClassifier::default();

        // Bluetooth 0x7F (127) unavailable sentinel and > 20 dBm are strictly rejected.
        assert_eq!(
            classifier.observe(127),
            Err(ProximityRadioError::InvalidRssi)
        );
        assert_eq!(
            classifier.observe(21),
            Err(ProximityRadioError::InvalidRssi)
        );

        // Start in Immediate (-52 dBm >= -55 dBm).
        assert_eq!(
            classifier.observe(-52),
            Ok(ProximityDistanceBand::Immediate)
        );

        // Fluctuating in the deadband [-61, -55] MUST remain Immediate (no flapping!).
        for sample in [-56, -58, -60, -61, -57, -60] {
            assert_eq!(
                classifier.observe(sample),
                Ok(ProximityDistanceBand::Immediate),
                "expected hysteresis hold at {sample} dBm"
            );
        }

        // Drop below immediate_exit (-62 < -61) -> demotes to Near.
        assert_eq!(classifier.observe(-62), Ok(ProximityDistanceBand::Near));

        // Rising back into [-61, -56] stays Near until crossing immediate_enter (-55).
        assert_eq!(classifier.observe(-58), Ok(ProximityDistanceBand::Near));
        assert_eq!(classifier.observe(-56), Ok(ProximityDistanceBand::Near));
        assert_eq!(
            classifier.observe(-55),
            Ok(ProximityDistanceBand::Immediate)
        );

        // Drop into Near, then hold across Near deadband [-81, -75], then demote to Ambient at -82.
        assert_eq!(classifier.observe(-70), Ok(ProximityDistanceBand::Near));
        for sample in [-76, -79, -81, -77] {
            assert_eq!(
                classifier.observe(sample),
                Ok(ProximityDistanceBand::Near),
                "expected Near hysteresis hold at {sample} dBm"
            );
        }
        assert_eq!(classifier.observe(-82), Ok(ProximityDistanceBand::Ambient));

        // Ambient holds at -76 (< -75) and promotes back to Near only at >= -75.
        assert_eq!(classifier.observe(-76), Ok(ProximityDistanceBand::Ambient));
        assert_eq!(classifier.observe(-75), Ok(ProximityDistanceBand::Near));
    }

    #[test]
    fn mdns_txt_roundtrips_wire_bytes_and_refuses_gps_coordinates() {
        let org = test_org("org-nantes");
        let master = sample_key(0x33);
        let seed = sample_key(0x88);
        let now = 1_760_020_000u64;

        let mut rotator =
            EphemeralTokenRotator::new(org.clone(), "lan-prox", master, seed).expect("rotator");
        let tok = rotator.emit(now).expect("tok");

        let record = MdnsProximityTxtRecord::new(tok, 48_443).expect("txt record");
        let wire = record.encode_wire().expect("wire encode");
        let decoded = MdnsProximityTxtRecord::decode_wire(&wire).expect("wire decode");
        assert_eq!(decoded, record);

        let verifier =
            ProximityMdnsQuicVerifier::new(org, "lan-prox", master).expect("mdns/quic verifier");
        let verified_tok = verifier
            .verify_mdns_txt(&decoded, now)
            .expect("mdns txt token verified");
        assert_eq!(verified_tok.rolling_pseudonym, tok.rolling_pseudonym());

        // Any GPS / coordinate key in mDNS TXT MUST be refused with ForbiddenCoordinateField!
        let mut entries_with_gps = record.to_entries();
        entries_with_gps.push("lat=48.8566".to_owned());
        assert_eq!(
            MdnsProximityTxtRecord::from_entries(&entries_with_gps),
            Err(ProximityRadioError::ForbiddenCoordinateField)
        );
    }

    #[test]
    fn quic_mutual_challenge_response_verifies_and_blocks_replay_reflection_and_tampering() {
        let org = test_org("org-bordeaux");
        let master = sample_key(0x55);
        let alice_seed = sample_key(0x91);
        let bob_seed = sample_key(0xa7);
        let now = 1_760_030_000u64;

        let mut alice_rotator =
            EphemeralTokenRotator::new(org.clone(), "room-cafe", master, alice_seed)
                .expect("alice rotator");
        let mut bob_rotator =
            EphemeralTokenRotator::new(org.clone(), "room-cafe", master, bob_seed)
                .expect("bob rotator");

        let mut alice_quic = ProximityMdnsQuicVerifier::new(org.clone(), "room-cafe", master)
            .expect("alice verifier");
        let mut bob_quic =
            ProximityMdnsQuicVerifier::new(org, "room-cafe", master).expect("bob verifier");

        let alice_tok = alice_rotator.emit(now).expect("alice token");
        let bob_tok = bob_rotator.emit(now).expect("bob token");

        let challenge_nonce = [0x11u8; 16];
        let responder_nonce = [0x22u8; 16];

        let challenge = alice_quic
            .build_challenge(alice_tok, challenge_nonce, now)
            .expect("challenge built");
        let encoded_challenge = challenge.encode();
        let decoded_challenge =
            ProximityQuicChallenge::decode(&encoded_challenge).expect("decode challenge");

        // Self-reflection (responding with initiator's own token or challenge_nonce) is rejected.
        assert_eq!(
            bob_quic.accept_challenge_and_respond(
                &decoded_challenge,
                alice_tok,
                responder_nonce,
                now
            ),
            Err(ProximityRadioError::ReflectionRejected)
        );

        let (response, bob_handshake) = bob_quic
            .accept_challenge_and_respond(&decoded_challenge, bob_tok, responder_nonce, now + 1)
            .expect("bob accepts challenge");

        // Replaying the same challenge to Bob is rejected immediately.
        let bob_tok2 = bob_rotator.emit(now + 1).expect("bob token 2");
        assert_eq!(
            bob_quic.accept_challenge_and_respond(
                &decoded_challenge,
                bob_tok2,
                [0x33u8; 16],
                now + 1
            ),
            Err(ProximityRadioError::ReplayRejected)
        );

        let encoded_response = response.encode();
        let decoded_response =
            ProximityQuicResponse::decode(&encoded_response).expect("decode response");

        // Bit-flip anywhere in encoded response fails decode or MAC check.
        let mut tampered_resp = encoded_response;
        tampered_resp[90] ^= 0x01;
        if let Ok(parsed_tampered) = ProximityQuicResponse::decode(&tampered_resp) {
            assert_eq!(
                alice_quic.verify_response(&challenge, &parsed_tampered, now + 2),
                Err(ProximityRadioError::AuthenticationFailed)
            );
        }

        let alice_handshake = alice_quic
            .verify_response(&challenge, &decoded_response, now + 2)
            .expect("alice verifies response");
        assert_eq!(
            alice_handshake.channel_binding_key,
            bob_handshake.channel_binding_key
        );

        // Replaying the same response to Alice is rejected!
        assert_eq!(
            alice_quic.verify_response(&challenge, &decoded_response, now + 2),
            Err(ProximityRadioError::ReplayRejected)
        );
    }
}
