//! ES256 WebAuthn assertion verification for a trusted, pre-registered passkey credential.
//! Registration/attestation, platform association and protected persistence remain external.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};

use crate::{sha256, validate_docs_host, NativeCryptoError, OrganisationId};

const MAX_CHALLENGES: usize = 64;
const MAX_CLIENT_DATA_JSON_BYTES: usize = 4096;
const MAX_AUTHENTICATOR_DATA_BYTES: usize = 2048;
const MAX_JSON_NESTING_DEPTH: u8 = 4;
const MAX_CBOR_EXTENSION_DEPTH: u8 = 4;
const FLAG_UP: u8 = 0x01;
const FLAG_UV: u8 = 0x04;
const FLAG_BE: u8 = 0x08;
const FLAG_BS: u8 = 0x10;
const FLAG_AT: u8 = 0x40;
const FLAG_ED: u8 = 0x80;
const FLAG_RFU_MASK: u8 = 0x22;

/// Backup flag policy for WebAuthn Level 3 §6.5 assertion flags.
///
/// - [`Self::Universal`] (default): admits single-device security keys (`0x05`), backup-eligible
///   local passkeys (`0x0D`), and multi-device synced passkeys (`0x1D`, including platform keychains
///   and self-hosted software vaults), with optional bounded CBOR extension data (`ED`, `0x80`),
///   while still requiring `UP|UV` and rejecting invalid `BS=1, BE=0` (`0x15`), attested-data
///   (`AT`), and reserved (`RFU`) bits.
/// - [`Self::StrictNonBackupable`]: additionally requires `(flags & 0x18) == 0`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PasskeyBackupPolicy {
    #[default]
    Universal,
    StrictNonBackupable,
}

/// Authenticator backup/residency posture reported by signed WebAuthn Level 3 assertion flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasskeyResidencyPosture {
    SingleDeviceBound,
    BackupEligibleLocal,
    MultiDeviceSynced,
}

/// Sensitive correlation material; the bytes are passed to the platform authenticator.
#[derive(Clone)]
pub struct PasskeyChallenge {
    organisation: OrganisationId,
    nonce: [u8; 32],
    expires_at: u64,
}

impl fmt::Debug for PasskeyChallenge {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PasskeyChallenge([redacted])")
    }
}

impl PasskeyChallenge {
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.nonce
    }
    pub fn base64url(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.nonce)
    }
}

/// Raw authenticator response. No client-side boolean establishes successful authentication.
pub struct PasskeyAssertion {
    pub credential_id: Vec<u8>,
    pub client_data_json: Vec<u8>,
    pub authenticator_data: Vec<u8>,
    pub signature_der: Vec<u8>,
}

impl fmt::Debug for PasskeyAssertion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PasskeyAssertion([redacted])")
    }
}

struct ClientData {
    ceremony: String,
    challenge: String,
    origin: String,
    cross_origin: bool,
}

struct StrictClientDataParser<'a> {
    raw: &'a str,
    offset: usize,
}

impl<'a> StrictClientDataParser<'a> {
    fn parse(raw_bytes: &'a [u8]) -> Result<ClientData, NativeCryptoError> {
        if raw_bytes.is_empty() || raw_bytes.len() > MAX_CLIENT_DATA_JSON_BYTES {
            return Err(NativeCryptoError::InvalidInput);
        }
        let raw = core::str::from_utf8(raw_bytes).map_err(|_| NativeCryptoError::InvalidInput)?;
        let mut parser = Self { raw, offset: 0 };
        parser.skip_ws();
        parser.expect_byte(b'{')?;
        parser.skip_ws();

        let mut seen_keys = BTreeSet::new();
        let mut ceremony: Option<String> = None;
        let mut challenge: Option<String> = None;
        let mut origin: Option<String> = None;
        let mut cross_origin = false;

        if !parser.try_byte(b'}') {
            loop {
                if seen_keys.len() >= 64 {
                    return Err(NativeCryptoError::InvalidInput);
                }
                parser.skip_ws();
                let key = parser.parse_string()?;
                if !seen_keys.insert(key.clone()) {
                    return Err(NativeCryptoError::InvalidInput);
                }
                parser.skip_ws();
                parser.expect_byte(b':')?;
                parser.skip_ws();

                match key.as_str() {
                    "type" => ceremony = Some(parser.parse_string()?),
                    "challenge" => challenge = Some(parser.parse_string()?),
                    "origin" => origin = Some(parser.parse_string()?),
                    "crossOrigin" => cross_origin = parser.parse_bool()?,
                    _ => parser.skip_value(1)?,
                }

                parser.skip_ws();
                if parser.try_byte(b'}') {
                    break;
                }
                parser.expect_byte(b',')?;
            }
        }

        parser.skip_ws();
        if parser.offset != parser.raw.len() {
            return Err(NativeCryptoError::InvalidInput);
        }

        Ok(ClientData {
            ceremony: ceremony.ok_or(NativeCryptoError::InvalidInput)?,
            challenge: challenge.ok_or(NativeCryptoError::InvalidInput)?,
            origin: origin.ok_or(NativeCryptoError::InvalidInput)?,
            cross_origin,
        })
    }

