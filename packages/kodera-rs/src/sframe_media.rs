//! RFC 9605-aligned `SFrame` v1 E2EE media key derivation, header codec, replay window,
//! and AES-256-GCM frame sealing/opening bound to OpenMLS room epochs.
//!
//! Design invariants:
//! - Domain-separated `HKDF-SHA256` (`"kodera-sframe-media-v1"`) binding `room_id`, `epoch` (`u64` BE),
//!   `sender_device_id`, `track_kind`, and `ratchet_step` (`u16` BE).
//! - Canonical minimal RFC 9605 Section 3 header (`config_byte || key_id_be || counter_be`), rejecting
//!   non-canonical leading-zero encodings to prevent header malleability.
//! - Codec-packetizer-safe cleartext prefix (`0` bytes for Opus audio; configurable `<= 64` bytes for
//!   VP8/H.264/AV1 payload descriptors) preserved at byte offset `0` so SFUs forward packets cleanly
//!   while authenticating every prefix and header byte in AES-256-GCM AAD.
//! - Constant-space 1024-frame sliding bitmap replay window (`[u64; 16]`) rejecting duplicate and stale
//!   counters before mutating state and committing counters strictly after AEAD tag verification.
//! - Live epoch rotation retiring prior send keys immediately, retaining at most one prior receive epoch
//!   for a bounded 2-second (`2000 ms`) in-flight grace window, and purging immediately when
//!   `member_removed == true`.

#[cfg(feature = "sframe-media")]
use std::collections::BTreeMap;
use std::fmt;

#[cfg(feature = "sframe-media")]
use aes_gcm::{aead::AeadInOut, Aes256Gcm, KeyInit, Nonce, Tag};

use crate::proximity::hkdf_sha256;

/// Canonical HKDF salt and protocol domain label for Kodera `SFrame` v1 media encryption.
pub const SFRAME_MEDIA_DOMAIN: &str = "kodera-sframe-media-v1";
/// Number of low-order bits in [`SFrameKeyId`] reserved for `ratchet_step` (`0..=65535`).
pub const SFRAME_RATCHET_BITS: u32 = 16;
/// Maximum OpenMLS epoch representable in [`SFrameKeyId`] (`2^48 - 1`).
pub const MAX_SFRAME_EPOCH: u64 = (1u64 << 48) - 1;
/// Sliding per-sender/track replay window size in frames.
pub const SFRAME_REPLAY_WINDOW_FRAMES: u64 = 1024;
/// AES-256-GCM authentication tag size in bytes.
pub const SFRAME_GCM_TAG_BYTES: usize = 16;
/// AES-256-GCM nonce / base salt size in bytes.
pub const SFRAME_NONCE_BYTES: usize = 12;
/// Symmetric key size in bytes (`AES-256` / `HKDF-SHA256` root).
pub const SFRAME_KEY_BYTES: usize = 32;
/// Maximum encoded wire length of an [`SFrameHeader`] (`1` config byte + `8` KID + `8` CTR).
pub const MAX_SFRAME_HEADER_BYTES: usize = 17;
/// Mandatory 64-bit random per-session sender generation (`session_salt`) carried after [`SFrameHeader`]
/// and mixed into `HKDF-SHA256` `info` + AEAD AAD so session restarts never reuse `(key, nonce)`.
pub const SFRAME_SENDER_GENERATION_BYTES: usize = 8;
/// Upper bound on codec-packetizer cleartext header prefix bytes authenticated via AAD.
pub const MAX_SFRAME_UNENCRYPTED_PREFIX_BYTES: usize = 64;
/// Upper bound on a single encoded media frame in bytes (`1 MiB`).
pub const MAX_SFRAME_FRAME_BYTES: usize = 1024 * 1024;
/// Bounded receive grace window in milliseconds (`2000 ms`) for in-flight prior-epoch packets.
pub const SFRAME_EPOCH_GRACE_MS: u64 = 2_000;

const MAX_SCOPE_LABEL_BYTES: usize = 256;
#[cfg(feature = "sframe-media")]
const MAX_TRACKED_SENDERS: usize = 512;

/// Errors returned by `SFrame` v1 key derivation, header parsing, replay checks, and AEAD operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SFrameMediaError {
    InvalidKeyMaterial,
    InvalidScope,
    InvalidUnencryptedPrefix,
    PayloadTooLarge,
    MalformedHeader,
    CounterExhausted,
    EpochMismatch,
    ReplayDetected,
    StaleCounter,
    ReflectionRejected,
    CapacityExceeded,
    AuthenticationFailed,
}

impl fmt::Display for SFrameMediaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidKeyMaterial => "invalid or all-zero SFrame epoch key material",
            Self::InvalidScope => "invalid SFrame room, device, or epoch scope",
            Self::InvalidUnencryptedPrefix => {
                "invalid or out-of-bounds SFrame codec unencrypted prefix length"
            }
            Self::PayloadTooLarge => "media frame exceeds 1 MiB SFrame bound",
            Self::MalformedHeader => "malformed or non-canonical SFrame v1 header",
            Self::CounterExhausted => "SFrame monotonic frame counter or ratchet step exhausted",
            Self::EpochMismatch => "SFrame packet epoch is outside active receive window",
            Self::ReplayDetected => "duplicate SFrame counter rejected by replay window",
            Self::StaleCounter => "stale SFrame counter older than 1024-frame replay window",
            Self::ReflectionRejected => "self-reflected SFrame sender frame rejected",
            Self::CapacityExceeded => "tracked SFrame sender replay state capacity exceeded",
            Self::AuthenticationFailed => "SFrame AES-256-GCM tag or AAD verification failed",
        };
        f.write_str(message)
    }
}

impl std::error::Error for SFrameMediaError {}

/// Media track discriminator bound into HKDF sender-key derivation and AES-256-GCM AAD.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum SFrameTrackKind {
    Audio = 1,
    Video = 2,
}

impl SFrameTrackKind {
    pub fn as_u8(self) -> u8 {
        self as u8
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Audio => "audio",
            Self::Video => "video",
        }
    }

    pub fn parse(value: &str) -> Result<Self, SFrameMediaError> {
        match value {
            "audio" => Ok(Self::Audio),
            "video" => Ok(Self::Video),
            _ => Err(SFrameMediaError::InvalidScope),
        }
    }
}

/// Codec-packetizer framing profile specifying how many leading payload-header bytes remain
/// unencrypted on the wire while still being authenticated as AES-256-GCM AAD.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SFrameCodecProfile {
    /// Opus audio always encrypts 100% of the payload (`0` unencrypted prefix bytes).
    Opus,
    /// VP8 video payload header (`3` bytes delta frame / `10` bytes keyframe uncompressed header).
    Vp8 { unencrypted_prefix_len: usize },
    /// H.264 NAL unit header (`1..=4` bytes, default `2`).
    H264 { unencrypted_prefix_len: usize },
    /// AV1 OBU header (`1..=4` bytes, default `2`).
    Av1 { unencrypted_prefix_len: usize },
    /// Explicit video prefix configuration bounded to [`MAX_SFRAME_UNENCRYPTED_PREFIX_BYTES`].
    CustomVideo { unencrypted_prefix_len: usize },
}

impl SFrameCodecProfile {
    pub const fn opus() -> Self {
        Self::Opus
    }

    pub const fn vp8_delta() -> Self {
        Self::Vp8 {
            unencrypted_prefix_len: 3,
        }
    }

    pub const fn vp8_keyframe() -> Self {
        Self::Vp8 {
            unencrypted_prefix_len: 10,
        }
    }

