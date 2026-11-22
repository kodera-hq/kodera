//! OS Keychain session slot naming, non-secret metadata contract, and persistent backend bridge.
//!
//! Security invariants:
//! - Every OS keychain item is scoped under `io.kodera.desktop.<kind>` and an organisation-bound
//!   account key `org:<organisation_uuid>:user:<matrix_user_id>` so multi-workspace credentials
//!   never collide or bleed across organisations.
//! - Raw session tokens wrapped in [`RedactedSessionSecret`] unconditionally format as
//!   `[REDACTED]` in `Debug` and `Display`, overwrite their backing byte buffer on drop, and are
//!   never echoed in [`KeychainError`] diagnostics or passed on CLI `argv`.
//! - Metadata validation refuses any payload where a caller accidentally copied secret material
//!   into public metadata fields (`device_id`, `matrix_user_id`, or slot identifiers).
//! - Window close and process exit (`clear_ram_cache`) zeroize in-RAM cached secrets while
//!   preserving persistent OS keychain slots; explicit logout (`delete_credential` or
//!   `clear_organisation`) removes persistent OS keychain entries and index records.

use core::fmt;
use kodera_rs::{validate_docs_host, OrganisationId};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use zeroize::Zeroize;

mod os_backend;
#[cfg(test)]
mod tests;

pub use os_backend::{
    default_keychain_index_path, OsKeychainExecOutput, OsKeychainProcessRunner,
    OsNativeKeychainBackend, StdOsKeychainProcessRunner, DEFAULT_OS_KEYCHAIN_TIMEOUT_MS,
    MAX_KEYCHAIN_INDEX_BYTES, MAX_MACOS_SECURITY_INTERACTIVE_LINE_BYTES,
};

/// Canonical reverse-DNS prefix for all Kodera Desktop keychain services.
pub const KEYCHAIN_SERVICE_NAMESPACE: &str = "io.kodera.desktop";

/// Minimum byte length for session tokens admitted to OS keychain storage.
pub const MIN_KEYCHAIN_SECRET_BYTES: usize = 16;

/// Maximum byte length for session tokens admitted to OS keychain storage (bounded safely below
/// Apple `security -i` interactive line limits).
pub const MAX_KEYCHAIN_SECRET_BYTES: usize = 3584;

/// Maximum UTF-8 byte length of a keychain `service` identifier.
pub const MAX_KEYCHAIN_SERVICE_BYTES: usize = 128;

/// Maximum UTF-8 byte length of a keychain `account` identifier.
pub const MAX_KEYCHAIN_ACCOUNT_BYTES: usize = 255;

/// Upper bound on stored credential slots per organisation session.
pub const MAX_KEYCHAIN_SLOTS_PER_ORG: usize = 32;

/// Closed refusal codes for keychain slot naming, secret wrapping, metadata validation, and
/// OS keychain backend operations. Carries zero raw token or untrusted input excerpts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeychainError {
    InvalidOrganisation,
    InvalidSecretKind,
    InvalidServiceIdentifier,
    InvalidAccountIdentifier,
    InvalidMatrixUserId,
    InvalidHomeserverDomain,
    InvalidDeviceId,
    InvalidExpiryWindow,
    SecretTooShort,
    SecretTooLarge,
    SecretInvalidCharacters,
    SecretLeakedInMetadata,
    CapacityExceeded,
    BackendTimeout,
    BackendUnavailable,
    BackendFailure,
}

impl fmt::Display for KeychainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            Self::InvalidOrganisation => "invalid_organisation",
            Self::InvalidSecretKind => "invalid_secret_kind",
            Self::InvalidServiceIdentifier => "invalid_service_identifier",
            Self::InvalidAccountIdentifier => "invalid_account_identifier",
            Self::InvalidMatrixUserId => "invalid_matrix_user_id",
            Self::InvalidHomeserverDomain => "invalid_homeserver_domain",
            Self::InvalidDeviceId => "invalid_device_id",
            Self::InvalidExpiryWindow => "invalid_expiry_window",
            Self::SecretTooShort => "secret_too_short",
            Self::SecretTooLarge => "secret_too_large",
            Self::SecretInvalidCharacters => "secret_invalid_characters",
            Self::SecretLeakedInMetadata => "secret_leaked_in_metadata",
            Self::CapacityExceeded => "capacity_exceeded",
            Self::BackendTimeout => "backend_timeout",
            Self::BackendUnavailable => "backend_unavailable",
            Self::BackendFailure => "backend_failure",
        };
        f.write_str(code)
    }
}