    fn peek(&self) -> Option<u8> {
        self.raw.as_bytes().get(self.offset).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\r' | b'\n')) {
            self.offset += 1;
        }
    }

    fn expect_byte(&mut self, expected: u8) -> Result<(), NativeCryptoError> {
        if self.peek() != Some(expected) {
            return Err(NativeCryptoError::InvalidInput);
        }
        self.offset += 1;
        Ok(())
    }

    fn try_byte(&mut self, expected: u8) -> bool {
        if self.peek() == Some(expected) {
            self.offset += 1;
            true
        } else {
            false
        }
    }

    fn expect_literal(&mut self, literal: &str) -> Result<(), NativeCryptoError> {
        if !self.raw[self.offset..].starts_with(literal) {
            return Err(NativeCryptoError::InvalidInput);
        }
        self.offset += literal.len();
        Ok(())
    }

    fn parse_bool(&mut self) -> Result<bool, NativeCryptoError> {
        match self.peek() {
            Some(b't') => {
                self.expect_literal("true")?;
                Ok(true)
            }
            Some(b'f') => {
                self.expect_literal("false")?;
                Ok(false)
            }
            _ => Err(NativeCryptoError::InvalidInput),
        }
    }

    fn parse_hex_u16(&mut self) -> Result<u16, NativeCryptoError> {
        let mut acc = 0u16;
        for _ in 0..4 {
            let b = self.peek().ok_or(NativeCryptoError::InvalidInput)?;
            let digit = match b {
                b'0'..=b'9' => u16::from(b - b'0'),
                b'a'..=b'f' => u16::from(b - b'a' + 10),
                b'A'..=b'F' => u16::from(b - b'A' + 10),
                _ => return Err(NativeCryptoError::InvalidInput),
            };
            self.offset += 1;
            acc = (acc << 4) | digit;
        }
        Ok(acc)
    }

    fn parse_string(&mut self) -> Result<String, NativeCryptoError> {
        self.expect_byte(b'"')?;
        let mut out = String::new();
        loop {
            let ch = self.raw[self.offset..]
                .chars()
                .next()
                .ok_or(NativeCryptoError::InvalidInput)?;
            self.offset += ch.len_utf8();
            match ch {
                '"' => return Ok(out),
                '\\' => {
                    let esc = self.peek().ok_or(NativeCryptoError::InvalidInput)?;
                    self.offset += 1;
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
                            let hi = u32::from(self.parse_hex_u16()?);
                            let scalar = if (0xD800..=0xDBFF).contains(&hi) {
                                self.expect_byte(b'\\')?;
                                self.expect_byte(b'u')?;
                                let lo = u32::from(self.parse_hex_u16()?);
                                if !(0xDC00..=0xDFFF).contains(&lo) {
                                    return Err(NativeCryptoError::InvalidInput);
                                }
                                0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                            } else {
                                hi
                            };
                            let decoded =
                                char::from_u32(scalar).ok_or(NativeCryptoError::InvalidInput)?;
                            out.push(decoded);
                        }
                        _ => return Err(NativeCryptoError::InvalidInput),
                    }
                }
                c if (c as u32) < 0x20 => return Err(NativeCryptoError::InvalidInput),
                other => out.push(other),
            }
        }
    }

    fn parse_number(&mut self) -> Result<(), NativeCryptoError> {
        let _ = self.try_byte(b'-');
        match self.peek() {
            Some(b'0') => self.offset += 1,
            Some(b'1'..=b'9') => {
                self.offset += 1;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.offset += 1;
                }
            }
            _ => return Err(NativeCryptoError::InvalidInput),
        }
        if self.try_byte(b'.') {
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(NativeCryptoError::InvalidInput);
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.offset += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.offset += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.offset += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(NativeCryptoError::InvalidInput);
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.offset += 1;
            }
        }
        Ok(())
    }

    fn skip_value(&mut self, depth: u8) -> Result<(), NativeCryptoError> {
        if depth > MAX_JSON_NESTING_DEPTH {
            return Err(NativeCryptoError::InvalidInput);
        }
        match self.peek() {
            Some(b'"') => {
                let _ = self.parse_string()?;
                Ok(())
            }
            Some(b't') => self.expect_literal("true"),
            Some(b'f') => self.expect_literal("false"),
            Some(b'n') => self.expect_literal("null"),
            Some(b'-' | b'0'..=b'9') => self.parse_number(),
            Some(b'[') => {
                if depth == MAX_JSON_NESTING_DEPTH {
                    return Err(NativeCryptoError::InvalidInput);
                }
                self.offset += 1;
                self.skip_ws();
                if self.try_byte(b']') {
                    return Ok(());
                }
                let mut count = 0usize;
                loop {
                    count += 1;
                    if count > 64 {
                        return Err(NativeCryptoError::InvalidInput);
                    }
                    self.skip_ws();
                    self.skip_value(depth + 1)?;
                    self.skip_ws();
                    if self.try_byte(b']') {
                        return Ok(());
                    }
                    self.expect_byte(b',')?;
                }
            }
            Some(b'{') => {
                if depth == MAX_JSON_NESTING_DEPTH {
                    return Err(NativeCryptoError::InvalidInput);
                }
                self.offset += 1;
                self.skip_ws();
                if self.try_byte(b'}') {
                    return Ok(());
                }
                let mut nested_keys = BTreeSet::new();
                loop {
                    if nested_keys.len() >= 64 {
                        return Err(NativeCryptoError::InvalidInput);
                    }
                    self.skip_ws();
                    let k = self.parse_string()?;
                    if !nested_keys.insert(k) {
                        return Err(NativeCryptoError::InvalidInput);
                    }
                    self.skip_ws();
                    self.expect_byte(b':')?;
                    self.skip_ws();
                    self.skip_value(depth + 1)?;
                    self.skip_ws();
                    if self.try_byte(b'}') {
                        return Ok(());
                    }
                    self.expect_byte(b',')?;
                }
            }
            _ => Err(NativeCryptoError::InvalidInput),
        }
    }
}