    pub const fn h264() -> Self {
        Self::H264 {
            unencrypted_prefix_len: 2,
        }
    }

    pub const fn av1() -> Self {
        Self::Av1 {
            unencrypted_prefix_len: 2,
        }
    }

    pub fn track_kind(self) -> SFrameTrackKind {
        match self {
            Self::Opus => SFrameTrackKind::Audio,
            Self::Vp8 { .. } | Self::H264 { .. } | Self::Av1 { .. } | Self::CustomVideo { .. } => {
                SFrameTrackKind::Video
            }
        }
    }

    pub fn validated_prefix_len(self) -> Result<usize, SFrameMediaError> {
        let len = match self {
            Self::Opus => 0,
            Self::Vp8 {
                unencrypted_prefix_len,
            }
            | Self::H264 {
                unencrypted_prefix_len,
            }
            | Self::Av1 {
                unencrypted_prefix_len,
            }
            | Self::CustomVideo {
                unencrypted_prefix_len,
            } => unencrypted_prefix_len,
        };
        if len > MAX_SFRAME_UNENCRYPTED_PREFIX_BYTES {
            return Err(SFrameMediaError::InvalidUnencryptedPrefix);
        }
        Ok(len)
    }
}

/// Composite RFC 9605 `KID` packing `(epoch, ratchet_step)` into a canonical `u64`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SFrameKeyId(u64);

impl SFrameKeyId {
    pub fn new(epoch: u64, ratchet_step: u16) -> Result<Self, SFrameMediaError> {
        if epoch > MAX_SFRAME_EPOCH {
            return Err(SFrameMediaError::InvalidScope);
        }
        Ok(Self(
            (epoch << SFRAME_RATCHET_BITS) | u64::from(ratchet_step),
        ))
    }

    pub const fn from_raw(raw: u64) -> Self {
        Self(raw)
    }

    pub const fn as_u64(self) -> u64 {
        self.0
    }

    pub const fn epoch(self) -> u64 {
        self.0 >> SFRAME_RATCHET_BITS
    }

    pub const fn ratchet_step(self) -> u16 {
        (self.0 & 0xffff) as u16
    }
}

fn minimal_be_len(value: u64) -> usize {
    debug_assert!(value >= 8);
    let leading_zeros = (value.leading_zeros() / 8) as usize;
    8 - leading_zeros
}

fn encode_u64_minimal(value: u64, out: &mut Vec<u8>) -> (bool, u8) {
    if value <= 7 {
        (false, value as u8)
    } else {
        let len = minimal_be_len(value);
        let bytes = value.to_be_bytes();
        out.extend_from_slice(&bytes[8 - len..]);
        (true, (len - 1) as u8)
    }
}

fn decode_u64_canonical(
    extended: bool,
    field: u8,
    cursor: &mut &[u8],
) -> Result<u64, SFrameMediaError> {
    if !extended {
        return Ok(u64::from(field));
    }
    let len = usize::from(field) + 1;
    if cursor.len() < len {
        return Err(SFrameMediaError::MalformedHeader);
    }
    let (head, rest) = cursor.split_at(len);
    // Reject non-canonical encodings: leading zero byte or single-byte value <= 7.
    if head[0] == 0 || (len == 1 && head[0] <= 7) {
        return Err(SFrameMediaError::MalformedHeader);
    }
    let mut buf = [0u8; 8];
    buf[8 - len..].copy_from_slice(head);
    *cursor = rest;
    Ok(u64::from_be_bytes(buf))
}

/// Compact RFC 9605 Section 3 `SFrame` v1 wire header (`1..=17` bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SFrameHeader {
    pub key_id: SFrameKeyId,
    pub counter: u64,
}

impl SFrameHeader {
    pub fn new(key_id: SFrameKeyId, counter: u64) -> Self {
        Self { key_id, counter }
    }

    /// Encodes the header into canonical minimal RFC 9605 wire bytes (`config_byte || KID || CTR`).
    pub fn encode(&self) -> Vec<u8> {
        let mut tail = Vec::with_capacity(16);
        let (x_flag, k_bits) = encode_u64_minimal(self.key_id.as_u64(), &mut tail);
        let (y_flag, c_bits) = encode_u64_minimal(self.counter, &mut tail);
        let config_byte =
            (u8::from(x_flag) << 7) | (k_bits << 4) | (u8::from(y_flag) << 3) | c_bits;
        let mut encoded = Vec::with_capacity(1 + tail.len());
        encoded.push(config_byte);
        encoded.extend_from_slice(&tail);
        encoded
    }

    /// Decodes a canonical RFC 9605 header from the start of `input`, returning `(header, bytes_read)`.
    pub fn decode(input: &[u8]) -> Result<(Self, usize), SFrameMediaError> {
        let (&config_byte, mut rest) = input
            .split_first()
            .ok_or(SFrameMediaError::MalformedHeader)?;
        let x_flag = (config_byte & 0x80) != 0;
        let k_bits = (config_byte >> 4) & 0x07;
        let y_flag = (config_byte & 0x08) != 0;
        let c_bits = config_byte & 0x07;
        let raw_kid = decode_u64_canonical(x_flag, k_bits, &mut rest)?;
        let counter = decode_u64_canonical(y_flag, c_bits, &mut rest)?;
        let consumed = input.len() - rest.len();
        Ok((
            Self {
                key_id: SFrameKeyId::from_raw(raw_kid),
                counter,
            },
            consumed,
        ))
    }
}

fn validate_scope_label(label: &str) -> Result<(), SFrameMediaError> {
    if label.is_empty()
        || label.len() > MAX_SCOPE_LABEL_BYTES
        || label.chars().any(|ch| (ch as u32) < 0x20)
    {
        return Err(SFrameMediaError::InvalidScope);
    }
    Ok(())
}

fn validate_secret(secret: &[u8; SFRAME_KEY_BYTES]) -> Result<(), SFrameMediaError> {
    let non_zero = secret.iter().fold(0u8, |acc, &b| acc | b);
    if non_zero == 0 {
        return Err(SFrameMediaError::InvalidKeyMaterial);
    }
    Ok(())
}

/// Derives a 32-byte epoch root key from an OpenMLS 32-byte epoch secret, `room_id`, and `epoch`.
pub fn derive_sframe_epoch_root_key(
    mls_epoch_secret: &[u8; SFRAME_KEY_BYTES],
    room_id: &str,
    epoch: u64,
) -> Result<[u8; SFRAME_KEY_BYTES], SFrameMediaError> {
    validate_secret(mls_epoch_secret)?;
    validate_scope_label(room_id)?;
    if epoch > MAX_SFRAME_EPOCH {
        return Err(SFrameMediaError::InvalidScope);
    }
    let room_len = u16::try_from(room_id.len()).map_err(|_| SFrameMediaError::InvalidScope)?;
    let mut info = Vec::with_capacity(36 + room_id.len() + 8);
    info.extend_from_slice(SFRAME_MEDIA_DOMAIN.as_bytes());
    info.extend_from_slice(b"\0epoch-root\0");
    info.extend_from_slice(&room_len.to_be_bytes());
    info.extend_from_slice(room_id.as_bytes());
    info.extend_from_slice(&epoch.to_be_bytes());
    hkdf_sha256::<SFRAME_KEY_BYTES>(SFRAME_MEDIA_DOMAIN.as_bytes(), mls_epoch_secret, &info)
        .map_err(|_| SFrameMediaError::InvalidKeyMaterial)
}