impl std::error::Error for KeychainError {}

/// Distinct credential classes stored in the platform OS keychain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeychainSecretKind {
    MatrixSession,
    OidcRefresh,
    MlsStoreKey,
}

impl KeychainSecretKind {
    pub fn parse(raw: &str) -> Result<Self, KeychainError> {
        match raw {
            "matrix-session" => Ok(Self::MatrixSession),
            "oidc-refresh" => Ok(Self::OidcRefresh),
            "mls-store-key" => Ok(Self::MlsStoreKey),
            _ => Err(KeychainError::InvalidSecretKind),
        }
    }

    pub const fn as_slug(self) -> &'static str {
        match self {
            Self::MatrixSession => "matrix-session",
            Self::OidcRefresh => "oidc-refresh",
            Self::MlsStoreKey => "mls-store-key",
        }
    }

    pub fn service_name(self) -> String {
        format!("{KEYCHAIN_SERVICE_NAMESPACE}.{}", self.as_slug())
    }
}

/// Storage durability tier achieved by a [`KeychainBackend`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeychainPersistence {
    NativeOsKeychain,
    EphemeralFallback,
}

impl KeychainPersistence {
    pub const fn is_native_keychain(self) -> bool {
        matches!(self, Self::NativeOsKeychain)
    }
}

/// Validated `(service, account)` coordinates for a platform OS keychain entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeychainSlotDescriptor {
    pub secret_kind: KeychainSecretKind,
    pub service_name: String,
    pub account_name: String,
}

/// Validates a canonical Kodera keychain `service` identifier (`io.kodera.desktop.<kind>`).
pub fn validate_keychain_service_id(service: &str) -> Result<KeychainSecretKind, KeychainError> {
    if service.is_empty() || service.len() > MAX_KEYCHAIN_SERVICE_BYTES || !service.is_ascii() {
        return Err(KeychainError::InvalidServiceIdentifier);
    }
    if service
        .bytes()
        .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
    {
        return Err(KeychainError::InvalidServiceIdentifier);
    }
    let Some(suffix) = service.strip_prefix("io.kodera.desktop.") else {
        return Err(KeychainError::InvalidServiceIdentifier);
    };
    KeychainSecretKind::parse(suffix).map_err(|_| KeychainError::InvalidServiceIdentifier)
}

/// Validates a canonical organisation-scoped keychain `account` identifier
/// (`org:<organisation_uuid>:user:@<localpart>:<domain>`).
pub fn validate_keychain_account_id(
    account: &str,
) -> Result<(OrganisationId, String, String), KeychainError> {
    if account.is_empty() || account.len() > MAX_KEYCHAIN_ACCOUNT_BYTES || !account.is_ascii() {
        return Err(KeychainError::InvalidAccountIdentifier);
    }
    if account
        .bytes()
        .any(|b| b.is_ascii_control() || b.is_ascii_whitespace() || matches!(b, b'/' | b'\\'))
        || account.contains("..")
    {
        return Err(KeychainError::InvalidAccountIdentifier);
    }
    let Some(rest) = account.strip_prefix("org:") else {
        return Err(KeychainError::InvalidAccountIdentifier);
    };
    let Some((org_raw, matrix_user_raw)) = rest.split_once(":user:") else {
        return Err(KeychainError::InvalidAccountIdentifier);
    };
    let org_id =
        OrganisationId::parse(org_raw).map_err(|_| KeychainError::InvalidAccountIdentifier)?;
    let (_, domain) = parse_canonical_matrix_user_id(matrix_user_raw)
        .map_err(|_| KeychainError::InvalidAccountIdentifier)?;
    Ok((org_id, matrix_user_raw.to_owned(), domain.to_owned()))
}

/// Builds and validates a deterministic [`KeychainSlotDescriptor`] for an organisation member.
pub fn build_keychain_slot(
    secret_kind: KeychainSecretKind,
    organisation_id: &str,
    matrix_user_id: &str,
) -> Result<KeychainSlotDescriptor, KeychainError> {
    let org =
        OrganisationId::parse(organisation_id).map_err(|_| KeychainError::InvalidOrganisation)?;
    let _ = parse_canonical_matrix_user_id(matrix_user_id)?;
    let service_name = secret_kind.service_name();
    let account_name = format!("org:{}:user:{matrix_user_id}", org.as_str());
    validate_keychain_service_id(&service_name)?;
    validate_keychain_account_id(&account_name)?;
    Ok(KeychainSlotDescriptor {
        secret_kind,
        service_name,
        account_name,
    })
}

