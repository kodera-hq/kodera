//! `kodera-rs` — Shared native Rust core for Kodera Desktop (Tauri v2), iOS (SwiftUI), and Android (Jetpack Compose).
//!
//! Architectural pillars:
//! 1. **Transport Seam (`UuidV7`):** Clients address channels and messages exclusively via canonical
//!    RFC 9562 UUIDv7 identifiers, keeping Matrix/Synapse room IDs isolated behind `MessagingTransport`.
//! 2. **Device Cryptographic Identity (`Ed25519`):** Hardware-backed/OS-keyring signing abstraction
//!    used to authenticate confidential envelopes and offline emergency frames.
//! 3. **Group E2EE Seam (`OpenMLS` RFC 9420):** Wire envelope and session trait preparing LiveKit
//!    voice/video frame encryption and confidential channels without coupling standard workspace search.
//! 4. **Building Blackout Lifeline (`#urgence`):** Pre-provisioned intra-organisation proximity beacon
//!    (`HMAC-SHA256` rotating salt) and bounded `<= 256`-byte store-and-forward frame codec (`TTL <= 6`)
//!    over local Wi-Fi (`mDNS + QUIC`) and `BLE GATT`.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::fmt;

mod poll_connector;
pub use poll_connector::{
    redact_iban, validate_channel_poll_id, validate_connector_post_url, ChannelPoll,
    ChannelPollOption, ChannelPollSnapshot, MAX_CHANNEL_POLL_VOTERS,
};

mod workspace_prefs;
pub use workspace_prefs::{
    curated_desktop_themes, decode_shareable_theme, encode_shareable_theme,
    evaluate_channel_access, validate_user_profile, ChannelAccessDecision, ChannelPermissionPolicy,
    CoreThemeMode, CustomThemePalette, DocsPadDocument, DocsPadError, OrgRoleRank, PresenceStatus,
    ProfileIamError, ShareableThemePayload, ThemeCodecError, UserProfile, KODERA_MONOGRAM_BG_HEX,
    KODERA_MONOGRAM_BG_RGB, MAX_DOCS_PAD_MARKDOWN_BYTES, MAX_THEME_SHARE_CODE_BYTES,
    THEME_SHARE_PREFIX,
};

/// Maximum wire size in bytes for a single `#urgence` BLE GATT frame.
pub const MAX_EMERGENCY_FRAME_BYTES: usize = 256;
/// Maximum UTF-8 byte length for `#urgence` short text payloads (`256 - 118` fixed overhead).
pub const MAX_EMERGENCY_TEXT_BYTES: usize = 138;
/// Maximum store-and-forward relay hop count across a building.
pub const MAX_EMERGENCY_TTL_HOPS: u8 = 6;
/// Rotating BLE advertisement window in seconds (5 minutes) to prevent external tracking.
pub const BEACON_ROTATION_WINDOW_SECS: u64 = 300;

// Shared emergency bounds. Every platform is to enforce these values; `vectors/emergency-v1-rules.txt`
// states them for the Swift, Kotlin and Web ports, and the tests below hold this file to it.

/// Hard upper bound for replay history and an organisation's tracked device roster.
pub const MAX_EMERGENCY_STATE_ENTRIES: usize = 4096;
/// Hard upper bound on queued radio frames, independent of caller-provided capacities.
pub const MAX_EMERGENCY_QUEUE_CAPACITY: usize = 128;
/// Hard upper bound on the device keys an organisation's roster tracks.
pub const MAX_EMERGENCY_ROSTER_MEMBERS: usize = MAX_EMERGENCY_STATE_ENTRIES;
/// Hard upper bound on the message IDs a replay guard remembers.
pub const MAX_EMERGENCY_REPLAY_ENTRIES: usize = MAX_EMERGENCY_STATE_ENTRIES;
/// How far a frame's UUIDv7 time may run ahead of the verifier's clock (5 minutes). A frame dated
/// further ahead is refused: kept, it would outrank its sender's real check-ins in the roster.
pub const MAX_EMERGENCY_FUTURE_SKEW_MS: u64 = 5 * 60 * 1000;

/// Native sound preference identifiers. These do not activate an audio renderer.
/// Legacy Web pack names are a separate contract and are not accepted as aliases.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SoundPackId {
    Givre,
    Cristal,
    Atelier,
    Arcade8Bit,
    Glitch404,
    Silent,
}

impl SoundPackId {
    pub fn parse(slug: &str) -> Result<Self, CoreError> {
        match slug {
            "givre" => Ok(Self::Givre),
            "cristal" => Ok(Self::Cristal),
            "atelier" => Ok(Self::Atelier),
            "8bit" => Ok(Self::Arcade8Bit),
            "404" => Ok(Self::Glitch404),
            "silent" => Ok(Self::Silent),
            _ => Err(CoreError::InvalidSoundPack),
        }
    }

    pub fn as_slug(&self) -> &'static str {
        match self {
            Self::Givre => "givre",
            Self::Cristal => "cristal",
            Self::Atelier => "atelier",
            Self::Arcade8Bit => "8bit",
            Self::Glitch404 => "404",
            Self::Silent => "silent",
        }
    }

    pub fn is_silent(&self) -> bool {
        *self == Self::Silent
    }
}

// ---------------------------------------------------------------------------
// 1. Canonical RFC 9562 UUIDv7 Seam
// ---------------------------------------------------------------------------

/// A 128-bit RFC 9562 UUIDv7 identifier isolating client state from underlying transport IDs.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct UuidV7([u8; 16]);

impl UuidV7 {
    /// Constructs a deterministic UUIDv7 from a Unix millisecond timestamp and 10 random bytes.
    pub fn from_parts(unix_ts_ms: u64, rand_bytes: [u8; 10]) -> Self {
        let mut out = [0u8; 16];
        let ts = unix_ts_ms.to_be_bytes();
        out[0..6].copy_from_slice(&ts[2..8]);
        // Version 7 (0b0111) in top 4 bits of octet 6
        out[6] = 0x70 | (rand_bytes[0] & 0x0f);
        out[7] = rand_bytes[1];
        // RFC 9562 variant (0b10) in top 2 bits of octet 8
        out[8] = 0x80 | (rand_bytes[2] & 0x3f);
        out[9..16].copy_from_slice(&rand_bytes[3..10]);
        Self(out)
    }

    /// Parses raw 16 bytes, validating RFC 9562 version 7 and variant bits.
    pub fn from_bytes_checked(bytes: [u8; 16]) -> Result<Self, CoreError> {
        if (bytes[6] >> 4) != 0x07 || (bytes[8] >> 6) != 0b10 {
            return Err(CoreError::InvalidUuidV7);
        }
        Ok(Self(bytes))
    }

    pub fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }

    pub fn timestamp_ms(&self) -> u64 {
        let mut buf = [0u8; 8];
        buf[2..8].copy_from_slice(&self.0[0..6]);
        u64::from_be_bytes(buf)
    }
}

impl fmt::Debug for UuidV7 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

impl fmt::Display for UuidV7 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut s = [0u8; 36];
        let mut idx = 0;
        for (i, &b) in self.0.iter().enumerate() {
            if i == 4 || i == 6 || i == 8 || i == 10 {
                s[idx] = b'-';
                idx += 1;
            }
            s[idx] = HEX[(b >> 4) as usize];
            s[idx + 1] = HEX[(b & 0x0f) as usize];
            idx += 2;
        }
        let formatted = std::str::from_utf8(&s).map_err(|_| fmt::Error)?;
        f.write_str(formatted)
    }
}

// ---------------------------------------------------------------------------
// 2. Device Signing (`Ed25519`) & OpenMLS (RFC 9420) Seam
// ---------------------------------------------------------------------------

pub type Ed25519PublicKey = [u8; 32];
pub type Ed25519Signature = [u8; 64];

/// Hardware/Keyring-backed Ed25519 device identity signer.
pub trait DeviceIdentitySigner: Send + Sync {
    fn public_key(&self) -> Ed25519PublicKey;
    fn sign(&self, message: &[u8]) -> Result<Ed25519Signature, CoreError>;
}

/// Signature verifier implemented by the native crypto provider (`ed25519-dalek` / OS CryptoKit).
pub trait SignatureVerifier: Send + Sync {
    fn verify(
        &self,
        public_key: &Ed25519PublicKey,
        message: &[u8],
        signature: &Ed25519Signature,
    ) -> Result<(), CoreError>;
}

/// Transport-agnostic messaging abstraction keeping Matrix/Synapse room IDs isolated behind canonical [`UuidV7`] IDs.
pub trait MessagingTransport: Send + Sync {
    fn send_envelope(&self, envelope: &MlsCiphertextEnvelope) -> Result<UuidV7, CoreError>;
}

/// Cryptographic protocol discriminator bridging existing Matrix Megolm/Olm rooms and RFC 9420 OpenMLS rooms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum CryptoAlgorithm {
    MatrixOlmV1 = 1,
    OpenMlsDraft = 2,
}

impl CryptoAlgorithm {
    pub fn from_u8(val: u8) -> Result<Self, CoreError> {
        match val {
            1 => Ok(Self::MatrixOlmV1),
            2 => Ok(Self::OpenMlsDraft),
            _ => Err(CoreError::CryptoFailure),
        }
    }
}

/// Transport-agnostic ciphertext envelope supporting both `MatrixOlmV1` and `OpenMlsDraft` (RFC 9420).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MlsCiphertextEnvelope {
    pub algorithm: CryptoAlgorithm,
    pub channel_id: UuidV7,
    pub epoch: u64,
    pub sender_device_key: Ed25519PublicKey,
    pub ciphertext: Vec<u8>,
}

/// Pluggable cryptographic provider seam allowing clean-room migration from `MatrixOlmV1` to `OpenMlsDraft`.
pub trait CryptoProvider: Send + Sync {
    fn algorithm(&self) -> CryptoAlgorithm;
    fn seal_channel_payload(
        &mut self,
        channel_id: UuidV7,
        plaintext: &[u8],
    ) -> Result<MlsCiphertextEnvelope, CoreError>;
    fn open_channel_payload(
        &mut self,
        envelope: &MlsCiphertextEnvelope,
    ) -> Result<Vec<u8>, CoreError>;
}

/// Trait implemented by the OpenMLS (RFC 9420) group session engine.
pub trait MlsGroupSession: Send + Sync {
    fn current_epoch(&self) -> u64;
    fn seal_application_message(
        &mut self,
        plaintext: &[u8],
    ) -> Result<MlsCiphertextEnvelope, CoreError>;
    fn open_application_message(
        &mut self,
        envelope: &MlsCiphertextEnvelope,
    ) -> Result<Vec<u8>, CoreError>;
}

/// Canonical lower-case UUID organisation identity. Nil IDs are not session identities.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OrganisationId(String);