/// One-way ratchets an epoch secret forward to `to_epoch` at `next_ratchet_step`.
pub fn ratchet_sframe_epoch_secret(
    current_epoch_secret: &[u8; SFRAME_KEY_BYTES],
    room_id: &str,
    from_epoch: u64,
    to_epoch: u64,
    next_ratchet_step: u16,
) -> Result<[u8; SFRAME_KEY_BYTES], SFrameMediaError> {
    validate_secret(current_epoch_secret)?;
    validate_scope_label(room_id)?;
    if to_epoch <= from_epoch || to_epoch > MAX_SFRAME_EPOCH {
        return Err(SFrameMediaError::EpochMismatch);
    }
    let room_len = u16::try_from(room_id.len()).map_err(|_| SFrameMediaError::InvalidScope)?;
    let mut info = Vec::with_capacity(40 + room_id.len() + 18);
    info.extend_from_slice(SFRAME_MEDIA_DOMAIN.as_bytes());
    info.extend_from_slice(b"\0epoch-ratchet\0");
    info.extend_from_slice(&room_len.to_be_bytes());
    info.extend_from_slice(room_id.as_bytes());
    info.extend_from_slice(&from_epoch.to_be_bytes());
    info.extend_from_slice(&to_epoch.to_be_bytes());
    info.extend_from_slice(&next_ratchet_step.to_be_bytes());
    hkdf_sha256::<SFRAME_KEY_BYTES>(SFRAME_MEDIA_DOMAIN.as_bytes(), current_epoch_secret, &info)
        .map_err(|_| SFrameMediaError::InvalidKeyMaterial)
}

/// Sender track AEAD key (`32` bytes) and RFC 9605 base salt (`12` bytes). Zeroized on drop.
#[derive(Clone)]
pub struct SFrameSenderKeyMaterial {
    aead_key: [u8; SFRAME_KEY_BYTES],
    base_salt: [u8; SFRAME_NONCE_BYTES],
}

impl fmt::Debug for SFrameSenderKeyMaterial {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SFrameSenderKeyMaterial([redacted])")
    }
}

impl Drop for SFrameSenderKeyMaterial {
    fn drop(&mut self) {
        self.aead_key.fill(0);
        self.base_salt.fill(0);
    }
}

impl SFrameSenderKeyMaterial {
    pub fn aead_key(&self) -> &[u8; SFRAME_KEY_BYTES] {
        &self.aead_key
    }

    pub fn base_salt(&self) -> &[u8; SFRAME_NONCE_BYTES] {
        &self.base_salt
    }

    /// Computes the RFC 9605 Section 4.3 per-frame AES-GCM nonce `base_salt XOR (0^32 || counter_be)`.
    pub fn nonce_for_counter(&self, counter: u64) -> [u8; SFRAME_NONCE_BYTES] {
        let mut nonce = self.base_salt;
        let ctr = counter.to_be_bytes();
        for i in 0..8 {
            nonce[4 + i] ^= ctr[i];
        }
        nonce
    }
}

#[cfg(feature = "sframe-media")]
fn random_sender_generation() -> Result<u64, SFrameMediaError> {
    for _ in 0..8 {
        let mut buf = [0u8; SFRAME_SENDER_GENERATION_BYTES];
        getrandom::fill(&mut buf).map_err(|_| SFrameMediaError::InvalidKeyMaterial)?;
        let value = u64::from_be_bytes(buf);
        if value != 0 {
            return Ok(value);
        }
    }
    Err(SFrameMediaError::InvalidKeyMaterial)
}

/// Derives per-sender, per-session-generation, per-track, per-ratchet-step `(aead_key, base_salt)` from `epoch_root_key`.
pub fn derive_sframe_sender_key(
    epoch_root_key: &[u8; SFRAME_KEY_BYTES],
    room_id: &str,
    epoch: u64,
    sender_device_id: &str,
    sender_generation: u64,
    track_kind: SFrameTrackKind,
    ratchet_step: u16,
) -> Result<SFrameSenderKeyMaterial, SFrameMediaError> {
    validate_secret(epoch_root_key)?;
    validate_scope_label(room_id)?;
    validate_scope_label(sender_device_id)?;
    if epoch > MAX_SFRAME_EPOCH || sender_generation == 0 {
        return Err(SFrameMediaError::InvalidScope);
    }
    let room_len = u16::try_from(room_id.len()).map_err(|_| SFrameMediaError::InvalidScope)?;
    let sender_len =
        u16::try_from(sender_device_id.len()).map_err(|_| SFrameMediaError::InvalidScope)?;
    let mut info = Vec::with_capacity(56 + room_id.len() + sender_device_id.len());
    info.extend_from_slice(SFRAME_MEDIA_DOMAIN.as_bytes());
    info.extend_from_slice(b"\0sender-key\0");
    info.extend_from_slice(&room_len.to_be_bytes());
    info.extend_from_slice(room_id.as_bytes());
    info.extend_from_slice(&epoch.to_be_bytes());
    info.extend_from_slice(&sender_len.to_be_bytes());
    info.extend_from_slice(sender_device_id.as_bytes());
    info.extend_from_slice(&sender_generation.to_be_bytes());
    info.push(track_kind.as_u8());
    info.extend_from_slice(&ratchet_step.to_be_bytes());

    let mut okm = hkdf_sha256::<44>(SFRAME_MEDIA_DOMAIN.as_bytes(), epoch_root_key, &info)
        .map_err(|_| SFrameMediaError::InvalidKeyMaterial)?;
    let mut aead_key = [0u8; SFRAME_KEY_BYTES];
    let mut base_salt = [0u8; SFRAME_NONCE_BYTES];
    aead_key.copy_from_slice(&okm[..32]);
    base_salt.copy_from_slice(&okm[32..44]);
    okm.fill(0);
    Ok(SFrameSenderKeyMaterial {
        aead_key,
        base_salt,
    })
}

/// Builds the canonical AES-256-GCM Additional Authenticated Data (AAD) authenticating room,
/// epoch, ratchet step, track kind, sender identity, 64-bit sender generation, codec unencrypted prefix,
/// and wire SFrame header.
pub fn build_sframe_aad(
    room_id: &str,
    key_id: SFrameKeyId,
    track_kind: SFrameTrackKind,
    sender_device_id: &str,
    sender_generation: u64,
    unencrypted_prefix: &[u8],
    header_bytes: &[u8],
) -> Result<Vec<u8>, SFrameMediaError> {
    validate_scope_label(room_id)?;
    validate_scope_label(sender_device_id)?;
    if sender_generation == 0 {
        return Err(SFrameMediaError::InvalidScope);
    }
    if unencrypted_prefix.len() > MAX_SFRAME_UNENCRYPTED_PREFIX_BYTES
        || (track_kind == SFrameTrackKind::Audio && !unencrypted_prefix.is_empty())
    {
        return Err(SFrameMediaError::InvalidUnencryptedPrefix);
    }
    if header_bytes.is_empty() || header_bytes.len() > MAX_SFRAME_HEADER_BYTES {
        return Err(SFrameMediaError::MalformedHeader);
    }
    let room_len = u16::try_from(room_id.len()).map_err(|_| SFrameMediaError::InvalidScope)?;
    let sender_len =
        u16::try_from(sender_device_id.len()).map_err(|_| SFrameMediaError::InvalidScope)?;
    let prefix_len = u16::try_from(unencrypted_prefix.len())
        .map_err(|_| SFrameMediaError::InvalidUnencryptedPrefix)?;

    let mut aad = Vec::with_capacity(
        SFRAME_MEDIA_DOMAIN.len()
            + 5
            + 2
            + room_id.len()
            + 8
            + 2
            + 1
            + 2
            + sender_device_id.len()
            + SFRAME_SENDER_GENERATION_BYTES
            + 2
            + unencrypted_prefix.len()
            + header_bytes.len(),
    );
    aad.extend_from_slice(SFRAME_MEDIA_DOMAIN.as_bytes());
    aad.extend_from_slice(b"\0aad\0");
    aad.extend_from_slice(&room_len.to_be_bytes());
    aad.extend_from_slice(room_id.as_bytes());
    aad.extend_from_slice(&key_id.epoch().to_be_bytes());
    aad.extend_from_slice(&key_id.ratchet_step().to_be_bytes());
    aad.push(track_kind.as_u8());
    aad.extend_from_slice(&sender_len.to_be_bytes());
    aad.extend_from_slice(sender_device_id.as_bytes());
    aad.extend_from_slice(&sender_generation.to_be_bytes());
    aad.extend_from_slice(&prefix_len.to_be_bytes());
    aad.extend_from_slice(unencrypted_prefix);
    aad.extend_from_slice(header_bytes);
    Ok(aad)
}