/// Ephemeral session token wrapper whose `Debug` and `Display` implementations are unconditionally
/// redacted, and whose backing byte buffer is zeroized on drop.
pub struct RedactedSessionSecret(Vec<u8>);

impl Clone for RedactedSessionSecret {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl RedactedSessionSecret {
    pub fn new(raw: &str) -> Result<Self, KeychainError> {
        let trimmed = raw.trim();
        if trimmed.len() < MIN_KEYCHAIN_SECRET_BYTES {
            return Err(KeychainError::SecretTooShort);
        }
        if trimmed.len() > MAX_KEYCHAIN_SECRET_BYTES {
            return Err(KeychainError::SecretTooLarge);
        }
        if !trimmed.bytes().all(|b| (0x21..=0x7E).contains(&b)) {
            return Err(KeychainError::SecretInvalidCharacters);
        }
        Ok(Self(trimmed.as_bytes().to_vec()))
    }

    /// Exposes the validated ASCII secret strictly for writing into the OS keychain adapter.
    pub fn expose_for_keychain_write(&self) -> &str {
        core::str::from_utf8(&self.0).expect("validated printable ASCII")
    }

    pub fn clear(&mut self) {
        self.0.zeroize();
        self.0.clear();
    }
}

impl Drop for RedactedSessionSecret {
    fn drop(&mut self) {
        self.clear();
    }
}

impl fmt::Debug for RedactedSessionSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RedactedSessionSecret([REDACTED])")
    }
}

impl fmt::Display for RedactedSessionSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}

/// Validated non-secret metadata accompanying an OS keychain session credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeychainSessionMetadata {
    pub slot: KeychainSlotDescriptor,
    pub organisation_id: String,
    pub matrix_user_id: String,
    pub homeserver_domain: String,
    pub device_id: String,
    pub issued_at_unix_secs: u64,
    pub expires_at_unix_secs: Option<u64>,
}

impl KeychainSessionMetadata {
    pub fn validate(
        secret_kind: KeychainSecretKind,
        organisation_id: &str,
        matrix_user_id: &str,
        device_id: &str,
        issued_at_unix_secs: u64,
        expires_at_unix_secs: Option<u64>,
    ) -> Result<Self, KeychainError> {
        let org = OrganisationId::parse(organisation_id)
            .map_err(|_| KeychainError::InvalidOrganisation)?;
        let (_, domain) = parse_canonical_matrix_user_id(matrix_user_id)?;
        if !is_valid_device_id(device_id) {
            return Err(KeychainError::InvalidDeviceId);
        }
        if issued_at_unix_secs == 0 {
            return Err(KeychainError::InvalidExpiryWindow);
        }
        if let Some(expires) = expires_at_unix_secs {
            if expires <= issued_at_unix_secs {
                return Err(KeychainError::InvalidExpiryWindow);
            }
        }
        let slot = build_keychain_slot(secret_kind, org.as_str(), matrix_user_id)?;
        Ok(Self {
            slot,
            organisation_id: org.as_str().to_owned(),
            matrix_user_id: matrix_user_id.to_owned(),
            homeserver_domain: domain.to_owned(),
            device_id: device_id.to_owned(),
            issued_at_unix_secs,
            expires_at_unix_secs,
        })
    }

    /// Validates both public metadata and an optional raw token, refusing any payload where the
    /// raw secret appears (case-insensitively) inside public metadata fields.
    pub fn validate_with_secret(
        secret_kind: KeychainSecretKind,
        organisation_id: &str,
        matrix_user_id: &str,
        device_id: &str,
        issued_at_unix_secs: u64,
        expires_at_unix_secs: Option<u64>,
        raw_secret: Option<&str>,
    ) -> Result<(Self, Option<RedactedSessionSecret>), KeychainError> {
        let secret = match raw_secret {
            Some(raw) => Some(RedactedSessionSecret::new(raw)?),
            None => None,
        };
        let metadata = Self::validate(
            secret_kind,
            organisation_id,
            matrix_user_id,
            device_id,
            issued_at_unix_secs,
            expires_at_unix_secs,
        )?;
        if let Some(ref wrapped) = secret {
            if metadata_exposes_secret(&metadata, wrapped.expose_for_keychain_write()) {
                return Err(KeychainError::SecretLeakedInMetadata);
            }
        }
        Ok((metadata, secret))
    }