fn validate_cbor_extension_map(bytes: &[u8]) -> Result<(), NativeCryptoError> {
    if bytes.is_empty() || bytes.len() > MAX_AUTHENTICATOR_DATA_BYTES {
        return Err(NativeCryptoError::AuthenticationFailed);
    }
    let mut offset = 0usize;
    let initial = bytes[0];
    if (initial >> 5) != 5 {
        return Err(NativeCryptoError::AuthenticationFailed);
    }
    let map_len = read_cbor_definite_len(bytes, &mut offset)?;
    if map_len == 0 || map_len > 32 {
        return Err(NativeCryptoError::AuthenticationFailed);
    }
    for _ in 0..map_len {
        skip_cbor_item(bytes, &mut offset, 1)?;
        skip_cbor_item(bytes, &mut offset, 1)?;
    }
    if offset != bytes.len() {
        return Err(NativeCryptoError::AuthenticationFailed);
    }
    Ok(())
}

fn read_cbor_definite_len(bytes: &[u8], offset: &mut usize) -> Result<usize, NativeCryptoError> {
    let initial = *bytes
        .get(*offset)
        .ok_or(NativeCryptoError::AuthenticationFailed)?;
    *offset += 1;
    let info = initial & 0x1F;
    match info {
        0..=23 => Ok(usize::from(info)),
        24 => {
            let v = *bytes
                .get(*offset)
                .ok_or(NativeCryptoError::AuthenticationFailed)?;
            *offset += 1;
            if v < 24 {
                return Err(NativeCryptoError::AuthenticationFailed);
            }
            Ok(usize::from(v))
        }
        25 => {
            let slice = bytes
                .get(*offset..*offset + 2)
                .ok_or(NativeCryptoError::AuthenticationFailed)?;
            *offset += 2;
            let v = u16::from_be_bytes([slice[0], slice[1]]);
            if v < 256 {
                return Err(NativeCryptoError::AuthenticationFailed);
            }
            Ok(usize::from(v))
        }
        _ => Err(NativeCryptoError::AuthenticationFailed),
    }
}

fn skip_cbor_item(bytes: &[u8], offset: &mut usize, depth: u8) -> Result<(), NativeCryptoError> {
    if depth > MAX_CBOR_EXTENSION_DEPTH {
        return Err(NativeCryptoError::AuthenticationFailed);
    }
    let initial = *bytes
        .get(*offset)
        .ok_or(NativeCryptoError::AuthenticationFailed)?;
    let major = initial >> 5;
    let info = initial & 0x1F;
    match major {
        0 | 1 => {
            *offset += 1;
            let extra = match info {
                0..=23 => 0usize,
                24 => 1,
                25 => 2,
                26 => 4,
                27 => 8,
                _ => return Err(NativeCryptoError::AuthenticationFailed),
            };
            if *offset + extra > bytes.len() {
                return Err(NativeCryptoError::AuthenticationFailed);
            }
            *offset += extra;
            Ok(())
        }
        2 => {
            let len = read_cbor_definite_len(bytes, offset)?;
            if *offset + len > bytes.len() {
                return Err(NativeCryptoError::AuthenticationFailed);
            }
            *offset += len;
            Ok(())
        }
        3 => {
            let len = read_cbor_definite_len(bytes, offset)?;
            let slice = bytes
                .get(*offset..*offset + len)
                .ok_or(NativeCryptoError::AuthenticationFailed)?;
            core::str::from_utf8(slice).map_err(|_| NativeCryptoError::AuthenticationFailed)?;
            *offset += len;
            Ok(())
        }
        4 => {
            if depth == MAX_CBOR_EXTENSION_DEPTH {
                return Err(NativeCryptoError::AuthenticationFailed);
            }
            let len = read_cbor_definite_len(bytes, offset)?;
            if len > 32 {
                return Err(NativeCryptoError::AuthenticationFailed);
            }
            for _ in 0..len {
                skip_cbor_item(bytes, offset, depth + 1)?;
            }
            Ok(())
        }
        5 => {
            if depth == MAX_CBOR_EXTENSION_DEPTH {
                return Err(NativeCryptoError::AuthenticationFailed);
            }
            let len = read_cbor_definite_len(bytes, offset)?;
            if len > 32 {
                return Err(NativeCryptoError::AuthenticationFailed);
            }
            for _ in 0..len {
                skip_cbor_item(bytes, offset, depth + 1)?;
                skip_cbor_item(bytes, offset, depth + 1)?;
            }
            Ok(())
        }
        7 if matches!(info, 20..=22) => {
            *offset += 1;
            Ok(())
        }
        _ => Err(NativeCryptoError::AuthenticationFailed),
    }
}