/// Allocation-free 1024-frame sliding bitmap replay window.
#[derive(Debug, Clone)]
pub struct SFrameReplayWindow {
    highest: Option<u64>,
    bitmap: [u64; 16],
}

impl Default for SFrameReplayWindow {
    fn default() -> Self {
        Self::new()
    }
}

impl SFrameReplayWindow {
    pub const fn new() -> Self {
        Self {
            highest: None,
            bitmap: [0u64; 16],
        }
    }

    pub const fn highest_counter(&self) -> Option<u64> {
        self.highest
    }

    /// Checks whether `counter` is fresh within `[highest - 1023, +inf)` without mutating state.
    pub fn check(&self, counter: u64) -> Result<(), SFrameMediaError> {
        let Some(high) = self.highest else {
            return Ok(());
        };
        if counter > high {
            return Ok(());
        }
        let delta = high - counter;
        if delta >= SFRAME_REPLAY_WINDOW_FRAMES {
            return Err(SFrameMediaError::StaleCounter);
        }
        let word = (delta / 64) as usize;
        let bit = (delta % 64) as u32;
        if ((self.bitmap[word] >> bit) & 1) != 0 {
            return Err(SFrameMediaError::ReplayDetected);
        }
        Ok(())
    }

    /// Commits `counter` after AEAD tag authentication has succeeded.
    pub fn commit(&mut self, counter: u64) -> Result<(), SFrameMediaError> {
        self.check(counter)?;
        match self.highest {
            None => {
                self.highest = Some(counter);
                self.bitmap = [0u64; 16];
                self.bitmap[0] = 1;
            }
            Some(high) if counter > high => {
                let shift = counter - high;
                if shift >= SFRAME_REPLAY_WINDOW_FRAMES {
                    self.bitmap = [0u64; 16];
                } else {
                    let word_shift = (shift / 64) as usize;
                    let bit_shift = (shift % 64) as u32;
                    let mut next = [0u64; 16];
                    for i in (0..16).rev() {
                        if i >= word_shift {
                            next[i] |= self.bitmap[i - word_shift] << bit_shift;
                            if bit_shift > 0 && i > word_shift {
                                next[i] |= self.bitmap[i - word_shift - 1] >> (64 - bit_shift);
                            }
                        }
                    }
                    self.bitmap = next;
                }
                self.bitmap[0] |= 1;
                self.highest = Some(counter);
            }
            Some(high) => {
                let delta = (high - counter) as usize;
                self.bitmap[delta / 64] |= 1u64 << (delta % 64);
            }
        }
        Ok(())
    }

    pub fn clear(&mut self) {
        self.highest = None;
        self.bitmap = [0u64; 16];
    }
}

/// Seals a single media frame with `AES-256-GCM` into
/// `[unencrypted_prefix || sframe_header || sender_generation_be(8B) || ciphertext || tag(16B)]`.
#[cfg(feature = "sframe-media")]
#[allow(clippy::too_many_arguments)]
pub fn seal_sframe_media_frame(
    epoch_root_key: &[u8; SFRAME_KEY_BYTES],
    room_id: &str,
    key_id: SFrameKeyId,
    sender_device_id: &str,
    sender_generation: u64,
    track_kind: SFrameTrackKind,
    counter: u64,
    unencrypted_prefix_len: usize,
    plaintext_frame: &[u8],
) -> Result<Vec<u8>, SFrameMediaError> {
    if plaintext_frame.len() > MAX_SFRAME_FRAME_BYTES {
        return Err(SFrameMediaError::PayloadTooLarge);
    }
    if sender_generation == 0 {
        return Err(SFrameMediaError::InvalidScope);
    }
    if unencrypted_prefix_len > MAX_SFRAME_UNENCRYPTED_PREFIX_BYTES
        || unencrypted_prefix_len > plaintext_frame.len()
        || (track_kind == SFrameTrackKind::Audio && unencrypted_prefix_len != 0)
    {
        return Err(SFrameMediaError::InvalidUnencryptedPrefix);
    }
    let sender_key = derive_sframe_sender_key(
        epoch_root_key,
        room_id,
        key_id.epoch(),
        sender_device_id,
        sender_generation,
        track_kind,
        key_id.ratchet_step(),
    )?;
    let (prefix, body) = plaintext_frame.split_at(unencrypted_prefix_len);
    let header = SFrameHeader::new(key_id, counter);
    let header_bytes = header.encode();
    let aad = build_sframe_aad(
        room_id,
        key_id,
        track_kind,
        sender_device_id,
        sender_generation,
        prefix,
        &header_bytes,
    )?;
    let nonce = sender_key.nonce_for_counter(counter);
    let cipher = Aes256Gcm::new_from_slice(sender_key.aead_key())
        .map_err(|_| SFrameMediaError::InvalidKeyMaterial)?;
    let mut encrypted = body.to_vec();
    let tag = cipher
        .encrypt_inout_detached(&Nonce::from(nonce), &aad, encrypted.as_mut_slice().into())
        .map_err(|_| SFrameMediaError::AuthenticationFailed)?;

    let mut wire = Vec::with_capacity(
        prefix.len()
            + header_bytes.len()
            + SFRAME_SENDER_GENERATION_BYTES
            + encrypted.len()
            + SFRAME_GCM_TAG_BYTES,
    );
    wire.extend_from_slice(prefix);
    wire.extend_from_slice(&header_bytes);
    wire.extend_from_slice(&sender_generation.to_be_bytes());
    wire.extend_from_slice(&encrypted);
    wire.extend_from_slice(&tag);
    Ok(wire)
}

