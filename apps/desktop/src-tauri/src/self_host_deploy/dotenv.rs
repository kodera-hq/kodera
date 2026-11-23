//! OS CSPRNG secret generation, atomic `0600` `.env` creation, and prepared `.env` verification.

use super::compose_service_policy::verify_kodera_source_root;
use super::input_and_stack::validate_oidc_provider_origin;
use super::{
    CommunityDeployError, CommunityTlsMode, BASE64URL_ALPHABET, BASE64_STANDARD_ALPHABET,
    HEX_SECRET_BYTES, LIVEKIT_KEY_RANDOM_BYTES, SEAL_KEY_BYTES,
};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

fn csprng_bytes<const N: usize>() -> Result<[u8; N], CommunityDeployError> {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).map_err(|_| CommunityDeployError::EntropyUnavailable)?;
    Ok(buf)
}

pub(super) fn csprng_hex(byte_len: usize) -> Result<String, CommunityDeployError> {
    let mut buf = vec![0u8; byte_len];
    getrandom::fill(&mut buf).map_err(|_| CommunityDeployError::EntropyUnavailable)?;
    Ok(kodera_rs::encode_hex(&buf))
}

fn csprng_base64_32() -> Result<String, CommunityDeployError> {
    let raw = csprng_bytes::<SEAL_KEY_BYTES>()?;
    Ok(encode_base64_padded_32(&raw))
}

fn csprng_base64url_32() -> Result<String, CommunityDeployError> {
    let raw = csprng_bytes::<SEAL_KEY_BYTES>()?;
    Ok(encode_base64url_padded_32(&raw))
}

pub(super) fn encode_base64_padded_32(bytes: &[u8; 32]) -> String {
    encode_base64_alphabet_padded_32(bytes, BASE64_STANDARD_ALPHABET)
}

pub(super) fn encode_base64url_padded_32(bytes: &[u8; 32]) -> String {
    encode_base64_alphabet_padded_32(bytes, BASE64URL_ALPHABET)
}

fn encode_base64_alphabet_padded_32(bytes: &[u8; 32], alphabet: &[u8; 64]) -> String {
    let mut out = String::with_capacity(44);
    let mut i = 0usize;
    while i + 3 <= 32 {
        let b0 = bytes[i];
        let b1 = bytes[i + 1];
        let b2 = bytes[i + 2];
        out.push(char::from(alphabet[usize::from(b0 >> 2)]));
        out.push(char::from(
            alphabet[usize::from(((b0 & 0x03) << 4) | (b1 >> 4))],
        ));
        out.push(char::from(
            alphabet[usize::from(((b1 & 0x0f) << 2) | (b2 >> 6))],
        ));
        out.push(char::from(alphabet[usize::from(b2 & 0x3f)]));
        i += 3;
    }
    // Final 2 bytes (indices 30 and 31) -> 3 chars + '=' padding (44 chars total).
    let b0 = bytes[30];
    let b1 = bytes[31];
    out.push(char::from(alphabet[usize::from(b0 >> 2)]));
    out.push(char::from(
        alphabet[usize::from(((b0 & 0x03) << 4) | (b1 >> 4))],
    ));
    out.push(char::from(alphabet[usize::from((b1 & 0x0f) << 2)]));
    out.push('=');
    out
}

