//! OS Keychain session slot naming and non-secret metadata contract.
//!
//! Security invariants:
//! - Every OS keychain item is scoped under `io.kodera.desktop.<kind>` and an organisation-bound
//!   account key `org:<organisation_uuid>:user:<matrix_user_id>` so multi-workspace credentials
//!   never collide or bleed across organisations.
//! - Raw session tokens wrapped in [`RedactedSessionSecret`] unconditionally format as
//!   `[REDACTED]` in `Debug` and `Display`, overwrite their backing byte buffer on drop, and are
//!   never echoed in [`KeychainError`] diagnostics.
//! - Metadata validation refuses any payload where a caller accidentally copied secret material
//!   into public metadata fields (`device_id`, `matrix_user_id`, or slot identifiers).

use core::fmt;
use kodera_rs::{validate_docs_host, OrganisationId};
use std::collections::BTreeMap;

/// Canonical reverse-DNS prefix for all Kodera Desktop keychain services.
pub const KEYCHAIN_SERVICE_NAMESPACE: &str = "io.kodera.desktop";

/// Minimum byte length for session tokens admitted to OS keychain storage.
pub const MIN_KEYCHAIN_SECRET_BYTES: usize = 16;

/// Maximum byte length for session tokens admitted to OS keychain storage.
pub const MAX_KEYCHAIN_SECRET_BYTES: usize = 4096;

/// Maximum UTF-8 byte length of a keychain `service` identifier.
pub const MAX_KEYCHAIN_SERVICE_BYTES: usize = 128;

/// Maximum UTF-8 byte length of a keychain `account` identifier.
pub const MAX_KEYCHAIN_ACCOUNT_BYTES: usize = 255;

/// Upper bound on stored credential slots per organisation session.
pub const MAX_KEYCHAIN_SLOTS_PER_ORG: usize = 32;

/// Closed refusal codes for keychain slot naming, secret wrapping, and metadata validation.
/// Carries zero raw token or untrusted input excerpts.
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
/// redacted, and whose backing byte buffer is overwritten on drop.
///
/// Note: logical overwrite clears this Vec's bytes on teardown; it is not a guarantee against OS
/// pagefile swap or prior caller-owned string copies.
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
        self.0.fill(0);
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
    let needle = raw_secret.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return false;
    }
    let contains_secret = |field: &str| field.to_ascii_lowercase().contains(&needle);
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
    WindowsCmdKey,
}

impl OsKeychainPlatform {
    pub const fn host() -> Self {
        #[cfg(target_os = "macos")]
        {
            Self::MacOsSecurity
        }
        #[cfg(target_os = "windows")]
        {
            Self::WindowsCmdKey
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Self::LinuxSecretTool
        }
    }
}

/// Safe, `unsafe`-free OS keychain CLI specification for validated `(service, account)` slots.
///
/// Secrets are never placed in public `args` on platforms supporting standard-input streaming
/// (`secret-tool store`) and are never formatted in `Debug` or `Display`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OsKeychainCommandSpec {
    pub platform: OsKeychainPlatform,
    pub program: &'static str,
    pub args: Vec<String>,
    pub secret_via_stdin: bool,
}

impl OsKeychainCommandSpec {
    pub fn build_lookup(
        platform: OsKeychainPlatform,
        slot: &KeychainSlotDescriptor,
    ) -> Result<Self, KeychainError> {
        validate_keychain_service_id(&slot.service_name)?;
        validate_keychain_account_id(&slot.account_name)?;
        Ok(match platform {
            OsKeychainPlatform::MacOsSecurity => Self {
                platform,
                program: "security",
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
                program: "secret-tool",
                args: vec![
                    "lookup".to_owned(),
                    "service".to_owned(),
                    slot.service_name.clone(),
                    "account".to_owned(),
                    slot.account_name.clone(),
                ],
                secret_via_stdin: false,
            },
            OsKeychainPlatform::WindowsCmdKey => Self {
                platform,
                program: "cmdkey",
                args: vec![format!("/list:{}/{}", slot.service_name, slot.account_name)],
                secret_via_stdin: false,
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
                program: "security",
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
                program: "secret-tool",
                args: vec![
                    "clear".to_owned(),
                    "service".to_owned(),
                    slot.service_name.clone(),
                    "account".to_owned(),
                    slot.account_name.clone(),
                ],
                secret_via_stdin: false,
            },
            OsKeychainPlatform::WindowsCmdKey => Self {
                platform,
                program: "cmdkey",
                args: vec![format!(
                    "/delete:{}/{}",
                    slot.service_name, slot.account_name
                )],
                secret_via_stdin: false,
            },
        })
    }
}