/// Opens and authenticates a single `SFrame` v1 wire packet without replay tracking (stateless primitive;
/// stateful callers should use [`SFrameMediaSession::open_frame`]).
#[cfg(feature = "sframe-media")]
pub fn open_sframe_media_frame(
    epoch_root_key: &[u8; SFRAME_KEY_BYTES],
    room_id: &str,
    expected_epoch: u64,
    sender_device_id: &str,
    track_kind: SFrameTrackKind,
    unencrypted_prefix_len: usize,
    sealed_frame: &[u8],
) -> Result<(SFrameHeader, u64, Vec<u8>), SFrameMediaError> {
    if sealed_frame.len()
        > MAX_SFRAME_FRAME_BYTES
            + MAX_SFRAME_HEADER_BYTES
            + SFRAME_SENDER_GENERATION_BYTES
            + SFRAME_GCM_TAG_BYTES
    {
        return Err(SFrameMediaError::PayloadTooLarge);
    }
    if unencrypted_prefix_len > MAX_SFRAME_UNENCRYPTED_PREFIX_BYTES
        || (track_kind == SFrameTrackKind::Audio && unencrypted_prefix_len != 0)
    {
        return Err(SFrameMediaError::InvalidUnencryptedPrefix);
    }
    if sealed_frame.len()
        < unencrypted_prefix_len + 1 + SFRAME_SENDER_GENERATION_BYTES + SFRAME_GCM_TAG_BYTES
    {
        return Err(SFrameMediaError::MalformedHeader);
    }
    let (prefix, remainder) = sealed_frame.split_at(unencrypted_prefix_len);
    let (header, header_len) = SFrameHeader::decode(remainder)?;
    if remainder.len() < header_len + SFRAME_SENDER_GENERATION_BYTES + SFRAME_GCM_TAG_BYTES {
        return Err(SFrameMediaError::MalformedHeader);
    }
    if header.key_id.epoch() != expected_epoch {
        return Err(SFrameMediaError::EpochMismatch);
    }
    let header_bytes = &remainder[..header_len];
    let gen_bytes: [u8; SFRAME_SENDER_GENERATION_BYTES] = remainder
        [header_len..header_len + SFRAME_SENDER_GENERATION_BYTES]
        .try_into()
        .map_err(|_| SFrameMediaError::MalformedHeader)?;
    let sender_generation = u64::from_be_bytes(gen_bytes);
    if sender_generation == 0 {
        return Err(SFrameMediaError::MalformedHeader);
    }
    let ciphertext_and_tag = &remainder[header_len + SFRAME_SENDER_GENERATION_BYTES..];
    let tag_offset = ciphertext_and_tag.len() - SFRAME_GCM_TAG_BYTES;
    let mut body = ciphertext_and_tag[..tag_offset].to_vec();
    let tag_bytes: [u8; SFRAME_GCM_TAG_BYTES] = ciphertext_and_tag[tag_offset..]
        .try_into()
        .map_err(|_| SFrameMediaError::MalformedHeader)?;

    let sender_key = derive_sframe_sender_key(
        epoch_root_key,
        room_id,
        expected_epoch,
        sender_device_id,
        sender_generation,
        track_kind,
        header.key_id.ratchet_step(),
    )?;
    let aad = build_sframe_aad(
        room_id,
        header.key_id,
        track_kind,
        sender_device_id,
        sender_generation,
        prefix,
        header_bytes,
    )?;
    let nonce = sender_key.nonce_for_counter(header.counter);
    let cipher = Aes256Gcm::new_from_slice(sender_key.aead_key())
        .map_err(|_| SFrameMediaError::InvalidKeyMaterial)?;
    if cipher
        .decrypt_inout_detached(
            &Nonce::from(nonce),
            &aad,
            body.as_mut_slice().into(),
            &Tag::from(tag_bytes),
        )
        .is_err()
    {
        body.fill(0);
        return Err(SFrameMediaError::AuthenticationFailed);
    }

    let mut output = Vec::with_capacity(prefix.len() + body.len());
    output.extend_from_slice(prefix);
    output.extend_from_slice(&body);
    body.fill(0);
    Ok((header, sender_generation, output))
}

#[cfg(feature = "sframe-media")]
struct EpochReceiveSlot {
    epoch: u64,
    epoch_root_key: [u8; SFRAME_KEY_BYTES],
    expires_at_ms: Option<u64>,
    replay: BTreeMap<(String, u64, SFrameTrackKind, u16), SFrameReplayWindow>,
    generation_owners: BTreeMap<u64, String>,
}

#[cfg(feature = "sframe-media")]
impl Drop for EpochReceiveSlot {
    fn drop(&mut self) {
        self.epoch_root_key.fill(0);
        self.replay.clear();
        self.generation_owners.clear();
    }
}

/// Stateful OpenMLS-bound `SFrame` v1 session enforcing unique CSPRNG 64-bit `sender_generation`
/// per session instantiation, monotonic send counters, reflection rejection, 1024-frame
/// per-`(sender_device_id, sender_generation)` replay windows, and bounded 2-second receive grace rotation.
#[cfg(feature = "sframe-media")]
pub struct SFrameMediaSession {
    room_id: String,
    local_device_id: String,
    send_epoch: u64,
    send_generation: u64,
    send_ratchet_step: u16,
    send_epoch_root_key: [u8; SFRAME_KEY_BYTES],
    audio_counter: u64,
    video_counter: u64,
    current_receive: EpochReceiveSlot,
    grace_receive: Option<EpochReceiveSlot>,
}

#[cfg(feature = "sframe-media")]
impl fmt::Debug for SFrameMediaSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SFrameMediaSession")
            .field("room_id", &self.room_id)
            .field("send_epoch", &self.send_epoch)
            .field("send_generation", &self.send_generation)
            .field("send_ratchet_step", &self.send_ratchet_step)
            .finish_non_exhaustive()
    }
}

#[cfg(feature = "sframe-media")]
impl Drop for SFrameMediaSession {
    fn drop(&mut self) {
        self.send_epoch_root_key.fill(0);
        self.grace_receive = None;
    }
}

#[cfg(feature = "sframe-media")]
impl SFrameMediaSession {
    pub fn new(
        room_id: &str,
        local_device_id: &str,
        epoch: u64,
        mls_epoch_secret: &[u8; SFRAME_KEY_BYTES],
    ) -> Result<Self, SFrameMediaError> {
        let generation = random_sender_generation()?;
        Self::with_sender_generation(
            room_id,
            local_device_id,
            epoch,
            mls_epoch_secret,
            generation,
        )
    }

    pub fn with_sender_generation(
        room_id: &str,
        local_device_id: &str,
        epoch: u64,
        mls_epoch_secret: &[u8; SFRAME_KEY_BYTES],
        sender_generation: u64,
    ) -> Result<Self, SFrameMediaError> {
        validate_scope_label(local_device_id)?;
        if sender_generation == 0 {
            return Err(SFrameMediaError::InvalidScope);
        }
        let root_key = derive_sframe_epoch_root_key(mls_epoch_secret, room_id, epoch)?;
        Ok(Self {
            room_id: room_id.to_owned(),
            local_device_id: local_device_id.to_owned(),
            send_epoch: epoch,
            send_generation: sender_generation,
            send_ratchet_step: 0,
            send_epoch_root_key: root_key,
            audio_counter: 0,
            video_counter: 0,
            current_receive: EpochReceiveSlot {
                epoch,
                epoch_root_key: root_key,
                expires_at_ms: None,
                replay: BTreeMap::new(),
                generation_owners: BTreeMap::new(),
            },
            grace_receive: None,
        })
    }

    pub fn epoch(&self) -> u64 {
        self.send_epoch
    }

    pub fn sender_generation(&self) -> u64 {
        self.send_generation
    }

    pub fn ratchet_step(&self) -> u16 {
        self.send_ratchet_step
    }

    /// Advances the local sender's intra-epoch ratchet step, resetting outgoing frame counters.
    pub fn ratchet_sender_step(&mut self) -> Result<u16, SFrameMediaError> {
        let next = self
            .send_ratchet_step
            .checked_add(1)
            .ok_or(SFrameMediaError::CounterExhausted)?;
        self.send_ratchet_step = next;
        self.audio_counter = 0;
        self.video_counter = 0;
        Ok(next)
    }