impl OrganisationId {
    pub fn parse(value: &str) -> Result<Self, CoreError> {
        if value.len() != 36
            || value == "00000000-0000-0000-0000-000000000000"
            || !value.bytes().enumerate().all(|(index, byte)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    byte == b'-'
                } else {
                    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
                }
            })
        {
            return Err(CoreError::InvalidOrganisation);
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Authenticated envelope metadata; separate from the existing ciphertext/wire representation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionEnvelopeHeader {
    pub organisation_id: OrganisationId,
    pub room_id: UuidV7,
    pub message_id: UuidV7,
    pub epoch: u64,
    pub algorithm: CryptoAlgorithm,
}

/// Trusted crypto adapter seam, not an IPC-supplied predicate. Implementations must authenticate
/// every header field against the actual ciphertext/session before returning success. Tracking
/// metadata does not implement MLS, signatures or ciphertext authentication by itself.
pub trait SessionEnvelopeVerifier {
    fn verify_header(&self, header: &SessionEnvelopeHeader) -> Result<(), CoreError>;
}

#[derive(Debug, Clone, Copy)]
struct RoomEnvelopeState {
    epoch: u64,
    algorithm: CryptoAlgorithm,
}

/// One authenticated organisation's bounded room history. Room entries are never evicted, because
/// eviction would silently permit an epoch rollback or algorithm change. New rooms fail at capacity.
/// Replay history is FIFO-bounded across rooms; an evicted message ID is no longer replay-protected.
/// Retained IDs cannot be reused in the same room even after an epoch advance. A trusted adapter
/// must persist session epochs separately if it needs rollback protection across process restarts.
#[derive(Debug)]
pub struct SessionEnvelopeTracker {
    organisation_id: OrganisationId,
    rooms: BTreeMap<UuidV7, RoomEnvelopeState>,
    replay: HashSet<(UuidV7, UuidV7)>,
    replay_order: VecDeque<(UuidV7, UuidV7)>,
    room_capacity: usize,
    replay_capacity: usize,
}

impl SessionEnvelopeTracker {
    pub fn new(
        organisation_id: OrganisationId,
        room_capacity: usize,
        replay_capacity: usize,
    ) -> Result<Self, CoreError> {
        if !(1..=MAX_EMERGENCY_STATE_ENTRIES).contains(&room_capacity)
            || !(1..=MAX_EMERGENCY_STATE_ENTRIES).contains(&replay_capacity)
        {
            return Err(CoreError::InvalidCapacity);
        }
        Ok(Self {
            organisation_id,
            rooms: BTreeMap::new(),
            replay: HashSet::new(),
            replay_order: VecDeque::new(),
            room_capacity,
            replay_capacity,
        })
    }

    /// All checks, including provider authentication, complete before any state is committed.
    pub fn verify_and_observe(
        &mut self,
        header: &SessionEnvelopeHeader,
        verifier: &dyn SessionEnvelopeVerifier,
    ) -> Result<(), CoreError> {
        if header.organisation_id != self.organisation_id {
            return Err(CoreError::OrganisationMismatch);
        }
        if let Some(room) = self.rooms.get(&header.room_id) {
            if header.algorithm != room.algorithm {
                return Err(CoreError::AlgorithmMismatch);
            }
            if header.epoch < room.epoch {
                return Err(CoreError::StaleFrame);
            }
        } else if self.rooms.len() == self.room_capacity {
            return Err(CoreError::CapacityExceeded);
        }
        let key = (header.room_id, header.message_id);
        if self.replay.contains(&key) {
            return Err(CoreError::ReplayDetected);
        }
        verifier.verify_header(header)?;
        if self.replay.len() == self.replay_capacity {
            if let Some(oldest) = self.replay_order.pop_front() {
                self.replay.remove(&oldest);
            }
        }
        self.replay.insert(key);
        self.replay_order.push_back(key);
        self.rooms.insert(
            header.room_id,
            RoomEnvelopeState {
                epoch: header.epoch,
                algorithm: header.algorithm,
            },
        );
        Ok(())
    }

    pub fn room_count(&self) -> usize {
        self.rooms.len()
    }

    pub fn replay_count(&self) -> usize {
        self.replay.len()
    }

    pub fn clear(&mut self) {
        self.rooms.clear();
        self.replay.clear();
        self.replay_order.clear();
    }
}

/// Maximum canonical Docs URL: HTTPS prefix, public host, optional port, path prefix and slug.
pub const MAX_DOCS_PAD_URL_BYTES: usize = 399;
/// Bound allocations in the current non-streaming webhook HMAC implementation.
pub const MAX_EXTENSION_WEBHOOK_PAYLOAD_BYTES: usize = 1024 * 1024;

/// A syntactically public, canonical DNS name; no DNS resolution or address trust is implied.
pub fn validate_docs_host(host: &str) -> Result<(), CoreError> {
    if host.len() > 253
        || host == "localhost"
        || [".localhost", ".local", ".internal"]
            .iter()
            .any(|suffix| host.ends_with(suffix))
    {
        return Err(CoreError::UntrustedDocsOrigin);
    }
    let mut labels = host.split('.');
    let first = labels.next().ok_or(CoreError::UntrustedDocsOrigin)?;
    let rest: Vec<&str> = labels.collect();
    if rest.is_empty()
        || std::iter::once(first)
            .chain(rest.iter().copied())
            .any(|label| {
                label.is_empty()
                    || label.len() > 63
                    || label.starts_with('-')
                    || label.ends_with('-')
                    || !label
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            })
        || !rest
            .last()
            .is_some_and(|tld| tld.len() >= 2 && tld.bytes().all(|b| b.is_ascii_lowercase()))
    {
        return Err(CoreError::UntrustedDocsOrigin);
    }
    Ok(())
}

/// Immutable validated link, not navigation authority or evidence of document access.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocsPadUrl {
    host: String,
    path: String,
    canonical_url: String,
}

impl DocsPadUrl {
    pub fn host(&self) -> &str {
        &self.host
    }
    pub fn path(&self) -> &str {
        &self.path
    }
    pub fn as_str(&self) -> &str {
        &self.canonical_url
    }
}

/// Parse a deliberately narrow grammar before any URL normalization can hide a delimiter or path.
/// HTTPS port 443 is accepted but omitted from the canonical result. No network request occurs.
pub fn validate_docs_pad_url(
    raw_url: &str,
    allowed_docs_host: &str,
) -> Result<DocsPadUrl, CoreError> {
    validate_docs_host(allowed_docs_host)?;
    if raw_url.len() > MAX_DOCS_PAD_URL_BYTES
        || !raw_url.is_ascii()
        || raw_url.bytes().any(|b| {
            b.is_ascii_control()
                || b.is_ascii_whitespace()
                || matches!(b, b'@' | b'?' | b'#' | b'\\')
        })
    {
        return Err(CoreError::InvalidDocsUrl);
    }
    let remainder = raw_url
        .strip_prefix("https://")
        .ok_or(CoreError::InvalidDocsUrl)?;
    let (authority, suffix) = remainder.split_once('/').ok_or(CoreError::InvalidDocsUrl)?;
    let host = authority.strip_suffix(":443").unwrap_or(authority);
    if host != allowed_docs_host {
        return Err(CoreError::UntrustedDocsOrigin);
    }
    let slug = suffix
        .strip_prefix("docs/")
        .or_else(|| suffix.strip_prefix("pads/"))
        .ok_or(CoreError::InvalidDocsUrl)?;
    if !(1..=128).contains(&slug.len())
        || !slug
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err(CoreError::InvalidDocsUrl);
    }
    let path = format!("/{suffix}");
    Ok(DocsPadUrl {
        host: host.to_owned(),
        canonical_url: format!("https://{host}{path}"),
        path,
    })
}

pub fn validate_extension_id(extension_id: &str) -> Result<(), CoreError> {
    if !(1..=64).contains(&extension_id.len())
        || !extension_id.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-' | b'_')
        })
    {
        return Err(CoreError::InvalidExtensionId);
    }
    Ok(())
}

/// Derives a context-bound webhook HMAC key `HMAC-SHA256(secret, org_id || ":" || ext_id)`
/// so a raw secret cannot be replayed across distinct `(organisation_id, extension_id)` pairs.
pub fn derive_extension_webhook_secret(
    secret: &[u8; 32],
    organisation_id: &OrganisationId,
    extension_id: &str,
) -> Result<[u8; 32], CoreError> {
    validate_extension_id(extension_id)?;
    let mut context = Vec::with_capacity(organisation_id.as_str().len() + 1 + extension_id.len());
    context.extend_from_slice(organisation_id.as_str().as_bytes());
    context.push(b':');
    context.extend_from_slice(extension_id.as_bytes());
    Ok(hmac_sha256(secret, &context))
}

/// Org-scoped replay bookkeeping for the native `kodera-ext-v1:` protocol, NOT the existing
/// extension SDK's timestamp-dot-body webhook wire format. There is no compatibility fallback.
/// The raw `verify_and_record` transcript does not sign organisation or extension ID: callers can
/// either use [`Self::verify_and_record_scoped`] / [`ScopedWebhookVerifierRegistry`] to bind
/// `(organisation_id, extension_id)` via `HMAC-SHA256(secret, org_id || ":" || ext_id)` or select
/// a distinct secret per pair. FIFO eviction/reset ends replay protection for forgotten IDs.
#[derive(Debug)]
pub struct ExtensionWebhookVerifier {
    organisation_id: OrganisationId,
    replay: HashSet<(String, UuidV7)>,
    order: VecDeque<(String, UuidV7)>,
    capacity: usize,
}

impl ExtensionWebhookVerifier {
    pub fn new(organisation_id: OrganisationId, capacity: usize) -> Result<Self, CoreError> {
        if !(1..=MAX_EMERGENCY_STATE_ENTRIES).contains(&capacity) {
            return Err(CoreError::InvalidCapacity);
        }
        Ok(Self {
            organisation_id,
            replay: HashSet::new(),
            order: VecDeque::new(),
            capacity,
        })
    }

    pub fn sign_scoped_payload(
        organisation_id: &OrganisationId,
        extension_id: &str,
        delivery_id: UuidV7,
        timestamp_secs: u64,
        secret: &[u8; 32],
        payload: &[u8],
    ) -> Result<String, CoreError> {
        if payload.len() > MAX_EXTENSION_WEBHOOK_PAYLOAD_BYTES {
            return Err(CoreError::PayloadTooLarge);
        }
        let scoped_secret = derive_extension_webhook_secret(secret, organisation_id, extension_id)?;
        let timestamp = timestamp_secs.to_string();
        let mut transcript = Vec::with_capacity(52 + payload.len());
        transcript.extend_from_slice(b"kodera-ext-v1:");
        transcript.extend_from_slice(timestamp.as_bytes());
        transcript.push(b':');
        transcript.extend_from_slice(delivery_id.as_bytes());
        transcript.push(b':');
        transcript.extend_from_slice(payload);
        Ok(encode_hex(&hmac_sha256(&scoped_secret, &transcript)))
    }

    /// Context-bound webhook verification deriving `HMAC-SHA256(secret, org_id || ":" || ext_id)`
    /// before checking the `kodera-ext-v1:` MAC and recording the delivery ID.
    #[allow(clippy::too_many_arguments)]
    pub fn verify_and_record_scoped(
        &mut self,
        organisation_id: &OrganisationId,
        extension_id: &str,
        delivery_id: UuidV7,
        timestamp_secs: u64,
        now_unix_secs: u64,
        secret: &[u8; 32],
        payload: &[u8],
        signature_hex: &str,
    ) -> Result<(), CoreError> {
        if organisation_id != &self.organisation_id {
            return Err(CoreError::OrganisationMismatch);
        }
        let scoped_secret = derive_extension_webhook_secret(secret, organisation_id, extension_id)?;
        self.verify_and_record(
            organisation_id,
            extension_id,
            delivery_id,
            timestamp_secs,
            now_unix_secs,
            &scoped_secret,
            payload,
            signature_hex,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn verify_and_record(
        &mut self,
        organisation_id: &OrganisationId,
        extension_id: &str,
        delivery_id: UuidV7,
        timestamp_secs: u64,
        now_unix_secs: u64,
        secret: &[u8; 32],
        payload: &[u8],
        signature_hex: &str,
    ) -> Result<(), CoreError> {
        if organisation_id != &self.organisation_id {
            return Err(CoreError::OrganisationMismatch);
        }
        validate_extension_id(extension_id)?;
        if now_unix_secs.abs_diff(timestamp_secs) > 300 {
            return Err(CoreError::StaleFrame);
        }
        if payload.len() > MAX_EXTENSION_WEBHOOK_PAYLOAD_BYTES {
            return Err(CoreError::PayloadTooLarge);
        }
        if signature_hex.len() != 64
            || !signature_hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(CoreError::InvalidSignature);
        }
        let supplied = decode_hex(signature_hex)?;
        let timestamp = timestamp_secs.to_string();
        let mut transcript = Vec::with_capacity(52 + payload.len());
        transcript.extend_from_slice(b"kodera-ext-v1:");
        transcript.extend_from_slice(timestamp.as_bytes());
        transcript.push(b':');
        transcript.extend_from_slice(delivery_id.as_bytes());
        transcript.push(b':');
        transcript.extend_from_slice(payload);
        let expected = hmac_sha256(secret, &transcript);
        // Fixed 32-byte comparison; no early return based on which signature byte differs.
        let different = expected
            .iter()
            .zip(supplied.iter())
            .fold(0u8, |difference, (a, b)| difference | (a ^ b));
        if different != 0 {
            return Err(CoreError::InvalidSignature);
        }
        let key = (extension_id.to_owned(), delivery_id);
        if self.replay.contains(&key) {
            return Err(CoreError::ReplayDetected);
        }
        if self.replay.len() == self.capacity {
            if let Some(oldest) = self.order.pop_front() {
                self.replay.remove(&oldest);
            }
        }
        self.replay.insert(key.clone());
        self.order.push_back(key);
        Ok(())
    }

    pub fn replay_count(&self) -> usize {
        self.replay.len()
    }
    pub fn clear(&mut self) {
        self.replay.clear();
        self.order.clear();
    }
}

/// Multi-organisation/extension webhook verifier registry enforcing both:
/// 1. Disjoint raw secret registration across distinct `(organisation_id, extension_id)` pairs
///    (tracked by SHA-256 fingerprint without retaining raw secret bytes).
/// 2. Context-bound HMAC derivation `HMAC-SHA256(secret, org_id || ":" || ext_id)` during verification.
#[derive(Debug)]
pub struct ScopedWebhookVerifierRegistry {
    verifiers: BTreeMap<OrganisationId, ExtensionWebhookVerifier>,
    pair_secret_fingerprints: BTreeMap<(OrganisationId, String), [u8; 32]>,
    fingerprint_owners: BTreeMap<[u8; 32], (OrganisationId, String)>,
    per_org_replay_capacity: usize,
}

impl ScopedWebhookVerifierRegistry {
    pub fn new(per_org_replay_capacity: usize) -> Result<Self, CoreError> {
        if !(1..=MAX_EMERGENCY_STATE_ENTRIES).contains(&per_org_replay_capacity) {
            return Err(CoreError::InvalidCapacity);
        }
        Ok(Self {
            verifiers: BTreeMap::new(),
            pair_secret_fingerprints: BTreeMap::new(),
            fingerprint_owners: BTreeMap::new(),
            per_org_replay_capacity,
        })
    }

