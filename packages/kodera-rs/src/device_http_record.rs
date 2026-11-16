//! Closed structural KDH1/KDA2 codecs. Parsing is not native or HTTP authority.
//! Native signatures, pending HPKE ownership and live host fences are checked by their owners.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::fmt;

pub const MAX_DEVICE_HTTP_RECORD_BYTES: usize = 65_536;
pub const MAX_DEVICE_HTTP_BODY_BYTES: usize = 32_768;
pub const DEVICE_HTTP_ACK_BYTES: usize = 276;
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const MAX_BODY_BASE64: usize = 43_692;
const RETRY_HORIZON_MS: u64 = 86_400_000;
pub type DeviceHttpScope = [String; 4];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeviceHttpRecordError;
impl fmt::Display for DeviceHttpRecordError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("invalid device HTTP record")
    }
}
impl std::error::Error for DeviceHttpRecordError {}
type Result<T> = std::result::Result<T, DeviceHttpRecordError>;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DeviceHttpRecord {
    pub version: u8,
    pub record_id: String,
    pub scope: DeviceHttpScope,
    pub native_generation: u64,
    pub sealed_sha256: String,
    pub admission: Option<DeviceHttpAdmission>,
    pub pending: Option<DeviceHttpPending>,
    pub publication: Option<DeviceHttpPublication>,
}
impl fmt::Debug for DeviceHttpRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DeviceHttpRecord([redacted])")
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DeviceHttpAdmission {
    pub operation_id: String,
    pub body_sha256: String,
    pub device_id: String,
    pub response_sha256: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeviceHttpOperation {
    #[serde(rename = "register")]
    Register,
    #[serde(rename = "publish-package")]
    PublishPackage,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceHttpPhase {
    Prepared,
    Attempted,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DeviceHttpPending {
    pub operation: DeviceHttpOperation,
    pub operation_id: String,
    pub body_base64: String,
    pub body_sha256: String,
    pub native_package_id: Option<String>,
    pub package_wire_sha256: Option<String>,
    pub phase: DeviceHttpPhase,
    pub recovery_spent: u8,
    pub first_attempt_at_ms: Option<u64>,
    pub retry_before_ms: Option<u64>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DeviceHttpPublication {
    pub operation_id: String,
    pub native_package_id: String,
    pub body_sha256: String,
    pub core_package_id: String,
    pub package_wire_sha256: String,
    pub expires_at: String,
    pub response_sha256: String,
}

fn require(condition: bool) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(DeviceHttpRecordError)
    }
}
fn positive(value: u64) -> Result<()> {
    require((1..=MAX_SAFE_INTEGER).contains(&value))
}
fn uuid(value: &str) -> Result<()> {
    require(value.len() == 36 && value != "00000000-0000-0000-0000-000000000000")?;
    require(value.bytes().enumerate().all(|(at, b)| {
        if matches!(at, 8 | 13 | 18 | 23) {
            b == b'-'
        } else {
            b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
        }
    }))
}
fn hex32(value: &str) -> Result<()> {
    require(
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
    )
}
fn scope(value: &DeviceHttpScope) -> Result<()> {
    for id in &value[..3] {
        uuid(id)?;
    }
    hex32(&value[3])
}
fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        result.push(DIGITS[(b >> 4) as usize] as char);
        result.push(DIGITS[(b & 15) as usize] as char);
    }
    result
}
fn raw_hex(value: &str) -> Result<[u8; 32]> {
    hex32(value)?;
    let mut bytes = [0; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let digit = |b: u8| if b <= b'9' { b - b'0' } else { b - b'a' + 10 };
        bytes[index] = digit(pair[0]) * 16 + digit(pair[1]);
    }
    Ok(bytes)
}

