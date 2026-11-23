//! Zero-`unsafe` mobile packet dispatcher (`PacketDispatcher` / `invoke_packet` / `invoke_json`),
//! `KDV1` `(org_id, device_id)` session vault, single-grapheme emoji reaction validator, and
//! payload-free push wakeup admission.
//!
//! Compiled on all non-WASM targets (`#[cfg(not(target_arch = "wasm32"))]`) while keeping
//! `#![forbid(unsafe_code)]` 100% intact. Because Rust 1.82+ classifies `#[no_mangle]` under
//! `unsafe_code`, this module exposes safe Rust entrypoints (`invoke_packet`, `invoke_json`, and
//! [`PacketDispatcher`]) verified byte-for-byte against `vectors/mobile-ffi-v1.txt` alongside
//! Swift (`CryptoKit`) and Kotlin (`javax.crypto`), without claiming an unmangled C symbol export.

use std::collections::BTreeMap;
use std::fmt;

use crate::{
    decode_hex, system_unix_ms, CoreError, CryptoAlgorithm, OrganisationId, SessionEnvelopeHeader,
    SessionEnvelopeTracker, SessionEnvelopeVerifier, UuidV7,
};

#[cfg(any(test, feature = "openmls-engine"))]
use crate::encode_hex;

#[cfg(feature = "openmls-engine")]
use std::sync::Arc;
#[cfg(feature = "openmls-engine")]
use std::task::{Context, Poll, Wake, Waker};

#[cfg(feature = "openmls-engine")]
use aes_gcm::{aead::AeadInOut, Aes256Gcm, KeyInit, Nonce, Tag};
#[cfg(feature = "openmls-engine")]
use openmls_rust_crypto::OpenMlsRustCrypto;
#[cfg(feature = "openmls-engine")]
use openmls_traits::{random::OpenMlsRand, OpenMlsProvider};

#[cfg(feature = "openmls-engine")]
use crate::{
    Ed25519PublicKey, MlsDeviceScope, MlsDeviceStore, MlsDeviceStoreError, MlsDeviceWrite,
    NativeCryptoError, OpenMlsDevice, RelayId, SealedMlsDeviceState,
};

/// Fixed packet payload capacity (`64 KiB`).
pub const KODERA_FFI_PACKET_CAPACITY: usize = 65_536;

/// `KDV1` magic prefix shared with mobile Keychain / AndroidKeyStore session vaults.
pub const SESSION_VAULT_MAGIC: &[u8; 4] = b"KDV1";
/// AES-256-GCM nonce length in bytes.
pub const SESSION_VAULT_NONCE_BYTES: usize = 12;
/// AES-256-GCM authentication tag length in bytes.
pub const SESSION_VAULT_TAG_BYTES: usize = 16;
/// Maximum plaintext bytes sealed inside a single mobile session vault record.
pub const MAX_SESSION_VAULT_PLAINTEXT_BYTES: usize = 262_144;
/// Maximum raw JSON bytes accepted for a payload-free push wakeup envelope.
pub const MAX_WAKEUP_ENVELOPE_BYTES: usize = 4_096;
/// Maximum UTF-8 byte length for an opaque wakeup `sync_hint` / `room_hash`.
pub const MAX_WAKEUP_SYNC_HINT_BYTES: usize = 128;
/// Maximum UTF-8 byte length for a single-grapheme emoji reaction key.
pub const MAX_REACTION_KEY_BYTES: usize = 32;
/// Maximum RFC 9562 48-bit Unix millisecond timestamp (`(1 << 48) - 1`).
pub const MAX_UUID_V7_TIMESTAMP_MS: u64 = 0x0000_FFFF_FFFF_FFFF;

const VAULT_AAD_DOMAIN: &[u8] = b"kodera-mobile-session-vault-kdv1\0";
const MAX_WAKEUP_EPOCH_MS: u64 = 4_102_444_800_000;

pub const KODERA_FFI_STATUS_OK: u32 = 0;
pub const KODERA_FFI_STATUS_INVALID_PACKET: u32 = 1;
pub const KODERA_FFI_STATUS_INVALID_JSON: u32 = 2;
pub const KODERA_FFI_STATUS_UNKNOWN_OP: u32 = 3;
pub const KODERA_FFI_STATUS_INVALID_INPUT: u32 = 4;
pub const KODERA_FFI_STATUS_AUTH_FAILED: u32 = 5;
pub const KODERA_FFI_STATUS_REPLAY: u32 = 6;
pub const KODERA_FFI_STATUS_STALE_EPOCH: u32 = 7;
pub const KODERA_FFI_STATUS_ALGORITHM_MISMATCH: u32 = 8;
pub const KODERA_FFI_STATUS_ORG_MISMATCH: u32 = 9;
pub const KODERA_FFI_STATUS_CAPACITY: u32 = 10;
pub const KODERA_FFI_STATUS_CLEARTEXT_FORBIDDEN: u32 = 11;
pub const KODERA_FFI_STATUS_UNEXPECTED_FIELD: u32 = 12;
pub const KODERA_FFI_STATUS_FEATURE_DISABLED: u32 = 13;

/// Fixed-size, value-bounded `64 KiB` request/response packet shared across [`PacketDispatcher`] bridges.
#[repr(C)]
#[derive(Clone)]
pub struct KoderaFfiPacket {
    pub len: u32,
    pub status: u32,
    pub data: [u8; KODERA_FFI_PACKET_CAPACITY],
}

impl Default for KoderaFfiPacket {
    fn default() -> Self {
        Self::empty()
    }
}

impl fmt::Debug for KoderaFfiPacket {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KoderaFfiPacket")
            .field("len", &self.len)
            .field("status", &self.status)
            .field("data", &"[redacted]")
            .finish()
    }
}

impl KoderaFfiPacket {
    pub const fn empty() -> Self {
        Self {
            len: 0,
            status: KODERA_FFI_STATUS_OK,
            data: [0u8; KODERA_FFI_PACKET_CAPACITY],
        }
    }

    pub fn from_slice(payload: &[u8]) -> Result<Self, MobileFfiError> {
        if payload.len() > KODERA_FFI_PACKET_CAPACITY {
            return Err(MobileFfiError::Capacity);
        }
        let mut pkt = Self::empty();
        pkt.len = payload.len() as u32;
        pkt.data[..payload.len()].copy_from_slice(payload);
        Ok(pkt)
    }

    pub fn as_slice(&self) -> Result<&[u8], MobileFfiError> {
        let len = self.len as usize;
        if len > KODERA_FFI_PACKET_CAPACITY {
            return Err(MobileFfiError::InvalidPacket);
        }
        Ok(&self.data[..len])
    }