    pub const fn is_expired(&self, now_unix_secs: u64) -> bool {
        match self.expires_at_unix_secs {
            Some(exp) => now_unix_secs >= exp,
            None => false,
        }
    }
}

/// Checks whether a secret string was copied (even with altered ASCII case) into public metadata.
pub fn metadata_exposes_secret(metadata: &KeychainSessionMetadata, raw_secret: &str) -> bool {
    let trimmed = raw_secret.trim();
    if trimmed.is_empty() {
        return false;
    }
    let mut needle = zeroize::Zeroizing::new(String::with_capacity(trimmed.len()));
    for ch in trimmed.chars() {
        needle.push(ch.to_ascii_lowercase());
    }
    let contains_secret = |field: &str| field.to_ascii_lowercase().contains(needle.as_str());
    contains_secret(&metadata.slot.service_name)
        || contains_secret(&metadata.slot.account_name)
        || contains_secret(&metadata.organisation_id)
        || contains_secret(&metadata.matrix_user_id)
        || contains_secret(&metadata.homeserver_domain)
        || contains_secret(&metadata.device_id)
}

fn parse_canonical_matrix_user_id(raw: &str) -> Result<(&str, &str), KeychainError> {
    if raw.len() > 192 || !raw.is_ascii() {
        return Err(KeychainError::InvalidMatrixUserId);
    }
    let Some(without_at) = raw.strip_prefix('@') else {
        return Err(KeychainError::InvalidMatrixUserId);
    };
    let Some((localpart, domain)) = without_at.split_once(':') else {
        return Err(KeychainError::InvalidMatrixUserId);
    };
    if !(1..=64).contains(&localpart.len())
        || localpart.starts_with('.')
        || localpart.ends_with('.')
        || localpart.contains("..")
        || !localpart.bytes().all(|b| {
            b.is_ascii_lowercase()
                || b.is_ascii_digit()
                || matches!(b, b'-' | b'_' | b'.' | b'=' | b'+')
        })
    {
        return Err(KeychainError::InvalidMatrixUserId);
    }
    validate_docs_host(domain).map_err(|_| KeychainError::InvalidHomeserverDomain)?;
    Ok((localpart, domain))
}

fn is_valid_device_id(device_id: &str) -> bool {
    (1..=64).contains(&device_id.len())
        && device_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// Platform OS credential backend targeted by the safe command specification builder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsKeychainPlatform {
    MacOsSecurity,
    LinuxSecretTool,
    WindowsPasswordVault,
}

impl OsKeychainPlatform {
    pub const fn host() -> Self {
        #[cfg(target_os = "macos")]
        {
            Self::MacOsSecurity
        }
        #[cfg(target_os = "windows")]
        {
            Self::WindowsPasswordVault
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Self::LinuxSecretTool
        }
    }
}

/// Safe, `unsafe`-free OS keychain CLI specification for validated `(service, account)` slots.
///
/// Secrets are never placed in public `args` (`secret_via_stdin` streams secret payloads over
/// `Stdio::piped()`) and are never formatted in `Debug` or `Display`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OsKeychainCommandSpec {
    pub platform: OsKeychainPlatform,
    pub program: String,
    pub args: Vec<String>,
    pub secret_via_stdin: bool,
}

impl OsKeychainCommandSpec {
    pub fn build_store(
        platform: OsKeychainPlatform,
        slot: &KeychainSlotDescriptor,
    ) -> Result<Self, KeychainError> {
        validate_keychain_service_id(&slot.service_name)?;
        validate_keychain_account_id(&slot.account_name)?;
        Ok(match platform {
            OsKeychainPlatform::MacOsSecurity => Self {
                platform,
                program: "/usr/bin/security".to_owned(),
                args: vec!["-i".to_owned()],
                secret_via_stdin: true,
            },
            OsKeychainPlatform::LinuxSecretTool => Self {
                platform,
                program: os_backend::resolve_linux_secret_tool_program(),
                args: vec![
                    "store".to_owned(),
                    "--label=Kodera".to_owned(),
                    "service".to_owned(),
                    slot.service_name.clone(),
                    "account".to_owned(),
                    slot.account_name.clone(),
                ],
                secret_via_stdin: true,
            },
            OsKeychainPlatform::WindowsPasswordVault => Self {
                platform,
                program: os_backend::resolve_windows_powershell_program(),
                args: vec![
                    "-NoProfile".to_owned(),
                    "-NonInteractive".to_owned(),
                    "-Command".to_owned(),
                    os_backend::WINDOWS_PASSWORD_VAULT_COMMAND.to_owned(),
                ],
                secret_via_stdin: true,
            },
        })
    }