#[allow(clippy::too_many_arguments)]
pub(super) fn render_community_dotenv(
    normalized_domain: &str,
    matrix_base_domain: &str,
    acme_email: &str,
    oidc_origin: &str,
    oidc_issuer: &str,
    tls_mode: CommunityTlsMode,
    http_port: u16,
    https_port: u16,
) -> Result<(String, Vec<String>), CommunityDeployError> {
    let postgres_password = csprng_hex(HEX_SECRET_BYTES)?;
    let api_db_password = csprng_hex(HEX_SECRET_BYTES)?;
    let collab_db_password = csprng_hex(HEX_SECRET_BYTES)?;
    let synapse_db_password = csprng_hex(HEX_SECRET_BYTES)?;
    let django_secret_key = csprng_hex(HEX_SECRET_BYTES)?;
    let contact_seal_key = csprng_base64url_32()?;
    let outbox_seal_key = csprng_base64url_32()?;
    let membership_cursor_key = csprng_hex(HEX_SECRET_BYTES)?;
    let discovery_hmac_key = csprng_base64_32()?;
    let collab_ticket_key = csprng_base64url_32()?;
    let room_access_matrix_token = csprng_hex(HEX_SECRET_BYTES)?;
    let livekit_api_key = format!("lk_{}", csprng_hex(LIVEKIT_KEY_RANDOM_BYTES)?);
    let livekit_api_secret = csprng_hex(HEX_SECRET_BYTES)?;
    let synapse_oidc_client_secret = csprng_hex(HEX_SECRET_BYTES)?;
    let keycloak_admin_password = csprng_hex(HEX_SECRET_BYTES)?;
    let keycloak_db_password = csprng_hex(HEX_SECRET_BYTES)?;

    let auth_trust_json = format!(
        r#"[{{"lane":"customer","issuer":"{oidc_issuer}","generation":"bootstrap-v1","expires_at":4102444800,"public_jwks":{{"keys":[]}}}}]"#
    );

    let pairs: [(&str, String); 30] = [
        ("KODERA_TOPOLOGY", "single".to_owned()),
        ("KODERA_DOMAIN", normalized_domain.to_owned()),
        ("KODERA_MATRIX_DOMAIN", matrix_base_domain.to_owned()),
        ("KODERA_ACME_EMAIL", acme_email.to_owned()),
        ("KODERA_TLS_MODE", tls_mode.as_str().to_owned()),
        ("KODERA_HTTP_PORT", http_port.to_string()),
        ("KODERA_HTTPS_PORT", https_port.to_string()),
        (
            "DJANGO_ALLOWED_HOSTS",
            format!("{normalized_domain},127.0.0.1,server"),
        ),
        ("KODERA_OIDC_PROVIDER_ORIGIN", oidc_origin.to_owned()),
        ("KODERA_OIDC_CLIENT_ID", "console".to_owned()),
        ("KODERA_AUTH_TRUST", format!("'{auth_trust_json}'")),
        ("KODERA_STAFF_ISSUER", String::new()),
        ("KODERA_DEFAULT_COMMUNITY_ORG_SLUG", "community".to_owned()),
        ("KODERA_DEFAULT_COMMUNITY_ISSUER", oidc_issuer.to_owned()),
        ("KODERA_SYNAPSE_OIDC_ISSUER", String::new()),
        (
            "KODERA_SYNAPSE_OIDC_CLIENT_SECRET",
            synapse_oidc_client_secret,
        ),
        ("KODERA_MATRIX_FEDERATION_ALLOWLIST", String::new()),
        ("KEYCLOAK_ADMIN", "admin".to_owned()),
        ("KEYCLOAK_ADMIN_PASSWORD", keycloak_admin_password),
        ("KEYCLOAK_DB_PASSWORD", keycloak_db_password),
        ("POSTGRES_USER", "kodera".to_owned()),
        ("POSTGRES_DB", "kodera_server".to_owned()),
        ("POSTGRES_PASSWORD", postgres_password),
        ("KODERA_API_DATABASE_PASSWORD", api_db_password),
        ("KODERA_COLLAB_DATABASE_PASSWORD", collab_db_password),
        ("SYNAPSE_POSTGRES_PASSWORD", synapse_db_password),
        ("DJANGO_SECRET_KEY", django_secret_key),
        ("KODERA_CONTACT_SEAL_KEY", contact_seal_key),
        ("KODERA_OUTBOX_SEAL_KEY", outbox_seal_key),
        ("KODERA_MEMBERSHIP_CURSOR_KEY", membership_cursor_key),
    ];

    let extra_pairs: [(&str, String); 6] = [
        ("KODERA_DISCOVERY_HMAC_KEY", discovery_hmac_key),
        ("KODERA_COLLAB_TICKET_KEY", collab_ticket_key),
        ("ROOM_ACCESS_MATRIX_TOKEN", room_access_matrix_token),
        ("LIVEKIT_API_KEY", livekit_api_key),
        ("LIVEKIT_API_SECRET", livekit_api_secret),
        ("KODERA_MATRIX_PARTNER_CHANNELS", String::new()),
    ];

    let mut out = String::with_capacity(2048);
    out.push_str("# Generated by Kodera Desktop Self-Host Wizard (mode 0600)\n");
    for (key, value) in pairs.iter().chain(extra_pairs.iter()) {
        if value.chars().any(|ch| ch.is_control()) {
            return Err(CommunityDeployError::EnvWriteFailed);
        }
        out.push_str(key);
        out.push('=');
        out.push_str(value);
        out.push('\n');
    }

    let generated_secret_keys = vec![
        "POSTGRES_PASSWORD".to_owned(),
        "KODERA_API_DATABASE_PASSWORD".to_owned(),
        "KODERA_COLLAB_DATABASE_PASSWORD".to_owned(),
        "SYNAPSE_POSTGRES_PASSWORD".to_owned(),
        "DJANGO_SECRET_KEY".to_owned(),
        "KODERA_CONTACT_SEAL_KEY".to_owned(),
        "KODERA_OUTBOX_SEAL_KEY".to_owned(),
        "KODERA_MEMBERSHIP_CURSOR_KEY".to_owned(),
        "KODERA_DISCOVERY_HMAC_KEY".to_owned(),
        "KODERA_COLLAB_TICKET_KEY".to_owned(),
        "ROOM_ACCESS_MATRIX_TOKEN".to_owned(),
        "LIVEKIT_API_KEY".to_owned(),
        "LIVEKIT_API_SECRET".to_owned(),
        "KODERA_SYNAPSE_OIDC_CLIENT_SECRET".to_owned(),
        "KEYCLOAK_ADMIN_PASSWORD".to_owned(),
        "KEYCLOAK_DB_PASSWORD".to_owned(),
    ];

    Ok((out, generated_secret_keys))
}