    /// Rotates to a strictly newer OpenMLS epoch secret:
    /// - Prior send keys are zeroized and retired immediately (and `send_generation` refreshed);
    /// - If `member_removed == true`, prior receive keys are purged immediately (`0 ms` grace);
    /// - Otherwise, the immediately preceding receive epoch is retained until `now_ms + 2000`.
    pub fn rotate_epoch_key(
        &mut self,
        next_epoch: u64,
        next_mls_epoch_secret: &[u8; SFRAME_KEY_BYTES],
        member_removed: bool,
        now_ms: u64,
    ) -> Result<(), SFrameMediaError> {
        if next_epoch <= self.send_epoch {
            return Err(SFrameMediaError::EpochMismatch);
        }
        let next_generation = random_sender_generation()?;
        let next_root =
            derive_sframe_epoch_root_key(next_mls_epoch_secret, &self.room_id, next_epoch)?;
        self.send_epoch_root_key.fill(0);
        self.send_epoch_root_key = next_root;
        self.send_epoch = next_epoch;
        self.send_generation = next_generation;
        self.send_ratchet_step = 0;
        self.audio_counter = 0;
        self.video_counter = 0;

        let next_slot = EpochReceiveSlot {
            epoch: next_epoch,
            epoch_root_key: next_root,
            expires_at_ms: None,
            replay: BTreeMap::new(),
            generation_owners: BTreeMap::new(),
        };
        let mut previous = std::mem::replace(&mut self.current_receive, next_slot);
        if member_removed {
            self.grace_receive = None;
            drop(previous);
        } else {
            previous.expires_at_ms = Some(now_ms.saturating_add(SFRAME_EPOCH_GRACE_MS));
            self.grace_receive = Some(previous);
        }
        Ok(())
    }

    /// Seals an outgoing frame with the active send epoch key and increments the track counter.
    pub fn seal_frame(
        &mut self,
        plaintext_frame: &[u8],
        codec: SFrameCodecProfile,
    ) -> Result<Vec<u8>, SFrameMediaError> {
        let track_kind = codec.track_kind();
        let prefix_len = codec.validated_prefix_len()?;
        let counter_slot = match track_kind {
            SFrameTrackKind::Audio => &mut self.audio_counter,
            SFrameTrackKind::Video => &mut self.video_counter,
        };
        if *counter_slot == u64::MAX {
            return Err(SFrameMediaError::CounterExhausted);
        }
        let counter = *counter_slot;
        let key_id = SFrameKeyId::new(self.send_epoch, self.send_ratchet_step)?;
        let wire = seal_sframe_media_frame(
            &self.send_epoch_root_key,
            &self.room_id,
            key_id,
            &self.local_device_id,
            self.send_generation,
            track_kind,
            counter,
            prefix_len,
            plaintext_frame,
        )?;
        *counter_slot += 1;
        Ok(wire)
    }