/// Non-secret lookup result returned across IPC when inspecting or loading a keychain slot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeychainCredentialStatus {
    pub slot: KeychainSlotDescriptor,
    pub present: bool,
    pub metadata: Option<KeychainSessionMetadata>,
}

/// Organisation-isolated bounded credential bridge store.
///
/// Backing [`RedactedSessionSecret`] buffers are overwritten on overwrite, deletion, organisation
/// switch, and drop, and `Debug` never prints secret material.
#[derive(Default)]
pub struct KeychainCredentialStore {
    entries: BTreeMap<(String, String), (KeychainSessionMetadata, RedactedSessionSecret)>,
}

impl fmt::Debug for KeychainCredentialStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KeychainCredentialStore")
            .field("slot_count", &self.entries.len())
            .finish()
    }
}

impl KeychainCredentialStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn slot_count(&self) -> usize {
        self.entries.len()
    }

    pub fn metadata_snapshot(&self) -> Vec<KeychainSessionMetadata> {
        self.entries
            .values()
            .map(|(meta, _)| meta.clone())
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
    ) -> Result<KeychainSessionMetadata, KeychainError> {
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
        if !self.entries.contains_key(&key) {
            let org_count = self
                .entries
                .values()
                .filter(|(m, _)| m.organisation_id == metadata.organisation_id)
                .count();
            if org_count >= MAX_KEYCHAIN_SLOTS_PER_ORG {
                return Err(KeychainError::CapacityExceeded);
            }
        }
        if let Some((_, mut previous_secret)) = self.entries.insert(key, (metadata.clone(), secret))
        {
            previous_secret.clear();
        }
        Ok(metadata)
    }

    /// Loads validated metadata and the redacted secret handle strictly for the matching org.
    pub fn load_credential_secret(
        &self,
        secret_kind: KeychainSecretKind,
        organisation_id: &str,
        matrix_user_id: &str,
    ) -> Result<Option<(KeychainSessionMetadata, RedactedSessionSecret)>, KeychainError> {
        let slot = build_keychain_slot(secret_kind, organisation_id, matrix_user_id)?;
        let key = (slot.service_name, slot.account_name);
        Ok(self.entries.get(&key).cloned())
    }

    /// Loads non-secret slot presence and metadata across the IPC boundary without exposing tokens.
    pub fn load_credential_status(
        &self,
        secret_kind: KeychainSecretKind,
        organisation_id: &str,
        matrix_user_id: &str,
    ) -> Result<KeychainCredentialStatus, KeychainError> {
        let slot = build_keychain_slot(secret_kind, organisation_id, matrix_user_id)?;
        let key = (slot.service_name.clone(), slot.account_name.clone());
        let metadata = self.entries.get(&key).map(|(meta, _)| meta.clone());
        Ok(KeychainCredentialStatus {
            slot,
            present: metadata.is_some(),
            metadata,
        })
    }

    /// Deletes a single organisation-scoped credential slot, overwriting its secret bytes.
    pub fn delete_credential(
        &mut self,
        secret_kind: KeychainSecretKind,
        organisation_id: &str,
        matrix_user_id: &str,
    ) -> Result<KeychainCredentialStatus, KeychainError> {
        let slot = build_keychain_slot(secret_kind, organisation_id, matrix_user_id)?;
        let key = (slot.service_name.clone(), slot.account_name.clone());
        let existed = if let Some((_, mut secret)) = self.entries.remove(&key) {
            secret.clear();
            true
        } else {
            false
        };
        Ok(KeychainCredentialStatus {
            slot,
            present: existed,
            metadata: None,
        })
    }

    /// Removes and overwrites every credential belonging to `organisation_id`.
    pub fn clear_organisation(&mut self, organisation_id: &str) -> Result<usize, KeychainError> {
        let org = OrganisationId::parse(organisation_id)
            .map_err(|_| KeychainError::InvalidOrganisation)?;
        let target = org.as_str();
        let keys_to_remove: Vec<(String, String)> = self
            .entries
            .iter()
            .filter(|(_, (meta, _))| meta.organisation_id == target)
            .map(|(k, _)| k.clone())
            .collect();
        let count = keys_to_remove.len();
        for key in keys_to_remove {
            if let Some((_, mut secret)) = self.entries.remove(&key) {
                secret.clear();
            }
        }
        Ok(count)
    }

    pub fn clear_all(&mut self) {
        for (_, (_, mut secret)) in core::mem::take(&mut self.entries) {
            secret.clear();
        }
    }
}