    fn write_response(&mut self, status: u32, body: &[u8]) -> i32 {
        self.data.fill(0);
        if body.len() > KODERA_FFI_PACKET_CAPACITY {
            self.len = 0;
            self.status = KODERA_FFI_STATUS_CAPACITY;
            return -(KODERA_FFI_STATUS_CAPACITY as i32);
        }
        self.data[..body.len()].copy_from_slice(body);
        self.len = body.len() as u32;
        self.status = status;
        if status == KODERA_FFI_STATUS_OK {
            0
        } else {
            -(status as i32)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MobileFfiError {
    InvalidPacket,
    InvalidJson,
    UnknownOp,
    InvalidInput,
    AuthenticationFailed,
    Replay,
    StaleEpoch,
    AlgorithmMismatch,
    OrganisationMismatch,
    Capacity,
    CleartextForbidden(String),
    UnexpectedField(String),
    FeatureDisabled,
}

impl MobileFfiError {
    pub fn status_code(&self) -> u32 {
        match self {
            Self::InvalidPacket => KODERA_FFI_STATUS_INVALID_PACKET,
            Self::InvalidJson => KODERA_FFI_STATUS_INVALID_JSON,
            Self::UnknownOp => KODERA_FFI_STATUS_UNKNOWN_OP,
            Self::InvalidInput => KODERA_FFI_STATUS_INVALID_INPUT,
            Self::AuthenticationFailed => KODERA_FFI_STATUS_AUTH_FAILED,
            Self::Replay => KODERA_FFI_STATUS_REPLAY,
            Self::StaleEpoch => KODERA_FFI_STATUS_STALE_EPOCH,
            Self::AlgorithmMismatch => KODERA_FFI_STATUS_ALGORITHM_MISMATCH,
            Self::OrganisationMismatch => KODERA_FFI_STATUS_ORG_MISMATCH,
            Self::Capacity => KODERA_FFI_STATUS_CAPACITY,
            Self::CleartextForbidden(_) => KODERA_FFI_STATUS_CLEARTEXT_FORBIDDEN,
            Self::UnexpectedField(_) => KODERA_FFI_STATUS_UNEXPECTED_FIELD,
            Self::FeatureDisabled => KODERA_FFI_STATUS_FEATURE_DISABLED,
        }
    }

    pub fn code_slug(&self) -> &'static str {
        match self {
            Self::InvalidPacket => "invalid_packet",
            Self::InvalidJson => "invalid_json",
            Self::UnknownOp => "unknown_op",
            Self::InvalidInput => "invalid_input",
            Self::AuthenticationFailed => "authentication_failed",
            Self::Replay => "replay_detected",
            Self::StaleEpoch => "stale_frame",
            Self::AlgorithmMismatch => "algorithm_mismatch",
            Self::OrganisationMismatch => "organisation_mismatch",
            Self::Capacity => "capacity_exceeded",
            Self::CleartextForbidden(_) => "cleartext_forbidden",
            Self::UnexpectedField(_) => "unexpected_field",
            Self::FeatureDisabled => "feature_disabled",
        }
    }
}

/// Validated payload-free push wakeup envelope containing zero cleartext room/sender/message strings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmittedWakeupEnvelope {
    pub wakeup_id: String,
    pub organisation_id: OrganisationId,
    pub sync_hint: String,
    pub epoch_ms: Option<u64>,
    pub transport: Option<String>,
}

/// Injectable packet-dispatch seam shared across Rust, Swift, and Kotlin mobile bridges.
pub trait PacketDispatcher: Send + Sync {
    fn dispatch(&self, req: &KoderaFfiPacket, resp: &mut KoderaFfiPacket) -> i32;
}

/// Default in-process safe-Rust [`PacketDispatcher`] implementation.
#[derive(Debug, Default, Clone, Copy)]
pub struct RustPacketDispatcher;

impl PacketDispatcher for RustPacketDispatcher {
    fn dispatch(&self, req: &KoderaFfiPacket, resp: &mut KoderaFfiPacket) -> i32 {
        invoke_packet(req, resp)
    }
}

/// Dispatches a bounded [`KoderaFfiPacket`] request into `resp` using the canonical JSON wire schema.
pub fn invoke_packet(req: &KoderaFfiPacket, resp: &mut KoderaFfiPacket) -> i32 {
    let input = match req.as_slice() {
        Ok(slice) if !slice.is_empty() => slice,
        _ => {
            let err = MobileFfiError::InvalidPacket;
            return resp.write_response(err.status_code(), error_json(&err).as_bytes());
        }
    };

    let (status, body) = invoke_json(input);
    resp.write_response(status, body.as_bytes())
}

/// Evaluates a raw UTF-8 JSON request payload and returns `(status_code, response_json)`.
pub fn invoke_json(input: &[u8]) -> (u32, String) {
    if input.is_empty() || input.len() > KODERA_FFI_PACKET_CAPACITY {
        let err = MobileFfiError::InvalidPacket;
        return (err.status_code(), error_json(&err));
    }
    match dispatch_json(input) {
        Ok(json_out) => (KODERA_FFI_STATUS_OK, json_out),
        Err(err) => (err.status_code(), error_json(&err)),
    }
}

fn error_json(err: &MobileFfiError) -> String {
    match err {
        MobileFfiError::CleartextForbidden(field) | MobileFfiError::UnexpectedField(field) => {
            format!(
                "{{\"ok\":false,\"code\":\"{}\",\"field\":\"{}\"}}",
                err.code_slug(),
                escape_json_str(field)
            )
        }
        _ => format!("{{\"ok\":false,\"code\":\"{}\"}}", err.code_slug()),
    }
}

fn dispatch_json(input: &[u8]) -> Result<String, MobileFfiError> {
    let root = StrictFfiJson::parse_object(input, KODERA_FFI_PACKET_CAPACITY)?;
    let op = root
        .get("op")
        .and_then(FfiJsonValue::as_str)
        .ok_or(MobileFfiError::InvalidJson)?;

    match op {
        "uuid_v7_mint" => handle_uuid_v7_mint(&root),
        "session_vault_seal" => handle_session_vault_seal(&root),
        "session_vault_open" => handle_session_vault_open(&root),
        "session_envelope_verify_and_observe" => handle_session_envelope_observe(&root),
        "mls_device_create" => handle_mls_device_create(&root),
        "mls_device_restore" => handle_mls_device_restore(&root),
        "attachment_mime_validate" => handle_attachment_mime_validate(&root),
        "reaction_validate" => handle_reaction_validate(&root),
        "wakeup_envelope_admit" => handle_wakeup_envelope_admit(&root),
        _ => Err(MobileFfiError::UnknownOp),
    }
}

// ---------------------------------------------------------------------------
// 1. UUIDv7 Mint & Parse
// ---------------------------------------------------------------------------

pub fn parse_uuid_v7_str(value: &str) -> Result<UuidV7, MobileFfiError> {
    if value.len() != 36 {
        return Err(MobileFfiError::InvalidInput);
    }
    let mut compact = String::with_capacity(32);
    for (index, byte) in value.bytes().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if byte != b'-' {
                return Err(MobileFfiError::InvalidInput);
            }
        } else if byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) {
            compact.push(byte as char);
        } else {
            return Err(MobileFfiError::InvalidInput);
        }
    }
    let raw = decode_hex(&compact).map_err(|_| MobileFfiError::InvalidInput)?;
    let arr: [u8; 16] = raw.try_into().map_err(|_| MobileFfiError::InvalidInput)?;
    UuidV7::from_bytes_checked(arr).map_err(|_| MobileFfiError::InvalidInput)
}

fn handle_uuid_v7_mint(root: &BTreeMap<String, FfiJsonValue>) -> Result<String, MobileFfiError> {
    ensure_allowed_keys(root, &["op", "unix_ts_ms", "rand_hex"])?;
    let unix_ts_ms = match root.get("unix_ts_ms") {
        Some(val) => val.as_u64().ok_or(MobileFfiError::InvalidInput)?,
        None => system_unix_ms(),
    };
    if unix_ts_ms > MAX_UUID_V7_TIMESTAMP_MS {
        return Err(MobileFfiError::InvalidInput);
    }
    let rand_bytes: [u8; 10] = match root.get("rand_hex") {
        Some(val) => {
            let hex = val.as_str().ok_or(MobileFfiError::InvalidInput)?;
            decode_fixed_hex::<10>(hex)?
        }
        None => random_10_bytes()?,
    };
    let minted = UuidV7::from_parts(unix_ts_ms, rand_bytes);
    Ok(format!(
        "{{\"ok\":true,\"uuid\":\"{minted}\",\"timestamp_ms\":{unix_ts_ms}}}"
    ))
}

#[cfg(feature = "openmls-engine")]
fn random_10_bytes() -> Result<[u8; 10], MobileFfiError> {
    OpenMlsRustCrypto::default()
        .rand()
        .random_array::<10>()
        .map_err(|_| MobileFfiError::InvalidInput)
}

#[cfg(all(not(feature = "openmls-engine"), feature = "passkey-bindings"))]
fn random_10_bytes() -> Result<[u8; 10], MobileFfiError> {
    let mut out = [0u8; 10];
    getrandom::fill(&mut out).map_err(|_| MobileFfiError::InvalidInput)?;
    Ok(out)
}

#[cfg(not(any(feature = "openmls-engine", feature = "passkey-bindings")))]
fn random_10_bytes() -> Result<[u8; 10], MobileFfiError> {
    Err(MobileFfiError::FeatureDisabled)
}

// ---------------------------------------------------------------------------
// 2. `KDV1` Session Vault (`AES-256-GCM` bound to `(org_id, device_id)` AAD)
// ---------------------------------------------------------------------------

pub fn validate_vault_device_id(device_id: &str) -> Result<(), MobileFfiError> {
    let bytes = device_id.as_bytes();
    if bytes.is_empty() || bytes.len() > 128 {
        return Err(MobileFfiError::InvalidInput);
    }
    if !bytes
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || matches!(*b, b'-' | b'_' | b'.' | b':'))
    {
        return Err(MobileFfiError::InvalidInput);
    }
    Ok(())
}

/// Canonical domain-separated, length-prefixed AAD binding `(org_id, device_id)`.
pub fn session_vault_aad(
    org_id: &OrganisationId,
    device_id: &str,
) -> Result<Vec<u8>, MobileFfiError> {
    validate_vault_device_id(device_id)?;
    let org_bytes = org_id.as_str().as_bytes();
    let dev_bytes = device_id.as_bytes();
    let mut aad =
        Vec::with_capacity(VAULT_AAD_DOMAIN.len() + 8 + org_bytes.len() + dev_bytes.len());
    aad.extend_from_slice(VAULT_AAD_DOMAIN);
    aad.extend_from_slice(&(org_bytes.len() as u32).to_be_bytes());
    aad.extend_from_slice(org_bytes);
    aad.extend_from_slice(&(dev_bytes.len() as u32).to_be_bytes());
    aad.extend_from_slice(dev_bytes);
    Ok(aad)
}

#[cfg(feature = "openmls-engine")]
pub fn session_vault_seal(
    org_id: &OrganisationId,
    device_id: &str,
    key: &[u8; 32],
    nonce: Option<[u8; SESSION_VAULT_NONCE_BYTES]>,
    plaintext: &[u8],
) -> Result<Vec<u8>, MobileFfiError> {
    if plaintext.is_empty() || plaintext.len() > MAX_SESSION_VAULT_PLAINTEXT_BYTES {
        return Err(MobileFfiError::Capacity);
    }
    let aad = session_vault_aad(org_id, device_id)?;
    let nonce_bytes = match nonce {
        Some(n) => n,
        None => OpenMlsRustCrypto::default()
            .rand()
            .random_array::<SESSION_VAULT_NONCE_BYTES>()
            .map_err(|_| MobileFfiError::InvalidInput)?,
    };
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| MobileFfiError::InvalidInput)?;
    let mut buffer = plaintext.to_vec();
    let tag = cipher
        .encrypt_inout_detached(
            &Nonce::from(nonce_bytes),
            &aad,
            buffer.as_mut_slice().into(),
        )
        .map_err(|_| MobileFfiError::AuthenticationFailed)?;
    let mut sealed = Vec::with_capacity(
        SESSION_VAULT_MAGIC.len()
            + SESSION_VAULT_NONCE_BYTES
            + buffer.len()
            + SESSION_VAULT_TAG_BYTES,
    );
    sealed.extend_from_slice(SESSION_VAULT_MAGIC);
    sealed.extend_from_slice(&nonce_bytes);
    sealed.extend_from_slice(&buffer);
    sealed.extend_from_slice(&tag);
    Ok(sealed)
}