struct ChallengeState {
    expires_at: u64,
    used: bool,
}

/// The public key must come from trusted registration/attestation, never an assertion payload.
/// Requires `UP+UV` (`0x05`) and enforces [`PasskeyBackupPolicy`] (`Universal` by default: `0x05`,
/// `0x0D`, `0x1D`, rejecting invalid `BS=1, BE=0` `0x15`, `AT`, `ED`, and RFU bits).
/// Signed flags do not themselves prove a hardware manufacturer or secure-element residency.
pub struct PasskeyBinding {
    organisation: OrganisationId,
    rp_id: String,
    origin: String,
    credential_id: Vec<u8>,
    public_key: VerifyingKey,
    backup_policy: PasskeyBackupPolicy,
    last_counter: u32,
    latest_now: u64,
    last_residency_posture: Option<PasskeyResidencyPosture>,
    challenges: BTreeMap<[u8; 32], ChallengeState>,
}

impl fmt::Debug for PasskeyBinding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PasskeyBinding([redacted])")
    }
}

fn validate_assertion_flags(
    flags: u8,
    policy: PasskeyBackupPolicy,
) -> Result<PasskeyResidencyPosture, NativeCryptoError> {
    if (flags & (FLAG_UP | FLAG_UV)) != (FLAG_UP | FLAG_UV) {
        return Err(NativeCryptoError::AuthenticationFailed);
    }
    if (flags & (FLAG_RFU_MASK | FLAG_AT)) != 0 {
        return Err(NativeCryptoError::AuthenticationFailed);
    }
    let backup_bits = flags & (FLAG_BE | FLAG_BS);
    if backup_bits == FLAG_BS {
        return Err(NativeCryptoError::AuthenticationFailed);
    }
    if policy == PasskeyBackupPolicy::StrictNonBackupable && backup_bits != 0 {
        return Err(NativeCryptoError::AuthenticationFailed);
    }
    Ok(match backup_bits {
        0 => PasskeyResidencyPosture::SingleDeviceBound,
        FLAG_BE => PasskeyResidencyPosture::BackupEligibleLocal,
        _ => PasskeyResidencyPosture::MultiDeviceSynced,
    })
}

fn admitted_origin(rp_id: &str, origin: &str) -> bool {
    if origin.len() > 512 {
        return false;
    }
    if let Some(host) = origin.strip_prefix("https://") {
        return validate_docs_host(host).is_ok()
            && (host == rp_id
                || host
                    .strip_suffix(rp_id)
                    .is_some_and(|prefix| prefix.ends_with('.')));
    }
    if let Some(hash) = origin.strip_prefix("android:apk-key-hash:") {
        return URL_SAFE_NO_PAD
            .decode(hash)
            .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == hash);
    }
    false
}

impl PasskeyBinding {
    /// Public origin and RP data come from the reviewed platform association policy.
    /// Defaults to [`PasskeyBackupPolicy::Universal`] so standard multi-provider WebAuthn L3
    /// passkeys (`0x05`, `0x0D`, `0x1D`) verify without vendor lock-in.
    pub fn new(
        organisation: OrganisationId,
        rp_id: &str,
        origin: &str,
        credential_id: &[u8],
        public_sec1_key: &[u8],
    ) -> Result<Self, NativeCryptoError> {
        Self::with_backup_policy(
            organisation,
            rp_id,
            origin,
            credential_id,
            public_sec1_key,
            PasskeyBackupPolicy::Universal,
        )
    }

    /// Creates an assertion verifier with an explicit [`PasskeyBackupPolicy`].
    pub fn with_backup_policy(
        organisation: OrganisationId,
        rp_id: &str,
        origin: &str,
        credential_id: &[u8],
        public_sec1_key: &[u8],
        backup_policy: PasskeyBackupPolicy,
    ) -> Result<Self, NativeCryptoError> {
        if validate_docs_host(rp_id).is_err()
            || !admitted_origin(rp_id, origin)
            || credential_id.is_empty()
            || credential_id.len() > 1024
            || !matches!(public_sec1_key.len(), 33 | 65)
        {
            return Err(NativeCryptoError::InvalidInput);
        }
        let public_key = VerifyingKey::from_sec1_bytes(public_sec1_key)
            .map_err(|_| NativeCryptoError::InvalidInput)?;
        Ok(Self {
            organisation,
            rp_id: rp_id.to_owned(),
            origin: origin.to_owned(),
            credential_id: credential_id.to_vec(),
            public_key,
            backup_policy,
            last_counter: 0,
            latest_now: 0,
            last_residency_posture: None,
            challenges: BTreeMap::new(),
        })
    }

    pub fn backup_policy(&self) -> PasskeyBackupPolicy {
        self.backup_policy
    }

    pub fn last_residency_posture(&self) -> Option<PasskeyResidencyPosture> {
        self.last_residency_posture
    }

