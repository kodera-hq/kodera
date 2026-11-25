//! Zero-knowledge `KVKB1` outer envelope parser and structural admission validator.
//!
//! Servers and native/browser clients share this exact outer frame grammar:
//! - 5-byte ASCII magic `b"KVKB1"`
//! - 32-bit big-endian header byte length `1..=2048`
//! - Byte-canonical UTF-8 JSON array:
//!   `["kodera-zk-key-backup",1,organisationId,accountId,backupEpoch,kdfKind,iterations,saltB64,ivB64]`
//! - Authenticated ciphertext + 128-bit AES-GCM tag (`>= 17` bytes)
//!
//! No secret, recovery key, passphrase, or plaintext ever enters this parser.

use std::fmt;

/// Five-byte ASCII wire magic prefix of a zero-knowledge key-backup archive.
pub const KVKB1_MAGIC: &[u8; 5] = b"KVKB1";
/// Canonical domain string bound into both the outer header and AES-GCM AAD.
pub const KVKB1_DOMAIN: &str = "kodera-zk-key-backup";
/// Wire format version for `KVKB1`.
pub const KVKB1_VERSION: u8 = 1;
/// Maximum UTF-8 byte length of the outer JSON header.
pub const MAX_KVKB1_HEADER_BYTES: usize = 2048;
/// Minimum trailing payload length (`>= 1` plaintext byte + `16`-byte AES-GCM tag).
pub const MIN_KVKB1_CIPHERTEXT_BYTES: usize = 17;
/// Minimum total byte length of a structurally valid `KVKB1` capsule.
pub const MIN_KVKB1_CAPSULE_BYTES: usize = 42;
/// Maximum capsule size admitted by the server key-backup relay (`256 KiB`).
pub const MAX_RELAY_KEY_BACKUP_CAPSULE_BYTES: usize = 262_144;
/// Minimum PBKDF2-SHA-512 iteration count for passphrase-hardened capsules.
pub const MIN_KVKB1_PASSPHRASE_ITERATIONS: u32 = 600_000;
/// Maximum PBKDF2-SHA-512 iteration count for passphrase-hardened capsules.
pub const MAX_KVKB1_PASSPHRASE_ITERATIONS: u32 = 2_000_000;
/// Maximum exact IEEE-754 JSON integer (`2^53 - 1`).
pub const MAX_KVKB1_EPOCH: u64 = (1 << 53) - 1;

/// Key-derivation mode declared in the `KVKB1` header and bound in AES-GCM AAD.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyBackupKdfKind {
    RecoveryKey,
    Passphrase,
}

impl KeyBackupKdfKind {
    pub fn parse(value: &str) -> Result<Self, KeyBackupError> {
        match value {
            "recovery-key" => Ok(Self::RecoveryKey),
            "passphrase" => Ok(Self::Passphrase),
            _ => Err(KeyBackupError::InvalidKdfParameters),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::RecoveryKey => "recovery-key",
            Self::Passphrase => "passphrase",
        }
    }
}

/// Structural refusal reasons for `KVKB1` capsules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyBackupError {
    CapsuleBounds,
    InvalidMagic,
    InvalidHeader,
    InvalidPrincipal,
    InvalidEpoch,
    InvalidKdfParameters,
    InvalidEncoding,
    CiphertextTooShort,
    OrganisationMismatch,
    AccountMismatch,
    EpochMismatch,
}

impl fmt::Display for KeyBackupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let label = match self {
            Self::CapsuleBounds => "capsule size outside permitted bounds",
            Self::InvalidMagic => "missing KVKB1 magic header",
            Self::InvalidHeader => "non-canonical or malformed KVKB1 JSON header",
            Self::InvalidPrincipal => "invalid organisation or account identifier",
            Self::InvalidEpoch => "invalid backup epoch integer",
            Self::InvalidKdfParameters => "invalid KDF kind or PBKDF2 iteration count",
            Self::InvalidEncoding => "invalid salt or IV base64 encoding",
            Self::CiphertextTooShort => "ciphertext shorter than 1 byte plus 128-bit GCM tag",
            Self::OrganisationMismatch => "capsule organisationId does not match expected tenant",
            Self::AccountMismatch => "capsule accountId does not match authenticated user",
            Self::EpochMismatch => "capsule backupEpoch does not match declared epoch",
        };
        f.write_str(label)
    }
}

