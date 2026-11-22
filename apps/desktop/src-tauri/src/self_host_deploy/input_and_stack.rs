//! Domain, ACME email, OIDC origin, port, and local stack directory path validators.

use super::compose_yaml::validate_compose_file_policy;
use super::dotenv::csprng_hex;
use super::{
    CommunityDeployError, MAX_DOMAIN_BYTES, MAX_EMAIL_BYTES, MAX_OIDC_ORIGIN_BYTES,
    MAX_STACK_DIR_BYTES, SHELL_METACHARS,
};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

pub(super) fn validate_ports(http_port: u16, https_port: u16) -> Result<(), CommunityDeployError> {
    if http_port == 0 || https_port == 0 || http_port == https_port {
        return Err(CommunityDeployError::InvalidPort);
    }
    Ok(())
}

fn has_unsafe_input_chars(raw: &str) -> bool {
    raw.chars()
        .any(|ch| ch.is_control() || ch.is_whitespace() || SHELL_METACHARS.contains(&ch))
}

pub(super) fn validate_and_normalize_domain(raw: &str) -> Result<String, CommunityDeployError> {
    if raw.is_empty()
        || raw.len() > MAX_DOMAIN_BYTES
        || has_unsafe_input_chars(raw)
        || raw.contains("..")
    {
        return Err(CommunityDeployError::InvalidDomain);
    }
    let normalized = raw.to_ascii_lowercase();
    if normalized.starts_with('.') || normalized.ends_with('.') {
        return Err(CommunityDeployError::InvalidDomain);
    }
    let labels: Vec<&str> = normalized.split('.').collect();
    if labels.len() < 2 {
        return Err(CommunityDeployError::InvalidDomain);
    }
    let all_numeric = labels
        .iter()
        .all(|label| !label.is_empty() && label.bytes().all(|b| b.is_ascii_digit()));
    if all_numeric {
        return Err(CommunityDeployError::InvalidDomain);
    }
    for label in &labels {
        if label.is_empty()
            || label.len() > 63
            || label.starts_with('-')
            || label.ends_with('-')
            || !label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(CommunityDeployError::InvalidDomain);
        }
    }
    let tld = labels.last().copied().unwrap_or("");
    if tld.len() < 2 || !tld.bytes().all(|b| b.is_ascii_lowercase()) {
        return Err(CommunityDeployError::InvalidDomain);
    }
    Ok(normalized)
}

pub(super) fn derive_matrix_base_domain(normalized_domain: &str) -> String {
    let labels: Vec<&str> = normalized_domain.split('.').collect();
    if labels.len() >= 3 {
        labels[1..].join(".")
    } else {
        normalized_domain.to_owned()
    }
}

pub(super) fn validate_acme_email(raw: &str) -> Result<String, CommunityDeployError> {
    if raw.is_empty()
        || raw.len() > MAX_EMAIL_BYTES
        || has_unsafe_input_chars(raw)
        || raw.contains("..")
    {
        return Err(CommunityDeployError::InvalidAcmeEmail);
    }
    let Some((local, domain)) = raw.split_once('@') else {
        return Err(CommunityDeployError::InvalidAcmeEmail);
    };
    if local.is_empty()
        || local.len() > 64
        || local.starts_with('.')
        || local.ends_with('.')
        || domain.contains('@')
    {
        return Err(CommunityDeployError::InvalidAcmeEmail);
    }
    if !local
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'))
    {
        return Err(CommunityDeployError::InvalidAcmeEmail);
    }
    let normalized_domain = validate_and_normalize_domain(domain)
        .map_err(|_| CommunityDeployError::InvalidAcmeEmail)?;
    Ok(format!("{local}@{normalized_domain}"))
}