// Bounded RFC3339 syntax/calendar parsing, retaining the original response spelling.
// Seconds=60 is admitted only at a possible UTC leap boundary, never as overflow.
fn rfc3339(value: &str) -> Result<()> {
    let b = value.as_bytes();
    require((20..=64).contains(&b.len()) && b.is_ascii())?;
    require(
        b[4] == b'-'
            && b[7] == b'-'
            && matches!(b[10], b'T' | b't')
            && b[13] == b':'
            && b[16] == b':',
    )?;
    let number = |start: usize, end: usize| -> Result<u32> {
        require(b[start..end].iter().all(u8::is_ascii_digit))?;
        Ok(b[start..end]
            .iter()
            .fold(0, |n, d| n * 10 + u32::from(d - b'0')))
    };
    let year = number(0, 4)?;
    let month = number(5, 7)?;
    let day = number(8, 10)?;
    let hour = number(11, 13)?;
    let minute = number(14, 16)?;
    let second = number(17, 19)?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    require(day >= 1 && day <= days && hour <= 23 && minute <= 59 && second <= 60)?;
    let mut at = 19;
    if b.get(at) == Some(&b'.') {
        at += 1;
        let first = at;
        while b.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        require(at > first)?;
    }
    let offset = match b.get(at) {
        Some(b'Z' | b'z') => {
            require(at + 1 == b.len())?;
            0i32
        }
        Some(b'+' | b'-') => {
            require(at + 6 == b.len() && b[at + 3] == b':')?;
            let h = number(at + 1, at + 3)?;
            let m = number(at + 4, at + 6)?;
            require(h <= 23 && m <= 59)?;
            let sign = if b[at] == b'+' { 1 } else { -1 };
            sign * (h * 60 + m) as i32
        }
        _ => return Err(DeviceHttpRecordError),
    };
    if second == 60 {
        let utc = hour as i32 * 60 + minute as i32 - offset;
        // A UTC leap second is 23:59 on June 30 or December 31. Offset may cross a date.
        let possible = (utc == 1439 && matches!((month, day), (6, 30) | (12, 31)))
            || (utc == -1 && matches!((month, day), (7, 1) | (1, 1)));
        require(possible)?;
    }
    Ok(())
}

impl DeviceHttpRecord {
    fn validate(&self) -> Result<()> {
        require(self.version == 1)?;
        uuid(&self.record_id)?;
        scope(&self.scope)?;
        positive(self.native_generation)?;
        hex32(&self.sealed_sha256)?;
        if let Some(a) = &self.admission {
            uuid(&a.operation_id)?;
            hex32(&a.body_sha256)?;
            uuid(&a.device_id)?;
            hex32(&a.response_sha256)?;
        }
        if let Some(p) = &self.pending {
            require(self.publication.is_none())?;
            uuid(&p.operation_id)?;
            hex32(&p.body_sha256)?;
            require(!p.body_base64.is_empty() && p.body_base64.len() <= MAX_BODY_BASE64)?;
            // Bound the decoded allocation before asking the decoder to allocate.
            require(p.body_base64.len() % 4 == 0)?;
            let padding = p
                .body_base64
                .bytes()
                .rev()
                .take_while(|b| *b == b'=')
                .count();
            require(
                padding <= 2 && p.body_base64.len() / 4 * 3 - padding <= MAX_DEVICE_HTTP_BODY_BYTES,
            )?;
            let mut body = vec![0; p.body_base64.len() / 4 * 3 - padding];
            let written = STANDARD
                .decode_slice(&p.body_base64, &mut body)
                .map_err(|_| DeviceHttpRecordError)?;
            require(written == body.len())?;
            require(
                !body.is_empty()
                    && body.len() <= MAX_DEVICE_HTTP_BODY_BYTES
                    && STANDARD.encode(&body) == p.body_base64,
            )?;
            require(hex(&crate::sha256(&body)) == p.body_sha256)?;
            match p.operation {
                DeviceHttpOperation::Register => require(
                    self.admission.is_none()
                        && p.native_package_id.is_none()
                        && p.package_wire_sha256.is_none(),
                )?,
                DeviceHttpOperation::PublishPackage => {
                    require(self.admission.is_some())?;
                    hex32(
                        p.native_package_id
                            .as_deref()
                            .ok_or(DeviceHttpRecordError)?,
                    )?;
                    hex32(
                        p.package_wire_sha256
                            .as_deref()
                            .ok_or(DeviceHttpRecordError)?,
                    )?;
                }
            }
            require(p.recovery_spent <= 1)?;
            match (p.phase, p.first_attempt_at_ms, p.retry_before_ms) {
                (DeviceHttpPhase::Prepared, None, None) => require(p.recovery_spent == 0)?,
                (DeviceHttpPhase::Attempted, Some(first), Some(last)) => {
                    let limit = first
                        .checked_add(RETRY_HORIZON_MS)
                        .filter(|v| *v <= MAX_SAFE_INTEGER)
                        .ok_or(DeviceHttpRecordError)?;
                    require(first <= last && last <= limit)?;
                }
                _ => return Err(DeviceHttpRecordError),
            }
        }
        if let Some(p) = &self.publication {
            require(self.admission.is_some())?;
            uuid(&p.operation_id)?;
            hex32(&p.native_package_id)?;
            hex32(&p.body_sha256)?;
            uuid(&p.core_package_id)?;
            hex32(&p.package_wire_sha256)?;
            rfc3339(&p.expires_at)?;
            hex32(&p.response_sha256)?;
        }
        Ok(())
    }