    pub fn register_extension_secret(
        &mut self,
        organisation_id: OrganisationId,
        extension_id: &str,
        raw_secret: &[u8; 32],
    ) -> Result<(), CoreError> {
        validate_extension_id(extension_id)?;
        let pair = (organisation_id.clone(), extension_id.to_owned());
        let fingerprint = sha256(raw_secret);
        if let Some(owner) = self.fingerprint_owners.get(&fingerprint) {
            if owner != &pair {
                return Err(CoreError::UnauthorizedSender);
            }
        }
        if !self.pair_secret_fingerprints.contains_key(&pair)
            && self.pair_secret_fingerprints.len() == MAX_EMERGENCY_STATE_ENTRIES
        {
            return Err(CoreError::CapacityExceeded);
        }
        if !self.verifiers.contains_key(&organisation_id) {
            let verifier = ExtensionWebhookVerifier::new(
                organisation_id.clone(),
                self.per_org_replay_capacity,
            )?;
            self.verifiers.insert(organisation_id, verifier);
        }
        if let Some(previous) = self
            .pair_secret_fingerprints
            .insert(pair.clone(), fingerprint)
        {
            self.fingerprint_owners.remove(&previous);
        }
        self.fingerprint_owners.insert(fingerprint, pair);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn verify_and_record(
        &mut self,
        organisation_id: &OrganisationId,
        extension_id: &str,
        delivery_id: UuidV7,
        timestamp_secs: u64,
        now_unix_secs: u64,
        raw_secret: &[u8; 32],
        payload: &[u8],
        signature_hex: &str,
    ) -> Result<(), CoreError> {
        validate_extension_id(extension_id)?;
        let pair = (organisation_id.clone(), extension_id.to_owned());
        let Some(expected_fp) = self.pair_secret_fingerprints.get(&pair) else {
            return Err(CoreError::UnauthorizedSender);
        };
        let supplied_fp = sha256(raw_secret);
        let fp_diff = expected_fp
            .iter()
            .zip(supplied_fp.iter())
            .fold(0u8, |diff, (a, b)| diff | (a ^ b));
        if fp_diff != 0 {
            return Err(CoreError::UnauthorizedSender);
        }
        let verifier = self
            .verifiers
            .get_mut(organisation_id)
            .ok_or(CoreError::UnauthorizedSender)?;
        verifier.verify_and_record_scoped(
            organisation_id,
            extension_id,
            delivery_id,
            timestamp_secs,
            now_unix_secs,
            raw_secret,
            payload,
            signature_hex,
        )
    }

    pub fn clear(&mut self) {
        self.verifiers.clear();
        self.pair_secret_fingerprints.clear();
        self.fingerprint_owners.clear();
    }
}

// ---------------------------------------------------------------------------
// 3. `#urgence` Proximity Beacon & Store-and-Forward Frame Codec
// ---------------------------------------------------------------------------

/// Quick safety status badges for `#urgence` check-ins during a building outage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum SafetyStatus {
    MessageOnly = 0,
    Safe = 1,
    NeedAssistance = 2,
    MusterPoint = 3,
}

impl SafetyStatus {
    fn from_u8(val: u8) -> Result<Self, CoreError> {
        match val {
            0 => Ok(Self::MessageOnly),
            1 => Ok(Self::Safe),
            2 => Ok(Self::NeedAssistance),
            3 => Ok(Self::MusterPoint),
            _ => Err(CoreError::InvalidStatusBadge),
        }
    }
}

/// Compact, authenticated `#urgence` frame designed to fit inside a single BLE GATT write (`<= 256 B`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmergencyFrame {
    pub message_id: UuidV7,
    pub sender_public_key: Ed25519PublicKey,
    pub ttl_hops: u8,
    pub status: SafetyStatus,
    pub text: String,
    pub signature: Ed25519Signature,
}

impl EmergencyFrame {
    const MAGIC: [u8; 2] = *b"KE"; // Kodera Emergency v1
    const VERSION: u8 = 1;
    // 2 (magic) + 1 (ver) + 16 (uuid) + 32 (pk) + 1 (ttl) + 1 (status) + 1 (len) + 64 (sig) = 118 bytes fixed overhead
    const FIXED_OVERHEAD: usize = 118;

    /// Creates and signs a new outbound `#urgence` frame.
    ///
    /// Note: `ttl_hops` is NOT covered by the author's signature so intermediate nodes can
    /// decrement `ttl_hops` at each hop without invalidating end-to-end sender authenticity.
    pub fn new_signed(
        message_id: UuidV7,
        ttl_hops: u8,
        status: SafetyStatus,
        text: impl Into<String>,
        signer: &dyn DeviceIdentitySigner,
    ) -> Result<Self, CoreError> {
        if ttl_hops == 0 || ttl_hops > MAX_EMERGENCY_TTL_HOPS {
            return Err(CoreError::InvalidTtl);
        }
        let text = text.into();
        if text.len() > MAX_EMERGENCY_TEXT_BYTES {
            return Err(CoreError::PayloadTooLarge);
        }
        let sender_public_key = signer.public_key();
        let signing_payload =
            Self::signing_transcript(&message_id, &sender_public_key, status, text.as_bytes());
        let signature = signer.sign(&signing_payload)?;
        Ok(Self {
            message_id,
            sender_public_key,
            ttl_hops,
            status,
            text,
            signature,
        })
    }

    pub fn verify_sender(
        &self,
        allowed_org_roster: &HashSet<Ed25519PublicKey>,
        verifier: &dyn SignatureVerifier,
    ) -> Result<(), CoreError> {
        self.validate_structure()?;
        if !allowed_org_roster.contains(&self.sender_public_key) {
            return Err(CoreError::UnauthorizedSender);
        }
        let transcript = Self::signing_transcript(
            &self.message_id,
            &self.sender_public_key,
            self.status,
            self.text.as_bytes(),
        );
        verifier.verify(&self.sender_public_key, &transcript, &self.signature)
    }

    /// Decrements hop TTL for store-and-forward relaying; returns `None` when TTL reaches 0.
    pub fn decrement_hop(&self) -> Option<Self> {
        if !(2..=MAX_EMERGENCY_TTL_HOPS).contains(&self.ttl_hops) {
            return None;
        }
        let mut next = self.clone();
        next.ttl_hops -= 1;
        Some(next)
    }

    /// Refuses a frame whose UUIDv7 time is more than [`MAX_EMERGENCY_FUTURE_SKEW_MS`] ahead of
    /// `now_unix_ms`, the verifier's own clock. A frame exactly at the bound is accepted.
    pub fn check_not_future(&self, now_unix_ms: u64) -> Result<(), CoreError> {
        if self.message_id.timestamp_ms() > now_unix_ms.saturating_add(MAX_EMERGENCY_FUTURE_SKEW_MS)
        {
            return Err(CoreError::FutureFrame);
        }
        Ok(())
    }

    /// Convenience helper checking [`Self::check_not_future`] against the local system wall-clock.
    pub fn check_not_future_now(&self) -> Result<(), CoreError> {
        self.check_not_future(system_unix_ms())
    }

    /// [`Self::verified`] plus the clock rule ([`Self::check_not_future`]). A path that receives
    /// frames from other devices uses this one.
    pub fn verified_at(
        &self,
        allowed_org_roster: &HashSet<Ed25519PublicKey>,
        verifier: &dyn SignatureVerifier,
        now_unix_ms: u64,
    ) -> Result<VerifiedEmergencyFrame, CoreError> {
        self.check_not_future(now_unix_ms)?;
        self.verified(allowed_org_roster, verifier)
    }

    /// Convenience helper verifying a received peer frame against the local system wall-clock ([`Self::verified_at`]).
    pub fn verified_now(
        &self,
        allowed_org_roster: &HashSet<Ed25519PublicKey>,
        verifier: &dyn SignatureVerifier,
    ) -> Result<VerifiedEmergencyFrame, CoreError> {
        self.verified_at(allowed_org_roster, verifier, system_unix_ms())
    }

    /// Produces an immutable proof token only after structural, roster and signature checks.
    /// It does not read a clock: a frame from another device goes through [`Self::verified_at`].
    pub fn verified(
        &self,
        allowed_org_roster: &HashSet<Ed25519PublicKey>,
        verifier: &dyn SignatureVerifier,
    ) -> Result<VerifiedEmergencyFrame, CoreError> {
        self.verify_sender(allowed_org_roster, verifier)?;
        Ok(VerifiedEmergencyFrame(self.clone()))
    }

    fn validate_structure(&self) -> Result<(), CoreError> {
        if !(1..=MAX_EMERGENCY_TTL_HOPS).contains(&self.ttl_hops) {
            return Err(CoreError::InvalidTtl);
        }
        if self.text.len() > MAX_EMERGENCY_TEXT_BYTES {
            return Err(CoreError::PayloadTooLarge);
        }
        Ok(())
    }

    pub fn encode(&self) -> Result<Vec<u8>, CoreError> {
        self.validate_structure()?;
        let text_bytes = self.text.as_bytes();
        if text_bytes.len() > MAX_EMERGENCY_TEXT_BYTES {
            return Err(CoreError::PayloadTooLarge);
        }
        let total = Self::FIXED_OVERHEAD + text_bytes.len();
        if total > MAX_EMERGENCY_FRAME_BYTES {
            return Err(CoreError::PayloadTooLarge);
        }
        let mut out = Vec::with_capacity(total);
        out.extend_from_slice(&Self::MAGIC);
        out.push(Self::VERSION);
        out.extend_from_slice(self.message_id.as_bytes());
        out.extend_from_slice(&self.sender_public_key);
        out.push(self.ttl_hops);
        out.push(self.status as u8);
        out.push(text_bytes.len() as u8);
        out.extend_from_slice(text_bytes);
        out.extend_from_slice(&self.signature);
        Ok(out)
    }

    pub fn decode(raw: &[u8]) -> Result<Self, CoreError> {
        if raw.len() < Self::FIXED_OVERHEAD || raw.len() > MAX_EMERGENCY_FRAME_BYTES {
            return Err(CoreError::MalformedFrame);
        }
        if raw[0..2] != Self::MAGIC || raw[2] != Self::VERSION {
            return Err(CoreError::MalformedFrame);
        }
        let mut uuid_bytes = [0u8; 16];
        uuid_bytes.copy_from_slice(&raw[3..19]);
        let message_id = UuidV7::from_bytes_checked(uuid_bytes)?;

        let mut sender_public_key = [0u8; 32];
        sender_public_key.copy_from_slice(&raw[19..51]);

        let ttl_hops = raw[51];
        if ttl_hops == 0 || ttl_hops > MAX_EMERGENCY_TTL_HOPS {
            return Err(CoreError::InvalidTtl);
        }
        let status = SafetyStatus::from_u8(raw[52])?;
        let text_len = raw[53] as usize;
        if text_len > MAX_EMERGENCY_TEXT_BYTES || Self::FIXED_OVERHEAD + text_len != raw.len() {
            return Err(CoreError::MalformedFrame);
        }
        let text = std::str::from_utf8(&raw[54..54 + text_len])
            .map_err(|_| CoreError::MalformedFrame)?
            .to_owned();

        let mut signature = [0u8; 64];
        signature.copy_from_slice(&raw[54 + text_len..]);

        Ok(Self {
            message_id,
            sender_public_key,
            ttl_hops,
            status,
            text,
            signature,
        })
    }

    /// Creates and signs an organisation-context-bound `#urgence` frame whose signature
    /// transcript commits to `organisation_id` and `organisation_beacon`, preventing cross-org
    /// public beacon retagging even if an `Ed25519` device key were present in two rosters.
    pub fn sign_for_organisation(
        organisation_id: &OrganisationId,
        organisation_beacon: [u8; 8],
        message_id: UuidV7,
        ttl_hops: u8,
        status: SafetyStatus,
        text: impl Into<String>,
        signer: &dyn DeviceIdentitySigner,
    ) -> Result<Self, CoreError> {
        if ttl_hops == 0 || ttl_hops > MAX_EMERGENCY_TTL_HOPS {
            return Err(CoreError::InvalidTtl);
        }
        let text = text.into();
        if text.len() > MAX_EMERGENCY_TEXT_BYTES {
            return Err(CoreError::PayloadTooLarge);
        }
        let sender_public_key = signer.public_key();
        let signing_payload = Self::organisation_signing_transcript(
            organisation_id,
            organisation_beacon,
            &message_id,
            &sender_public_key,
            status,
            text.as_bytes(),
        );
        let signature = signer.sign(&signing_payload)?;
        Ok(Self {
            message_id,
            sender_public_key,
            ttl_hops,
            status,
            text,
            signature,
        })
    }

    pub fn verify_for_organisation(
        &self,
        organisation_id: &OrganisationId,
        organisation_beacon: [u8; 8],
        allowed_org_roster: &HashSet<Ed25519PublicKey>,
        verifier: &dyn SignatureVerifier,
    ) -> Result<(), CoreError> {
        self.validate_structure()?;
        if !allowed_org_roster.contains(&self.sender_public_key) {
            return Err(CoreError::UnauthorizedSender);
        }
        let transcript = Self::organisation_signing_transcript(
            organisation_id,
            organisation_beacon,
            &self.message_id,
            &self.sender_public_key,
            self.status,
            self.text.as_bytes(),
        );
        verifier.verify(&self.sender_public_key, &transcript, &self.signature)
    }

    pub fn verified_for_organisation(
        &self,
        organisation_id: &OrganisationId,
        organisation_beacon: [u8; 8],
        allowed_org_roster: &HashSet<Ed25519PublicKey>,
        verifier: &dyn SignatureVerifier,
    ) -> Result<VerifiedEmergencyFrame, CoreError> {
        self.verify_for_organisation(
            organisation_id,
            organisation_beacon,
            allowed_org_roster,
            verifier,
        )?;
        Ok(VerifiedEmergencyFrame(self.clone()))
    }

    pub fn verified_for_organisation_at(
        &self,
        organisation_id: &OrganisationId,
        organisation_beacon: [u8; 8],
        allowed_org_roster: &HashSet<Ed25519PublicKey>,
        verifier: &dyn SignatureVerifier,
        now_unix_ms: u64,
    ) -> Result<VerifiedEmergencyFrame, CoreError> {
        self.check_not_future(now_unix_ms)?;
        self.verified_for_organisation(
            organisation_id,
            organisation_beacon,
            allowed_org_roster,
            verifier,
        )
    }