    pub fn build_lookup(
        platform: OsKeychainPlatform,
        slot: &KeychainSlotDescriptor,
    ) -> Result<Self, KeychainError> {
        validate_keychain_service_id(&slot.service_name)?;
        validate_keychain_account_id(&slot.account_name)?;
        Ok(match platform {
            OsKeychainPlatform::MacOsSecurity => Self {
                platform,
                program: "/usr/bin/security".to_owned(),
                args: vec![
                    "find-generic-password".to_owned(),
                    "-s".to_owned(),
                    slot.service_name.clone(),
                    "-a".to_owned(),
                    slot.account_name.clone(),
                    "-w".to_owned(),
                ],
                secret_via_stdin: false,
            },
            OsKeychainPlatform::LinuxSecretTool => Self {
                platform,
                program: os_backend::resolve_linux_secret_tool_program(),
                args: vec![
                    "lookup".to_owned(),
                    "service".to_owned(),
                    slot.service_name.clone(),
                    "account".to_owned(),
                    slot.account_name.clone(),
                ],
                secret_via_stdin: false,
            },
            OsKeychainPlatform::WindowsPasswordVault => Self {
                platform,
                program: os_backend::resolve_windows_powershell_program(),
                args: vec![
                    "-NoProfile".to_owned(),
                    "-NonInteractive".to_owned(),
                    "-Command".to_owned(),
                    os_backend::WINDOWS_PASSWORD_VAULT_COMMAND.to_owned(),
                ],
                secret_via_stdin: true,
            },
        })
    }

    pub fn build_delete(
        platform: OsKeychainPlatform,
        slot: &KeychainSlotDescriptor,
    ) -> Result<Self, KeychainError> {
        validate_keychain_service_id(&slot.service_name)?;
        validate_keychain_account_id(&slot.account_name)?;
        Ok(match platform {
            OsKeychainPlatform::MacOsSecurity => Self {
                platform,
                program: "/usr/bin/security".to_owned(),
                args: vec![
                    "delete-generic-password".to_owned(),
                    "-s".to_owned(),
                    slot.service_name.clone(),
                    "-a".to_owned(),
                    slot.account_name.clone(),
                ],
                secret_via_stdin: false,
            },
            OsKeychainPlatform::LinuxSecretTool => Self {
                platform,
                program: os_backend::resolve_linux_secret_tool_program(),
                args: vec![
                    "clear".to_owned(),
                    "service".to_owned(),
                    slot.service_name.clone(),
                    "account".to_owned(),
                    slot.account_name.clone(),
                ],
                secret_via_stdin: false,
            },
            OsKeychainPlatform::WindowsPasswordVault => Self {
                platform,
                program: os_backend::resolve_windows_powershell_program(),
                args: vec![
                    "-NoProfile".to_owned(),
                    "-NonInteractive".to_owned(),
                    "-Command".to_owned(),
                    os_backend::WINDOWS_PASSWORD_VAULT_COMMAND.to_owned(),
                ],
                secret_via_stdin: true,
            },
        })
    }
}

/// Non-secret outcome returned when storing a session credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeychainStoreOutcome {
    pub slot: KeychainSlotDescriptor,
    pub metadata: KeychainSessionMetadata,
    pub persistence: KeychainPersistence,
    pub native_keychain: bool,
}

/// Non-secret lookup or deletion status returned across IPC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeychainCredentialStatus {
    pub slot: KeychainSlotDescriptor,
    pub present: bool,
    pub native_keychain: bool,
    pub metadata: Option<KeychainSessionMetadata>,
}