    /// OS entropy supplies each 256-bit challenge. The trusted adapter supplies the clock.
    pub fn issue_challenge(
        &mut self,
        organisation: &OrganisationId,
        now: u64,
        lifetime_seconds: u64,
    ) -> Result<PasskeyChallenge, NativeCryptoError> {
        if organisation != &self.organisation {
            return Err(NativeCryptoError::ScopeMismatch);
        }
        if now < self.latest_now {
            return Err(NativeCryptoError::EpochMismatch);
        }
        if !(1..=300).contains(&lifetime_seconds) {
            return Err(NativeCryptoError::InvalidInput);
        }
        let expires_at = now
            .checked_add(lifetime_seconds)
            .ok_or(NativeCryptoError::InvalidInput)?;
        let retained = self
            .challenges
            .values()
            .filter(|state| state.expires_at >= now)
            .count();
        if retained == MAX_CHALLENGES {
            return Err(NativeCryptoError::Capacity);
        }
        let mut nonce = [0; 32];
        getrandom::fill(&mut nonce).map_err(|_| NativeCryptoError::AuthenticationFailed)?;
        if self.challenges.contains_key(&nonce) {
            return Err(NativeCryptoError::Replay);
        }
        self.challenges.retain(|_, state| state.expires_at >= now);
        self.challenges.insert(
            nonce,
            ChallengeState {
                expires_at,
                used: false,
            },
        );
        self.latest_now = now;
        Ok(PasskeyChallenge {
            organisation: self.organisation.clone(),
            nonce,
            expires_at,
        })
    }

    /// Verify the actual signature over authenticatorData || SHA256(clientDataJSON).
    /// Consume a challenge and advance the signed counter only after all checks pass.
    pub fn verify_assertion(
        &mut self,
        organisation: &OrganisationId,
        challenge: &PasskeyChallenge,
        assertion: &PasskeyAssertion,
        now: u64,
    ) -> Result<(), NativeCryptoError> {
        self.verify_assertion_posture(organisation, challenge, assertion, now)
            .map(|_| ())
    }

    /// Verify the assertion and return the authenticated [`PasskeyResidencyPosture`].
    pub fn verify_assertion_posture(
        &mut self,
        organisation: &OrganisationId,
        challenge: &PasskeyChallenge,
        assertion: &PasskeyAssertion,
        now: u64,
    ) -> Result<PasskeyResidencyPosture, NativeCryptoError> {
        if organisation != &self.organisation || challenge.organisation != self.organisation {
            return Err(NativeCryptoError::ScopeMismatch);
        }
        if now < self.latest_now {
            return Err(NativeCryptoError::EpochMismatch);
        }
        let state = self
            .challenges
            .get(&challenge.nonce)
            .ok_or(NativeCryptoError::AuthenticationFailed)?;
        if state.used {
            return Err(NativeCryptoError::Replay);
        }
        self.latest_now = now;
        if now > state.expires_at || state.expires_at != challenge.expires_at {
            return Err(NativeCryptoError::AuthenticationFailed);
        }
        if assertion.credential_id != self.credential_id
            || assertion.client_data_json.is_empty()
            || assertion.client_data_json.len() > MAX_CLIENT_DATA_JSON_BYTES
            || assertion.authenticator_data.len() < 37
            || assertion.authenticator_data.len() > MAX_AUTHENTICATOR_DATA_BYTES
            || !(8..=80).contains(&assertion.signature_der.len())
        {
            return Err(NativeCryptoError::InvalidInput);
        }
        let client = StrictClientDataParser::parse(&assertion.client_data_json)?;
        let nonce = URL_SAFE_NO_PAD
            .decode(&client.challenge)
            .map_err(|_| NativeCryptoError::AuthenticationFailed)?;
        if client.ceremony != "webauthn.get"
            || client.origin != self.origin
            || client.cross_origin
            || nonce != challenge.nonce
            || URL_SAFE_NO_PAD.encode(&nonce) != client.challenge
        {
            return Err(NativeCryptoError::ScopeMismatch);
        }
        let data = &assertion.authenticator_data;
        if data[..32] != sha256(self.rp_id.as_bytes()) {
            return Err(NativeCryptoError::AuthenticationFailed);
        }
        let flags = data[32];
        let posture = validate_assertion_flags(flags, self.backup_policy)?;
        let extension_slice = &data[37..];
        if (flags & FLAG_ED) != 0 {
            validate_cbor_extension_map(extension_slice)?;
        } else if !extension_slice.is_empty() {
            return Err(NativeCryptoError::InvalidInput);
        }
        let counter = u32::from_be_bytes(
            data[33..37]
                .try_into()
                .map_err(|_| NativeCryptoError::InvalidInput)?,
        );
        if (counter > 0 || self.last_counter > 0) && counter <= self.last_counter {
            return Err(NativeCryptoError::Replay);
        }
        let signature = Signature::from_der(&assertion.signature_der)
            .map_err(|_| NativeCryptoError::AuthenticationFailed)?;
        let mut signed = data.to_vec();
        signed.extend_from_slice(&sha256(&assertion.client_data_json));
        self.public_key
            .verify(&signed, &signature)
            .map_err(|_| NativeCryptoError::AuthenticationFailed)?;
        self.challenges
            .get_mut(&challenge.nonce)
            .ok_or(NativeCryptoError::AuthenticationFailed)?
            .used = true;
        self.last_counter = counter;
        self.last_residency_posture = Some(posture);
        Ok(posture)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Signer, SigningKey};