pub(super) fn create_dotenv_candidate_0600(
    stack_dir: &Path,
    contents: &[u8],
) -> Result<PathBuf, CommunityDeployError> {
    let suffix = csprng_hex(8)?;
    let tmp_path = stack_dir.join(format!(".env.kodera-tmp-{suffix}"));

    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }

    let mut file = opts
        .open(&tmp_path)
        .map_err(|_| CommunityDeployError::EnvWriteFailed)?;
    if file.write_all(contents).is_err() || file.sync_all().is_err() {
        let _ = fs::remove_file(&tmp_path);
        return Err(CommunityDeployError::EnvWriteFailed);
    }
    drop(file);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600)).is_err() {
            let _ = fs::remove_file(&tmp_path);
            return Err(CommunityDeployError::EnvWriteFailed);
        }
    }

    Ok(tmp_path)
}

pub(super) fn publish_candidate_dotenv_no_replace(
    candidate_path: &Path,
    env_path: &Path,
) -> Result<u32, CommunityDeployError> {
    match fs::symlink_metadata(env_path) {
        Ok(meta) => {
            let _ = fs::remove_file(candidate_path);
            if meta.file_type().is_symlink() {
                return Err(CommunityDeployError::SymlinkRejected);
            }
            return Err(CommunityDeployError::EnvAlreadyExists);
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {
            let _ = fs::remove_file(candidate_path);
            return Err(CommunityDeployError::EnvWriteFailed);
        }
    }

    match fs::hard_link(candidate_path, env_path) {
        Ok(()) => {
            let _ = fs::remove_file(candidate_path);
        }
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            let _ = fs::remove_file(candidate_path);
            return Err(CommunityDeployError::EnvAlreadyExists);
        }
        Err(_) => {
            let _ = fs::remove_file(candidate_path);
            return Err(CommunityDeployError::EnvWriteFailed);
        }
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = match fs::symlink_metadata(env_path) {
            Ok(m) => m,
            Err(_) => {
                let _ = fs::remove_file(candidate_path);
                return Err(CommunityDeployError::EnvWriteFailed);
            }
        };
        if meta.file_type().is_symlink() {
            let _ = fs::remove_file(candidate_path);
            return Err(CommunityDeployError::SymlinkRejected);
        }
        let mode = meta.permissions().mode() & 0o777;
        if mode != 0o600 {
            let _ = fs::remove_file(candidate_path);
            return Err(CommunityDeployError::EnvPermissionsInsecure);
        }
        Ok(mode)
    }
    #[cfg(not(unix))]
    {
        Ok(0)
    }
}