pub(super) fn validate_oidc_provider_origin(raw: &str) -> Result<String, CommunityDeployError> {
    if raw.is_empty()
        || raw.len() > MAX_OIDC_ORIGIN_BYTES
        || has_unsafe_input_chars(raw)
        || raw.contains("..")
    {
        return Err(CommunityDeployError::InvalidOidcOrigin);
    }
    let Some(rest) = raw.strip_prefix("https://") else {
        return Err(CommunityDeployError::InvalidOidcOrigin);
    };
    if rest.is_empty()
        || rest.contains('/')
        || rest.contains('?')
        || rest.contains('#')
        || rest.contains('@')
    {
        return Err(CommunityDeployError::InvalidOidcOrigin);
    }
    let (host_part, port_suffix) = match rest.split_once(':') {
        Some((h, p)) => {
            if p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()) {
                return Err(CommunityDeployError::InvalidOidcOrigin);
            }
            let port: u16 = p
                .parse()
                .map_err(|_| CommunityDeployError::InvalidOidcOrigin)?;
            if port == 0 {
                return Err(CommunityDeployError::InvalidOidcOrigin);
            }
            if port == 443 {
                (h, String::new())
            } else {
                (h, format!(":{port}"))
            }
        }
        None => (rest, String::new()),
    };
    let normalized_host = validate_and_normalize_domain(host_part)
        .map_err(|_| CommunityDeployError::InvalidOidcOrigin)?;
    Ok(format!("https://{normalized_host}{port_suffix}"))
}

/// Canonicalizes and validates a local Community stack directory for native operator authorization
/// before any WebView IPC `self_host_*` invocation is permitted against it.
pub fn canonicalize_authorized_stack_dir(raw_dir: &str) -> Result<PathBuf, CommunityDeployError> {
    let (canonical_dir, _canonical_compose) = validate_stack_dir_and_compose(raw_dir, false)?;
    Ok(canonical_dir)
}

pub(super) fn is_unc_or_network_share_str(raw: &str) -> bool {
    if raw.starts_with("//") {
        return true;
    }
    if let Some(after_ext) = raw.strip_prefix("\\\\?\\") {
        return after_ext
            .get(..4)
            .is_some_and(|p| p.eq_ignore_ascii_case("unc\\"));
    }
    raw.starts_with("\\\\")
}

pub(super) fn has_sensitive_credential_segment(path: &Path) -> bool {
    for comp in path.components() {
        if let Component::Normal(segment) = comp {
            if let Some(seg) = segment.to_str() {
                if matches!(
                    seg.to_ascii_lowercase().as_str(),
                    ".ssh" | ".gnupg" | ".aws" | ".kube" | ".docker" | "keychains"
                ) {
                    return true;
                }
            }
        }
    }
    false
}

pub(super) fn is_sensitive_stack_root(canonical_dir: &Path) -> bool {
    if canonical_dir.parent().is_none() {
        return true;
    }

    if let Some(raw_str) = canonical_dir.to_str() {
        if is_unc_or_network_share_str(raw_str) {
            return true;
        }
    }

    let sensitive_prefixes = [
        "/tmp",
        "/private/tmp",
        "/var/tmp",
        "/private/var/tmp",
        "/var/folders",
        "/private/var/folders",
        "/dev/shm",
        "/etc",
        "/private/etc",
        "/usr",
        "/bin",
        "/sbin",
        "/lib",
        "/lib64",
        "/boot",
        "/proc",
        "/sys",
        "/dev",
        "/root",
        "/var/root",
        "/private/var/root",
        "/var/run",
        "/private/var/run",
        "/var/db",
        "/private/var/db",
        "/System",
        "/Library",
        "/Applications",
    ];
    for prefix in sensitive_prefixes {
        if canonical_dir.starts_with(Path::new(prefix)) {
            return true;
        }
    }

    if let Some(raw_str) = canonical_dir.to_str() {
        let lower = raw_str.to_ascii_lowercase().replace('/', "\\");
        let trimmed = lower.strip_prefix("\\\\?\\").unwrap_or(&lower);
        if trimmed.starts_with("unc\\") || trimmed.starts_with("\\\\") {
            return true;
        }
        for win_prefix in [
            "c:\\windows",
            "c:\\temp",
            "c:\\program files",
            "c:\\program files (x86)",
            "c:\\programdata",
        ] {
            if trimmed == win_prefix || trimmed.starts_with(&format!("{win_prefix}\\")) {
                return true;
            }
        }
    }

    let normal_segments: Vec<&str> = canonical_dir
        .components()
        .filter_map(|comp| match comp {
            Component::Normal(seg) => seg.to_str(),
            _ => None,
        })
        .collect();
    if let Some(&first) = normal_segments.first() {
        if (first.eq_ignore_ascii_case("users") || first.eq_ignore_ascii_case("home"))
            && normal_segments.len() <= 2
        {
            return true;
        }
    }

    for env_key in ["HOME", "USERPROFILE"] {
        if let Some(home_raw) = std::env::var_os(env_key) {
            if let Ok(canonical_home) = fs::canonicalize(&home_raw) {
                if canonical_dir == canonical_home {
                    return true;
                }
            }
        }
    }

    has_sensitive_credential_segment(canonical_dir)
}