#[cfg(feature = "openmls-engine")]
pub fn session_vault_open(
    org_id: &OrganisationId,
    device_id: &str,
    key: &[u8; 32],
    sealed: &[u8],
) -> Result<Vec<u8>, MobileFfiError> {
    let min_len =
        SESSION_VAULT_MAGIC.len() + SESSION_VAULT_NONCE_BYTES + 1 + SESSION_VAULT_TAG_BYTES;
    let max_len = SESSION_VAULT_MAGIC.len()
        + SESSION_VAULT_NONCE_BYTES
        + MAX_SESSION_VAULT_PLAINTEXT_BYTES
        + SESSION_VAULT_TAG_BYTES;
    if sealed.len() > max_len {
        return Err(MobileFfiError::Capacity);
    }
    if sealed.len() < min_len || !sealed.starts_with(SESSION_VAULT_MAGIC) {
        return Err(MobileFfiError::InvalidInput);
    }
    let aad = session_vault_aad(org_id, device_id)?;
    let header_end = SESSION_VAULT_MAGIC.len() + SESSION_VAULT_NONCE_BYTES;
    let tag_start = sealed.len() - SESSION_VAULT_TAG_BYTES;
    let nonce_bytes: [u8; SESSION_VAULT_NONCE_BYTES] = sealed
        [SESSION_VAULT_MAGIC.len()..header_end]
        .try_into()
        .map_err(|_| MobileFfiError::InvalidInput)?;
    let tag_bytes: [u8; SESSION_VAULT_TAG_BYTES] = sealed[tag_start..]
        .try_into()
        .map_err(|_| MobileFfiError::InvalidInput)?;
    let mut buffer = sealed[header_end..tag_start].to_vec();
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| MobileFfiError::InvalidInput)?;
    if cipher
        .decrypt_inout_detached(
            &Nonce::from(nonce_bytes),
            &aad,
            buffer.as_mut_slice().into(),
            &Tag::from(tag_bytes),
        )
        .is_err()
    {
        buffer.fill(0);
        return Err(MobileFfiError::AuthenticationFailed);
    }
    Ok(buffer)
}

#[cfg(feature = "openmls-engine")]
fn handle_session_vault_seal(
    root: &BTreeMap<String, FfiJsonValue>,
) -> Result<String, MobileFfiError> {
    ensure_allowed_keys(
        root,
        &[
            "op",
            "org_id",
            "device_id",
            "key_hex",
            "nonce_hex",
            "plaintext_hex",
        ],
    )?;
    let org_id = parse_org_field(root, "org_id")?;
    let device_id = required_str(root, "device_id")?;
    let key = decode_fixed_hex::<32>(required_str(root, "key_hex")?)?;
    let nonce = match root.get("nonce_hex") {
        Some(v) => Some(decode_fixed_hex::<SESSION_VAULT_NONCE_BYTES>(
            v.as_str().ok_or(MobileFfiError::InvalidInput)?,
        )?),
        None => None,
    };
    let plaintext = decode_lower_hex(required_str(root, "plaintext_hex")?)?;
    let sealed = session_vault_seal(&org_id, device_id, &key, nonce, &plaintext)?;
    Ok(format!(
        "{{\"ok\":true,\"sealed_hex\":\"{}\"}}",
        encode_hex(&sealed)
    ))
}

#[cfg(not(feature = "openmls-engine"))]
fn handle_session_vault_seal(
    _root: &BTreeMap<String, FfiJsonValue>,
) -> Result<String, MobileFfiError> {
    Err(MobileFfiError::FeatureDisabled)
}

#[cfg(feature = "openmls-engine")]
fn handle_session_vault_open(
    root: &BTreeMap<String, FfiJsonValue>,
) -> Result<String, MobileFfiError> {
    ensure_allowed_keys(
        root,
        &["op", "org_id", "device_id", "key_hex", "sealed_hex"],
    )?;
    let org_id = parse_org_field(root, "org_id")?;
    let device_id = required_str(root, "device_id")?;
    let key = decode_fixed_hex::<32>(required_str(root, "key_hex")?)?;
    let sealed = decode_lower_hex(required_str(root, "sealed_hex")?)?;
    let plaintext = session_vault_open(&org_id, device_id, &key, &sealed)?;
    Ok(format!(
        "{{\"ok\":true,\"plaintext_hex\":\"{}\"}}",
        encode_hex(&plaintext)
    ))
}

#[cfg(not(feature = "openmls-engine"))]
fn handle_session_vault_open(
    _root: &BTreeMap<String, FfiJsonValue>,
) -> Result<String, MobileFfiError> {
    Err(MobileFfiError::FeatureDisabled)
}

// ---------------------------------------------------------------------------
// 3. `SessionEnvelopeTracker` Verification & Observation
// ---------------------------------------------------------------------------

struct StructuralHeaderVerifier;

impl SessionEnvelopeVerifier for StructuralHeaderVerifier {
    fn verify_header(&self, _header: &SessionEnvelopeHeader) -> Result<(), CoreError> {
        Ok(())
    }
}

fn map_core_envelope_error(err: CoreError) -> MobileFfiError {
    match err {
        CoreError::OrganisationMismatch => MobileFfiError::OrganisationMismatch,
        CoreError::AlgorithmMismatch => MobileFfiError::AlgorithmMismatch,
        CoreError::StaleFrame => MobileFfiError::StaleEpoch,
        CoreError::ReplayDetected => MobileFfiError::Replay,
        CoreError::CapacityExceeded => MobileFfiError::Capacity,
        _ => MobileFfiError::InvalidInput,
    }
}

fn parse_envelope_header(
    obj: &BTreeMap<String, FfiJsonValue>,
) -> Result<SessionEnvelopeHeader, MobileFfiError> {
    ensure_allowed_keys(
        obj,
        &["org_id", "room_id", "message_id", "epoch", "algorithm"],
    )?;
    let organisation_id = parse_org_field(obj, "org_id")?;
    let room_id = parse_uuid_v7_str(required_str(obj, "room_id")?)?;
    let message_id = parse_uuid_v7_str(required_str(obj, "message_id")?)?;
    let epoch = obj
        .get("epoch")
        .and_then(FfiJsonValue::as_u64)
        .ok_or(MobileFfiError::InvalidInput)?;
    let alg_num = obj
        .get("algorithm")
        .and_then(FfiJsonValue::as_u64)
        .and_then(|n| u8::try_from(n).ok())
        .ok_or(MobileFfiError::InvalidInput)?;
    let algorithm = CryptoAlgorithm::from_u8(alg_num).map_err(|_| MobileFfiError::InvalidInput)?;
    Ok(SessionEnvelopeHeader {
        organisation_id,
        room_id,
        message_id,
        epoch,
        algorithm,
    })
}

fn handle_session_envelope_observe(
    root: &BTreeMap<String, FfiJsonValue>,
) -> Result<String, MobileFfiError> {
    ensure_allowed_keys(
        root,
        &[
            "op",
            "org_id",
            "room_capacity",
            "replay_capacity",
            "history",
            "envelope",
        ],
    )?;
    let org_id = parse_org_field(root, "org_id")?;
    let room_capacity = root
        .get("room_capacity")
        .and_then(FfiJsonValue::as_u64)
        .map(|v| v as usize)
        .unwrap_or(64);
    let replay_capacity = root
        .get("replay_capacity")
        .and_then(FfiJsonValue::as_u64)
        .map(|v| v as usize)
        .unwrap_or(256);

    let mut tracker = SessionEnvelopeTracker::new(org_id, room_capacity, replay_capacity)
        .map_err(map_core_envelope_error)?;
    let verifier = StructuralHeaderVerifier;

    if let Some(history_val) = root.get("history") {
        let items = history_val.as_array().ok_or(MobileFfiError::InvalidInput)?;
        if items.len() > 512 {
            return Err(MobileFfiError::Capacity);
        }
        for entry in items {
            let entry_obj = entry.as_object().ok_or(MobileFfiError::InvalidInput)?;
            let header = parse_envelope_header(entry_obj)?;
            tracker
                .verify_and_observe(&header, &verifier)
                .map_err(map_core_envelope_error)?;
        }
    }

    let candidate_obj = root
        .get("envelope")
        .and_then(FfiJsonValue::as_object)
        .ok_or(MobileFfiError::InvalidInput)?;
    let candidate = parse_envelope_header(candidate_obj)?;
    tracker
        .verify_and_observe(&candidate, &verifier)
        .map_err(map_core_envelope_error)?;

    Ok(format!(
        "{{\"ok\":true,\"room_count\":{},\"replay_count\":{}}}",
        tracker.room_count(),
        tracker.replay_count()
    ))
}

// ---------------------------------------------------------------------------
// 4. `OpenMlsDevice` Create & Restore
// ---------------------------------------------------------------------------

#[cfg(feature = "openmls-engine")]
struct ImmediateWake;

#[cfg(feature = "openmls-engine")]
impl Wake for ImmediateWake {
    fn wake(self: Arc<Self>) {}
}

#[cfg(feature = "openmls-engine")]
fn poll_ready<T>(fut: impl std::future::Future<Output = T>) -> Result<T, MobileFfiError> {
    let waker = Waker::from(Arc::new(ImmediateWake));
    let mut cx = Context::from_waker(&waker);
    let mut pinned = Box::pin(fut);
    match pinned.as_mut().poll(&mut cx) {
        Poll::Ready(val) => Ok(val),
        Poll::Pending => Err(MobileFfiError::InvalidInput),
    }
}

#[cfg(feature = "openmls-engine")]
struct SingleShotMlsDeviceStore {
    sealed: Option<Vec<u8>>,
    device_key: Option<Ed25519PublicKey>,
    generation: u64,
}