/// Pluggable credential storage adapter backing [`KeychainCredentialStore`].
pub trait KeychainBackend: Send + Sync {
    fn store(
        &self,
        metadata: &KeychainSessionMetadata,
        secret: &RedactedSessionSecret,
    ) -> Result<KeychainPersistence, KeychainError>;

    fn load_status(
        &self,
        slot: &KeychainSlotDescriptor,
    ) -> Result<KeychainCredentialStatus, KeychainError>;

    fn load_secret(
        &self,
        slot: &KeychainSlotDescriptor,
    ) -> Result<Option<(KeychainSessionMetadata, RedactedSessionSecret)>, KeychainError>;

    fn delete(
        &self,
        slot: &KeychainSlotDescriptor,
    ) -> Result<KeychainCredentialStatus, KeychainError>;

    /// Deletes every persisted credential slot belonging to `organisation_id`.
    fn clear_organisation(&self, organisation_id: &str) -> Result<usize, KeychainError>;

    /// Zeroizes non-persistent fallback RAM caches on session teardown while leaving persistent
    /// OS keychain entries intact.
    fn clear_ephemeral_cache(&self) {}
}

type SlotKey = (String, String);
type EphemeralEntry = (KeychainSessionMetadata, RedactedSessionSecret);
type CachedEntry = (
    KeychainSessionMetadata,
    RedactedSessionSecret,
    KeychainPersistence,
);
type EphemeralClockFn = dyn Fn() -> u64 + Send + Sync;

/// Zeroized in-RAM fallback backend (`native_keychain: false`) with clock-enforced expiration.
pub struct EphemeralKeychainBackend {
    entries: Mutex<BTreeMap<SlotKey, EphemeralEntry>>,
    clock: Arc<EphemeralClockFn>,
}

impl Default for EphemeralKeychainBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl EphemeralKeychainBackend {
    pub fn new() -> Self {
        Self::with_clock(Arc::new(kodera_rs::system_unix_secs))
    }

    pub fn with_clock(clock: Arc<EphemeralClockFn>) -> Self {
        Self {
            entries: Mutex::new(BTreeMap::new()),
            clock,
        }
    }

    fn purge_expired_locked(entries: &mut BTreeMap<SlotKey, EphemeralEntry>, now_secs: u64) {
        entries.retain(|_, (m, s)| {
            if m.is_expired(now_secs) {
                s.clear();
                false
            } else {
                true
            }
        });
    }
}

impl KeychainBackend for EphemeralKeychainBackend {
    fn store(
        &self,
        metadata: &KeychainSessionMetadata,
        secret: &RedactedSessionSecret,
    ) -> Result<KeychainPersistence, KeychainError> {
        if metadata_exposes_secret(metadata, secret.expose_for_keychain_write()) {
            return Err(KeychainError::SecretLeakedInMetadata);
        }
        let now = (self.clock)();
        let mut guard = self
            .entries
            .lock()
            .map_err(|_| KeychainError::BackendFailure)?;
        Self::purge_expired_locked(&mut guard, now);
        let key = (
            metadata.slot.service_name.clone(),
            metadata.slot.account_name.clone(),
        );
        if !guard.contains_key(&key) {
            let org_count = guard
                .values()
                .filter(|(m, _)| m.organisation_id == metadata.organisation_id)
                .count();
            if org_count >= MAX_KEYCHAIN_SLOTS_PER_ORG {
                return Err(KeychainError::CapacityExceeded);
            }
        }
        if let Some((_, mut prev)) = guard.insert(key, (metadata.clone(), secret.clone())) {
            prev.clear();
        }
        Ok(KeychainPersistence::EphemeralFallback)
    }

    fn load_status(
        &self,
        slot: &KeychainSlotDescriptor,
    ) -> Result<KeychainCredentialStatus, KeychainError> {
        validate_keychain_service_id(&slot.service_name)?;
        validate_keychain_account_id(&slot.account_name)?;
        let now = (self.clock)();
        let mut guard = self
            .entries
            .lock()
            .map_err(|_| KeychainError::BackendFailure)?;
        Self::purge_expired_locked(&mut guard, now);
        let key = (slot.service_name.clone(), slot.account_name.clone());
        let metadata = guard.get(&key).map(|(m, _)| m.clone());
        Ok(KeychainCredentialStatus {
            slot: slot.clone(),
            present: metadata.is_some(),
            native_keychain: false,
            metadata,
        })
    }