    /// Authoritative field-order serialization. Public proof/HPKE validation is separate.
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let json = serde_json::to_vec(self).map_err(|_| DeviceHttpRecordError)?;
        require(json.len() <= MAX_DEVICE_HTTP_RECORD_BYTES - 8)?;
        let mut result = Vec::with_capacity(8 + json.len());
        result.extend_from_slice(b"KDH1");
        result.extend_from_slice(&(json.len() as u32).to_be_bytes());
        result.extend_from_slice(&json);
        Ok(result)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        require(
            (8..=MAX_DEVICE_HTTP_RECORD_BYTES).contains(&bytes.len()) && &bytes[..4] == b"KDH1",
        )?;
        let len =
            u32::from_be_bytes(bytes[4..8].try_into().map_err(|_| DeviceHttpRecordError)?) as usize;
        require(len == bytes.len() - 8)?;
        let record: Self =
            serde_json::from_slice(&bytes[8..]).map_err(|_| DeviceHttpRecordError)?;
        require(record.encode()?.as_slice() == bytes)?;
        Ok(record)
    }

    /// This verifies supplied structural bindings; it cannot authenticate a sealed state.
    pub fn validate_binding(
        &self,
        expected_scope: &DeviceHttpScope,
        native: u64,
        host: u64,
        sealed: &str,
    ) -> Result<()> {
        self.validate()?;
        positive(native)?;
        positive(host)?;
        scope(expected_scope)?;
        hex32(sealed)?;
        require(
            host >= native
                && self.native_generation == native
                && &self.scope == expected_scope
                && self.sealed_sha256 == sealed,
        )
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct DeviceHttpAck {
    pub scope: DeviceHttpScope,
    pub record_id: String,
    pub expected_native_generation: u64,
    pub next_native_generation: u64,
    pub expected_host_generation: u64,
    pub next_host_generation: u64,
    pub sealed_sha256: String,
    pub record_sha256: String,
}
impl fmt::Debug for DeviceHttpAck {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DeviceHttpAck([redacted])")
    }
}
impl DeviceHttpAck {
    fn validate(&self) -> Result<()> {
        scope(&self.scope)?;
        uuid(&self.record_id)?;
        hex32(&self.sealed_sha256)?;
        hex32(&self.record_sha256)?;
        for n in [
            self.expected_native_generation,
            self.next_native_generation,
            self.expected_host_generation,
            self.next_host_generation,
        ] {
            positive(n)?;
        }
        require(
            self.expected_host_generation >= self.expected_native_generation
                && self.next_host_generation >= self.next_native_generation,
        )?;
        require(self.expected_host_generation.checked_add(1) == Some(self.next_host_generation))?;
        require(
            self.next_native_generation == self.expected_native_generation
                || self.expected_native_generation.checked_add(1)
                    == Some(self.next_native_generation),
        )
    }
    pub fn encode(&self) -> Result<[u8; DEVICE_HTTP_ACK_BYTES]> {
        self.validate()?;
        let mut bytes = [0; DEVICE_HTTP_ACK_BYTES];
        let mut at = 0;
        let mut put = |value: &[u8]| {
            bytes[at..at + value.len()].copy_from_slice(value);
            at += value.len();
        };
        put(b"KDA2");
        for id in &self.scope[..3] {
            put(id.as_bytes());
        }
        put(&raw_hex(&self.scope[3])?);
        put(self.record_id.as_bytes());
        for n in [
            self.expected_native_generation,
            self.next_native_generation,
            self.expected_host_generation,
            self.next_host_generation,
        ] {
            put(&n.to_be_bytes());
        }
        put(&raw_hex(&self.sealed_sha256)?);
        put(&raw_hex(&self.record_sha256)?);
        Ok(bytes)
    }
    #[cfg(test)]
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        require(bytes.len() == DEVICE_HTTP_ACK_BYTES && &bytes[..4] == b"KDA2")?;
        let text = |start: usize, end: usize| {
            std::str::from_utf8(&bytes[start..end])
                .map(str::to_owned)
                .map_err(|_| DeviceHttpRecordError)
        };
        let integer = |start: usize| -> Result<u64> {
            Ok(u64::from_be_bytes(
                bytes[start..start + 8]
                    .try_into()
                    .map_err(|_| DeviceHttpRecordError)?,
            ))
        };
        let value = Self {
            scope: [
                text(4, 40)?,
                text(40, 76)?,
                text(76, 112)?,
                hex(&bytes[112..144]),
            ],
            record_id: text(144, 180)?,
            expected_native_generation: integer(180)?,
            next_native_generation: integer(188)?,
            expected_host_generation: integer(196)?,
            next_host_generation: integer(204)?,
            sealed_sha256: hex(&bytes[212..244]),
            record_sha256: hex(&bytes[244..276]),
        };
        value.validate()?;
        Ok(value)
    }
    /// Compare the entire reply with an independently owned expected transition.
    pub fn verify(bytes: &[u8], expected: &Self) -> Result<()> {
        require(bytes == expected.encode()?.as_slice())
    }
}

#[cfg(test)]
#[path = "device_http_record_tests.rs"]
mod tests;