impl std::error::Error for KeyBackupError {}

/// Validated outer metadata and offsets of an opaque `KVKB1` archive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedKeyBackupHeader {
    pub organisation_id: String,
    pub account_id: String,
    pub backup_epoch: u64,
    pub kdf_kind: KeyBackupKdfKind,
    pub iterations: u32,
    pub salt: [u8; 16],
    pub iv: [u8; 12],
    pub aad_bytes: Vec<u8>,
    pub ciphertext_offset: usize,
    pub ciphertext_len: usize,
}

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn encode_standard_base64(input: &[u8]) -> String {
    let mut out = String::with_capacity(4 * input.len().div_ceil(3));
    let mut i = 0;
    while i < input.len() {
        let b0 = input[i];
        let b1 = if i + 1 < input.len() { input[i + 1] } else { 0 };
        let b2 = if i + 2 < input.len() { input[i + 2] } else { 0 };
        out.push(B64_ALPHABET[(b0 >> 2) as usize] as char);
        out.push(B64_ALPHABET[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if i + 1 < input.len() {
            out.push(B64_ALPHABET[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if i + 2 < input.len() {
            out.push(B64_ALPHABET[(b2 & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        i += 3;
    }
    out
}

fn b64_val(byte: u8) -> Result<u8, KeyBackupError> {
    match byte {
        b'A'..=b'Z' => Ok(byte - b'A'),
        b'a'..=b'z' => Ok(byte - b'a' + 26),
        b'0'..=b'9' => Ok(byte - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        _ => Err(KeyBackupError::InvalidEncoding),
    }
}

fn decode_standard_base64_exact<const N: usize>(encoded: &str) -> Result<[u8; N], KeyBackupError> {
    if encoded.is_empty() || encoded.len() % 4 != 0 || encoded.len() > 256 {
        return Err(KeyBackupError::InvalidEncoding);
    }
    let raw = encoded.as_bytes();
    let mut vec = Vec::with_capacity((raw.len() / 4) * 3);
    let mut idx = 0;
    while idx < raw.len() {
        let c0 = b64_val(raw[idx])?;
        let c1 = b64_val(raw[idx + 1])?;
        let pad2 = raw[idx + 2] == b'=';
        let pad3 = raw[idx + 3] == b'=';
        if pad2 && !pad3 || pad3 && idx + 4 != raw.len() {
            return Err(KeyBackupError::InvalidEncoding);
        }
        vec.push((c0 << 2) | (c1 >> 4));
        if !pad2 {
            let c2 = b64_val(raw[idx + 2])?;
            vec.push((c1 << 4) | (c2 >> 2));
            if !pad3 {
                let c3 = b64_val(raw[idx + 3])?;
                vec.push((c2 << 6) | c3);
            }
        }
        idx += 4;
    }
    if vec.len() != N || encode_standard_base64(&vec) != encoded {
        return Err(KeyBackupError::InvalidEncoding);
    }
    let mut out = [0u8; N];
    out.copy_from_slice(&vec);
    Ok(out)
}

fn is_valid_json_principal(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && value
            .bytes()
            .all(|byte| (0x21..=0x7e).contains(&byte) && byte != b'"' && byte != b'\\')
}

fn is_canonical_uuid(value: &str) -> bool {
    value.len() == 36
        && value != "00000000-0000-0000-0000-000000000000"
        && value.bytes().enumerate().all(|(idx, b)| {
            if matches!(idx, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}

fn parse_json_string(input: &str) -> Result<(&str, &str), KeyBackupError> {
    let rest = input
        .strip_prefix('"')
        .ok_or(KeyBackupError::InvalidHeader)?;
    let mut end = None;
    for (idx, byte) in rest.bytes().enumerate() {
        if byte == b'"' {
            end = Some(idx);
            break;
        }
        if byte == b'\\' || byte < 0x20 {
            return Err(KeyBackupError::InvalidHeader);
        }
    }
    let end = end.ok_or(KeyBackupError::InvalidHeader)?;
    Ok((&rest[..end], &rest[end + 1..]))
}

fn parse_json_u64(input: &str) -> Result<(u64, &str), KeyBackupError> {
    let bytes = input.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_digit() {
        return Err(KeyBackupError::InvalidHeader);
    }
    let mut len = 0;
    while len < bytes.len() && bytes[len].is_ascii_digit() {
        len += 1;
    }
    if len > 1 && bytes[0] == b'0' {
        return Err(KeyBackupError::InvalidHeader);
    }
    let value = input[..len]
        .parse::<u64>()
        .map_err(|_| KeyBackupError::InvalidHeader)?;
    Ok((value, &input[len..]))
}

/// Parses and validates the outer `KVKB1` frame without inspecting or decrypting ciphertext.
pub fn parse_kvkb1_capsule(
    capsule: &[u8],
    max_capsule_bytes: usize,
) -> Result<ParsedKeyBackupHeader, KeyBackupError> {
    if capsule.len() < MIN_KVKB1_CAPSULE_BYTES || capsule.len() > max_capsule_bytes {
        return Err(KeyBackupError::CapsuleBounds);
    }
    if &capsule[0..5] != KVKB1_MAGIC {
        return Err(KeyBackupError::InvalidMagic);
    }
    let header_len = u32::from_be_bytes([capsule[5], capsule[6], capsule[7], capsule[8]]) as usize;
    if !(1..=MAX_KVKB1_HEADER_BYTES).contains(&header_len) {
        return Err(KeyBackupError::InvalidHeader);
    }
    let ciphertext_offset = 9 + header_len;
    if capsule.len() < ciphertext_offset {
        return Err(KeyBackupError::InvalidHeader);
    }
    let ciphertext_len = capsule.len() - ciphertext_offset;
    if ciphertext_len < MIN_KVKB1_CIPHERTEXT_BYTES {
        return Err(KeyBackupError::CiphertextTooShort);
    }
    let header_bytes = &capsule[9..ciphertext_offset];
    let header_str =
        std::str::from_utf8(header_bytes).map_err(|_| KeyBackupError::InvalidHeader)?;

    let cursor = header_str
        .strip_prefix('[')
        .ok_or(KeyBackupError::InvalidHeader)?;
    let (domain, cursor) = parse_json_string(cursor)?;
    if domain != KVKB1_DOMAIN {
        return Err(KeyBackupError::InvalidHeader);
    }
    let cursor = cursor
        .strip_prefix(',')
        .ok_or(KeyBackupError::InvalidHeader)?;
    let (version, cursor) = parse_json_u64(cursor)?;
    if version != u64::from(KVKB1_VERSION) {
        return Err(KeyBackupError::InvalidHeader);
    }
    let cursor = cursor
        .strip_prefix(',')
        .ok_or(KeyBackupError::InvalidHeader)?;
    let (org_id, cursor) = parse_json_string(cursor)?;
    let cursor = cursor
        .strip_prefix(',')
        .ok_or(KeyBackupError::InvalidHeader)?;
    let (account_id, cursor) = parse_json_string(cursor)?;
    if !is_valid_json_principal(org_id) || !is_valid_json_principal(account_id) {
        return Err(KeyBackupError::InvalidPrincipal);
    }
    let cursor = cursor
        .strip_prefix(',')
        .ok_or(KeyBackupError::InvalidHeader)?;
    let (backup_epoch, cursor) = parse_json_u64(cursor)?;
    if !(1..=MAX_KVKB1_EPOCH).contains(&backup_epoch) {
        return Err(KeyBackupError::InvalidEpoch);
    }
    let cursor = cursor
        .strip_prefix(',')
        .ok_or(KeyBackupError::InvalidHeader)?;
    let (kdf_raw, cursor) = parse_json_string(cursor)?;
    let kdf_kind = KeyBackupKdfKind::parse(kdf_raw)?;
    let cursor = cursor
        .strip_prefix(',')
        .ok_or(KeyBackupError::InvalidHeader)?;
    let (iterations_u64, cursor) = parse_json_u64(cursor)?;
    let iterations =
        u32::try_from(iterations_u64).map_err(|_| KeyBackupError::InvalidKdfParameters)?;
    match kdf_kind {
        KeyBackupKdfKind::RecoveryKey => {
            if iterations != 0 {
                return Err(KeyBackupError::InvalidKdfParameters);
            }
        }
        KeyBackupKdfKind::Passphrase => {
            if !(MIN_KVKB1_PASSPHRASE_ITERATIONS..=MAX_KVKB1_PASSPHRASE_ITERATIONS)
                .contains(&iterations)
            {
                return Err(KeyBackupError::InvalidKdfParameters);
            }
        }
    }
    let cursor = cursor
        .strip_prefix(',')
        .ok_or(KeyBackupError::InvalidHeader)?;
    let (salt_b64, cursor) = parse_json_string(cursor)?;
    let cursor = cursor
        .strip_prefix(',')
        .ok_or(KeyBackupError::InvalidHeader)?;
    let (iv_b64, cursor) = parse_json_string(cursor)?;
    if cursor != "]" {
        return Err(KeyBackupError::InvalidHeader);
    }
    let salt = decode_standard_base64_exact::<16>(salt_b64)?;
    let iv = decode_standard_base64_exact::<12>(iv_b64)?;

    let canonical_aad = format!(
        "[\"{}\",{},{:?},{:?},{},\"{}\",{}]",
        KVKB1_DOMAIN,
        KVKB1_VERSION,
        org_id,
        account_id,
        backup_epoch,
        kdf_kind.as_str(),
        iterations,
    );
    let canonical_header = format!(
        "[\"{}\",{},{:?},{:?},{},\"{}\",{},\"{}\",\"{}\"]",
        KVKB1_DOMAIN,
        KVKB1_VERSION,
        org_id,
        account_id,
        backup_epoch,
        kdf_kind.as_str(),
        iterations,
        salt_b64,
        iv_b64,
    );
    if canonical_header.as_bytes() != header_bytes {
        return Err(KeyBackupError::InvalidHeader);
    }

    Ok(ParsedKeyBackupHeader {
        organisation_id: org_id.to_owned(),
        account_id: account_id.to_owned(),
        backup_epoch,
        kdf_kind,
        iterations,
        salt,
        iv,
        aad_bytes: canonical_aad.into_bytes(),
        ciphertext_offset,
        ciphertext_len,
    })
}

/// Validates a `KVKB1` archive against server relay admission bounds and exact UUID bindings.
pub fn validate_relay_kvkb1_capsule(
    capsule: &[u8],
    expected_organisation_id: &str,
    expected_account_id: &str,
    expected_epoch: u64,
) -> Result<ParsedKeyBackupHeader, KeyBackupError> {
    if !is_canonical_uuid(expected_organisation_id) || !is_canonical_uuid(expected_account_id) {
        return Err(KeyBackupError::InvalidPrincipal);
    }
    if !(1..=MAX_KVKB1_EPOCH).contains(&expected_epoch) {
        return Err(KeyBackupError::InvalidEpoch);
    }
    let parsed = parse_kvkb1_capsule(capsule, MAX_RELAY_KEY_BACKUP_CAPSULE_BYTES)?;
    if !is_canonical_uuid(&parsed.organisation_id) || !is_canonical_uuid(&parsed.account_id) {
        return Err(KeyBackupError::InvalidPrincipal);
    }
    if parsed.organisation_id != expected_organisation_id {
        return Err(KeyBackupError::OrganisationMismatch);
    }
    if parsed.account_id != expected_account_id {
        return Err(KeyBackupError::AccountMismatch);
    }
    if parsed.backup_epoch != expected_epoch {
        return Err(KeyBackupError::EpochMismatch);
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORG_ID: &str = "01950000-0000-7000-8000-0000000000a1";
    const USER_ID: &str = "01950000-0000-7000-8000-0000000000b1";

    fn build_capsule(header_json: &str, ciphertext: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(9 + header_json.len() + ciphertext.len());
        out.extend_from_slice(KVKB1_MAGIC);
        out.extend_from_slice(&(header_json.len() as u32).to_be_bytes());
        out.extend_from_slice(header_json.as_bytes());
        out.extend_from_slice(ciphertext);
        out
    }

    #[test]
    fn parses_recovery_key_and_passphrase_capsules_and_enforces_relay_bindings() {
        let salt_b64 =
            encode_standard_base64(&[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        let iv_b64 = encode_standard_base64(&[16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]);
        let recovery_header = format!(
            "[\"kodera-zk-key-backup\",1,\"{ORG_ID}\",\"{USER_ID}\",1,\"recovery-key\",0,\"{salt_b64}\",\"{iv_b64}\"]"
        );
        let capsule = build_capsule(&recovery_header, &[0xaa; 32]);
        let parsed = validate_relay_kvkb1_capsule(&capsule, ORG_ID, USER_ID, 1).unwrap();
        assert_eq!(parsed.kdf_kind, KeyBackupKdfKind::RecoveryKey);
        assert_eq!(parsed.iterations, 0);
        assert_eq!(parsed.backup_epoch, 1);
        assert_eq!(parsed.ciphertext_len, 32);

        let pass_header = format!(
            "[\"kodera-zk-key-backup\",1,\"{ORG_ID}\",\"{USER_ID}\",2,\"passphrase\",600000,\"{salt_b64}\",\"{iv_b64}\"]"
        );
        let pass_capsule = build_capsule(&pass_header, &[0xbb; 17]);
        let parsed_pass = validate_relay_kvkb1_capsule(&pass_capsule, ORG_ID, USER_ID, 2).unwrap();
        assert_eq!(parsed_pass.kdf_kind, KeyBackupKdfKind::Passphrase);
        assert_eq!(parsed_pass.iterations, 600_000);
        assert_eq!(parsed_pass.ciphertext_len, 17);

        assert_eq!(
            validate_relay_kvkb1_capsule(
                &capsule,
                "01950000-0000-7000-8000-0000000000ff",
                USER_ID,
                1
            ),
            Err(KeyBackupError::OrganisationMismatch)
        );
        assert_eq!(
            validate_relay_kvkb1_capsule(
                &capsule,
                ORG_ID,
                "01950000-0000-7000-8000-0000000000ff",
                1
            ),
            Err(KeyBackupError::AccountMismatch)
        );
        assert_eq!(
            validate_relay_kvkb1_capsule(&capsule, ORG_ID, USER_ID, 2),
            Err(KeyBackupError::EpochMismatch)
        );
    }

    #[test]
    fn refuses_malformed_magic_whitespace_kdf_iterations_salt_iv_and_truncated_tags() {
        let salt_b64 = "AAECAwQFBgcICQoLDA0ODw==";
        let iv_b64 = "EBESExQVFhcYGRob";
        let valid_header = format!(
            "[\"kodera-zk-key-backup\",1,\"{ORG_ID}\",\"{USER_ID}\",1,\"recovery-key\",0,\"{salt_b64}\",\"{iv_b64}\"]"
        );
        let mut bad_magic = build_capsule(&valid_header, &[0xaa; 17]);
        bad_magic[4] = b'2';
        assert_eq!(
            parse_kvkb1_capsule(&bad_magic, MAX_RELAY_KEY_BACKUP_CAPSULE_BYTES),
            Err(KeyBackupError::InvalidMagic)
        );

        let too_short_ct = build_capsule(&valid_header, &[0xaa; 16]);
        assert_eq!(
            parse_kvkb1_capsule(&too_short_ct, MAX_RELAY_KEY_BACKUP_CAPSULE_BYTES),
            Err(KeyBackupError::CiphertextTooShort)
        );

        let non_canonical = format!(
            "[ \"kodera-zk-key-backup\",1,\"{ORG_ID}\",\"{USER_ID}\",1,\"recovery-key\",0,\"{salt_b64}\",\"{iv_b64}\"]"
        );
        assert_eq!(
            parse_kvkb1_capsule(
                &build_capsule(&non_canonical, &[0xaa; 17]),
                MAX_RELAY_KEY_BACKUP_CAPSULE_BYTES
            ),
            Err(KeyBackupError::InvalidHeader)
        );

        for bad_kdf in [
            format!(
                "[\"kodera-zk-key-backup\",1,\"{ORG_ID}\",\"{USER_ID}\",1,\"recovery-key\",1,\"{salt_b64}\",\"{iv_b64}\"]"
            ),
            format!(
                "[\"kodera-zk-key-backup\",1,\"{ORG_ID}\",\"{USER_ID}\",1,\"passphrase\",599999,\"{salt_b64}\",\"{iv_b64}\"]"
            ),
            format!(
                "[\"kodera-zk-key-backup\",1,\"{ORG_ID}\",\"{USER_ID}\",1,\"passphrase\",2000001,\"{salt_b64}\",\"{iv_b64}\"]"
            ),
            format!(
                "[\"kodera-zk-key-backup\",1,\"{ORG_ID}\",\"{USER_ID}\",1,\"argon2\",600000,\"{salt_b64}\",\"{iv_b64}\"]"
            ),
        ] {
            assert_eq!(
                parse_kvkb1_capsule(
                    &build_capsule(&bad_kdf, &[0xaa; 17]),
                    MAX_RELAY_KEY_BACKUP_CAPSULE_BYTES
                ),
                Err(KeyBackupError::InvalidKdfParameters)
            );
        }

        let bad_salt = format!(
            "[\"kodera-zk-key-backup\",1,\"{ORG_ID}\",\"{USER_ID}\",1,\"recovery-key\",0,\"EBESExQVFhcYGRob\",\"{iv_b64}\"]"
        );
        assert_eq!(
            parse_kvkb1_capsule(
                &build_capsule(&bad_salt, &[0xaa; 17]),
                MAX_RELAY_KEY_BACKUP_CAPSULE_BYTES
            ),
            Err(KeyBackupError::InvalidEncoding)
        );
    }

    #[cfg(feature = "openmls-engine")]
    #[test]
    fn matches_golden_kvkb1_v1_vectors() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        use serde_json::Value;

        let raw = include_str!("../vectors/kvkb1-v1.json");
        let doc: Value = serde_json::from_str(raw).unwrap();
        assert_eq!(doc["version"], 1);
        for item in doc["valid"].as_array().unwrap() {
            let bytes = STANDARD
                .decode(item["capsuleBase64"].as_str().unwrap())
                .unwrap();
            let org = item["organisationId"].as_str().unwrap();
            let user = item["accountId"].as_str().unwrap();
            let epoch = item["backupEpoch"].as_u64().unwrap();
            let parsed = validate_relay_kvkb1_capsule(&bytes, org, user, epoch).unwrap();
            assert_eq!(parsed.kdf_kind.as_str(), item["kdfKind"].as_str().unwrap());
            assert_eq!(
                u64::from(parsed.iterations),
                item["iterations"].as_u64().unwrap()
            );
            assert_eq!(
                std::str::from_utf8(&parsed.aad_bytes).unwrap(),
                item["aadJson"].as_str().unwrap()
            );
        }
        for bad in doc["invalid"].as_array().unwrap() {
            let bytes = STANDARD
                .decode(bad["capsuleBase64"].as_str().unwrap())
                .unwrap();
            let org = bad["organisationId"].as_str().unwrap();
            let user = bad["accountId"].as_str().unwrap();
            let epoch = bad["backupEpoch"].as_u64().unwrap();
            assert!(
                validate_relay_kvkb1_capsule(&bytes, org, user, epoch).is_err(),
                "expected refusal for vector {}",
                bad["name"]
            );
        }
    }
}