#[cfg(feature = "openmls-engine")]
impl MlsDeviceStore for SingleShotMlsDeviceStore {
    fn compare_and_swap<'a>(
        &'a mut self,
        write: &'a MlsDeviceWrite<'_>,
    ) -> impl std::future::Future<Output = Result<(), MlsDeviceStoreError>> + 'a {
        let result = if write.expected_generation != self.generation {
            Err(MlsDeviceStoreError::Conflict)
        } else {
            self.sealed = Some(write.sealed.as_bytes().to_vec());
            self.device_key = Some(write.device_key);
            self.generation = write.generation;
            Ok(())
        };
        std::future::ready(result)
    }
}

#[cfg(feature = "openmls-engine")]
fn map_mls_error(err: NativeCryptoError) -> MobileFfiError {
    match err {
        NativeCryptoError::AuthenticationFailed | NativeCryptoError::UnauthorisedDevice => {
            MobileFfiError::AuthenticationFailed
        }
        NativeCryptoError::Replay => MobileFfiError::Replay,
        NativeCryptoError::EpochMismatch => MobileFfiError::StaleEpoch,
        NativeCryptoError::ScopeMismatch => MobileFfiError::OrganisationMismatch,
        NativeCryptoError::Capacity => MobileFfiError::Capacity,
        NativeCryptoError::InvalidInput | NativeCryptoError::Storage => {
            MobileFfiError::InvalidInput
        }
    }
}

#[cfg(feature = "openmls-engine")]
fn handle_mls_device_create(
    root: &BTreeMap<String, FfiJsonValue>,
) -> Result<String, MobileFfiError> {
    ensure_allowed_keys(
        root,
        &[
            "op",
            "org_id",
            "membership_id",
            "public_identity_hex",
            "wrapping_key_hex",
        ],
    )?;
    let org_id = parse_org_field(root, "org_id")?;
    let membership = RelayId::parse(required_str(root, "membership_id")?).map_err(map_mls_error)?;
    let public_identity = decode_lower_hex(required_str(root, "public_identity_hex")?)?;
    let wrapping_key = decode_fixed_hex::<32>(required_str(root, "wrapping_key_hex")?)?;

    let scope = MlsDeviceScope::new(org_id, membership);
    let mut store = SingleShotMlsDeviceStore {
        sealed: None,
        device_key: None,
        generation: 0,
    };
    let device = poll_ready(OpenMlsDevice::create_and_persist(
        scope,
        &public_identity,
        &wrapping_key,
        &mut store,
    ))?
    .map_err(map_mls_error)?;
    let sealed = store.sealed.ok_or(MobileFfiError::InvalidInput)?;
    if sealed.len() * 2 + 256 > KODERA_FFI_PACKET_CAPACITY {
        return Err(MobileFfiError::Capacity);
    }
    Ok(format!(
        "{{\"ok\":true,\"device_key_hex\":\"{}\",\"generation\":{},\"sealed_hex\":\"{}\"}}",
        encode_hex(&device.device_key()),
        device.generation(),
        encode_hex(&sealed)
    ))
}

#[cfg(not(feature = "openmls-engine"))]
fn handle_mls_device_create(
    _root: &BTreeMap<String, FfiJsonValue>,
) -> Result<String, MobileFfiError> {
    Err(MobileFfiError::FeatureDisabled)
}

#[cfg(feature = "openmls-engine")]
fn handle_mls_device_restore(
    root: &BTreeMap<String, FfiJsonValue>,
) -> Result<String, MobileFfiError> {
    ensure_allowed_keys(
        root,
        &[
            "op",
            "org_id",
            "membership_id",
            "expected_device_key_hex",
            "expected_generation",
            "wrapping_key_hex",
            "sealed_hex",
        ],
    )?;
    let org_id = parse_org_field(root, "org_id")?;
    let membership = RelayId::parse(required_str(root, "membership_id")?).map_err(map_mls_error)?;
    let expected_key = decode_fixed_hex::<32>(required_str(root, "expected_device_key_hex")?)?;
    let expected_generation = root
        .get("expected_generation")
        .and_then(FfiJsonValue::as_u64)
        .ok_or(MobileFfiError::InvalidInput)?;
    let wrapping_key = decode_fixed_hex::<32>(required_str(root, "wrapping_key_hex")?)?;
    let sealed_raw = decode_lower_hex(required_str(root, "sealed_hex")?)?;
    let sealed = SealedMlsDeviceState::from_bytes(&sealed_raw).map_err(map_mls_error)?;

    let scope = MlsDeviceScope::new(org_id, membership);
    let restored = OpenMlsDevice::restore_device(
        scope,
        expected_key,
        None,
        expected_generation,
        &sealed,
        &wrapping_key,
    )
    .map_err(map_mls_error)?;

    Ok(format!(
        "{{\"ok\":true,\"device_key_hex\":\"{}\",\"generation\":{}}}",
        encode_hex(&restored.device_key()),
        restored.generation()
    ))
}

#[cfg(not(feature = "openmls-engine"))]
fn handle_mls_device_restore(
    _root: &BTreeMap<String, FfiJsonValue>,
) -> Result<String, MobileFfiError> {
    Err(MobileFfiError::FeatureDisabled)
}

// ---------------------------------------------------------------------------
// 5. Single-Grapheme Emoji Reaction Validator (`UTS #51` / `timeline.ts`)
// ---------------------------------------------------------------------------

/// Validates that `key` is a single emoji grapheme cluster (`<= 32` UTF-8 bytes) with zero
/// control, whitespace, or bidi/invisible format characters.
pub fn validate_reaction_key(key: &str) -> bool {
    if key.is_empty() || key.len() > MAX_REACTION_KEY_BYTES {
        return false;
    }
    let scalars: Vec<u32> = key.chars().map(|c| c as u32).collect();
    if scalars.iter().any(|&cp| is_forbidden_reaction_scalar(cp)) {
        return false;
    }

    // 1. Keycap sequence: [0-9#*] U+FE0F? U+20E3
    if matches!(scalars[0], 0x23 | 0x2A | 0x30..=0x39) {
        return matches!(scalars.as_slice(), [_, 0x20E3] | [_, 0xFE0F, 0x20E3]);
    }

    // 2. Regional indicator flag sequence: exactly 2 regional indicators
    if is_regional_indicator(scalars[0]) {
        return scalars.len() == 2 && is_regional_indicator(scalars[1]);
    }

    // 3. Emoji base (+ optional skin tone / VS16) (+ optional ZWJ continuations)
    let mut idx = 0;
    loop {
        if idx >= scalars.len() || !is_emoji_pictographic_base(scalars[idx]) {
            return false;
        }
        idx += 1;
        if idx < scalars.len() && scalars[idx] == 0xFE0F {
            idx += 1;
        }
        if idx < scalars.len() && is_skin_tone_modifier(scalars[idx]) {
            idx += 1;
            if idx < scalars.len() && scalars[idx] == 0xFE0F {
                idx += 1;
            }
        }
        if idx == scalars.len() {
            return true;
        }
        // Only a U+200D ZWJ followed by another valid emoji base continues the single cluster.
        if scalars[idx] == 0x200D {
            idx += 1;
            if idx >= scalars.len() {
                return false;
            }
        } else {
            return false;
        }
    }
}

fn is_forbidden_reaction_scalar(cp: u32) -> bool {
    if let Some(ch) = char::from_u32(cp) {
        if ch.is_whitespace() {
            return true;
        }
    }
    matches!(
        cp,
        0x0000..=0x001F
            | 0x007F..=0x009F
            | 0x00AD
            | 0x034F
            | 0x061C
            | 0x200B..=0x200C
            | 0x200E..=0x200F
            | 0x202A..=0x202E
            | 0x2060..=0x206F
            | 0xFEFF
            | 0xE0000..=0xE007F
    )
}

fn is_regional_indicator(cp: u32) -> bool {
    (0x1F1E6..=0x1F1FF).contains(&cp)
}

fn is_skin_tone_modifier(cp: u32) -> bool {
    (0x1F3FB..=0x1F3FF).contains(&cp)
}

fn is_emoji_pictographic_base(cp: u32) -> bool {
    if is_regional_indicator(cp) || is_skin_tone_modifier(cp) {
        return false;
    }
    matches!(
        cp,
        0x00A9
            | 0x00AE
            | 0x203C
            | 0x2049
            | 0x2122
            | 0x2139
            | 0x2194..=0x2199
            | 0x21A9..=0x21AA
            | 0x231A..=0x231B
            | 0x2328
            | 0x23CF
            | 0x23E9..=0x23F3
            | 0x23F8..=0x23FA
            | 0x24C2
            | 0x25AA..=0x25AB
            | 0x25B6
            | 0x25C0
            | 0x25FB..=0x25FE
            | 0x2600..=0x27BF
            | 0x2934..=0x2935
            | 0x2B05..=0x2B07
            | 0x2B1B..=0x2B1C
            | 0x2B50
            | 0x2B55
            | 0x3030
            | 0x303D
            | 0x3297
            | 0x3299
            | 0x1F000..=0x1FAFF
    )
}

/// MIME allowlist shared with native mobile attachment references.
pub fn validate_attachment_mime(content_type: &str) -> bool {
    matches!(
        content_type,
        "image/jpeg"
            | "image/png"
            | "image/webp"
            | "image/gif"
            | "application/pdf"
            | "text/plain"
            | "application/octet-stream"
            | "audio/ogg"
            | "audio/webm"
            | "audio/mp4"
    )
}