    fn signing_transcript(
        message_id: &UuidV7,
        sender_pk: &Ed25519PublicKey,
        status: SafetyStatus,
        text: &[u8],
    ) -> Vec<u8> {
        let mut buf = Vec::with_capacity(70 + text.len());
        buf.extend_from_slice(b"kodera-emergency-v1:");
        buf.extend_from_slice(message_id.as_bytes());
        buf.extend_from_slice(sender_pk);
        buf.push(status as u8);
        buf.push(text.len() as u8);
        buf.extend_from_slice(text);
        buf
    }

    fn organisation_signing_transcript(
        organisation_id: &OrganisationId,
        organisation_beacon: [u8; 8],
        message_id: &UuidV7,
        sender_pk: &Ed25519PublicKey,
        status: SafetyStatus,
        text: &[u8],
    ) -> Vec<u8> {
        let org_bytes = organisation_id.as_str().as_bytes();
        let mut buf = Vec::with_capacity(83 + org_bytes.len() + text.len());
        buf.extend_from_slice(b"kodera-emergency-org-v1:");
        buf.extend_from_slice(org_bytes);
        buf.push(b':');
        buf.extend_from_slice(&organisation_beacon);
        buf.extend_from_slice(message_id.as_bytes());
        buf.extend_from_slice(sender_pk);
        buf.push(status as u8);
        buf.push(text.len() as u8);
        buf.extend_from_slice(text);
        buf
    }
}

/// Multi-organisation signing key isolation guard for `#urgence` rosters.
///
/// Rejects registering or reusing the same `Ed25519PublicKey` (or `organisation_beacon`)
/// across distinct `(OrganisationId, organisation_beacon)` contexts so v1 frames cannot be
/// retagged across organisations via a shared device key.
#[derive(Debug, Default)]
pub struct EmergencyOrganisationKeyGuard {
    rosters: BTreeMap<OrganisationId, ([u8; 8], HashSet<Ed25519PublicKey>)>,
    key_owners: BTreeMap<Ed25519PublicKey, (OrganisationId, [u8; 8])>,
    beacon_owners: BTreeMap<[u8; 8], OrganisationId>,
}

impl EmergencyOrganisationKeyGuard {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_roster(
        &mut self,
        organisation_id: OrganisationId,
        organisation_beacon: [u8; 8],
        roster: HashSet<Ed25519PublicKey>,
    ) -> Result<(), CoreError> {
        if roster.is_empty() || roster.len() > MAX_EMERGENCY_ROSTER_MEMBERS {
            return Err(CoreError::InvalidCapacity);
        }
        if let Some(owner) = self.beacon_owners.get(&organisation_beacon) {
            if owner != &organisation_id {
                return Err(CoreError::OrganisationMismatch);
            }
        }
        for key in &roster {
            if let Some((owner_org, owner_beacon)) = self.key_owners.get(key) {
                if owner_org != &organisation_id || owner_beacon != &organisation_beacon {
                    return Err(CoreError::UnauthorizedSender);
                }
            }
        }
        let existing_len = self
            .rosters
            .get(&organisation_id)
            .map_or(0, |(_, prev)| prev.len());
        if self
            .key_owners
            .len()
            .saturating_sub(existing_len)
            .saturating_add(roster.len())
            > MAX_EMERGENCY_ROSTER_MEMBERS
        {
            return Err(CoreError::CapacityExceeded);
        }
        if let Some((old_beacon, old_roster)) = self.rosters.remove(&organisation_id) {
            self.beacon_owners.remove(&old_beacon);
            for key in old_roster {
                self.key_owners.remove(&key);
            }
        }
        self.beacon_owners
            .insert(organisation_beacon, organisation_id.clone());
        for &key in &roster {
            self.key_owners
                .insert(key, (organisation_id.clone(), organisation_beacon));
        }
        self.rosters
            .insert(organisation_id, (organisation_beacon, roster));
        Ok(())
    }

    pub fn verify_v1_frame_in_context(
        &self,
        organisation_id: &OrganisationId,
        observed_beacon: [u8; 8],
        frame: &EmergencyFrame,
        verifier: &dyn SignatureVerifier,
        now_unix_ms: u64,
    ) -> Result<VerifiedEmergencyFrame, CoreError> {
        let Some((expected_beacon, roster)) = self.rosters.get(organisation_id) else {
            return Err(CoreError::UnauthorizedSender);
        };
        if expected_beacon != &observed_beacon {
            return Err(CoreError::UnauthorizedSender);
        }
        let Some((owner_org, owner_beacon)) = self.key_owners.get(&frame.sender_public_key) else {
            return Err(CoreError::UnauthorizedSender);
        };
        if owner_org != organisation_id || owner_beacon != &observed_beacon {
            return Err(CoreError::UnauthorizedSender);
        }
        frame.verified_at(roster, verifier, now_unix_ms)
    }

    pub fn clear(&mut self) {
        self.rosters.clear();
        self.key_owners.clear();
        self.beacon_owners.clear();
    }
}

/// Deduplication ring preventing epidemic gossip broadcast storms across BLE/mDNS hops.
#[derive(Debug)]
pub struct EmergencyReplayGuard {
    seen: HashSet<UuidV7>,
    max_entries: usize,
}

impl EmergencyReplayGuard {
    pub fn clear(&mut self) {
        self.seen.clear();
    }

    pub fn new(max_entries: usize) -> Self {
        Self {
            seen: HashSet::new(),
            max_entries: max_entries.clamp(1, MAX_EMERGENCY_REPLAY_ENTRIES),
        }
    }

    pub fn contains(&self, id: &UuidV7) -> bool {
        self.seen.contains(id)
    }

    /// Returns `true` if `id` is absent from the bounded recent history and records it.
    /// Oldest UUIDs are evicted at capacity; this is not an unbounded replay archive.
    pub fn accept_once(&mut self, id: UuidV7) -> bool {
        if self.seen.contains(&id) {
            return false;
        }
        if self.seen.len() >= self.max_entries {
            if let Some(&oldest) = self.seen.iter().min() {
                self.seen.remove(&oldest);
            }
        }
        self.seen.insert(id)
    }
}

impl Default for EmergencyReplayGuard {
    fn default() -> Self {
        Self::new(512)
    }
}

/// Immutable frame whose signature and organisation membership were checked by a trusted provider.
/// The inner frame cannot be constructed or modified by callers after verification.
#[derive(Debug, Clone)]
pub struct VerifiedEmergencyFrame(EmergencyFrame);

impl VerifiedEmergencyFrame {
    pub fn frame(&self) -> &EmergencyFrame {
        &self.0
    }
}

fn relay_priority(frame: &EmergencyFrame) -> (u8, UuidV7) {
    let priority = match frame.status {
        SafetyStatus::NeedAssistance => 3,
        SafetyStatus::MusterPoint => 2,
        SafetyStatus::Safe => 1,
        SafetyStatus::MessageOnly => 0,
    };
    (priority, frame.message_id)
}

/// Bounded verified outbox. At capacity, a higher-priority/newer frame replaces the least
/// important pending frame; lower-priority frames are refused without poisoning replay history.
#[derive(Debug)]
pub struct EmergencyMeshQueue {
    frames: Vec<EmergencyFrame>,
    replay: EmergencyReplayGuard,
    capacity: usize,
}

impl EmergencyMeshQueue {
    pub fn clear(&mut self) {
        self.frames.clear();
        self.replay.clear();
    }

    pub fn new(max_capacity: usize) -> Result<Self, CoreError> {
        if !(1..=MAX_EMERGENCY_QUEUE_CAPACITY).contains(&max_capacity) {
            return Err(CoreError::InvalidCapacity);
        }
        Ok(Self {
            frames: Vec::new(),
            replay: EmergencyReplayGuard::new(max_capacity.saturating_mul(4)),
            capacity: max_capacity,
        })
    }

    pub fn len(&self) -> usize {
        self.frames.len()
    }
    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Pending IDs are checked independently of the bounded replay cache so cache eviction
    /// cannot create a duplicate of a low-priority frame that is still waiting to be sent.
    pub fn contains(&self, id: &UuidV7) -> bool {
        self.frames.iter().any(|frame| &frame.message_id == id) || self.replay.contains(id)
    }

    /// Originating frames retain their hop budget; only a receiving relay decrements it.
    pub fn enqueue_local(&mut self, verified: &VerifiedEmergencyFrame) -> bool {
        self.enqueue(verified.frame().clone())
    }

    pub fn enqueue_relay(&mut self, verified: &VerifiedEmergencyFrame) -> bool {
        verified
            .frame()
            .decrement_hop()
            .is_some_and(|frame| self.enqueue(frame))
    }

    fn enqueue(&mut self, frame: EmergencyFrame) -> bool {
        if self.contains(&frame.message_id) {
            return false;
        }
        if self.frames.len() == self.capacity {
            let (index, lowest) = self
                .frames
                .iter()
                .enumerate()
                .min_by_key(|(_, pending)| relay_priority(pending))
                .expect("a full nonzero-capacity queue has a frame");
            if relay_priority(&frame) <= relay_priority(lowest) {
                return false;
            }
            self.frames.remove(index);
        }
        self.replay.accept_once(frame.message_id);
        self.frames.push(frame);
        true
    }

    /// Returns highest priority first; newer complete UUIDv7 values break timestamp ties.
    pub fn drain(&mut self, max_frames: usize) -> Vec<EmergencyFrame> {
        self.frames
            .sort_unstable_by_key(|frame| std::cmp::Reverse(relay_priority(frame)));
        self.frames
            .drain(..max_frames.min(self.frames.len()))
            .collect()
    }
}

/// Deterministic device-specific relay delay in 25..=275 ms. Scheduling the returned delay
/// remains the transport adapter's responsibility; this does not itself access a radio.
pub fn compute_relay_backoff_ms(message_id: &UuidV7, device_pk: &Ed25519PublicKey) -> u32 {
    let mut transcript = Vec::with_capacity(64);
    transcript.extend_from_slice(b"kodera-relay-v1");
    transcript.extend_from_slice(message_id.as_bytes());
    transcript.extend_from_slice(device_pk);
    let hash = sha256(&transcript);
    25 + u32::from_be_bytes([hash[0], hash[1], hash[2], hash[3]]) % 251
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmergencyMemberStatus {
    pub message_id: UuidV7,
    pub sender_public_key: Ed25519PublicKey,
    pub status: SafetyStatus,
    pub text: String,
    pub timestamp_ms: u64,
    /// Unsigned hop metadata, not a trusted location or distance measurement.
    pub ttl_hops: u8,
}

/// Latest verified status per device. No expiration implies current safety: these remain
/// historical check-ins until replaced; the UI must display their timestamps.
#[derive(Debug)]
pub struct EmergencyRosterTracker {
    members: BTreeMap<Ed25519PublicKey, EmergencyMemberStatus>,
    max_members: usize,
}

impl EmergencyRosterTracker {
    pub fn clear(&mut self) {
        self.members.clear();
    }

    pub fn new(max_members: usize) -> Result<Self, CoreError> {
        if max_members > MAX_EMERGENCY_ROSTER_MEMBERS {
            return Err(CoreError::InvalidCapacity);
        }
        Ok(Self {
            members: BTreeMap::new(),
            max_members,
        })
    }

    pub fn can_observe(&self, verified: &VerifiedEmergencyFrame) -> Result<bool, CoreError> {
        let frame = verified.frame();
        if let Some(previous) = self.members.get(&frame.sender_public_key) {
            return Ok(frame.message_id > previous.message_id);
        }
        if self.members.len() == self.max_members {
            return Err(CoreError::CapacityExceeded);
        }
        Ok(true)
    }

    pub fn observe(&mut self, verified: &VerifiedEmergencyFrame) -> Result<bool, CoreError> {
        if !self.can_observe(verified)? {
            return Ok(false);
        }
        let frame = verified.frame();
        self.members.insert(
            frame.sender_public_key,
            EmergencyMemberStatus {
                message_id: frame.message_id,
                sender_public_key: frame.sender_public_key,
                status: frame.status,
                text: frame.text.clone(),
                timestamp_ms: frame.message_id.timestamp_ms(),
                ttl_hops: frame.ttl_hops,
            },
        );
        Ok(true)
    }

    pub fn statuses(&self) -> Vec<EmergencyMemberStatus> {
        self.members.values().cloned().collect()
    }
}

/// Lowercase hex for cross-platform byte fixtures, without punctuation or whitespace.
pub fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(HEX[(byte >> 4) as usize] as char);
        result.push(HEX[(byte & 15) as usize] as char);
    }
    result
}

pub fn decode_hex(hex: &str) -> Result<Vec<u8>, CoreError> {
    fn nibble(byte: u8) -> Result<u8, CoreError> {
        match byte {
            b'0'..=b'9' => Ok(byte - b'0'),
            b'a'..=b'f' => Ok(byte - b'a' + 10),
            b'A'..=b'F' => Ok(byte - b'A' + 10),
            _ => Err(CoreError::InvalidHex),
        }
    }
    if hex.len() % 2 != 0 {
        return Err(CoreError::InvalidHex);
    }
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| Ok((nibble(pair[0])? << 4) | nibble(pair[1])?))
        .collect()
}

/// Cross-OS local transport trait implemented by Local Wi-Fi (`mDNS + QUIC`) and `BLE GATT`.
pub trait ProximityTransport: Send + Sync {
    fn advertise_org_beacon(&mut self, beacon_id: [u8; 8]) -> Result<(), CoreError>;
    fn broadcast_frame(&mut self, wire_bytes: &[u8]) -> Result<(), CoreError>;
    fn stop(&mut self) -> Result<(), CoreError>;
}