    fn org() -> OrganisationId {
        OrganisationId::parse("00000000-0000-4000-8000-000000000001").unwrap()
    }
    fn setup() -> (PasskeyBinding, SigningKey) {
        let signer = loop {
            let mut material = [0u8; 32];
            getrandom::fill(&mut material).unwrap();
            if let Ok(signer) = SigningKey::from_bytes(&material.into()) {
                break signer;
            }
        };
        let key = signer.verifying_key().to_sec1_point(false);
        let binding = PasskeyBinding::new(
            org(),
            "accounts.example.test",
            "https://accounts.example.test",
            b"public-fixture-credential",
            key.as_bytes(),
        )
        .unwrap();
        (binding, signer)
    }

    fn assertion(
        signer: &SigningKey,
        challenge: &PasskeyChallenge,
        count: u32,
        flags: u8,
        origin: &str,
    ) -> PasskeyAssertion {
        let client_data_json =
            serde_json::to_vec(&serde_json::json!({"type":"webauthn.get", "origin":origin,
            "challenge":challenge.base64url(), "crossOrigin":false}))
            .unwrap();
        let mut data = sha256(b"accounts.example.test").to_vec();
        data.push(flags);
        data.extend_from_slice(&count.to_be_bytes());
        let mut signed = data.clone();
        signed.extend_from_slice(&sha256(&client_data_json));
        let signature: Signature = signer.sign(&signed);
        PasskeyAssertion {
            credential_id: b"public-fixture-credential".to_vec(),
            client_data_json,
            authenticator_data: data,
            signature_der: signature.to_der().as_bytes().to_vec(),
        }
    }

    fn resign(signer: &SigningKey, response: &mut PasskeyAssertion) {
        let mut signed = response.authenticator_data.clone();
        signed.extend_from_slice(&sha256(&response.client_data_json));
        let signature: Signature = signer.sign(&signed);
        response.signature_der = signature.to_der().as_bytes().to_vec();
    }

    #[test]
    fn signed_rp_origin_challenge_and_strict_json_mutations_do_not_consume_a_good_response() {
        let (mut binding, signer) = setup();
        let challenge = binding.issue_challenge(&org(), 100, 30).unwrap();
        for mutation in 0..6 {
            let mut response = assertion(
                &signer,
                &challenge,
                1,
                0x05,
                "https://accounts.example.test",
            );
            if mutation == 0 {
                response.authenticator_data[..32].copy_from_slice(&sha256(b"foreign.example.test"));
            } else if mutation == 5 {
                let raw = String::from_utf8(response.client_data_json).unwrap();
                response.client_data_json = format!(
                    "{},\"\\u0074ype\":\"webauthn.get\"}}",
                    raw.trim_end_matches('}')
                )
                .into_bytes();
            } else {
                let mut client: serde_json::Value =
                    serde_json::from_slice(&response.client_data_json).unwrap();
                match mutation {
                    1 => client["crossOrigin"] = serde_json::json!(true),
                    2 => client["crossOrigin"] = serde_json::Value::Null,
                    3 => {
                        client["deeplyNested"] =
                            serde_json::json!({"l1":{"l2":{"l3":{"l4":{"l5":true}}}}})
                    }
                    4 => client["challenge"] = serde_json::json!(URL_SAFE_NO_PAD.encode([9u8; 32])),
                    _ => unreachable!(),
                }
                response.client_data_json = serde_json::to_vec(&client).unwrap();
            }
            resign(&signer, &mut response);
            let expected = if mutation == 0 {
                NativeCryptoError::AuthenticationFailed
            } else if matches!(mutation, 1 | 4) {
                NativeCryptoError::ScopeMismatch
            } else {
                NativeCryptoError::InvalidInput
            };
            assert_eq!(
                binding.verify_assertion(&org(), &challenge, &response, 101),
                Err(expected)
            );
        }
        let good = assertion(
            &signer,
            &challenge,
            1,
            0x05,
            "https://accounts.example.test",
        );
        binding
            .verify_assertion(&org(), &challenge, &good, 101)
            .unwrap();
    }

    #[test]
    fn exact_android_public_facet_and_zero_counters_still_require_each_new_challenge() {
        let (_, signer) = setup();
        let facet = format!("android:apk-key-hash:{}", URL_SAFE_NO_PAD.encode([9u8; 32]));
        let key = signer.verifying_key().to_sec1_point(false);
        let mut binding = PasskeyBinding::new(
            org(),
            "accounts.example.test",
            &facet,
            b"public-fixture-credential",
            key.as_bytes(),
        )
        .unwrap();
        let first = binding.issue_challenge(&org(), 100, 30).unwrap();
        let first_response = assertion(&signer, &first, 0, 0x05, &facet);
        binding
            .verify_assertion(&org(), &first, &first_response, 101)
            .unwrap();
        let second = binding.issue_challenge(&org(), 102, 30).unwrap();
        assert_eq!(
            binding.verify_assertion(&org(), &second, &first_response, 102),
            Err(NativeCryptoError::ScopeMismatch)
        );
        let second_response = assertion(&signer, &second, 0, 0x05, &facet);
        binding
            .verify_assertion(&org(), &second, &second_response, 102)
            .unwrap();
        assert!(!admitted_origin(
            "accounts.example.test",
            &format!("android:apk-key-hash:{}", "A".repeat(513))
        ));
    }