    fn load_secret(
        &self,
        slot: &KeychainSlotDescriptor,
    ) -> Result<Option<(KeychainSessionMetadata, RedactedSessionSecret)>, KeychainError> {
        validate_keychain_service_id(&slot.service_name)?;
        validate_keychain_account_id(&slot.account_name)?;
        let now = (self.clock)();
        let mut guard = self
            .entries
            .lock()
            .map_err(|_| KeychainError::BackendFailure)?;
        Self::purge_expired_locked(&mut guard, now);
        let key = (slot.service_name.clone(), slot.account_name.clone());
        Ok(guard.get(&key).cloned())
    }

    fn delete(
        &self,
        slot: &KeychainSlotDescriptor,
    ) -> Result<KeychainCredentialStatus, KeychainError> {
        validate_keychain_service_id(&slot.service_name)?;
        validate_keychain_account_id(&slot.account_name)?;
        let mut guard = self
            .entries
            .lock()
            .map_err(|_| KeychainError::BackendFailure)?;
        let key = (slot.service_name.clone(), slot.account_name.clone());
        let existed = if let Some((_, mut secret)) = guard.remove(&key) {
            secret.clear();
            true
        } else {
            false
        };
        Ok(KeychainCredentialStatus {
            slot: slot.clone(),
            present: existed,
            native_keychain: false,
            metadata: None,
        })
    }

    fn clear_organisation(&self, organisation_id: &str) -> Result<usize, KeychainError> {
        let org = OrganisationId::parse(organisation_id)
            .map_err(|_| KeychainError::InvalidOrganisation)?;
        let target = org.as_str();
        let mut guard = self
            .entries
            .lock()
            .map_err(|_| KeychainError::BackendFailure)?;
        let keys: Vec<(String, String)> = guard
            .iter()
            .filter(|(_, (meta, _))| meta.organisation_id == target)
            .map(|(k, _)| k.clone())
            .collect();
        let count = keys.len();
        for key in keys {
            if let Some((_, mut secret)) = guard.remove(&key) {
                secret.clear();
            }
        }
        Ok(count)
    }

    fn clear_ephemeral_cache(&self) {
        if let Ok(mut guard) = self.entries.lock() {
            for (_, (_, mut secret)) in core::mem::take(&mut *guard) {
                secret.clear();
            }
        }
    }
}

/// Organisation-isolated bounded credential bridge store with pluggable [`KeychainBackend`].
///
/// In-RAM cached [`RedactedSessionSecret`] buffers are zeroized on overwrite, deletion,
/// `clear_ram_cache` (window close / session teardown), and drop, while persistent OS keychain
/// slots remain intact until explicit logout (`delete_credential` or `clear_organisation`).
pub struct KeychainCredentialStore {
    ram_cache: BTreeMap<SlotKey, CachedEntry>,
    backend: Arc<dyn KeychainBackend>,
}

impl Default for KeychainCredentialStore {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for KeychainCredentialStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KeychainCredentialStore")
            .field("slot_count", &self.ram_cache.len())
            .finish()
    }
}

impl KeychainCredentialStore {
    pub fn new() -> Self {
        #[cfg(test)]
        {
            Self::with_backend(Arc::new(EphemeralKeychainBackend::new()))
        }
        #[cfg(not(test))]
        {
            Self::with_backend(os_backend::default_runtime_keychain_backend())
        }
    }

    pub fn with_backend(backend: Arc<dyn KeychainBackend>) -> Self {
        Self {
            ram_cache: BTreeMap::new(),
            backend,
        }
    }

    pub fn slot_count(&self) -> usize {
        self.ram_cache.len()
    }