fn handle_attachment_mime_validate(
    root: &BTreeMap<String, FfiJsonValue>,
) -> Result<String, MobileFfiError> {
    ensure_allowed_keys(root, &["op", "content_type"])?;
    let valid = validate_attachment_mime(required_str(root, "content_type")?);
    Ok(format!("{{\"ok\":true,\"valid\":{valid}}}"))
}

fn handle_reaction_validate(
    root: &BTreeMap<String, FfiJsonValue>,
) -> Result<String, MobileFfiError> {
    ensure_allowed_keys(root, &["op", "key"])?;
    let key = required_str(root, "key")?;
    let valid = validate_reaction_key(key);
    Ok(format!("{{\"ok\":true,\"valid\":{valid}}}"))
}

// ---------------------------------------------------------------------------
// 6. Payload-Free Push Wakeup Admission (`wakeup_envelope_admit`)
// ---------------------------------------------------------------------------

const FORBIDDEN_CLEARTEXT_KEYS: &[&str] = &[
    "notification",
    "room_title",
    "roomtitle",
    "room_name",
    "roomname",
    "channel_name",
    "channelname",
    "sender",
    "sender_name",
    "sendername",
    "sender_display_name",
    "caller",
    "caller_name",
    "callername",
    "display_name",
    "displayname",
    "message",
    "body",
    "plaintext",
    "text",
    "content",
    "topic",
    "subject",
    "title",
    "subtitle",
    "alert",
    "avatar_url",
    "matrix_event",
    "sdp",
    "livekit_token",
    "access_token",
    "auth_token",
];

const ADMITTED_WAKEUP_KEYS: &[&str] = &[
    "wakeup_id",
    "organisation_id",
    "org_id",
    "sync_hint",
    "room_hash",
    "epoch_ms",
    "transport",
    "aps",
];

pub fn admit_wakeup_envelope(raw_json: &[u8]) -> Result<AdmittedWakeupEnvelope, MobileFfiError> {
    if raw_json.is_empty() || raw_json.len() > MAX_WAKEUP_ENVELOPE_BYTES {
        return Err(MobileFfiError::InvalidJson);
    }
    let obj = StrictFfiJson::parse_object(raw_json, MAX_WAKEUP_ENVELOPE_BYTES)?;

    for (key, value) in &obj {
        if is_forbidden_cleartext_key(key) {
            return Err(MobileFfiError::CleartextForbidden(key.clone()));
        }
        if key == "aps" {
            let aps = value.as_object().ok_or(MobileFfiError::InvalidInput)?;
            for (aps_key, aps_val) in aps {
                let qualified = format!("aps.{aps_key}");
                if is_forbidden_cleartext_key(aps_key) {
                    return Err(MobileFfiError::CleartextForbidden(qualified));
                }
                if aps_key != "content-available" {
                    return Err(MobileFfiError::UnexpectedField(qualified));
                }
                if aps_val.as_u64() != Some(1) {
                    return Err(MobileFfiError::InvalidInput);
                }
            }
            continue;
        }
        if let Some(leaked) = find_forbidden_nested_value(value) {
            return Err(MobileFfiError::CleartextForbidden(format!(
                "{key}.{leaked}"
            )));
        }
        if !ADMITTED_WAKEUP_KEYS.contains(&key.as_str()) {
            return Err(MobileFfiError::UnexpectedField(key.clone()));
        }
    }

    let wakeup_id = required_str(&obj, "wakeup_id")?.to_owned();
    OrganisationId::parse(&wakeup_id).map_err(|_| MobileFfiError::InvalidInput)?;

    let org_primary = optional_checked_str(&obj, "org_id")?;
    let org_alias = optional_checked_str(&obj, "organisation_id")?;
    if let (Some(a), Some(b)) = (org_primary, org_alias) {
        if a != b {
            return Err(MobileFfiError::InvalidInput);
        }
    }
    let org_str = org_primary
        .or(org_alias)
        .ok_or(MobileFfiError::InvalidInput)?;
    let organisation_id =
        OrganisationId::parse(org_str).map_err(|_| MobileFfiError::InvalidInput)?;

    let hint_primary = optional_checked_str(&obj, "sync_hint")?;
    let hint_alias = optional_checked_str(&obj, "room_hash")?;
    if let (Some(a), Some(b)) = (hint_primary, hint_alias) {
        if a != b {
            return Err(MobileFfiError::InvalidInput);
        }
    }
    let sync_hint = hint_primary
        .or(hint_alias)
        .ok_or(MobileFfiError::InvalidInput)?;
    if !is_valid_sync_hint(sync_hint) {
        return Err(MobileFfiError::InvalidInput);
    }

    let epoch_ms = match obj.get("epoch_ms") {
        None => None,
        Some(FfiJsonValue::Uint(v)) if (1..=MAX_WAKEUP_EPOCH_MS).contains(v) => Some(*v),
        Some(FfiJsonValue::Str(s)) => {
            let parsed = parse_canonical_u64(s).ok_or(MobileFfiError::InvalidInput)?;
            if !(1..=MAX_WAKEUP_EPOCH_MS).contains(&parsed) {
                return Err(MobileFfiError::InvalidInput);
            }
            Some(parsed)
        }
        _ => return Err(MobileFfiError::InvalidInput),
    };

    let transport = match obj.get("transport") {
        None => None,
        Some(FfiJsonValue::Str(t)) => {
            let lower = t.to_ascii_lowercase();
            if !matches!(lower.as_str(), "apns" | "unifiedpush" | "fcm") {
                return Err(MobileFfiError::InvalidInput);
            }
            Some(lower)
        }
        _ => return Err(MobileFfiError::InvalidInput),
    };

    Ok(AdmittedWakeupEnvelope {
        wakeup_id,
        organisation_id,
        sync_hint: sync_hint.to_owned(),
        epoch_ms,
        transport,
    })
}

fn is_forbidden_cleartext_key(key: &str) -> bool {
    let normalized = key.trim().to_ascii_lowercase().replace('-', "_");
    FORBIDDEN_CLEARTEXT_KEYS.contains(&normalized.as_str())
}

fn find_forbidden_nested_value(value: &FfiJsonValue) -> Option<String> {
    match value {
        FfiJsonValue::Obj(map) => find_forbidden_nested_key(map),
        FfiJsonValue::Arr(items) => {
            for item in items {
                if let Some(leaked) = find_forbidden_nested_value(item) {
                    return Some(leaked);
                }
            }
            None
        }
        _ => None,
    }
}

fn find_forbidden_nested_key(map: &BTreeMap<String, FfiJsonValue>) -> Option<String> {
    for (k, v) in map {
        if is_forbidden_cleartext_key(k) {
            return Some(k.clone());
        }
        if let Some(sub) = find_forbidden_nested_value(v) {
            return Some(format!("{k}.{sub}"));
        }
    }
    None
}

fn is_valid_sync_hint(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=MAX_WAKEUP_SYNC_HINT_BYTES).contains(&bytes.len())
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(*b, b'-' | b'.' | b'_' | b':'))
}

fn parse_canonical_u64(raw: &str) -> Option<u64> {
    let bytes = raw.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 16
        || !(b'1'..=b'9').contains(&bytes[0])
        || !bytes.iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    raw.parse::<u64>().ok()
}

fn handle_wakeup_envelope_admit(
    root: &BTreeMap<String, FfiJsonValue>,
) -> Result<String, MobileFfiError> {
    ensure_allowed_keys(root, &["op", "payload_hex"])?;
    let payload = decode_lower_hex(required_str(root, "payload_hex")?)?;
    let admitted = admit_wakeup_envelope(&payload)?;
    Ok(format!(
        "{{\"ok\":true,\"wakeup_id\":\"{}\",\"organisation_id\":\"{}\",\"sync_hint\":\"{}\"}}",
        admitted.wakeup_id,
        admitted.organisation_id.as_str(),
        admitted.sync_hint
    ))
}

// ---------------------------------------------------------------------------
// Helpers & Self-Contained Strict JSON Parser (`<= 65_536` bytes, zero `unsafe`)
// ---------------------------------------------------------------------------

fn ensure_allowed_keys(
    map: &BTreeMap<String, FfiJsonValue>,
    allowed: &[&str],
) -> Result<(), MobileFfiError> {
    for key in map.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(MobileFfiError::UnexpectedField(key.clone()));
        }
    }
    Ok(())
}

fn required_str<'a>(
    map: &'a BTreeMap<String, FfiJsonValue>,
    key: &str,
) -> Result<&'a str, MobileFfiError> {
    map.get(key)
        .and_then(FfiJsonValue::as_str)
        .ok_or(MobileFfiError::InvalidInput)
}

fn optional_checked_str<'a>(
    map: &'a BTreeMap<String, FfiJsonValue>,
    key: &str,
) -> Result<Option<&'a str>, MobileFfiError> {
    match map.get(key) {
        None => Ok(None),
        Some(v) => v.as_str().map(Some).ok_or(MobileFfiError::InvalidInput),
    }
}

fn parse_org_field(
    map: &BTreeMap<String, FfiJsonValue>,
    key: &str,
) -> Result<OrganisationId, MobileFfiError> {
    let raw = required_str(map, key)?;
    OrganisationId::parse(raw).map_err(|_| MobileFfiError::InvalidInput)
}

fn decode_lower_hex(hex: &str) -> Result<Vec<u8>, MobileFfiError> {
    if !hex
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(MobileFfiError::InvalidInput);
    }
    decode_hex(hex).map_err(|_| MobileFfiError::InvalidInput)
}

fn decode_fixed_hex<const N: usize>(hex: &str) -> Result<[u8; N], MobileFfiError> {
    if hex.len() != N * 2 {
        return Err(MobileFfiError::InvalidInput);
    }
    let decoded = decode_lower_hex(hex)?;
    decoded.try_into().map_err(|_| MobileFfiError::InvalidInput)
}