    #[test]
    fn real_es256_verification_consumes_only_authenticated_challenges_and_counters() {
        let (mut binding, signer) = setup();
        let challenge = binding.issue_challenge(&org(), 100, 30).unwrap();
        let mut response = assertion(
            &signer,
            &challenge,
            1,
            0x05,
            "https://accounts.example.test",
        );
        response.signature_der[10] ^= 1;
        assert_eq!(
            binding.verify_assertion(&org(), &challenge, &response, 101),
            Err(NativeCryptoError::AuthenticationFailed)
        );
        let good = assertion(
            &signer,
            &challenge,
            1,
            0x05,
            "https://accounts.example.test",
        );
        binding
            .verify_assertion(&org(), &challenge, &good, 101)
            .unwrap();
        assert_eq!(
            binding.verify_assertion(&org(), &challenge, &good, 101),
            Err(NativeCryptoError::Replay)
        );
        let next = binding.issue_challenge(&org(), 102, 30).unwrap();
        let stale = assertion(&signer, &next, 1, 0x05, "https://accounts.example.test");
        assert_eq!(
            binding.verify_assertion(&org(), &next, &stale, 103),
            Err(NativeCryptoError::Replay)
        );
        let good = assertion(&signer, &next, 2, 0x05, "https://accounts.example.test");
        binding.verify_assertion(&org(), &next, &good, 103).unwrap();
    }

    #[test]
    fn universal_policy_admits_single_device_backup_eligible_and_synced_passkeys_and_refuses_invalid_flags(
    ) {
        let (mut binding, signer) = setup();
        assert_eq!(binding.backup_policy(), PasskeyBackupPolicy::Universal);
        assert_eq!(binding.last_residency_posture(), None);

        let challenge = binding.issue_challenge(&org(), 100, 30).unwrap();
        for flags in [0x00, 0x01, 0x04, 0x09, 0x15, 0x19, 0x25, 0x45, 0x85] {
            let response = assertion(
                &signer,
                &challenge,
                1,
                flags,
                "https://accounts.example.test",
            );
            assert_eq!(
                binding.verify_assertion(&org(), &challenge, &response, 101),
                Err(NativeCryptoError::AuthenticationFailed),
                "unexpected acceptance for flags 0x{flags:02x}"
            );
        }

        for (step, (flags, expected_posture)) in [
            (0x05, PasskeyResidencyPosture::SingleDeviceBound),
            (0x0d, PasskeyResidencyPosture::BackupEligibleLocal),
            (0x1d, PasskeyResidencyPosture::MultiDeviceSynced),
        ]
        .into_iter()
        .enumerate()
        {
            let now = 102 + (step as u64) * 2;
            let c = binding.issue_challenge(&org(), now, 30).unwrap();
            let resp = assertion(
                &signer,
                &c,
                (step as u32) + 1,
                flags,
                "https://accounts.example.test",
            );
            let posture = binding
                .verify_assertion_posture(&org(), &c, &resp, now + 1)
                .unwrap();
            assert_eq!(posture, expected_posture);
            assert_eq!(binding.last_residency_posture(), Some(expected_posture));
        }
    }

    #[test]
    fn strict_non_backupable_policy_scope_origin_uv_expiry_and_clock_refusals_are_real_signed_assertions(
    ) {
        let (_, signer) = setup();
        let key = signer.verifying_key().to_sec1_point(false);
        let mut binding = PasskeyBinding::with_backup_policy(
            org(),
            "accounts.example.test",
            "https://accounts.example.test",
            b"public-fixture-credential",
            key.as_bytes(),
            PasskeyBackupPolicy::StrictNonBackupable,
        )
        .unwrap();
        let challenge = binding.issue_challenge(&org(), 100, 30).unwrap();
        for flags in [0x00, 0x01, 0x04, 0x0d, 0x15, 0x1d, 0x45, 0x85] {
            let response = assertion(
                &signer,
                &challenge,
                1,
                flags,
                "https://accounts.example.test",
            );
            assert_eq!(
                binding.verify_assertion(&org(), &challenge, &response, 101),
                Err(NativeCryptoError::AuthenticationFailed)
            );
        }
        let wrong_origin = assertion(&signer, &challenge, 1, 0x05, "https://foreign.example.test");
        assert_eq!(
            binding.verify_assertion(&org(), &challenge, &wrong_origin, 101),
            Err(NativeCryptoError::ScopeMismatch)
        );
        let good = assertion(
            &signer,
            &challenge,
            1,
            0x05,
            "https://accounts.example.test",
        );
        let foreign = OrganisationId::parse("00000000-0000-4000-8000-000000000002").unwrap();
        assert_eq!(
            binding.verify_assertion(&foreign, &challenge, &good, 101),
            Err(NativeCryptoError::ScopeMismatch)
        );
        assert_eq!(
            binding.verify_assertion(&org(), &challenge, &good, 131),
            Err(NativeCryptoError::AuthenticationFailed)
        );
        assert_eq!(
            binding.verify_assertion(&org(), &challenge, &good, 101),
            Err(NativeCryptoError::EpochMismatch)
        );
        assert!(format!("{binding:?} {challenge:?} {good:?}").contains("[redacted]"));
    }