    pub fn metadata_snapshot(&self) -> Vec<KeychainSessionMetadata> {
        self.ram_cache
            .values()
            .map(|(meta, _, _)| meta.clone())
            .collect()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn store_credential(
        &mut self,
        secret_kind: KeychainSecretKind,
        organisation_id: &str,
        matrix_user_id: &str,
        device_id: &str,
        issued_at_unix_secs: u64,
        expires_at_unix_secs: Option<u64>,
        raw_secret: &str,
    ) -> Result<KeychainStoreOutcome, KeychainError> {
        let (metadata, wrapped) = KeychainSessionMetadata::validate_with_secret(
            secret_kind,
            organisation_id,
            matrix_user_id,
            device_id,
            issued_at_unix_secs,
            expires_at_unix_secs,
            Some(raw_secret),
        )?;
        let secret = wrapped.expect("Some(raw_secret) produces Some(RedactedSessionSecret)");
        let key = (
            metadata.slot.service_name.clone(),
            metadata.slot.account_name.clone(),
        );
        if !self.ram_cache.contains_key(&key) {
            let org_count = self
                .ram_cache
                .values()
                .filter(|(m, _, _)| m.organisation_id == metadata.organisation_id)
                .count();
            if org_count >= MAX_KEYCHAIN_SLOTS_PER_ORG {
                return Err(KeychainError::CapacityExceeded);
            }
        }
        let persistence = self.backend.store(&metadata, &secret)?;
        if let Some((_, mut previous_secret, _)) = self
            .ram_cache
            .insert(key, (metadata.clone(), secret, persistence))
        {
            previous_secret.clear();
        }
        Ok(KeychainStoreOutcome {
            slot: metadata.slot.clone(),
            metadata,
            persistence,
            native_keychain: persistence.is_native_keychain(),
        })
    }

    /// Loads validated metadata and the redacted secret handle strictly for the matching org.
    pub fn load_credential_secret(
        &self,
        secret_kind: KeychainSecretKind,
        organisation_id: &str,
        matrix_user_id: &str,
    ) -> Result<Option<(KeychainSessionMetadata, RedactedSessionSecret)>, KeychainError> {
        let slot = build_keychain_slot(secret_kind, organisation_id, matrix_user_id)?;
        self.backend.load_secret(&slot)
    }

    /// Loads non-secret slot presence and metadata across the IPC boundary without exposing tokens.
    pub fn load_credential_status(
        &self,
        secret_kind: KeychainSecretKind,
        organisation_id: &str,
        matrix_user_id: &str,
    ) -> Result<KeychainCredentialStatus, KeychainError> {
        let slot = build_keychain_slot(secret_kind, organisation_id, matrix_user_id)?;
        self.backend.load_status(&slot)
    }

    /// Deletes a single organisation-scoped credential slot from RAM and the OS keychain.
    pub fn delete_credential(
        &mut self,
        secret_kind: KeychainSecretKind,
        organisation_id: &str,
        matrix_user_id: &str,
    ) -> Result<KeychainCredentialStatus, KeychainError> {
        let slot = build_keychain_slot(secret_kind, organisation_id, matrix_user_id)?;
        let key = (slot.service_name.clone(), slot.account_name.clone());
        let cached_existed = if let Some((_, mut secret, _)) = self.ram_cache.remove(&key) {
            secret.clear();
            true
        } else {
            false
        };
        let mut status = self.backend.delete(&slot)?;
        if cached_existed && !status.present {
            status.present = true;
        }
        Ok(status)
    }

    /// Explicitly deletes every credential belonging to `organisation_id` from RAM and the OS keychain.
    pub fn clear_organisation(&mut self, organisation_id: &str) -> Result<usize, KeychainError> {
        let org = OrganisationId::parse(organisation_id)
            .map_err(|_| KeychainError::InvalidOrganisation)?;
        let target = org.as_str();
        let keys_to_remove: Vec<(String, String)> = self
            .ram_cache
            .iter()
            .filter(|(_, (meta, _, _))| meta.organisation_id == target)
            .map(|(k, _)| k.clone())
            .collect();
        let ram_removed = keys_to_remove.len();
        for key in keys_to_remove {
            if let Some((_, mut secret, _)) = self.ram_cache.remove(&key) {
                secret.clear();
            }
        }
        let backend_removed = self.backend.clear_organisation(target)?;
        Ok(backend_removed.max(ram_removed))
    }

    /// Zeroizes only in-RAM cached secret bytes (and ephemeral fallback maps) without deleting
    /// persistent OS keychain entries. Invoked on window close, process exit, and session teardown.
    pub fn clear_ram_cache(&mut self) {
        for (_, (_, mut secret, _)) in core::mem::take(&mut self.ram_cache) {
            secret.clear();
        }
        self.backend.clear_ephemeral_cache();
    }

    /// Alias for [`Self::clear_ram_cache`] preserving in-memory zeroization semantics.
    pub fn clear_all(&mut self) {
        self.clear_ram_cache();
    }
}

impl Drop for KeychainCredentialStore {
    fn drop(&mut self) {
        self.clear_ram_cache();
    }
}