fn escape_json_str(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum FfiJsonValue {
    Obj(BTreeMap<String, FfiJsonValue>),
    Arr(Vec<FfiJsonValue>),
    Str(String),
    Uint(u64),
    NonUintNumber,
    Bool(bool),
    Null,
}

impl FfiJsonValue {
    fn as_str(&self) -> Option<&str> {
        if let Self::Str(s) = self {
            Some(s.as_str())
        } else {
            None
        }
    }

    fn as_u64(&self) -> Option<u64> {
        if let Self::Uint(v) = self {
            Some(*v)
        } else {
            None
        }
    }

    fn as_object(&self) -> Option<&BTreeMap<String, FfiJsonValue>> {
        if let Self::Obj(m) = self {
            Some(m)
        } else {
            None
        }
    }

    fn as_array(&self) -> Option<&[FfiJsonValue]> {
        if let Self::Arr(a) = self {
            Some(a.as_slice())
        } else {
            None
        }
    }
}

struct StrictFfiJson<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> StrictFfiJson<'a> {
    const MAX_DEPTH: usize = 16;

    fn parse_object(
        raw: &'a [u8],
        byte_limit: usize,
    ) -> Result<BTreeMap<String, FfiJsonValue>, MobileFfiError> {
        if raw.is_empty() || raw.len() > byte_limit || std::str::from_utf8(raw).is_err() {
            return Err(MobileFfiError::InvalidJson);
        }
        let mut parser = Self { bytes: raw, pos: 0 };
        parser.skip_ws();
        let obj = parser.read_object(1)?;
        parser.skip_ws();
        if parser.pos != parser.bytes.len() {
            return Err(MobileFfiError::InvalidJson);
        }
        Ok(obj)
    }

    fn skip_ws(&mut self) {
        while self.pos < self.bytes.len()
            && matches!(self.bytes[self.pos], b' ' | b'\t' | b'\r' | b'\n')
        {
            self.pos += 1;
        }
    }

    fn take_byte(&mut self, expected: u8) -> bool {
        if self.pos < self.bytes.len() && self.bytes[self.pos] == expected {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn expect_byte(&mut self, expected: u8) -> Result<(), MobileFfiError> {
        if self.take_byte(expected) {
            Ok(())
        } else {
            Err(MobileFfiError::InvalidJson)
        }
    }

    fn read_value(&mut self, depth: usize) -> Result<FfiJsonValue, MobileFfiError> {
        if depth > Self::MAX_DEPTH {
            return Err(MobileFfiError::InvalidJson);
        }
        self.skip_ws();
        let b = *self
            .bytes
            .get(self.pos)
            .ok_or(MobileFfiError::InvalidJson)?;
        match b {
            b'{' => self.read_object(depth).map(FfiJsonValue::Obj),
            b'[' => self.read_array(depth).map(FfiJsonValue::Arr),
            b'"' => self.read_string().map(FfiJsonValue::Str),
            b't' => {
                self.expect_literal(b"true")?;
                Ok(FfiJsonValue::Bool(true))
            }
            b'f' => {
                self.expect_literal(b"false")?;
                Ok(FfiJsonValue::Bool(false))
            }
            b'n' => {
                self.expect_literal(b"null")?;
                Ok(FfiJsonValue::Null)
            }
            b'-' | b'0'..=b'9' => self.read_number(),
            _ => Err(MobileFfiError::InvalidJson),
        }
    }

    fn read_object(
        &mut self,
        depth: usize,
    ) -> Result<BTreeMap<String, FfiJsonValue>, MobileFfiError> {
        if depth > Self::MAX_DEPTH {
            return Err(MobileFfiError::InvalidJson);
        }
        self.expect_byte(b'{')?;
        self.skip_ws();
        let mut map = BTreeMap::new();
        if self.take_byte(b'}') {
            return Ok(map);
        }
        loop {
            self.skip_ws();
            let key = self.read_string()?;
            if map.contains_key(&key) {
                return Err(MobileFfiError::InvalidJson);
            }
            self.skip_ws();
            self.expect_byte(b':')?;
            let val = self.read_value(depth + 1)?;
            map.insert(key, val);
            self.skip_ws();
            if self.take_byte(b'}') {
                return Ok(map);
            }
            self.expect_byte(b',')?;
        }
    }

    fn read_array(&mut self, depth: usize) -> Result<Vec<FfiJsonValue>, MobileFfiError> {
        self.expect_byte(b'[')?;
        self.skip_ws();
        let mut items = Vec::new();
        if self.take_byte(b']') {
            return Ok(items);
        }
        loop {
            items.push(self.read_value(depth + 1)?);
            self.skip_ws();
            if self.take_byte(b']') {
                return Ok(items);
            }
            self.expect_byte(b',')?;
        }
    }

    fn expect_literal(&mut self, lit: &[u8]) -> Result<(), MobileFfiError> {
        if self.bytes.len().saturating_sub(self.pos) < lit.len()
            || &self.bytes[self.pos..self.pos + lit.len()] != lit
        {
            return Err(MobileFfiError::InvalidJson);
        }
        self.pos += lit.len();
        Ok(())
    }

    fn read_number(&mut self) -> Result<FfiJsonValue, MobileFfiError> {
        let start = self.pos;
        let negative = self.take_byte(b'-');
        let int_start = self.pos;
        if self.take_byte(b'0') {
            if self.bytes.get(self.pos).is_some_and(u8::is_ascii_digit) {
                return Err(MobileFfiError::InvalidJson);
            }
        } else {
            while self.bytes.get(self.pos).is_some_and(u8::is_ascii_digit) {
                self.pos += 1;
            }
            if self.pos == int_start {
                return Err(MobileFfiError::InvalidJson);
            }
        }
        let mut fractional_or_exp = false;
        if self.take_byte(b'.') {
            fractional_or_exp = true;
            let frac_start = self.pos;
            while self.bytes.get(self.pos).is_some_and(u8::is_ascii_digit) {
                self.pos += 1;
            }
            if self.pos == frac_start {
                return Err(MobileFfiError::InvalidJson);
            }
        }
        if matches!(self.bytes.get(self.pos), Some(b'e' | b'E')) {
            fractional_or_exp = true;
            self.pos += 1;
            if matches!(self.bytes.get(self.pos), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            let exp_start = self.pos;
            while self.bytes.get(self.pos).is_some_and(u8::is_ascii_digit) {
                self.pos += 1;
            }
            if self.pos == exp_start {
                return Err(MobileFfiError::InvalidJson);
            }
        }
        if negative || fractional_or_exp {
            return Ok(FfiJsonValue::NonUintNumber);
        }
        let s = std::str::from_utf8(&self.bytes[start..self.pos])
            .map_err(|_| MobileFfiError::InvalidJson)?;
        Ok(match s.parse::<u64>() {
            Ok(v) => FfiJsonValue::Uint(v),
            Err(_) => FfiJsonValue::NonUintNumber,
        })
    }

    fn read_string(&mut self) -> Result<String, MobileFfiError> {
        self.expect_byte(b'"')?;
        let mut out = String::new();
        while self.pos < self.bytes.len() {
            let b = self.bytes[self.pos];
            if b == b'"' {
                self.pos += 1;
                return Ok(out);
            }
            if b < 0x20 {
                return Err(MobileFfiError::InvalidJson);
            }
            if b == b'\\' {
                self.pos += 1;
                let esc = *self
                    .bytes
                    .get(self.pos)
                    .ok_or(MobileFfiError::InvalidJson)?;
                self.pos += 1;
                match esc {
                    b'"' => out.push('"'),
                    b'\\' => out.push('\\'),
                    b'/' => out.push('/'),
                    b'b' => out.push('\u{0008}'),
                    b'f' => out.push('\u{000C}'),
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'u' => {
                        let code = self.read_hex_u16()?;
                        if (0xD800..=0xDBFF).contains(&code) {
                            if self.bytes.get(self.pos..self.pos + 2) != Some(b"\\u") {
                                return Err(MobileFfiError::InvalidJson);
                            }
                            self.pos += 2;
                            let low = self.read_hex_u16()?;
                            if !(0xDC00..=0xDFFF).contains(&low) {
                                return Err(MobileFfiError::InvalidJson);
                            }
                            let scalar =
                                0x10000 + (((code as u32 - 0xD800) << 10) | (low as u32 - 0xDC00));
                            let ch = char::from_u32(scalar).ok_or(MobileFfiError::InvalidJson)?;
                            out.push(ch);
                        } else if (0xDC00..=0xDFFF).contains(&code) {
                            return Err(MobileFfiError::InvalidJson);
                        } else {
                            let ch =
                                char::from_u32(code as u32).ok_or(MobileFfiError::InvalidJson)?;
                            out.push(ch);
                        }
                    }
                    _ => return Err(MobileFfiError::InvalidJson),
                }
            } else {
                let remaining = std::str::from_utf8(&self.bytes[self.pos..])
                    .map_err(|_| MobileFfiError::InvalidJson)?;
                let ch = remaining
                    .chars()
                    .next()
                    .ok_or(MobileFfiError::InvalidJson)?;
                out.push(ch);
                self.pos += ch.len_utf8();
            }
        }
        Err(MobileFfiError::InvalidJson)
    }

    fn read_hex_u16(&mut self) -> Result<u16, MobileFfiError> {
        if self.bytes.len().saturating_sub(self.pos) < 4 {
            return Err(MobileFfiError::InvalidJson);
        }
        let hex = std::str::from_utf8(&self.bytes[self.pos..self.pos + 4])
            .map_err(|_| MobileFfiError::InvalidJson)?;
        self.pos += 4;
        u16::from_str_radix(hex, 16).map_err(|_| MobileFfiError::InvalidJson)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load_mobile_vectors() -> BTreeMap<String, String> {
        let text = include_str!("../vectors/mobile-ffi-v1.txt");
        let mut map = BTreeMap::new();
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let (k, v) = trimmed
                .split_once('=')
                .expect("valid key=value vector line");
            assert!(map.insert(k.to_owned(), v.to_owned()).is_none());
        }
        map
    }

    fn invoke_packet_json(json: &str) -> (i32, u32, String) {
        let req = KoderaFfiPacket::from_slice(json.as_bytes()).unwrap();
        let mut resp = KoderaFfiPacket::empty();
        let dispatcher: &dyn PacketDispatcher = &RustPacketDispatcher;
        let code = dispatcher.dispatch(&req, &mut resp);
        let text = std::str::from_utf8(resp.as_slice().unwrap())
            .unwrap()
            .to_owned();
        (code, resp.status, text)
    }

    #[test]
    fn packet_bounds_and_invalid_json_fail_closed() {
        let mut oversized = KoderaFfiPacket::empty();
        oversized.len = (KODERA_FFI_PACKET_CAPACITY + 1) as u32;
        let mut resp = KoderaFfiPacket::empty();
        assert_eq!(
            invoke_packet(&oversized, &mut resp),
            -(KODERA_FFI_STATUS_INVALID_PACKET as i32)
        );
        assert_eq!(resp.status, KODERA_FFI_STATUS_INVALID_PACKET);

        let (code, status, body) = invoke_packet_json("{\"op\":\"uuid_v7_mint\",\"op\":\"dup\"}");
        assert_eq!(code, -(KODERA_FFI_STATUS_INVALID_JSON as i32));
        assert_eq!(status, KODERA_FFI_STATUS_INVALID_JSON);
        assert!(body.contains("invalid_json"));

        let (code_unk, status_unk, _) = invoke_packet_json("{\"op\":\"not_an_operation\"}");
        assert_eq!(code_unk, -(KODERA_FFI_STATUS_UNKNOWN_OP as i32));
        assert_eq!(status_unk, KODERA_FFI_STATUS_UNKNOWN_OP);
    }

    #[test]
    fn uuid_v7_mint_and_envelope_tracker_match_shared_vectors() {
        let vectors = load_mobile_vectors();
        let ts_ms: u64 = vectors["unix_ts_ms"].parse().unwrap();
        let rand_hex = &vectors["uuid_rand_hex"];
        let expected_uuid = &vectors["expected_uuid_v7"];

        let (code, status, body) = invoke_packet_json(&format!(
            "{{\"op\":\"uuid_v7_mint\",\"unix_ts_ms\":{ts_ms},\"rand_hex\":\"{rand_hex}\"}}"
        ));
        assert_eq!(code, 0);
        assert_eq!(status, KODERA_FFI_STATUS_OK);
        assert_eq!(
            body,
            format!("{{\"ok\":true,\"uuid\":\"{expected_uuid}\",\"timestamp_ms\":{ts_ms}}}")
        );

        let org = &vectors["organisation"];
        let room = &vectors["envelope_room_id"];
        let msg1 = &vectors["envelope_msg_1"];
        let msg2 = &vectors["envelope_msg_2"];

        let (ok_code, _, ok_body) = invoke_packet_json(&format!(
            "{{\"op\":\"session_envelope_verify_and_observe\",\"org_id\":\"{org}\",\
            \"history\":[{{\"org_id\":\"{org}\",\"room_id\":\"{room}\",\"message_id\":\"{msg1}\",\"epoch\":1,\"algorithm\":2}}],\
            \"envelope\":{{\"org_id\":\"{org}\",\"room_id\":\"{room}\",\"message_id\":\"{msg2}\",\"epoch\":2,\"algorithm\":2}}}}"
        ));
        assert_eq!(ok_code, 0);
        assert_eq!(ok_body, "{\"ok\":true,\"room_count\":1,\"replay_count\":2}");

        // Replay of msg1 is refused
        let (replay_code, replay_status, _) = invoke_packet_json(&format!(
            "{{\"op\":\"session_envelope_verify_and_observe\",\"org_id\":\"{org}\",\
            \"history\":[{{\"org_id\":\"{org}\",\"room_id\":\"{room}\",\"message_id\":\"{msg1}\",\"epoch\":2,\"algorithm\":2}}],\
            \"envelope\":{{\"org_id\":\"{org}\",\"room_id\":\"{room}\",\"message_id\":\"{msg1}\",\"epoch\":2,\"algorithm\":2}}}}"
        ));
        assert_eq!(replay_code, -(KODERA_FFI_STATUS_REPLAY as i32));
        assert_eq!(replay_status, KODERA_FFI_STATUS_REPLAY);

        // Epoch rollback (2 -> 1) is refused
        let (stale_code, stale_status, _) = invoke_packet_json(&format!(
            "{{\"op\":\"session_envelope_verify_and_observe\",\"org_id\":\"{org}\",\
            \"history\":[{{\"org_id\":\"{org}\",\"room_id\":\"{room}\",\"message_id\":\"{msg1}\",\"epoch\":2,\"algorithm\":2}}],\
            \"envelope\":{{\"org_id\":\"{org}\",\"room_id\":\"{room}\",\"message_id\":\"{msg2}\",\"epoch\":1,\"algorithm\":2}}}}"
        ));
        assert_eq!(stale_code, -(KODERA_FFI_STATUS_STALE_EPOCH as i32));
        assert_eq!(stale_status, KODERA_FFI_STATUS_STALE_EPOCH);
    }

    #[test]
    fn reaction_and_wakeup_admission_match_shared_vectors() {
        let vectors = load_mobile_vectors();
        for emoji in vectors["valid_reactions"].split(',') {
            let (code, _, body) = invoke_packet_json(&format!(
                "{{\"op\":\"reaction_validate\",\"key\":\"{emoji}\"}}"
            ));
            assert_eq!(code, 0);
            assert_eq!(body, "{\"ok\":true,\"valid\":true}", "emoji={emoji}");
        }
        for bad in ["", "👍👎", "🇫🇷🇺🇸", "ok", "1", "👍 ", "👍\\u200b"] {
            let (code, _, body) = invoke_packet_json(&format!(
                "{{\"op\":\"reaction_validate\",\"key\":\"{bad}\"}}"
            ));
            assert_eq!(code, 0);
            assert_eq!(body, "{\"ok\":true,\"valid\":false}", "bad={bad}");
        }

        let valid_wakeup_hex = encode_hex(vectors["valid_wakeup_json"].as_bytes());
        let (w_code, _, w_body) = invoke_packet_json(&format!(
            "{{\"op\":\"wakeup_envelope_admit\",\"payload_hex\":\"{valid_wakeup_hex}\"}}"
        ));
        assert_eq!(w_code, 0);
        assert!(w_body.contains("\"ok\":true"));

        for leak_json in [
            "{\"wakeup_id\":\"01935800-0000-7000-8000-000000000301\",\"organisation_id\":\"00000000-0000-4000-8000-000000000001\",\"sync_hint\":\"sync_1\",\"body\":\"secret\"}",
            "{\"wakeup_id\":\"01935800-0000-7000-8000-000000000301\",\"organisation_id\":\"00000000-0000-4000-8000-000000000001\",\"sync_hint\":\"sync_1\",\"aps\":{\"alert\":\"hi\"}}",
            vectors["invalid_wakeup_nested_transport_json"].as_str(),
        ] {
            let hex = encode_hex(leak_json.as_bytes());
            let (code, status, body) = invoke_packet_json(&format!(
                "{{\"op\":\"wakeup_envelope_admit\",\"payload_hex\":\"{hex}\"}}"
            ));
            assert_eq!(code, -(KODERA_FFI_STATUS_CLEARTEXT_FORBIDDEN as i32));
            assert_eq!(status, KODERA_FFI_STATUS_CLEARTEXT_FORBIDDEN);
            assert!(body.contains("cleartext_forbidden"));
        }

        let admitted_transport_epoch =
            admit_wakeup_envelope(vectors["valid_wakeup_transport_epoch_json"].as_bytes())
                .expect("valid unifiedpush + epoch_ms wakeup");
        assert_eq!(
            admitted_transport_epoch.transport.as_deref(),
            Some("unifiedpush")
        );
        assert_eq!(admitted_transport_epoch.epoch_ms, Some(1732320000123));

        for dup_json in [
            vectors["invalid_wakeup_duplicate_key_json"].as_str(),
            "{\"wakeup_id\":\"01935800-0000-7000-8000-000000000301\",\"organisation_id\":\"00000000-0000-4000-8000-000000000001\",\"sync_hint\":\"sync_1\",\"transport\":\"apns\",\"trans\\u0070ort\":{\"body\":\"secret\"}}",
            "{\"wakeup_id\":\"01935800-0000-7000-8000-000000000301\",\"organisation_id\":\"00000000-0000-4000-8000-000000000001\",\"sync_hint\":\"sync_1\",\"aps\":{\"content-available\":1,\"content-available\":1}}",
        ] {
            assert_eq!(
                admit_wakeup_envelope(dup_json.as_bytes()),
                Err(MobileFfiError::InvalidJson)
            );
            let dup_hex = encode_hex(dup_json.as_bytes());
            let (dup_code, dup_status, dup_body) = invoke_packet_json(&format!(
                "{{\"op\":\"wakeup_envelope_admit\",\"payload_hex\":\"{dup_hex}\"}}"
            ));
            assert_eq!(dup_code, -(KODERA_FFI_STATUS_INVALID_JSON as i32));
            assert_eq!(dup_status, KODERA_FFI_STATUS_INVALID_JSON);
            assert!(dup_body.contains("invalid_json"));
        }

        for invalid_key in [
            "invalid_wakeup_nonstring_transport_json",
            "invalid_wakeup_unknown_transport_json",
            "invalid_wakeup_bad_epoch_json",
        ] {
            let hex = encode_hex(vectors[invalid_key].as_bytes());
            let (code, status, _) = invoke_packet_json(&format!(
                "{{\"op\":\"wakeup_envelope_admit\",\"payload_hex\":\"{hex}\"}}"
            ));
            assert_eq!(
                code,
                -(KODERA_FFI_STATUS_INVALID_INPUT as i32),
                "{invalid_key}"
            );
            assert_eq!(status, KODERA_FFI_STATUS_INVALID_INPUT, "{invalid_key}");
        }

        for extra_invalid in [
            "{\"wakeup_id\":\"01935800-0000-7000-8000-000000000301\",\"organisation_id\":\"00000000-0000-4000-8000-000000000001\",\"sync_hint\":\"sync_1\",\"epoch_ms\":-5}",
            "{\"wakeup_id\":\"01935800-0000-7000-8000-000000000301\",\"organisation_id\":\"00000000-0000-4000-8000-000000000001\",\"sync_hint\":\"sync_1\",\"epoch_ms\":1.5}",
            "{\"wakeup_id\":\"01935800-0000-7000-8000-000000000301\",\"organisation_id\":\"00000000-0000-4000-8000-000000000001\",\"sync_hint\":\"sync_1\",\"transport\":null}",
        ] {
            assert_eq!(
                admit_wakeup_envelope(extra_invalid.as_bytes()),
                Err(MobileFfiError::InvalidInput)
            );
        }
    }

    #[test]
    fn attachment_mime_vectors_match_mobile() {
        let vectors = load_mobile_vectors();
        for kind in ["ogg", "webm", "mp4", "html"] {
            let (status, body) =
                super::invoke_json(vectors[&format!("req_attachment_{kind}_json")].as_bytes());
            assert_eq!(status, KODERA_FFI_STATUS_OK);
            assert_eq!(body, vectors[&format!("resp_attachment_{kind}_json")]);
        }
    }

    #[cfg(feature = "openmls-engine")]
    #[test]
    fn unified_wire_schema_golden_vectors_round_trip() {
        let vectors = load_mobile_vectors();
        for (req_key, resp_key) in [
            ("req_uuid_v7_mint_json", "resp_uuid_v7_mint_json"),
            (
                "req_session_vault_seal_json",
                "resp_session_vault_seal_json",
            ),
            (
                "req_session_vault_open_json",
                "resp_session_vault_open_json",
            ),
            (
                "req_session_envelope_observe_json",
                "resp_session_envelope_observe_json",
            ),
            ("req_reaction_validate_json", "resp_reaction_validate_json"),
            ("req_attachment_ogg_json", "resp_attachment_ogg_json"),
            ("req_attachment_webm_json", "resp_attachment_webm_json"),
            ("req_attachment_mp4_json", "resp_attachment_mp4_json"),
            ("req_attachment_html_json", "resp_attachment_html_json"),
            ("req_wakeup_admit_json", "resp_wakeup_admit_json"),
        ] {
            let (code, status, body) = invoke_packet_json(&vectors[req_key]);
            assert_eq!(code, 0, "{req_key}");
            assert_eq!(status, KODERA_FFI_STATUS_OK, "{req_key}");
            assert_eq!(body, vectors[resp_key], "{req_key}");
            let (direct_status, direct_body) = super::invoke_json(vectors[req_key].as_bytes());
            assert_eq!(direct_status, KODERA_FFI_STATUS_OK, "{req_key}");
            assert_eq!(direct_body, vectors[resp_key], "{req_key}");
        }

        let (rep_code, rep_status, rep_body) =
            invoke_packet_json(&vectors["req_session_envelope_replay_json"]);
        assert_eq!(rep_code, -(KODERA_FFI_STATUS_REPLAY as i32));
        assert_eq!(rep_status, KODERA_FFI_STATUS_REPLAY);
        assert_eq!(rep_body, "{\"ok\":false,\"code\":\"replay_detected\"}");
    }

    #[cfg(feature = "openmls-engine")]
    #[test]
    fn kdv1_session_vault_and_openmls_device_round_trip_and_match_golden_vectors() {
        let vectors = load_mobile_vectors();
        let org = OrganisationId::parse(&vectors["organisation"]).unwrap();
        let device_id = &vectors["device_id"];
        let aad = session_vault_aad(&org, device_id).unwrap();
        assert_eq!(encode_hex(&aad), vectors["vault_aad_hex"]);

        let (seal_code, _, seal_body) = invoke_packet_json(&format!(
            "{{\"op\":\"session_vault_seal\",\"org_id\":\"{}\",\"device_id\":\"{}\",\
            \"key_hex\":\"{}\",\"nonce_hex\":\"{}\",\"plaintext_hex\":\"{}\"}}",
            org.as_str(),
            device_id,
            vectors["public_fixture_vault_material"],
            vectors["public_fixture_vault_nonce"],
            vectors["vault_plaintext_hex"]
        ));
        assert_eq!(seal_code, 0);
        let expected_sealed = &vectors["vault_sealed_kdv1_hex"];
        assert_eq!(
            seal_body,
            format!("{{\"ok\":true,\"sealed_hex\":\"{expected_sealed}\"}}")
        );

        let (open_code, _, open_body) = invoke_packet_json(&format!(
            "{{\"op\":\"session_vault_open\",\"org_id\":\"{}\",\"device_id\":\"{}\",\
            \"key_hex\":\"{}\",\"sealed_hex\":\"{}\"}}",
            org.as_str(),
            device_id,
            vectors["public_fixture_vault_material"],
            expected_sealed
        ));
        assert_eq!(open_code, 0);
        assert_eq!(
            open_body,
            format!(
                "{{\"ok\":true,\"plaintext_hex\":\"{}\"}}",
                vectors["vault_plaintext_hex"]
            )
        );

        // Cross-org and cross-device AAD tampering must fail closed
        let (_, wrong_dev_status, _) = invoke_packet_json(&format!(
            "{{\"op\":\"session_vault_open\",\"org_id\":\"{}\",\"device_id\":\"other-device\",\
            \"key_hex\":\"{}\",\"sealed_hex\":\"{}\"}}",
            org.as_str(),
            vectors["public_fixture_vault_material"],
            expected_sealed
        ));
        assert_eq!(wrong_dev_status, KODERA_FFI_STATUS_AUTH_FAILED);

        // Every single byte flip in KDV1 wire format must refuse cleanly
        let raw_kdv1 = decode_lower_hex(expected_sealed).unwrap();
        let key_arr = decode_fixed_hex::<32>(&vectors["public_fixture_vault_material"]).unwrap();
        for idx in 0..raw_kdv1.len() {
            let mut mutated = raw_kdv1.clone();
            mutated[idx] ^= 0x01;
            let expected_err = if idx < 4 {
                MobileFfiError::InvalidInput
            } else {
                MobileFfiError::AuthenticationFailed
            };
            assert_eq!(
                session_vault_open(&org, device_id, &key_arr, &mutated),
                Err(expected_err),
                "byte {idx}"
            );
        }

        // OpenMlsDevice create + restore via PacketDispatcher
        let membership = "00000000-0000-4000-8000-000000000099";
        let pub_id_hex = encode_hex(b"@alice:community.kodera.io");
        let wrap_hex = &vectors["public_fixture_vault_material"];
        let (create_code, _, create_body) = invoke_packet_json(&format!(
            "{{\"op\":\"mls_device_create\",\"org_id\":\"{}\",\"membership_id\":\"{membership}\",\
            \"public_identity_hex\":\"{pub_id_hex}\",\"wrapping_key_hex\":\"{wrap_hex}\"}}",
            org.as_str()
        ));
        assert_eq!(create_code, 0);
        let parsed = StrictFfiJson::parse_object(create_body.as_bytes(), 65_536).unwrap();
        let dev_key_hex = parsed["device_key_hex"].as_str().unwrap();
        let mls_sealed_hex = parsed["sealed_hex"].as_str().unwrap();
        assert_eq!(parsed["generation"].as_u64(), Some(1));
        assert!(mls_sealed_hex.starts_with("4b445631")); // KDV1

        let (restore_code, _, restore_body) = invoke_packet_json(&format!(
            "{{\"op\":\"mls_device_restore\",\"org_id\":\"{}\",\"membership_id\":\"{membership}\",\
            \"expected_device_key_hex\":\"{dev_key_hex}\",\"expected_generation\":1,\
            \"wrapping_key_hex\":\"{wrap_hex}\",\"sealed_hex\":\"{mls_sealed_hex}\"}}",
            org.as_str()
        ));
        assert_eq!(restore_code, 0);
        assert_eq!(
            restore_body,
            format!("{{\"ok\":true,\"device_key_hex\":\"{dev_key_hex}\",\"generation\":1}}")
        );

        // Wrong expected_generation refuses authentication
        let (_, bad_gen_status, _) = invoke_packet_json(&format!(
            "{{\"op\":\"mls_device_restore\",\"org_id\":\"{}\",\"membership_id\":\"{membership}\",\
            \"expected_device_key_hex\":\"{dev_key_hex}\",\"expected_generation\":2,\
            \"wrapping_key_hex\":\"{wrap_hex}\",\"sealed_hex\":\"{mls_sealed_hex}\"}}",
            org.as_str()
        ));
        assert_eq!(bad_gen_status, KODERA_FFI_STATUS_AUTH_FAILED);
    }
}