/// Returns the current system wall-clock in milliseconds since the Unix epoch.
pub fn system_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Returns the current system wall-clock in whole seconds since the Unix epoch.
pub fn system_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Computes an 8-byte rotating pseudonymous BLE beacon ID for an organisation.
///
/// Outsiders scanning Bluetooth see a rotating random-looking 8-byte tag every 5 minutes
/// and cannot identify the company, while provisioned org members recognize colleagues immediately.
pub fn compute_proximity_beacon(org_beacon_salt: &[u8; 32], unix_secs: u64) -> [u8; 8] {
    let bucket = unix_secs / BEACON_ROTATION_WINDOW_SECS;
    let mut msg = [0u8; 24];
    msg[0..16].copy_from_slice(b"kodera-beacon-v1");
    msg[16..24].copy_from_slice(&bucket.to_be_bytes());
    let mac = hmac_sha256(org_beacon_salt, &msg);
    let mut tag = [0u8; 8];
    tag.copy_from_slice(&mac[0..8]);
    tag
}

// ---------------------------------------------------------------------------
// 4. Self-Contained FIPS 180-4 SHA-256 & RFC 2104 HMAC-SHA256
// ---------------------------------------------------------------------------

pub fn sha256(data: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    let bit_len = (data.len() as u64) * 8;
    let mut padded = data.to_vec();
    padded.push(0x80);
    while (padded.len() % 64) != 56 {
        padded.push(0x00);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in padded.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let mut a = h[0];
        let mut b = h[1];
        let mut c = h[2];
        let mut d = h[3];
        let mut e = h[4];
        let mut f = h[5];
        let mut g = h[6];
        let mut hh = h[7];

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..(i + 1) * 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut key_block = [0u8; 64];
    if key.len() > 64 {
        let hashed = sha256(key);
        key_block[0..32].copy_from_slice(&hashed);
    } else {
        key_block[0..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= key_block[i];
        opad[i] ^= key_block[i];
    }

    let mut inner = Vec::with_capacity(64 + message.len());
    inner.extend_from_slice(&ipad);
    inner.extend_from_slice(message);
    let inner_hash = sha256(&inner);

    let mut outer = [0u8; 96];
    outer[0..64].copy_from_slice(&opad);
    outer[64..96].copy_from_slice(&inner_hash);
    sha256(&outer)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreError {
    InvalidTheme,
    InvalidUserProfile,
    InvalidIamPolicy,
    InvalidDocsPad,
    InvalidPoll,
    InvalidPollVote,
    PollClosed,
    PollExists,
    PollNotFound,
    InvalidIban,
    InvalidConnectorUrl,
    InvalidSoundPack,
    InvalidDocsUrl,
    UntrustedDocsOrigin,
    InvalidExtensionId,
    InvalidOrganisation,
    OrganisationMismatch,
    AlgorithmMismatch,
    InvalidUuidV7,
    InvalidHex,
    InvalidCapacity,
    CapacityExceeded,
    ReplayDetected,
    StaleFrame,
    /// An emergency frame dated more than `MAX_EMERGENCY_FUTURE_SKEW_MS` ahead of the verifier.
    FutureFrame,
    InvalidTtl,
    InvalidStatusBadge,
    PayloadTooLarge,
    MalformedFrame,
    UnauthorizedSender,
    InvalidSignature,
    CryptoFailure,
    TransportUnavailable,
}

#[cfg(test)]
mod sound_pack_tests {
    use super::*;

    #[test]
    fn native_packs_round_trip_exact_ids_and_silence() {
        for pack in [
            SoundPackId::Givre,
            SoundPackId::Cristal,
            SoundPackId::Atelier,
            SoundPackId::Arcade8Bit,
            SoundPackId::Glitch404,
            SoundPackId::Silent,
        ] {
            assert_eq!(SoundPackId::parse(pack.as_slug()), Ok(pack));
            assert_eq!(pack.is_silent(), pack == SoundPackId::Silent);
        }
    }

    #[test]
    fn native_pack_ids_refuse_case_whitespace_and_legacy_aliases() {
        for slug in [
            "",
            "Givre",
            " givre",
            "givre ",
            "kodera-givre",
            "feutre",
            "impulsion",
            "8bit-atelier",
            "silencieux",
            "unknown",
        ] {
            assert_eq!(SoundPackId::parse(slug), Err(CoreError::InvalidSoundPack));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestKeyedMacSigner {
        secret: [u8; 32],
        pk: Ed25519PublicKey,
    }

    impl DeviceIdentitySigner for TestKeyedMacSigner {
        fn public_key(&self) -> Ed25519PublicKey {
            self.pk
        }

        fn sign(&self, message: &[u8]) -> Result<Ed25519Signature, CoreError> {
            let left = hmac_sha256(&self.secret, message);
            let right = hmac_sha256(&left, &self.pk);
            let mut sig = [0u8; 64];
            sig[0..32].copy_from_slice(&left);
            sig[32..64].copy_from_slice(&right);
            Ok(sig)
        }
    }

    struct TestKeyedMacVerifier {
        secret: [u8; 32],
    }

    impl SignatureVerifier for TestKeyedMacVerifier {
        fn verify(
            &self,
            public_key: &Ed25519PublicKey,
            message: &[u8],
            signature: &Ed25519Signature,
        ) -> Result<(), CoreError> {
            let left = hmac_sha256(&self.secret, message);
            let right = hmac_sha256(&left, public_key);
            if signature[0..32] == left && signature[32..64] == right {
                Ok(())
            } else {
                Err(CoreError::InvalidSignature)
            }
        }
    }

    #[test]
    fn hmac_sha256_matches_rfc_4231_test_case_2() {
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        let expected: [u8; 32] = [
            0x5b, 0xdc, 0xc1, 0x46, 0xbf, 0x60, 0x75, 0x4e, 0x6a, 0x04, 0x24, 0x26, 0x08, 0x95,
            0x75, 0xc7, 0x5a, 0x00, 0x3f, 0x08, 0x9d, 0x27, 0x39, 0x83, 0x9d, 0xec, 0x58, 0xb9,
            0x64, 0xec, 0x38, 0x43,
        ];
        assert_eq!(mac, expected);
    }

    #[test]
    fn uuidv7_preserves_monotonic_timestamp_and_rejects_v4_bytes() {
        let earlier = UuidV7::from_parts(1_762_520_000_000, [1; 10]);
        let later = UuidV7::from_parts(1_762_520_000_001, [0; 10]);
        assert!(later > earlier);
        assert_eq!(earlier.timestamp_ms(), 1_762_520_000_000);
        assert_eq!(earlier.to_string().len(), 36);

        let mut invalid = *earlier.as_bytes();
        invalid[6] = 0x40; // v4 instead of v7
        assert_eq!(
            UuidV7::from_bytes_checked(invalid),
            Err(CoreError::InvalidUuidV7)
        );
    }

    #[test]
    fn proximity_beacon_is_stable_within_window_and_rotates_after_5_minutes() {
        let salt = [0x42u8; 32];
        let b1 = compute_proximity_beacon(&salt, 1_762_520_100);
        let b2 = compute_proximity_beacon(&salt, 1_762_520_299);
        let b3 = compute_proximity_beacon(&salt, 1_762_520_400);
        assert_eq!(b1, b2);
        assert_ne!(b1, b3);
    }

    #[test]
    fn emergency_frame_roundtrips_survives_hop_decrement_and_rejects_tampering() {
        let signer = TestKeyedMacSigner {
            secret: [7u8; 32],
            pk: [9u8; 32],
        };
        let verifier = TestKeyedMacVerifier { secret: [7u8; 32] };
        let mut roster = HashSet::new();
        roster.insert([9u8; 32]);

        let id = UuidV7::from_parts(1_762_520_000_500, [3; 10]);
        let frame = EmergencyFrame::new_signed(
            id,
            4,
            SafetyStatus::Safe,
            "Floor 3 clear - gathering at north courtyard",
            &signer,
        )
        .expect("valid signed frame");

        let wire = frame.encode().expect("fits <= 256 bytes");
        assert!(wire.len() <= MAX_EMERGENCY_FRAME_BYTES);

        let decoded = EmergencyFrame::decode(&wire).expect("valid wire frame");
        assert_eq!(decoded, frame);
        assert_eq!(decoded.verify_sender(&roster, &verifier), Ok(()));

        // Relaying decrements TTL without breaking author signature!
        let relayed = decoded.decrement_hop().expect("ttl 3 remaining");
        assert_eq!(relayed.ttl_hops, 3);
        assert_eq!(relayed.verify_sender(&roster, &verifier), Ok(()));

        // Mutation self-test 1: tampered text MUST fail signature verification
        let mut forged = relayed.clone();
        forged.text = "Forged evacuation order".to_owned();
        assert_eq!(
            forged.verify_sender(&roster, &verifier),
            Err(CoreError::InvalidSignature)
        );

        // Mutation self-test 2: revoked/non-member public key MUST fail roster check
        let empty_roster = HashSet::new();
        assert_eq!(
            relayed.verify_sender(&empty_roster, &verifier),
            Err(CoreError::UnauthorizedSender)
        );
    }

    #[test]
    fn replay_guard_deduplicates_epidemic_broadcasts() {
        let mut guard = EmergencyReplayGuard::new(64);
        let id = UuidV7::from_parts(1_762_520_000_000, [5; 10]);
        assert!(guard.accept_once(id));
        assert!(!guard.accept_once(id));
    }

    #[test]
    fn crypto_algorithm_discriminates_matrix_olm_and_openmls() {
        assert_eq!(
            CryptoAlgorithm::from_u8(1),
            Ok(CryptoAlgorithm::MatrixOlmV1)
        );
        assert_eq!(
            CryptoAlgorithm::from_u8(2),
            Ok(CryptoAlgorithm::OpenMlsDraft)
        );
        assert_eq!(CryptoAlgorithm::from_u8(0), Err(CoreError::CryptoFailure));
        assert_eq!(CryptoAlgorithm::from_u8(99), Err(CoreError::CryptoFailure));
    }

    fn checked_frame(ts: u64, status: SafetyStatus, key: u8) -> VerifiedEmergencyFrame {
        let signer = TestKeyedMacSigner {
            secret: [7; 32],
            pk: [key; 32],
        };
        let frame = EmergencyFrame::new_signed(
            UuidV7::from_parts(ts, [3; 10]),
            3,
            status,
            "check-in",
            &signer,
        )
        .unwrap();
        frame
            .verified(
                &HashSet::from([[key; 32]]),
                &TestKeyedMacVerifier { secret: [7; 32] },
            )
            .unwrap()
    }

    #[test]
    fn canonical_beacon_and_real_ed25519_wire_fixture_are_byte_exact() {
        // Signature generated with the published RFC 8032 test 1 public key; independently
        // checked with native providers by other platforms. This crate injects its verifier.
        let wire_hex = "4b4501019a5e626ca073038303030303030303d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a03010bc380206ce2809961627269de751167ed246633a763a7ea63c555078167ddf5960d86437c64e3bf3a50e27e8d2f15a871c011221283833943f8a5a1a5b9bb758a6b9f31d60aa771cb89c005";
        let transcript_hex = "6b6f646572612d656d657267656e63792d76313a019a5e626ca073038303030303030303d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a010bc380206ce2809961627269";
        let wire = decode_hex(wire_hex).unwrap();
        let frame = EmergencyFrame::decode(&wire).unwrap();
        assert_eq!(wire.len(), 129);
        assert_eq!(frame.message_id.timestamp_ms(), 1_762_520_100_000);
        assert_eq!(
            frame.message_id,
            UuidV7::from_parts(1_762_520_100_000, [3; 10])
        );
        assert_eq!(frame.status, SafetyStatus::Safe);
        assert_eq!(frame.ttl_hops, 3);
        assert_eq!(frame.text, "À l’abri");
        assert_eq!(frame.text.len(), 11);
        assert_eq!(encode_hex(&frame.encode().unwrap()), wire_hex);
        assert_eq!(
            encode_hex(&EmergencyFrame::signing_transcript(
                &frame.message_id,
                &frame.sender_public_key,
                frame.status,
                frame.text.as_bytes(),
            )),
            transcript_hex
        );
        let relayed = frame.decrement_hop().unwrap();
        assert_eq!(relayed.signature, frame.signature);
        assert_eq!(
            EmergencyFrame::signing_transcript(
                &relayed.message_id,
                &relayed.sender_public_key,
                relayed.status,
                relayed.text.as_bytes()
            ),
            decode_hex(transcript_hex).unwrap()
        );
        assert_eq!(
            encode_hex(&compute_proximity_beacon(&[0x42; 32], 1_762_520_100)),
            "1be3967637ebb0ea"
        );
        for bad in ["a", "xx", "00 0", "é", "0\n"] {
            assert_eq!(decode_hex(bad), Err(CoreError::InvalidHex));
        }
        assert_eq!(decode_hex("A0fF").unwrap(), vec![0xa0, 0xff]);
    }

    #[test]
    fn verified_boundary_rejects_typed_ttl_and_payload_mutations() {
        let verified = checked_frame(10, SafetyStatus::Safe, 9);
        for ttl in [0, 7, 255] {
            let mut frame = verified.frame().clone();
            frame.ttl_hops = ttl;
            assert_eq!(frame.encode(), Err(CoreError::InvalidTtl));
            assert!(frame.decrement_hop().is_none());
            assert!(matches!(
                frame.verified(
                    &HashSet::from([[9; 32]]),
                    &TestKeyedMacVerifier { secret: [7; 32] }
                ),
                Err(CoreError::InvalidTtl)
            ));
        }
        let mut frame = verified.frame().clone();
        frame.text = "é".repeat(70);
        assert_eq!(frame.encode(), Err(CoreError::PayloadTooLarge));
        assert!(matches!(
            frame.verified(
                &HashSet::from([[9; 32]]),
                &TestKeyedMacVerifier { secret: [7; 32] }
            ),
            Err(CoreError::PayloadTooLarge)
        ));
    }

    #[test]
    fn queue_drains_priority_then_newest_and_honours_hop_exhaustion() {
        let mut queue = EmergencyMeshQueue::new(8).unwrap();
        for (ts, status) in [
            (9, SafetyStatus::MessageOnly),
            (8, SafetyStatus::Safe),
            (7, SafetyStatus::MusterPoint),
            (6, SafetyStatus::NeedAssistance),
            (10, SafetyStatus::Safe),
        ] {
            assert!(queue.enqueue_relay(&checked_frame(ts, status, 9)));
        }
        assert!(queue.drain(0).is_empty());
        assert_eq!(queue.len(), 5);
        let frames = queue.drain(99);
        assert_eq!(
            frames
                .iter()
                .map(|f| f.message_id.timestamp_ms())
                .collect::<Vec<_>>(),
            vec![6, 7, 10, 8, 9]
        );
        assert!(frames.iter().all(|f| f.ttl_hops == 2));
        assert!(queue.is_empty());
        let mut exhausted = checked_frame(11, SafetyStatus::Safe, 9).frame().clone();
        exhausted.ttl_hops = 1;
        let exhausted = exhausted
            .verified(
                &HashSet::from([[9; 32]]),
                &TestKeyedMacVerifier { secret: [7; 32] },
            )
            .unwrap();
        assert!(!queue.enqueue_relay(&exhausted));
        assert!(queue.is_empty());
    }

    #[test]
    fn queue_rejects_overflow_without_poisoning_retry_and_preserves_pending_dedup() {
        assert!(matches!(
            EmergencyMeshQueue::new(0),
            Err(CoreError::InvalidCapacity)
        ));
        assert!(matches!(
            EmergencyMeshQueue::new(129),
            Err(CoreError::InvalidCapacity)
        ));
        let mut queue = EmergencyMeshQueue::new(2).unwrap();
        let pending = checked_frame(1, SafetyStatus::MessageOnly, 9);
        assert!(queue.enqueue_local(&pending));
        for ts in 2..30 {
            let urgent = checked_frame(ts, SafetyStatus::NeedAssistance, 9);
            assert!(queue.enqueue_local(&urgent));
            assert_eq!(queue.drain(1)[0].status, SafetyStatus::NeedAssistance);
        }
        assert!(!queue.replay.contains(&pending.frame().message_id));
        assert!(!queue.enqueue_local(&pending));
        assert_eq!(queue.len(), 1);
        let mut bounded = EmergencyMeshQueue::new(1).unwrap();
        let urgent = checked_frame(100, SafetyStatus::NeedAssistance, 9);
        let lower = checked_frame(101, SafetyStatus::Safe, 9);
        assert!(bounded.enqueue_local(&urgent));
        assert!(!bounded.enqueue_local(&lower));
        bounded.drain(1);
        assert!(bounded.enqueue_local(&lower));
        assert_eq!(bounded.capacity(), 1);
        assert!(bounded.enqueue_local(&checked_frame(102, SafetyStatus::NeedAssistance, 9)));
        assert_eq!(bounded.len(), 1);
        assert_eq!(bounded.drain(1)[0].status, SafetyStatus::NeedAssistance);
    }

    #[test]
    fn roster_ignores_older_status_and_is_bounded() {
        let mut tracker = EmergencyRosterTracker::new(1).unwrap();
        assert!(tracker
            .observe(&checked_frame(20, SafetyStatus::Safe, 9))
            .unwrap());
        assert!(!tracker
            .observe(&checked_frame(19, SafetyStatus::NeedAssistance, 9))
            .unwrap());
        assert!(!tracker
            .observe(&checked_frame(20, SafetyStatus::Safe, 9))
            .unwrap());
        assert_eq!(tracker.statuses()[0].status, SafetyStatus::Safe);
        assert_eq!(tracker.statuses()[0].timestamp_ms, 20);
        assert_eq!(tracker.statuses()[0].ttl_hops, 3);
        assert_eq!(
            tracker.observe(&checked_frame(21, SafetyStatus::Safe, 10)),
            Err(CoreError::CapacityExceeded)
        );
        assert!(matches!(
            EmergencyRosterTracker::new(4097),
            Err(CoreError::InvalidCapacity)
        ));
        let mut empty = EmergencyRosterTracker::new(0).unwrap();
        assert_eq!(
            empty.observe(&checked_frame(1, SafetyStatus::Safe, 9)),
            Err(CoreError::CapacityExceeded)
        );
    }

    #[test]
    fn relay_jitter_is_stable_device_specific_and_bounded() {
        let id = UuidV7::from_parts(1_762_520_100_000, [3; 10]);
        let first = compute_relay_backoff_ms(&id, &[9; 32]);
        assert_eq!(first, compute_relay_backoff_ms(&id, &[9; 32]));
        assert_ne!(first, compute_relay_backoff_ms(&id, &[10; 32]));
        for byte in 0..=255 {
            assert!((25..=275).contains(&compute_relay_backoff_ms(&id, &[byte; 32])));
        }
        let mut default_guard = EmergencyReplayGuard::default();
        assert!(default_guard.accept_once(id));
        assert!(!default_guard.accept_once(id));
    }

    // -- the shared rules file (vectors/emergency-v1-rules.txt) --------------------------------

    const RULES: &str = include_str!("../vectors/emergency-v1-rules.txt");

    struct RuleCase {
        name: String,
        now_unix_ms: u64,
        frame_timestamp_ms: u64,
        accept: bool,
    }

    struct SharedRules {
        bounds: BTreeMap<String, u64>,
        rules: BTreeMap<String, u64>,
        cases: Vec<RuleCase>,
    }

    fn shared_number(field: &str, line: usize) -> u64 {
        let value: u64 = field
            .parse()
            .unwrap_or_else(|_| panic!("rules line {line}: {field:?} is not a number"));
        assert!(
            value <= i64::MAX as u64,
            "rules line {line}: {value} exceeds i64"
        );
        value
    }

    /// Strict: a line outside the grammar fails the test rather than being skipped.
    fn shared_rules() -> SharedRules {
        let mut parsed = SharedRules {
            bounds: BTreeMap::new(),
            rules: BTreeMap::new(),
            cases: Vec::new(),
        };
        for (index, line) in RULES.lines().enumerate() {
            let number = index + 1;
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            match line.split(' ').collect::<Vec<_>>().as_slice() {
                ["bound", name, value] => {
                    let value = shared_number(value, number);
                    assert!(parsed.bounds.insert((*name).to_owned(), value).is_none());
                }
                ["rule", name, value] => {
                    let value = shared_number(value, number);
                    assert!(parsed.rules.insert((*name).to_owned(), value).is_none());
                }
                ["case", rule, name, now, timestamp, outcome] => {
                    assert_eq!(
                        *rule, "max_future_skew_ms",
                        "rules line {number}: unknown rule"
                    );
                    assert!(
                        matches!(*outcome, "accept" | "refuse"),
                        "rules line {number}: outcome {outcome:?}"
                    );
                    parsed.cases.push(RuleCase {
                        name: (*name).to_owned(),
                        now_unix_ms: shared_number(now, number),
                        frame_timestamp_ms: shared_number(timestamp, number),
                        accept: *outcome == "accept",
                    });
                }
                _ => panic!("rules line {number} is not in the grammar: {line:?}"),
            }
        }
        parsed
    }

    #[test]
    fn shared_rules_file_states_the_bounds_this_crate_enforces() {
        let rules = shared_rules();
        assert_eq!(
            rules.bounds,
            BTreeMap::from([
                (
                    "queue_capacity".to_owned(),
                    MAX_EMERGENCY_QUEUE_CAPACITY as u64
                ),
                (
                    "replay_entries".to_owned(),
                    MAX_EMERGENCY_REPLAY_ENTRIES as u64
                ),
                (
                    "roster_members".to_owned(),
                    MAX_EMERGENCY_ROSTER_MEMBERS as u64
                ),
            ])
        );
        assert_eq!(
            rules.rules,
            BTreeMap::from([(
                "max_future_skew_ms".to_owned(),
                MAX_EMERGENCY_FUTURE_SKEW_MS
            )])
        );
        assert_eq!(MAX_EMERGENCY_FUTURE_SKEW_MS, 300_000);
    }

    #[test]
    fn emergency_bounds_are_enforced_at_their_named_value() {
        assert!(EmergencyMeshQueue::new(MAX_EMERGENCY_QUEUE_CAPACITY).is_ok());
        assert!(matches!(
            EmergencyMeshQueue::new(MAX_EMERGENCY_QUEUE_CAPACITY + 1),
            Err(CoreError::InvalidCapacity)
        ));
        assert!(EmergencyRosterTracker::new(MAX_EMERGENCY_ROSTER_MEMBERS).is_ok());
        assert!(matches!(
            EmergencyRosterTracker::new(MAX_EMERGENCY_ROSTER_MEMBERS + 1),
            Err(CoreError::InvalidCapacity)
        ));
        // A caller asking for more replay history gets the bound: one ID past it evicts the oldest.
        let mut guard = EmergencyReplayGuard::new(usize::MAX);
        let ids: Vec<UuidV7> = (0..=MAX_EMERGENCY_REPLAY_ENTRIES as u64)
            .map(|ms| UuidV7::from_parts(1_762_520_000_000 + ms, [1; 10]))
            .collect();
        for id in &ids {
            assert!(guard.accept_once(*id));
        }
        assert!(!guard.contains(&ids[0]));
        assert!(ids[1..].iter().all(|id| guard.contains(id)));
    }

    fn frame_at(timestamp_ms: u64) -> EmergencyFrame {
        let signer = TestKeyedMacSigner {
            secret: [7; 32],
            pk: [9; 32],
        };
        EmergencyFrame::new_signed(
            UuidV7::from_parts(timestamp_ms, [3; 10]),
            3,
            SafetyStatus::Safe,
            "check-in",
            &signer,
        )
        .unwrap()
    }

    #[test]
    fn frames_dated_past_the_future_skew_are_refused_per_the_shared_vector() {
        let rules = shared_rules();
        assert!(rules.cases.len() >= 9, "the vector lost cases");
        assert!(rules.cases.iter().any(|case| case.accept));
        assert!(rules.cases.iter().any(|case| !case.accept));
        let roster = HashSet::from([[9; 32]]);
        let verifier = TestKeyedMacVerifier { secret: [7; 32] };
        for case in &rules.cases {
            let frame = frame_at(case.frame_timestamp_ms);
            assert_eq!(frame.message_id.timestamp_ms(), case.frame_timestamp_ms);
            let expected = if case.accept {
                Ok(())
            } else {
                Err(CoreError::FutureFrame)
            };
            assert_eq!(
                frame.check_not_future(case.now_unix_ms),
                expected,
                "case {}",
                case.name
            );
            assert_eq!(
                frame
                    .verified_at(&roster, &verifier, case.now_unix_ms)
                    .map(|verified| verified.frame().message_id),
                expected.map(|()| frame.message_id),
                "case {}",
                case.name
            );
        }
    }

    #[test]
    fn a_future_dated_frame_cannot_mask_its_senders_real_check_ins() {
        let now = 1_762_520_100_000;
        let roster = HashSet::from([[9; 32]]);
        let verifier = TestKeyedMacVerifier { secret: [7; 32] };
        let ahead = frame_at(now + 24 * 3600 * 1000);
        assert_eq!(
            ahead.verified_at(&roster, &verifier, now).map(|_| ()),
            Err(CoreError::FutureFrame)
        );
        let mut tracker = EmergencyRosterTracker::new(1).unwrap();
        let real = frame_at(now).verified_at(&roster, &verifier, now).unwrap();
        assert!(tracker.observe(&real).unwrap());
        assert_eq!(tracker.statuses()[0].timestamp_ms, now);
        // The clock rule never overflows, whatever the verifier's clock says.
        assert_eq!(
            frame_at(281_474_976_710_655).check_not_future(u64::MAX),
            Ok(())
        );
    }

    #[test]
    fn emergency_frame_default_system_clock_accepts_present_and_rejects_far_future() {
        let roster = HashSet::from([[9; 32]]);
        let verifier = TestKeyedMacVerifier { secret: [7; 32] };
        let now_ms = system_unix_ms();
        let current = frame_at(now_ms);
        assert!(current.check_not_future_now().is_ok());
        assert!(current.verified_now(&roster, &verifier).is_ok());

        let future = frame_at(now_ms + MAX_EMERGENCY_FUTURE_SKEW_MS + 60_000);
        assert_eq!(future.check_not_future_now(), Err(CoreError::FutureFrame));
        assert_eq!(
            future.verified_now(&roster, &verifier).map(|_| ()),
            Err(CoreError::FutureFrame)
        );
    }

    #[test]
    fn organisation_bound_emergency_frames_and_key_guard_prevent_cross_org_beacon_retagging() {
        let org_a = OrganisationId::parse("11111111-1111-4111-8111-111111111111").unwrap();
        let org_b = OrganisationId::parse("22222222-2222-4222-8222-222222222222").unwrap();
        let beacon_a = compute_proximity_beacon(&[0x42; 32], 1_762_520_100);
        let beacon_b = compute_proximity_beacon(&[0x43; 32], 1_762_520_100);
        let signer = TestKeyedMacSigner {
            secret: [7; 32],
            pk: [9; 32],
        };
        let verifier = TestKeyedMacVerifier { secret: [7; 32] };
        let roster = HashSet::from([signer.pk]);
        let now_ms = 1_762_520_100_000;

        // 1. Domain-separated sign_for_organisation / verify_for_organisation binds (org_id, beacon)
        let frame_a = EmergencyFrame::sign_for_organisation(
            &org_a,
            beacon_a,
            UuidV7::from_parts(now_ms, [3; 10]),
            3,
            SafetyStatus::Safe,
            "Org A check-in",
            &signer,
        )
        .unwrap();
        assert!(frame_a
            .verified_for_organisation_at(&org_a, beacon_a, &roster, &verifier, now_ms)
            .is_ok());
        // Hop decrement preserves signature within the same (org_id, beacon) context
        let relayed = frame_a.decrement_hop().unwrap();
        assert!(relayed
            .verified_for_organisation_at(&org_a, beacon_a, &roster, &verifier, now_ms)
            .is_ok());
        // Cross-org or retagged-beacon verification fails even with the exact same roster key!
        assert_eq!(
            frame_a
                .verified_for_organisation_at(&org_b, beacon_a, &roster, &verifier, now_ms)
                .map(|_| ()),
            Err(CoreError::InvalidSignature)
        );
        assert_eq!(
            frame_a
                .verified_for_organisation_at(&org_a, beacon_b, &roster, &verifier, now_ms)
                .map(|_| ()),
            Err(CoreError::InvalidSignature)
        );
        assert_eq!(
            frame_a
                .verified_for_organisation_at(&org_b, beacon_b, &roster, &verifier, now_ms)
                .map(|_| ()),
            Err(CoreError::InvalidSignature)
        );

        // 2. EmergencyOrganisationKeyGuard rejects registering the same Ed25519 key across orgs/beacons
        let mut key_guard = EmergencyOrganisationKeyGuard::new();
        key_guard
            .register_roster(org_a.clone(), beacon_a, roster.clone())
            .unwrap();
        assert_eq!(
            key_guard.register_roster(org_b.clone(), beacon_b, roster.clone()),
            Err(CoreError::UnauthorizedSender)
        );
        assert_eq!(
            key_guard.register_roster(org_b.clone(), beacon_a, HashSet::from([[10; 32]])),
            Err(CoreError::OrganisationMismatch)
        );
        let v1_frame = frame_at(now_ms);
        assert!(key_guard
            .verify_v1_frame_in_context(&org_a, beacon_a, &v1_frame, &verifier, now_ms)
            .is_ok());
        assert_eq!(
            key_guard
                .verify_v1_frame_in_context(&org_b, beacon_b, &v1_frame, &verifier, now_ms)
                .map(|_| ()),
            Err(CoreError::UnauthorizedSender)
        );
        key_guard.clear();
        key_guard.register_roster(org_b, beacon_b, roster).unwrap();
    }
}

#[cfg(test)]
mod session_envelope_tests {
    use super::*;

    const ORG: &str = "019a5e62-6ca0-7303-8303-030303030303";
    const OTHER_ORG: &str = "019a5e62-6ca0-7303-8303-030303030304";

    struct ProviderResult(Result<(), CoreError>);
    impl SessionEnvelopeVerifier for ProviderResult {
        fn verify_header(&self, _header: &SessionEnvelopeHeader) -> Result<(), CoreError> {
            self.0
        }
    }
    const AUTHENTICATED: ProviderResult = ProviderResult(Ok(()));
    const FORGED: ProviderResult = ProviderResult(Err(CoreError::InvalidSignature));

    fn header(room: u64, message: u64, epoch: u64) -> SessionEnvelopeHeader {
        SessionEnvelopeHeader {
            organisation_id: OrganisationId::parse(ORG).unwrap(),
            room_id: UuidV7::from_parts(room, [1; 10]),
            message_id: UuidV7::from_parts(message, [2; 10]),
            epoch,
            algorithm: CryptoAlgorithm::OpenMlsDraft,
        }
    }

    fn tracker(rooms: usize, replay: usize) -> SessionEnvelopeTracker {
        SessionEnvelopeTracker::new(OrganisationId::parse(ORG).unwrap(), rooms, replay).unwrap()
    }

    #[test]
    fn organisation_identity_requires_canonical_non_nil_uuid() {
        assert_eq!(OrganisationId::parse(ORG).unwrap().as_str(), ORG);
        for bad in [
            "",
            "org",
            " 019a5e62-6ca0-7303-8303-030303030303",
            "019A5e62-6ca0-7303-8303-030303030303",
            "00000000-0000-0000-0000-000000000000",
        ] {
            assert_eq!(
                OrganisationId::parse(bad),
                Err(CoreError::InvalidOrganisation)
            );
        }
    }

    #[test]
    fn rejected_headers_do_not_advance_epoch_or_burn_retry_ids() {
        let mut tracker = tracker(2, 8);
        let initial = header(1, 1, 5);
        assert_eq!(
            tracker.verify_and_observe(&initial, &FORGED),
            Err(CoreError::InvalidSignature)
        );
        assert_eq!((tracker.room_count(), tracker.replay_count()), (0, 0));
        tracker
            .verify_and_observe(&initial, &AUTHENTICATED)
            .unwrap();
        assert_eq!(
            tracker.verify_and_observe(&header(1, 2, 100), &FORGED),
            Err(CoreError::InvalidSignature)
        );
        assert_eq!(
            tracker.verify_and_observe(&header(1, 2, 4), &AUTHENTICATED),
            Err(CoreError::StaleFrame)
        );
        let mut mismatch = header(1, 2, 100);
        mismatch.algorithm = CryptoAlgorithm::MatrixOlmV1;
        assert_eq!(
            tracker.verify_and_observe(&mismatch, &AUTHENTICATED),
            Err(CoreError::AlgorithmMismatch)
        );
        tracker
            .verify_and_observe(&header(1, 2, 6), &AUTHENTICATED)
            .unwrap();
        assert_eq!(tracker.replay_count(), 2);
        assert_eq!(
            tracker.verify_and_observe(&header(1, 3, 5), &AUTHENTICATED),
            Err(CoreError::StaleFrame)
        );
        tracker
            .verify_and_observe(&header(1, 3, 6), &AUTHENTICATED)
            .unwrap();
    }

    #[test]
    fn replay_is_room_scoped_and_retained_across_epoch_advances() {
        let mut tracker = tracker(2, 8);
        tracker
            .verify_and_observe(&header(1, 1, 5), &AUTHENTICATED)
            .unwrap();
        for epoch in [5, 10] {
            assert_eq!(
                tracker.verify_and_observe(&header(1, 1, epoch), &AUTHENTICATED),
                Err(CoreError::ReplayDetected)
            );
        }
        // A rejected replay with epoch 10 must not advance room state.
        tracker
            .verify_and_observe(&header(1, 2, 6), &AUTHENTICATED)
            .unwrap();
        tracker
            .verify_and_observe(&header(2, 1, 0), &AUTHENTICATED)
            .unwrap();
        let mut cross_org = header(2, 3, 1);
        cross_org.organisation_id = OrganisationId::parse(OTHER_ORG).unwrap();
        assert_eq!(
            tracker.verify_and_observe(&cross_org, &AUTHENTICATED),
            Err(CoreError::OrganisationMismatch)
        );
        cross_org.organisation_id = OrganisationId::parse(ORG).unwrap();
        tracker
            .verify_and_observe(&cross_org, &AUTHENTICATED)
            .unwrap();
        let mut other =
            SessionEnvelopeTracker::new(OrganisationId::parse(OTHER_ORG).unwrap(), 1, 1).unwrap();
        cross_org.organisation_id = OrganisationId::parse(OTHER_ORG).unwrap();
        other
            .verify_and_observe(&cross_org, &AUTHENTICATED)
            .unwrap();
    }

    #[test]
    fn algorithm_is_pinned_in_both_directions_until_explicit_session_reset() {
        for initial in [CryptoAlgorithm::OpenMlsDraft, CryptoAlgorithm::MatrixOlmV1] {
            let mut tracker = tracker(1, 2);
            let mut first = header(1, 1, 0);
            first.algorithm = initial;
            tracker.verify_and_observe(&first, &AUTHENTICATED).unwrap();
            let mut changed = header(1, 2, 1);
            changed.algorithm = match initial {
                CryptoAlgorithm::OpenMlsDraft => CryptoAlgorithm::MatrixOlmV1,
                CryptoAlgorithm::MatrixOlmV1 => CryptoAlgorithm::OpenMlsDraft,
            };
            assert_eq!(
                tracker.verify_and_observe(&changed, &AUTHENTICATED),
                Err(CoreError::AlgorithmMismatch)
            );
            first.message_id = changed.message_id;
            tracker.verify_and_observe(&first, &AUTHENTICATED).unwrap();
            tracker.clear();
            assert_eq!((tracker.room_count(), tracker.replay_count()), (0, 0));
            tracker
                .verify_and_observe(&changed, &AUTHENTICATED)
                .unwrap();
        }
    }

    #[test]
    fn bounded_replay_eviction_does_not_evict_room_epoch_or_algorithm() {
        let mut tracker = tracker(1, 2);
        for message in 1..=3 {
            tracker
                .verify_and_observe(&header(1, message, 10), &AUTHENTICATED)
                .unwrap();
        }
        assert_eq!((tracker.room_count(), tracker.replay_count()), (1, 2));
        assert_eq!(
            tracker.verify_and_observe(&header(2, 4, 1), &AUTHENTICATED),
            Err(CoreError::CapacityExceeded)
        );
        assert_eq!(
            tracker.verify_and_observe(&header(1, 1, 9), &AUTHENTICATED),
            Err(CoreError::StaleFrame)
        );
        // The evicted ID is no longer protected at the current epoch, as documented.
        tracker
            .verify_and_observe(&header(1, 1, 10), &AUTHENTICATED)
            .unwrap();
        assert_eq!(tracker.replay_count(), 2);
        for (rooms, replay) in [(0, 1), (1, 0), (4097, 1), (1, 4097), (usize::MAX, 1)] {
            assert!(matches!(
                SessionEnvelopeTracker::new(OrganisationId::parse(ORG).unwrap(), rooms, replay),
                Err(CoreError::InvalidCapacity)
            ));
        }
        assert!(
            SessionEnvelopeTracker::new(OrganisationId::parse(ORG).unwrap(), 4096, 4096).is_ok()
        );
    }
}

#[cfg(test)]
mod docs_webhook_tests {
    use super::*;

    const ORG: &str = "019a5e62-6ca0-7303-8303-030303030303";
    const OTHER_ORG: &str = "019a5e62-6ca0-7303-8303-030303030304";
    const NOW: u64 = 1_762_520_100;
    // Public synthetic fixture, independently computed with Python hmac and Node createHmac.
    const FIXTURE_MAC: &str = "83ece4ff7a8e78097259ad7127fe1281cb706c7d4ab94e73779de45429707150";

    fn id(value: u64) -> UuidV7 {
        UuidV7::from_parts(value, [3; 10])
    }
    fn fixture_id() -> UuidV7 {
        id(NOW * 1000)
    }
    fn organisation() -> OrganisationId {
        OrganisationId::parse(ORG).unwrap()
    }
    fn verifier(capacity: usize) -> ExtensionWebhookVerifier {
        ExtensionWebhookVerifier::new(organisation(), capacity).unwrap()
    }
    fn signature(delivery: UuidV7, timestamp: u64, payload: &[u8]) -> String {
        let mut input = format!("kodera-ext-v1:{timestamp}:").into_bytes();
        input.extend_from_slice(delivery.as_bytes());
        input.push(b':');
        input.extend_from_slice(payload);
        encode_hex(&hmac_sha256(&[0x42; 32], &input))
    }
    fn record(
        verifier: &mut ExtensionWebhookVerifier,
        extension: &str,
        delivery: UuidV7,
        timestamp: u64,
        now: u64,
        payload: &[u8],
        mac: &str,
    ) -> Result<(), CoreError> {
        verifier.verify_and_record(
            &organisation(),
            extension,
            delivery,
            timestamp,
            now,
            &[0x42; 32],
            payload,
            mac,
        )
    }

    #[test]
    fn docs_urls_are_exact_origin_canonical_immutable_metadata() {
        for family in ["docs", "pads"] {
            for slug in ["a".to_owned(), "A-0_b".to_owned(), "z".repeat(128)] {
                let raw = format!("https://docs.example.org/{family}/{slug}");
                let result = validate_docs_pad_url(&raw, "docs.example.org").unwrap();
                assert_eq!(result.as_str(), raw);
                assert_eq!(result.host(), "docs.example.org");
                assert_eq!(result.path(), format!("/{family}/{slug}"));
                assert_eq!(
                    validate_docs_pad_url(
                        &raw.replacen(".org/", ".org:443/", 1),
                        "docs.example.org"
                    )
                    .unwrap(),
                    result
                );
            }
        }
    }

    #[test]
    fn docs_host_rejects_noncanonical_local_literal_and_malformed_authorities() {
        for host in [
            "",
            "localhost",
            "x.localhost",
            "x.local",
            "x.internal",
            "127.0.0.1",
            "[::1]",
            "::1",
            "2130706433",
            "127.1",
            "0x7f000001",
            "Docs.example.org",
            "docs.example.org.",
            ".example.org",
            "a..example.org",
            "-a.example.org",
            "a-.example.org",
            "a_b.example.org",
            "docs.example.org:443",
            "docs.example.org/path",
            "docs.example.org\n",
            "é.example.org",
        ] {
            assert_eq!(
                validate_docs_host(host),
                Err(CoreError::UntrustedDocsOrigin),
                "{host:?}"
            );
        }
        assert!(validate_docs_host(&format!("{}.example.org", "a".repeat(64))).is_err());
        assert!(validate_docs_host(&format!(
            "{}.{}.{}.{}",
            "a".repeat(63),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(62)
        ))
        .is_err());
        assert!(validate_docs_host("docs.example.org").is_ok());
    }

    #[test]
    fn docs_urls_reject_parser_normalisation_traversal_and_origin_confusion() {
        for raw in [
            "http://docs.example.org/docs/a",
            "HTTPS://docs.example.org/docs/a",
            "https://DOCS.example.org/docs/a",
            "https://docs.example.org.evil.example/docs/a",
            "https://user@docs.example.org/docs/a",
            "https://docs.example.org:444/docs/a",
            "https://docs.example.org:0443/docs/a",
            "https://docs.example.org:443:443/docs/a",
            "https://docs.example.org/docs/a?",
            "https://docs.example.org/docs/a#",
            "https://docs.example.org",
            "https://docs.example.org/",
            "https://docs.example.org/docs/",
            "https://docs.example.org/pads",
            "https://docs.example.org/other/a",
            "https://docs.example.org//docs/a",
            "https://docs.example.org/docs/a//b",
            "https://docs.example.org/docs/a/../b",
            "https://docs.example.org/docs/..",
            "https://docs.example.org/docs/%2e%2e",
            "https://docs.example.org/docs/a%2Fb",
            "https://docs.example.org/docs/a\\b",
            "https://docs.example.org/docs/é",
            " https://docs.example.org/docs/a",
            "https://docs.example.org/docs/a\n",
        ] {
            assert!(
                validate_docs_pad_url(raw, "docs.example.org").is_err(),
                "{raw:?}"
            );
        }
        assert!(validate_docs_pad_url(
            &format!("https://docs.example.org/docs/{}", "a".repeat(129)),
            "docs.example.org"
        )
        .is_err());
        assert!(
            validate_docs_pad_url(&"a".repeat(MAX_DOCS_PAD_URL_BYTES + 1), "docs.example.org")
                .is_err()
        );
    }

    #[test]
    fn webhook_matches_independent_binary_transcript_fixture_and_rejects_every_bad_byte() {
        let payload = [0, 255, 10, 58, 65];
        assert_eq!(signature(fixture_id(), NOW, &payload), FIXTURE_MAC);
        let mut guard = verifier(1);
        for index in 0..32 {
            let mut bytes = decode_hex(FIXTURE_MAC).unwrap();
            bytes[index] ^= 1;
            assert_eq!(
                record(
                    &mut guard,
                    "docs.announcer",
                    fixture_id(),
                    NOW,
                    NOW,
                    &payload,
                    &encode_hex(&bytes)
                ),
                Err(CoreError::InvalidSignature)
            );
            assert_eq!(guard.replay_count(), 0);
        }
        assert_eq!(
            record(
                &mut guard,
                "docs.announcer",
                fixture_id(),
                NOW,
                NOW,
                b"altered",
                FIXTURE_MAC
            ),
            Err(CoreError::InvalidSignature)
        );
        assert_eq!(
            record(
                &mut guard,
                "docs.announcer",
                id(2),
                NOW,
                NOW,
                &payload,
                FIXTURE_MAC
            ),
            Err(CoreError::InvalidSignature)
        );
        record(
            &mut guard,
            "docs.announcer",
            fixture_id(),
            NOW,
            NOW,
            &payload,
            FIXTURE_MAC,
        )
        .unwrap();
        assert_eq!(
            record(
                &mut guard,
                "docs.announcer",
                fixture_id(),
                NOW,
                NOW,
                &payload,
                FIXTURE_MAC
            ),
            Err(CoreError::ReplayDetected)
        );
        assert_eq!(guard.replay_count(), 1);
    }

    #[test]
    fn webhook_format_bounds_and_auth_failures_do_not_evict_or_burn_ids() {
        let mut guard = verifier(1);
        let original = signature(id(1), NOW, b"one");
        record(&mut guard, "a", id(1), NOW, NOW, b"one", &original).unwrap();
        for bad in [
            "".to_owned(),
            "a".repeat(63),
            "a".repeat(65),
            "g".repeat(64),
            FIXTURE_MAC.to_uppercase(),
            format!("v1={FIXTURE_MAC}"),
        ] {
            assert_eq!(
                record(&mut guard, "a", fixture_id(), NOW, NOW, b"", &bad),
                Err(CoreError::InvalidSignature)
            );
            assert_eq!(guard.replay_count(), 1);
        }
        for extension in [
            "".to_owned(),
            "A".to_owned(),
            "bad id".to_owned(),
            "a/".to_owned(),
            "a".repeat(65),
            "é".to_owned(),
        ] {
            assert_eq!(
                record(
                    &mut guard,
                    &extension,
                    fixture_id(),
                    NOW,
                    NOW,
                    b"",
                    FIXTURE_MAC
                ),
                Err(CoreError::InvalidExtensionId)
            );
        }
        let other = OrganisationId::parse(OTHER_ORG).unwrap();
        assert_eq!(
            guard.verify_and_record(
                &other,
                "a",
                fixture_id(),
                NOW,
                NOW,
                &[0x42; 32],
                b"",
                FIXTURE_MAC
            ),
            Err(CoreError::OrganisationMismatch)
        );
        assert_eq!(
            record(
                &mut guard,
                "a",
                fixture_id(),
                NOW,
                NOW,
                &vec![0; MAX_EXTENSION_WEBHOOK_PAYLOAD_BYTES + 1],
                FIXTURE_MAC
            ),
            Err(CoreError::PayloadTooLarge)
        );
        assert_eq!(
            record(&mut guard, "a", id(1), NOW, NOW, b"one", &original),
            Err(CoreError::ReplayDetected)
        );
        let retry = signature(fixture_id(), NOW, b"retry");
        record(&mut guard, "a", fixture_id(), NOW, NOW, b"retry", &retry).unwrap();
        assert_eq!(guard.replay_count(), 1);
    }

    #[test]
    fn webhook_window_is_inclusive_and_unsigned_extremes_do_not_overflow() {
        for (timestamp, now, accepted) in [
            (NOW - 300, NOW, true),
            (NOW + 300, NOW, true),
            (NOW - 301, NOW, false),
            (NOW + 301, NOW, false),
            (0, 0, true),
            (u64::MAX, u64::MAX, true),
            (u64::MAX, 0, false),
            (0, u64::MAX, false),
        ] {
            let mac = signature(id(1), timestamp, b"");
            let result = record(&mut verifier(1), "a", id(1), timestamp, now, b"", &mac);
            assert_eq!(
                result,
                if accepted {
                    Ok(())
                } else {
                    Err(CoreError::StaleFrame)
                }
            );
        }
    }

    #[test]
    fn webhook_fifo_is_bounded_and_unsigned_context_requires_separate_secrets() {
        let mut guard = verifier(2);
        let mac = signature(id(1), NOW, b"same");
        record(&mut guard, "a", id(1), NOW, NOW, b"same", &mac).unwrap();
        // Extension ID is not signed. The same key authorises another extension unless provisioning
        // selects distinct pair-specific secrets. This is a protocol limit, not isolation evidence.
        record(&mut guard, "b", id(1), NOW, NOW, b"same", &mac).unwrap();
        let third = signature(id(2), NOW, b"third");
        record(&mut guard, "a", id(2), NOW, NOW, b"third", &third).unwrap();
        assert_eq!(guard.replay_count(), 2);
        assert_eq!(
            record(&mut guard, "b", id(1), NOW, NOW, b"same", &mac),
            Err(CoreError::ReplayDetected)
        );
        // First FIFO entry has evicted, as documented.
        record(&mut guard, "a", id(1), NOW, NOW, b"same", &mac).unwrap();
        guard.clear();
        assert_eq!(guard.replay_count(), 0);
        record(&mut guard, "a", id(1), NOW, NOW, b"same", &mac).unwrap();
        let mut other =
            ExtensionWebhookVerifier::new(OrganisationId::parse(OTHER_ORG).unwrap(), 1).unwrap();
        other
            .verify_and_record(
                &OrganisationId::parse(OTHER_ORG).unwrap(),
                "a",
                id(1),
                NOW,
                NOW,
                &[0x42; 32],
                b"same",
                &mac,
            )
            .unwrap();
        for capacity in [0, 4097, usize::MAX] {
            assert!(matches!(
                ExtensionWebhookVerifier::new(organisation(), capacity),
                Err(CoreError::InvalidCapacity)
            ));
        }
        assert!(ExtensionWebhookVerifier::new(organisation(), 4096).is_ok());
    }

    #[test]
    fn webhook_native_transcript_refuses_existing_sdk_timestamp_dot_body_mac() {
        let payload = b"{}";
        let sdk_input = format!("{NOW}.{{}}");
        let sdk_mac = encode_hex(&hmac_sha256(&[0x42; 32], sdk_input.as_bytes()));
        assert_eq!(
            record(&mut verifier(1), "a", id(1), NOW, NOW, payload, &sdk_mac),
            Err(CoreError::InvalidSignature)
        );
    }

    #[test]
    fn scoped_webhook_derivation_and_registry_reject_cross_org_and_cross_extension_replay() {
        let org_a = OrganisationId::parse(ORG).unwrap();
        let org_b = OrganisationId::parse(OTHER_ORG).unwrap();
        let raw_secret = [0x42u8; 32];
        let other_secret = [0x43u8; 32];
        let payload = b"{\"event\":\"pad.updated\"}";
        let delivery = id(10);

        let key_a_one = derive_extension_webhook_secret(&raw_secret, &org_a, "ext.one").unwrap();
        let key_a_two = derive_extension_webhook_secret(&raw_secret, &org_a, "ext.two").unwrap();
        let key_b_one = derive_extension_webhook_secret(&raw_secret, &org_b, "ext.one").unwrap();
        assert_ne!(key_a_one, key_a_two);
        assert_ne!(key_a_one, key_b_one);

        let sig_a_one = ExtensionWebhookVerifier::sign_scoped_payload(
            &org_a,
            "ext.one",
            delivery,
            NOW,
            &raw_secret,
            payload,
        )
        .unwrap();

        let mut verifier_a = ExtensionWebhookVerifier::new(org_a.clone(), 4).unwrap();
        let mut verifier_b = ExtensionWebhookVerifier::new(org_b.clone(), 4).unwrap();

        // Cross-extension replay with the exact same raw_secret is rejected before replay state changes
        assert_eq!(
            verifier_a.verify_and_record_scoped(
                &org_a,
                "ext.two",
                delivery,
                NOW,
                NOW,
                &raw_secret,
                payload,
                &sig_a_one,
            ),
            Err(CoreError::InvalidSignature)
        );
        // Cross-org replay with the exact same raw_secret and extension_id is rejected
        assert_eq!(
            verifier_b.verify_and_record_scoped(
                &org_b,
                "ext.one",
                delivery,
                NOW,
                NOW,
                &raw_secret,
                payload,
                &sig_a_one,
            ),
            Err(CoreError::InvalidSignature)
        );
        assert_eq!(verifier_a.replay_count(), 0);
        assert_eq!(verifier_b.replay_count(), 0);

        // Matching (org_a, "ext.one") context succeeds once and rejects replay
        verifier_a
            .verify_and_record_scoped(
                &org_a,
                "ext.one",
                delivery,
                NOW,
                NOW,
                &raw_secret,
                payload,
                &sig_a_one,
            )
            .unwrap();
        assert_eq!(
            verifier_a.verify_and_record_scoped(
                &org_a,
                "ext.one",
                delivery,
                NOW,
                NOW,
                &raw_secret,
                payload,
                &sig_a_one,
            ),
            Err(CoreError::ReplayDetected)
        );

        // ScopedWebhookVerifierRegistry also forbids registering the same raw secret across pairs
        let mut registry = ScopedWebhookVerifierRegistry::new(4).unwrap();
        registry
            .register_extension_secret(org_a.clone(), "ext.one", &raw_secret)
            .unwrap();
        assert_eq!(
            registry.register_extension_secret(org_a.clone(), "ext.two", &raw_secret),
            Err(CoreError::UnauthorizedSender)
        );
        assert_eq!(
            registry.register_extension_secret(org_b.clone(), "ext.one", &raw_secret),
            Err(CoreError::UnauthorizedSender)
        );
        registry
            .register_extension_secret(org_b.clone(), "ext.one", &other_secret)
            .unwrap();

        let delivery_2 = id(11);
        let sig_2 = ExtensionWebhookVerifier::sign_scoped_payload(
            &org_a,
            "ext.one",
            delivery_2,
            NOW,
            &raw_secret,
            payload,
        )
        .unwrap();
        registry
            .verify_and_record(
                &org_a,
                "ext.one",
                delivery_2,
                NOW,
                NOW,
                &raw_secret,
                payload,
                &sig_2,
            )
            .unwrap();
        assert_eq!(
            registry.verify_and_record(
                &org_b,
                "ext.one",
                delivery_2,
                NOW,
                NOW,
                &other_secret,
                payload,
                &sig_2,
            ),
            Err(CoreError::InvalidSignature)
        );
    }
}