pub(super) fn validate_stack_dir_and_compose(
    raw_dir: &str,
    verify_writable: bool,
) -> Result<(PathBuf, PathBuf), CommunityDeployError> {
    if raw_dir.is_empty()
        || raw_dir.len() > MAX_STACK_DIR_BYTES
        || is_unc_or_network_share_str(raw_dir)
    {
        return Err(CommunityDeployError::InvalidStackDir);
    }
    if raw_dir.chars().any(|ch| {
        ch.is_control()
            || matches!(
                ch,
                ';' | '|' | '&' | '$' | '`' | '>' | '<' | '*' | '?' | '\'' | '"' | '\n' | '\r'
            )
    }) {
        return Err(CommunityDeployError::InvalidStackDir);
    }

    let candidate = Path::new(raw_dir);
    if !candidate.is_absolute()
        || candidate
            .components()
            .any(|comp| matches!(comp, Component::ParentDir))
    {
        return Err(CommunityDeployError::InvalidStackDir);
    }

    let dir_meta =
        fs::symlink_metadata(candidate).map_err(|_| CommunityDeployError::InvalidStackDir)?;
    if dir_meta.file_type().is_symlink() {
        return Err(CommunityDeployError::SymlinkRejected);
    }
    if !dir_meta.file_type().is_dir() {
        return Err(CommunityDeployError::InvalidStackDir);
    }

    let canonical_dir =
        fs::canonicalize(candidate).map_err(|_| CommunityDeployError::InvalidStackDir)?;
    if is_sensitive_stack_root(&canonical_dir) {
        return Err(CommunityDeployError::InvalidStackDir);
    }

    let compose_path = candidate.join("docker-compose.yml");
    let compose_meta = fs::symlink_metadata(&compose_path)
        .map_err(|_| CommunityDeployError::ComposeFileMissing)?;
    if compose_meta.file_type().is_symlink() {
        return Err(CommunityDeployError::SymlinkRejected);
    }
    if !compose_meta.file_type().is_file() || compose_meta.len() == 0 {
        return Err(CommunityDeployError::ComposeFileMissing);
    }

    for local_bind_rel in [
        "Caddyfile",
        "Caddyfile.split",
        "configure_synapse.py",
        "livekit.yaml",
    ] {
        let local_bind_path = canonical_dir.join(local_bind_rel);
        if let Ok(bind_meta) = fs::symlink_metadata(&local_bind_path) {
            if bind_meta.file_type().is_symlink() {
                return Err(CommunityDeployError::SymlinkRejected);
            }
            if !bind_meta.file_type().is_file() {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            }
        }
    }

    let canonical_compose = canonical_dir.join("docker-compose.yml");
    validate_compose_file_policy(&canonical_compose)?;

    if verify_writable {
        fs::read_dir(&canonical_dir).map_err(|_| CommunityDeployError::StackDirNotWritable)?;
        let probe_suffix = csprng_hex(8)?;
        let probe_path = canonical_dir.join(format!(".kodera-preflight-{probe_suffix}.tmp"));
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut handle = opts
            .open(&probe_path)
            .map_err(|_| CommunityDeployError::StackDirNotWritable)?;
        if handle.write_all(b"ok\n").is_err() {
            let _ = fs::remove_file(&probe_path);
            return Err(CommunityDeployError::StackDirNotWritable);
        }
        drop(handle);
        let _ = fs::remove_file(&probe_path);
    }

    Ok((canonical_dir, canonical_compose))
}