    /// Opens an incoming `SFrame` v1 packet, enforcing reflection rejection, non-zero & non-duplicate
    /// `sender_generation` ownership, active/grace epoch selection, 1024-frame replay protection,
    /// and AES-256-GCM AAD verification.
    pub fn open_frame(
        &mut self,
        sealed_frame: &[u8],
        codec: SFrameCodecProfile,
        sender_device_id: &str,
        now_ms: u64,
    ) -> Result<Vec<u8>, SFrameMediaError> {
        validate_scope_label(sender_device_id)?;
        if sender_device_id == self.local_device_id {
            return Err(SFrameMediaError::ReflectionRejected);
        }
        if let Some(grace) = &self.grace_receive {
            if grace.expires_at_ms.is_some_and(|exp| now_ms >= exp) {
                self.grace_receive = None;
            }
        }
        let track_kind = codec.track_kind();
        let prefix_len = codec.validated_prefix_len()?;
        if sealed_frame.len()
            < prefix_len + 1 + SFRAME_SENDER_GENERATION_BYTES + SFRAME_GCM_TAG_BYTES
        {
            return Err(SFrameMediaError::MalformedHeader);
        }
        let remainder = &sealed_frame[prefix_len..];
        let (header, header_len) = SFrameHeader::decode(remainder)?;
        if remainder.len() < header_len + SFRAME_SENDER_GENERATION_BYTES + SFRAME_GCM_TAG_BYTES {
            return Err(SFrameMediaError::MalformedHeader);
        }
        let gen_bytes: [u8; SFRAME_SENDER_GENERATION_BYTES] = remainder
            [header_len..header_len + SFRAME_SENDER_GENERATION_BYTES]
            .try_into()
            .map_err(|_| SFrameMediaError::MalformedHeader)?;
        let sender_generation = u64::from_be_bytes(gen_bytes);
        if sender_generation == 0 {
            return Err(SFrameMediaError::MalformedHeader);
        }
        if sender_generation == self.send_generation {
            return Err(SFrameMediaError::ReflectionRejected);
        }
        let packet_epoch = header.key_id.epoch();

        let slot = if packet_epoch == self.current_receive.epoch {
            &mut self.current_receive
        } else if let Some(grace) = self
            .grace_receive
            .as_mut()
            .filter(|g| g.epoch == packet_epoch)
        {
            grace
        } else {
            return Err(SFrameMediaError::EpochMismatch);
        };

        if let Some(owner) = slot.generation_owners.get(&sender_generation) {
            if owner != sender_device_id {
                return Err(SFrameMediaError::ReplayDetected);
            }
        }
        let replay_key = (
            sender_device_id.to_owned(),
            sender_generation,
            track_kind,
            header.key_id.ratchet_step(),
        );
        if let Some(window) = slot.replay.get(&replay_key) {
            window.check(header.counter)?;
        } else if slot.replay.len() >= MAX_TRACKED_SENDERS {
            return Err(SFrameMediaError::CapacityExceeded);
        }

        let (_, _, plaintext) = open_sframe_media_frame(
            &slot.epoch_root_key,
            &self.room_id,
            slot.epoch,
            sender_device_id,
            track_kind,
            prefix_len,
            sealed_frame,
        )?;
        slot.generation_owners
            .insert(sender_generation, sender_device_id.to_owned());
        slot.replay
            .entry(replay_key)
            .or_default()
            .commit(header.counter)?;
        Ok(plaintext)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "sframe-media")]
    fn sample_secret(byte: u8) -> [u8; 32] {
        [byte; 32]
    }

    #[test]
    fn canonical_sframe_header_roundtrips_and_rejects_non_canonical_encodings() {
        for (epoch, ratchet, counter, expected_len) in [
            (0u64, 0u16, 0u64, 1usize),
            (0u64, 7u16, 7u64, 1usize),
            (0u64, 8u16, 8u64, 3usize),
            (1u64, 0u16, 0u64, 4usize),
            (7u64, 2u16, 1025u64, 6usize),
            (
                0x0001_0203_0405u64,
                0x0607u16,
                0x0809_0a0b_0c0d_0e0fu64,
                16usize,
            ),
        ] {
            let kid = SFrameKeyId::new(epoch, ratchet).unwrap();
            assert_eq!(kid.epoch(), epoch);
            assert_eq!(kid.ratchet_step(), ratchet);
            let header = SFrameHeader::new(kid, counter);
            let encoded = header.encode();
            assert_eq!(encoded.len(), expected_len);
            let (decoded, used) = SFrameHeader::decode(&encoded).unwrap();
            assert_eq!(used, encoded.len());
            assert_eq!(decoded, header);
        }

        // Non-canonical X=1 with KID=5 in 1 byte must be rejected.
        assert_eq!(
            SFrameHeader::decode(&[0b1000_0000, 0x05]),
            Err(SFrameMediaError::MalformedHeader)
        );
        // Non-canonical Y=1 with leading 0x00 in 2-byte CTR must be rejected.
        assert_eq!(
            SFrameHeader::decode(&[0b0000_1001, 0x00, 0x09]),
            Err(SFrameMediaError::MalformedHeader)
        );
    }

    #[test]
    fn replay_window_tracks_1024_out_of_order_frames_and_rejects_duplicates_and_stale() {
        let mut window = SFrameReplayWindow::new();
        window.commit(0).unwrap();
        assert_eq!(window.check(0), Err(SFrameMediaError::ReplayDetected));

        window.commit(1023).unwrap();
        // Counter 0 is at delta = 1023 (inside window, already seen -> ReplayDetected).
        assert_eq!(window.check(0), Err(SFrameMediaError::ReplayDetected));
        // Counter 500 is unseen inside window -> accepted once, then rejected on duplicate.
        window.commit(500).unwrap();
        assert_eq!(window.check(500), Err(SFrameMediaError::ReplayDetected));

        // Advancing to 1024 pushes counter 0 to delta = 1024 -> StaleCounter!
        window.commit(1024).unwrap();
        assert_eq!(window.check(0), Err(SFrameMediaError::StaleCounter));
        // Counter 1 is at delta = 1023 -> still inside window and unseen!
        window.commit(1).unwrap();
        assert_eq!(window.check(1), Err(SFrameMediaError::ReplayDetected));
    }

    #[cfg(feature = "sframe-media")]
    #[test]
    fn opus_and_vp8_prefix_aad_roundtrip_tamper_resistance_and_epoch_grace_window() {
        let room = "01950000-0000-7000-8000-000000000777";
        let secret_e7 = sample_secret(0x47);
        let secret_e8 = sample_secret(0x89);
        let secret_e9 = sample_secret(0xa5);

        let mut alice = SFrameMediaSession::new(room, "alice-dev-1", 7, &secret_e7).unwrap();
        let mut bob = SFrameMediaSession::new(room, "bob-dev-2", 7, &secret_e7).unwrap();

        // 1. Opus audio (0-byte prefix, including 0-byte DTX silence)
        let silence = alice.seal_frame(&[], SFrameCodecProfile::opus()).unwrap();
        assert_eq!(
            alice.open_frame(&silence, SFrameCodecProfile::opus(), "alice-dev-1", 1_000),
            Err(SFrameMediaError::ReflectionRejected)
        );
        assert_eq!(
            bob.open_frame(&silence, SFrameCodecProfile::opus(), "alice-dev-1", 1_000)
                .unwrap(),
            Vec::<u8>::new()
        );
        assert_eq!(
            bob.open_frame(&silence, SFrameCodecProfile::opus(), "alice-dev-1", 1_000),
            Err(SFrameMediaError::ReplayDetected)
        );

        // 2. VP8 keyframe with 10-byte cleartext payload header authenticated via AAD
        let mut vp8_frame = vec![0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x07, 0x38, 0x04];
        vp8_frame.extend_from_slice(b"confidential-vp8-macroblocks-payload");
        let sealed_vp8 = alice
            .seal_frame(&vp8_frame, SFrameCodecProfile::vp8_keyframe())
            .unwrap();
        // SFU sees exact 10-byte VP8 uncompressed header at offset 0..10:
        assert_eq!(&sealed_vp8[..10], &vp8_frame[..10]);
        // Ciphertext hides macroblock payload:
        assert!(!sealed_vp8
            .windows(b"confidential-vp8".len())
            .any(|w| w == b"confidential-vp8"));

        // Flipping 1 bit in the unencrypted VP8 header MUST fail GCM AAD authentication
        // AND must not consume the counter in Bob's replay window!
        let mut tampered_prefix = sealed_vp8.clone();
        tampered_prefix[0] ^= 0x01;
        assert_eq!(
            bob.open_frame(
                &tampered_prefix,
                SFrameCodecProfile::vp8_keyframe(),
                "alice-dev-1",
                1_010
            ),
            Err(SFrameMediaError::AuthenticationFailed)
        );
        // Genuine packet still opens cleanly afterwards:
        assert_eq!(
            bob.open_frame(
                &sealed_vp8,
                SFrameCodecProfile::vp8_keyframe(),
                "alice-dev-1",
                1_010
            )
            .unwrap(),
            vp8_frame
        );

        // 3. Routine epoch rotation (member_removed = false):
        //    - Prior send keys retired immediately;
        //    - In-flight epoch-7 packet accepted within 2000 ms grace, rejected at >= 2000 ms.
        let in_flight_e7 = alice
            .seal_frame(b"late-opus-e7-packet", SFrameCodecProfile::opus())
            .unwrap();
        bob.rotate_epoch_key(8, &secret_e8, false, 10_000).unwrap();
        alice
            .rotate_epoch_key(8, &secret_e8, false, 10_000)
            .unwrap();

        let fresh_e8 = alice
            .seal_frame(b"fresh-opus-e8-packet", SFrameCodecProfile::opus())
            .unwrap();
        assert_eq!(
            bob.open_frame(&fresh_e8, SFrameCodecProfile::opus(), "alice-dev-1", 10_100)
                .unwrap(),
            b"fresh-opus-e8-packet"
        );
        // Still inside 2-second grace (11_999 < 12_000):
        assert_eq!(
            bob.open_frame(
                &in_flight_e7,
                SFrameCodecProfile::opus(),
                "alice-dev-1",
                11_999
            )
            .unwrap(),
            b"late-opus-e7-packet"
        );

        let expired_e7 = seal_sframe_media_frame(
            &derive_sframe_epoch_root_key(&secret_e7, room, 7).unwrap(),
            room,
            SFrameKeyId::new(7, 0).unwrap(),
            "alice-dev-1",
            0x0102_0304_0506_0708,
            SFrameTrackKind::Audio,
            99,
            0,
            b"too-late-e7",
        )
        .unwrap();
        assert_eq!(
            bob.open_frame(
                &expired_e7,
                SFrameCodecProfile::opus(),
                "alice-dev-1",
                12_000
            ),
            Err(SFrameMediaError::EpochMismatch)
        );

        // 4. Member removal rotation (member_removed = true): strict immediate purge!
        let evicted_e8 = alice
            .seal_frame(b"evicted-member-packet", SFrameCodecProfile::opus())
            .unwrap();
        bob.rotate_epoch_key(9, &secret_e9, true, 20_000).unwrap();
        assert_eq!(
            bob.open_frame(
                &evicted_e8,
                SFrameCodecProfile::opus(),
                "alice-dev-1",
                20_001
            ),
            Err(SFrameMediaError::EpochMismatch)
        );
    }

    #[cfg(feature = "sframe-media")]
    #[test]
    fn session_restarts_in_same_epoch_never_reuse_key_or_nonce_and_refuse_zero_or_duplicate_generations(
    ) {
        let room = "01950000-0000-7000-8000-000000000888";
        let secret = sample_secret(0x5c);

        // Zero sender_generation is strictly refused at construction, key derivation, and wire open.
        assert_eq!(
            SFrameMediaSession::with_sender_generation(room, "alice-dev-1", 7, &secret, 0)
                .unwrap_err(),
            SFrameMediaError::InvalidScope
        );
        let root = derive_sframe_epoch_root_key(&secret, room, 7).unwrap();
        assert_eq!(
            derive_sframe_sender_key(&root, room, 7, "alice-dev-1", 0, SFrameTrackKind::Audio, 0)
                .unwrap_err(),
            SFrameMediaError::InvalidScope
        );

        // Two freshly constructed sessions with identical (epoch_secret, room_id, epoch, sender_device_id)
        // draw distinct 64-bit sender_generations, distinct AEAD keys, and distinct ciphertexts at counter=0!
        let mut alice_first = SFrameMediaSession::new(room, "alice-dev-1", 7, &secret).unwrap();
        let mut alice_restarted = SFrameMediaSession::new(room, "alice-dev-1", 7, &secret).unwrap();
        assert_ne!(alice_first.sender_generation(), 0);
        assert_ne!(alice_restarted.sender_generation(), 0);
        assert_ne!(
            alice_first.sender_generation(),
            alice_restarted.sender_generation()
        );

        let key_first = derive_sframe_sender_key(
            &root,
            room,
            7,
            "alice-dev-1",
            alice_first.sender_generation(),
            SFrameTrackKind::Audio,
            0,
        )
        .unwrap();
        let key_restarted = derive_sframe_sender_key(
            &root,
            room,
            7,
            "alice-dev-1",
            alice_restarted.sender_generation(),
            SFrameTrackKind::Audio,
            0,
        )
        .unwrap();
        assert_ne!(key_first.aead_key(), key_restarted.aead_key());
        assert_ne!(key_first.base_salt(), key_restarted.base_salt());

        let frame_1 = alice_first
            .seal_frame(
                b"identical-opus-frame-at-counter-0",
                SFrameCodecProfile::opus(),
            )
            .unwrap();
        let frame_2 = alice_restarted
            .seal_frame(
                b"identical-opus-frame-at-counter-0",
                SFrameCodecProfile::opus(),
            )
            .unwrap();
        assert_ne!(frame_1, frame_2);

        let mut bob = SFrameMediaSession::new(room, "bob-dev-2", 7, &secret).unwrap();
        assert_eq!(
            bob.open_frame(&frame_1, SFrameCodecProfile::opus(), "alice-dev-1", 1_000)
                .unwrap(),
            b"identical-opus-frame-at-counter-0"
        );
        assert_eq!(
            bob.open_frame(&frame_2, SFrameCodecProfile::opus(), "alice-dev-1", 1_005)
                .unwrap(),
            b"identical-opus-frame-at-counter-0"
        );
        // Replaying either session's counter=0 packet is rejected:
        assert_eq!(
            bob.open_frame(&frame_1, SFrameCodecProfile::opus(), "alice-dev-1", 1_006),
            Err(SFrameMediaError::ReplayDetected)
        );
        // Cross-sender reuse of alice_first's sender_generation by another device is rejected:
        let forged_dup_gen = seal_sframe_media_frame(
            &root,
            room,
            SFrameKeyId::new(7, 0).unwrap(),
            "mallory-dev-9",
            alice_first.sender_generation(),
            SFrameTrackKind::Audio,
            1,
            0,
            b"spoofed",
        )
        .unwrap();
        assert_eq!(
            bob.open_frame(
                &forged_dup_gen,
                SFrameCodecProfile::opus(),
                "mallory-dev-9",
                1_007
            ),
            Err(SFrameMediaError::ReplayDetected)
        );
    }

    #[cfg(all(feature = "sframe-media", feature = "openmls-engine"))]
    #[test]
    fn golden_vectors_match_sframe_media_v1_json() {
        use crate::{decode_hex, encode_hex};

        #[derive(serde::Deserialize)]
        struct VectorSuite {
            schema: String,
            domain: String,
            replay_window_frames: u64,
            epoch_grace_ms: u64,
            vectors: Vec<GoldenVector>,
        }

        #[derive(serde::Deserialize)]
        struct GoldenVector {
            name: String,
            room_id: String,
            epoch: u64,
            ratchet_step: u16,
            sender_device_id: String,
            sender_generation_hex: String,
            track_kind: String,
            counter: u64,
            unencrypted_prefix_len: usize,
            mls_epoch_material_hex: String,
            plaintext_hex: String,
            expected_epoch_root_material_hex: String,
            expected_aead_material_hex: String,
            expected_base_salt_hex: String,
            expected_nonce_hex: String,
            expected_header_hex: String,
            expected_aad_hex: String,
            expected_sealed_hex: String,
        }

        let raw = include_str!("../vectors/sframe-media-v1.json");
        let suite: VectorSuite = serde_json::from_str(raw).expect("valid sframe-media-v1.json");
        assert_eq!(suite.schema, "kodera.sframe-media.vectors.v1");
        assert_eq!(suite.domain, SFRAME_MEDIA_DOMAIN);
        assert_eq!(suite.replay_window_frames, SFRAME_REPLAY_WINDOW_FRAMES);
        assert_eq!(suite.epoch_grace_ms, SFRAME_EPOCH_GRACE_MS);
        assert!(suite.vectors.len() >= 4);

        for vector in &suite.vectors {
            let secret: [u8; 32] = decode_hex(&vector.mls_epoch_material_hex)
                .unwrap()
                .try_into()
                .unwrap();
            let gen_bytes: [u8; 8] = decode_hex(&vector.sender_generation_hex)
                .unwrap()
                .try_into()
                .unwrap();
            let sender_generation = u64::from_be_bytes(gen_bytes);
            let plaintext = decode_hex(&vector.plaintext_hex).unwrap();
            let track_kind = SFrameTrackKind::parse(&vector.track_kind).unwrap();
            let key_id = SFrameKeyId::new(vector.epoch, vector.ratchet_step).unwrap();

            let root_key =
                derive_sframe_epoch_root_key(&secret, &vector.room_id, vector.epoch).unwrap();
            assert_eq!(
                encode_hex(&root_key),
                vector.expected_epoch_root_material_hex,
                "root key mismatch in {}",
                vector.name
            );

            let sender_key = derive_sframe_sender_key(
                &root_key,
                &vector.room_id,
                vector.epoch,
                &vector.sender_device_id,
                sender_generation,
                track_kind,
                vector.ratchet_step,
            )
            .unwrap();
            assert_eq!(
                encode_hex(sender_key.aead_key()),
                vector.expected_aead_material_hex,
                "aead key mismatch in {}",
                vector.name
            );
            assert_eq!(
                encode_hex(sender_key.base_salt()),
                vector.expected_base_salt_hex,
                "base salt mismatch in {}",
                vector.name
            );
            assert_eq!(
                encode_hex(&sender_key.nonce_for_counter(vector.counter)),
                vector.expected_nonce_hex,
                "nonce mismatch in {}",
                vector.name
            );

            let header = SFrameHeader::new(key_id, vector.counter);
            let header_bytes = header.encode();
            assert_eq!(
                encode_hex(&header_bytes),
                vector.expected_header_hex,
                "header mismatch in {}",
                vector.name
            );

            let aad = build_sframe_aad(
                &vector.room_id,
                key_id,
                track_kind,
                &vector.sender_device_id,
                sender_generation,
                &plaintext[..vector.unencrypted_prefix_len],
                &header_bytes,
            )
            .unwrap();
            assert_eq!(
                encode_hex(&aad),
                vector.expected_aad_hex,
                "aad mismatch in {}",
                vector.name
            );

            let sealed = seal_sframe_media_frame(
                &root_key,
                &vector.room_id,
                key_id,
                &vector.sender_device_id,
                sender_generation,
                track_kind,
                vector.counter,
                vector.unencrypted_prefix_len,
                &plaintext,
            )
            .unwrap();
            assert_eq!(
                encode_hex(&sealed),
                vector.expected_sealed_hex,
                "sealed packet mismatch in {}",
                vector.name
            );

            let (opened_header, opened_gen, opened_plaintext) = open_sframe_media_frame(
                &root_key,
                &vector.room_id,
                vector.epoch,
                &vector.sender_device_id,
                track_kind,
                vector.unencrypted_prefix_len,
                &sealed,
            )
            .unwrap();
            assert_eq!(opened_header, header);
            assert_eq!(opened_gen, sender_generation);
            assert_eq!(opened_plaintext, plaintext);
        }
    }
}