impl Drop for KeychainCredentialStore {
    fn drop(&mut self) {
        self.clear_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORG: &str = "019a5e62-6ca0-7303-8303-030303030303";
    const SAMPLE_OPAQUE_PAYLOAD: &str = "syt_sample_opaque_fixture_0123456789";

    #[test]
    fn builds_and_validates_org_scoped_keychain_slots() {
        let slot = build_keychain_slot(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io")
            .unwrap();
        assert!(slot.service_name == "io.kodera.desktop.matrix-session");
        let expected_slot = format!("org:{ORG}:user:@alice:kodera.io");
        assert!(slot.account_name == expected_slot);
        assert!(matches!(
            validate_keychain_service_id(&slot.service_name),
            Ok(KeychainSecretKind::MatrixSession)
        ));
        let (parsed_org, parsed_user, parsed_domain) =
            validate_keychain_account_id(&slot.account_name).unwrap();
        assert_eq!(parsed_org.as_str(), ORG);
        assert_eq!(parsed_user, "@alice:kodera.io");
        assert_eq!(parsed_domain, "kodera.io");
    }

    #[test]
    fn rejects_invalid_service_and_account_identifiers() {
        for invalid_svc_candidate in [
            "",
            "io.kodera.desktop",
            "io.kodera.desktop.unknown",
            "com.other.app.matrix-session",
            "io.kodera.desktop.matrix-session\0",
            "io.kodera.desktop.matrix session",
        ] {
            assert!(matches!(
                validate_keychain_service_id(invalid_svc_candidate),
                Err(KeychainError::InvalidServiceIdentifier)
            ));
        }

        for invalid_slot_candidate in [
            "",
            "@alice:kodera.io",
            "org:00000000-0000-0000-0000-000000000000:user:@alice:kodera.io",
            "org:019a5e62-6ca0-7303-8303-030303030303:user:alice:kodera.io",
            "org:019a5e62-6ca0-7303-8303-030303030303:user:@alice:localhost",
            "org:019a5e62-6ca0-7303-8303-030303030303:user:@../alice:kodera.io",
            "org:019a5e62-6ca0-7303-8303-030303030303/user:@alice:kodera.io",
        ] {
            assert!(matches!(
                validate_keychain_account_id(invalid_slot_candidate),
                Err(KeychainError::InvalidAccountIdentifier)
            ));
        }
    }

    #[test]
    fn redacts_secret_in_debug_display_errors_and_blocks_metadata_leaks() {
        let (meta, wrapped) = KeychainSessionMetadata::validate_with_secret(
            KeychainSecretKind::OidcRefresh,
            ORG,
            "@zxxma:community.kodera.io",
            "DEV_MACBOOK_01",
            1_762_520_000,
            Some(1_762_523_600),
            Some(SAMPLE_OPAQUE_PAYLOAD),
        )
        .unwrap();
        let mut redacted_box = wrapped.unwrap();
        let debug_repr = format!("{redacted_box:?}");
        let display_repr = format!("{redacted_box}");
        assert!(!debug_repr.contains(SAMPLE_OPAQUE_PAYLOAD));
        assert!(!display_repr.contains(SAMPLE_OPAQUE_PAYLOAD));
        assert!(debug_repr.contains("REDACTED"));
        assert!(!meta.device_id.contains(SAMPLE_OPAQUE_PAYLOAD));
        assert!(!meta.is_expired(1_762_523_599));
        assert!(meta.is_expired(1_762_523_600));

        redacted_box.clear();
        assert!(redacted_box.expose_for_keychain_write().is_empty());

        // Copying the opaque value (or case-folded variant) into device_id is refused.
        let leaked = KeychainSessionMetadata::validate_with_secret(
            KeychainSecretKind::MatrixSession,
            ORG,
            "@zxxma:community.kodera.io",
            &SAMPLE_OPAQUE_PAYLOAD.to_ascii_uppercase(),
            1_762_520_000,
            None,
            Some(SAMPLE_OPAQUE_PAYLOAD),
        );
        assert!(matches!(leaked, Err(KeychainError::SecretLeakedInMetadata)));

        // Error formatting never echoes malformed inputs.
        let malformed_fixture = format!("{SAMPLE_OPAQUE_PAYLOAD}\0injected");
        let err = RedactedSessionSecret::new(&malformed_fixture).unwrap_err();
        assert!(matches!(err, KeychainError::SecretInvalidCharacters));
        assert!(!err.to_string().contains("syt_sample"));
    }

    #[test]
    fn credential_store_isolates_organisations_redacts_debug_and_builds_os_specs() {
        const OTHER_ORG: &str = "019a5e62-6ca0-7303-8303-030303030304";
        let mut store = KeychainCredentialStore::new();
        let stored = store
            .store_credential(
                KeychainSecretKind::MatrixSession,
                ORG,
                "@alice:kodera.io",
                "MACBOOK_PRO_01",
                1_762_520_000,
                Some(1_762_523_600),
                SAMPLE_OPAQUE_PAYLOAD,
            )
            .unwrap();
        assert_eq!(store.slot_count(), 1);
        assert!(!format!("{store:?}").contains(SAMPLE_OPAQUE_PAYLOAD));

        // Other organisation cannot see Alice's credential.
        let other_status = store
            .load_credential_status(
                KeychainSecretKind::MatrixSession,
                OTHER_ORG,
                "@alice:kodera.io",
            )
            .unwrap();
        assert!(!other_status.present);
        assert!(other_status.metadata.is_none());

        // Matching organisation sees metadata via status and redacted secret via internal handle.
        let own_status = store
            .load_credential_status(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io")
            .unwrap();
        assert!(own_status.present);
        assert_eq!(own_status.metadata.as_ref(), Some(&stored));

        let (_, loaded_secret) = store
            .load_credential_secret(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io")
            .unwrap()
            .unwrap();
        assert_eq!(
            loaded_secret.expose_for_keychain_write(),
            SAMPLE_OPAQUE_PAYLOAD
        );

        // OS command specs validate slot IDs across all three desktop OS backends.
        for platform in [
            OsKeychainPlatform::MacOsSecurity,
            OsKeychainPlatform::LinuxSecretTool,
            OsKeychainPlatform::WindowsCmdKey,
        ] {
            let lookup = OsKeychainCommandSpec::build_lookup(platform, &stored.slot).unwrap();
            let delete = OsKeychainCommandSpec::build_delete(platform, &stored.slot).unwrap();
            assert!(!lookup.args.is_empty());
            assert!(!delete.args.is_empty());
        }

        let deleted = store
            .delete_credential(KeychainSecretKind::MatrixSession, ORG, "@alice:kodera.io")
            .unwrap();
        assert!(deleted.present);
        assert_eq!(store.slot_count(), 0);
    }
}