pub(super) struct PreparedDotenvPolicy {
    pub(super) external_oidc_configured: bool,
    pub(super) configured_source_root: Option<PathBuf>,
}

fn unquote_dotenv_simple_value(raw: &str) -> Result<&str, CommunityDeployError> {
    let trimmed = raw.trim();
    if trimmed.chars().any(char::is_control) {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    if trimmed.starts_with('\'') {
        let Some(inner) = trimmed
            .strip_prefix('\'')
            .and_then(|s| s.strip_suffix('\''))
        else {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        };
        if inner.contains('\'') {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
        return Ok(inner);
    }
    if trimmed.starts_with('"') {
        let Some(inner) = trimmed.strip_prefix('"').and_then(|s| s.strip_suffix('"')) else {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        };
        if inner.contains('"') || inner.contains('\\') || inner.contains('$') || inner.contains('`')
        {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
        return Ok(inner);
    }
    if trimmed.contains('\'')
        || trimmed.contains('"')
        || trimmed.contains('$')
        || trimmed.contains('\\')
        || trimmed.contains('`')
        || trimmed.contains('#')
    {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    Ok(trimmed)
}

pub(super) fn verify_prepared_dotenv(
    env_path: &Path,
) -> Result<PreparedDotenvPolicy, CommunityDeployError> {
    let meta = fs::symlink_metadata(env_path).map_err(|_| CommunityDeployError::EnvFileMissing)?;
    if meta.file_type().is_symlink() {
        return Err(CommunityDeployError::SymlinkRejected);
    }
    if !meta.file_type().is_file() || meta.len() == 0 || meta.len() > 65_536 {
        return Err(CommunityDeployError::EnvFileMissing);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode() & 0o777;
        if (mode & 0o077) != 0 {
            return Err(CommunityDeployError::EnvPermissionsInsecure);
        }
    }

    let raw = fs::read_to_string(env_path).map_err(|_| CommunityDeployError::EnvFileMissing)?;
    if raw.contains('\0') {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

    let mut has_https_oidc_origin = false;
    let mut configured_source_root: Option<PathBuf> = None;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let assignment = trimmed
            .strip_prefix("export")
            .filter(|rest| rest.starts_with(char::is_whitespace))
            .map(str::trim_start)
            .unwrap_or(trimmed);
        let Some((raw_key, raw_val)) = assignment.split_once('=') else {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        };
        let key = raw_key.trim();
        if key.is_empty()
            || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            || key.as_bytes()[0].is_ascii_digit()
        {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }

        match key {
            "COMPOSE_FILE"
            | "COMPOSE_PATH_SEPARATOR"
            | "COMPOSE_PROJECT_DIR"
            | "COMPOSE_ENV_FILES"
            | "DOCKER_HOST"
            | "DOCKER_CONTEXT"
            | "DOCKER_CONFIG" => {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            }
            "KODERA_OIDC_PROVIDER_ORIGIN" => {
                if let Ok(unquoted) = unquote_dotenv_simple_value(raw_val) {
                    if validate_oidc_provider_origin(unquoted).is_ok() {
                        has_https_oidc_origin = true;
                    }
                }
            }
            "KODERA_MEDIA_SECRETS_SOURCE" => {
                let unquoted = unquote_dotenv_simple_value(raw_val)?;
                if !unquoted.is_empty()
                    && (unquoted.len() > 64
                        || !unquoted
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')))
                {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
            }
            "KODERA_SOURCE_DIR" => {
                if configured_source_root.is_some() {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
                let unquoted = unquote_dotenv_simple_value(raw_val)?;
                if unquoted.is_empty() {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
                let verified_root = verify_kodera_source_root(Path::new(unquoted))?;
                configured_source_root = Some(verified_root);
            }
            _ => {}
        }
    }

    Ok(PreparedDotenvPolicy {
        external_oidc_configured: has_https_oidc_origin,
        configured_source_root,
    })
}