    #[test]
    fn android_credential_manager_browser_token_binding_and_cbor_ed_extensions_verify_cleanly() {
        let (_, signer) = setup();
        let key = signer.verifying_key().to_sec1_point(false);

        // 1. Real Android CredentialManager CollectedClientData with `androidPackageName` + `ED=0x80` CBOR map.
        let facet = format!("android:apk-key-hash:{}", URL_SAFE_NO_PAD.encode([7u8; 32]));
        let mut android_binding = PasskeyBinding::new(
            org(),
            "accounts.example.test",
            &facet,
            b"public-fixture-credential",
            key.as_bytes(),
        )
        .unwrap();
        let c1 = android_binding.issue_challenge(&org(), 200, 30).unwrap();
        let android_client_json = serde_json::to_vec(&serde_json::json!({
            "type": "webauthn.get",
            "challenge": c1.base64url(),
            "origin": facet,
            "androidPackageName": "io.kodera.android"
        }))
        .unwrap();
        let cred_props_cbor: &[u8] = &[
            0xa1, 0x69, b'c', b'r', b'e', b'd', b'P', b'r', b'o', b'p', b's', 0xa1, 0x62, b'r',
            b'k', 0xf5,
        ];
        let mut auth_data_ed = sha256(b"accounts.example.test").to_vec();
        auth_data_ed.push(0x9d); // UP | UV | BE | BS | ED
        auth_data_ed.extend_from_slice(&1u32.to_be_bytes());
        auth_data_ed.extend_from_slice(cred_props_cbor);
        let mut signed_ed = auth_data_ed.clone();
        signed_ed.extend_from_slice(&sha256(&android_client_json));
        let sig_ed: Signature = signer.sign(&signed_ed);
        let android_assertion = PasskeyAssertion {
            credential_id: b"public-fixture-credential".to_vec(),
            client_data_json: android_client_json,
            authenticator_data: auth_data_ed,
            signature_der: sig_ed.to_der().as_bytes().to_vec(),
        };
        let posture = android_binding
            .verify_assertion_posture(&org(), &c1, &android_assertion, 201)
            .unwrap();
        assert_eq!(posture, PasskeyResidencyPosture::MultiDeviceSynced);

        // 2. Browser CollectedClientData with `tokenBinding` object, `topOrigin`, and `clientExtensions`.
        let (mut web_binding, web_signer) = setup();
        let c2 = web_binding.issue_challenge(&org(), 300, 30).unwrap();
        let browser_client_json = serde_json::to_vec(&serde_json::json!({
            "type": "webauthn.get",
            "challenge": c2.base64url(),
            "origin": "https://accounts.example.test",
            "crossOrigin": false,
            "topOrigin": "https://accounts.example.test",
            "tokenBinding": {
                "status": "present",
                "id": "AQIDBAUGBwgJCgsMDQ4PEA"
            },
            "clientExtensions": {
                "appidExclude": false,
                "credBlob": null,
                "uvm": [[1, 2, 3]]
            }
        }))
        .unwrap();
        let mut web_auth_data = sha256(b"accounts.example.test").to_vec();
        web_auth_data.push(0x85); // UP | UV | ED
        web_auth_data.extend_from_slice(&1u32.to_be_bytes());
        web_auth_data.extend_from_slice(cred_props_cbor);
        let mut web_signed = web_auth_data.clone();
        web_signed.extend_from_slice(&sha256(&browser_client_json));
        let web_sig: Signature = web_signer.sign(&web_signed);
        let browser_assertion = PasskeyAssertion {
            credential_id: b"public-fixture-credential".to_vec(),
            client_data_json: browser_client_json,
            authenticator_data: web_auth_data,
            signature_der: web_sig.to_der().as_bytes().to_vec(),
        };
        let web_posture = web_binding
            .verify_assertion_posture(&org(), &c2, &browser_assertion, 301)
            .unwrap();
        assert_eq!(web_posture, PasskeyResidencyPosture::SingleDeviceBound);

        // 3. Malformed CBOR extension data or trailing bytes after CBOR map are rejected.
        let c3 = web_binding.issue_challenge(&org(), 302, 30).unwrap();
        let mut trailing_cbor =
            assertion(&web_signer, &c3, 2, 0x85, "https://accounts.example.test");
        trailing_cbor
            .authenticator_data
            .extend_from_slice(cred_props_cbor);
        trailing_cbor.authenticator_data.push(0x00);
        resign(&web_signer, &mut trailing_cbor);
        assert_eq!(
            web_binding.verify_assertion(&org(), &c3, &trailing_cbor, 303),
            Err(NativeCryptoError::AuthenticationFailed)
        );
    }
}
