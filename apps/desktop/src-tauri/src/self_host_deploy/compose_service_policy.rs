//! Per-service Compose image digest, build context, volume bind, command, entrypoint, and port policies.

use super::compose_yaml::{unquote_yaml_scalar, validate_compose_file_policy};
use super::input_and_stack::{
    has_sensitive_credential_segment, is_sensitive_stack_root, is_unc_or_network_share_str,
    validate_and_normalize_domain, validate_oidc_provider_origin,
};
use super::{CommunityDeployError, ADMITTED_READONLY_BIND_SOURCES};
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ServiceBuildPolicySpec {
    pub(super) context_subpath: &'static str,
    pub(super) dockerfile: &'static str,
    pub(super) allow_vite_args: bool,
}

pub(super) fn expected_service_build_spec(service_name: &str) -> Option<ServiceBuildPolicySpec> {
    match service_name {
        "migrate" => Some(ServiceBuildPolicySpec {
            context_subpath: "apps/server",
            dockerfile: "Dockerfile.migrator",
            allow_vite_args: false,
        }),
        "yjs-collab" => Some(ServiceBuildPolicySpec {
            context_subpath: "apps/server/yjs_collab",
            dockerfile: "Dockerfile",
            allow_vite_args: false,
        }),
        "web" => Some(ServiceBuildPolicySpec {
            context_subpath: "",
            dockerfile: "apps/web/Dockerfile",
            allow_vite_args: true,
        }),
        "agent-state-init"
        | "api-admission"
        | "media-socket-init"
        | "media-storage-worker"
        | "proximity-broker"
        | "proximity-socket-init"
        | "room-access"
        | "server"
        | "tenant-agent" => Some(ServiceBuildPolicySpec {
            context_subpath: "apps/server",
            dockerfile: "Dockerfile",
            allow_vite_args: false,
        }),
        _ => None,
    }
}

pub(super) fn is_admitted_vite_build_arg_key(key: &str) -> bool {
    key.starts_with("VITE_")
        && key.len() > 5
        && key.len() <= 64
        && key
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

fn is_admitted_yaml_source_dir_expr(raw: &str, expected_subpath: &str) -> bool {
    let Some(after_prefix) = raw.strip_prefix("${KODERA_SOURCE_DIR:?") else {
        return false;
    };
    let Some((prompt_msg, suffix)) = after_prefix.split_once('}') else {
        return false;
    };
    if prompt_msg.is_empty()
        || prompt_msg.len() > 128
        || prompt_msg.bytes().any(|b| {
            !b.is_ascii()
                || b.is_ascii_control()
                || matches!(b, b'$' | b'{' | b'}' | b'/' | b'\\' | b':' | b'`')
        })
    {
        return false;
    }
    if expected_subpath.is_empty() {
        suffix.is_empty()
    } else {
        suffix
            .strip_prefix('/')
            .is_some_and(|sub| sub == expected_subpath)
    }
}

pub(super) fn is_admitted_yaml_build_context(raw_context: &str, expected_subpath: &str) -> bool {
    if expected_subpath.is_empty() {
        raw_context == "../.." || is_admitted_yaml_source_dir_expr(raw_context, "")
    } else {
        let rel_ok = raw_context
            .strip_prefix("../../")
            .is_some_and(|sub| sub == expected_subpath);
        rel_ok || is_admitted_yaml_source_dir_expr(raw_context, expected_subpath)
    }
}

const REQUIRED_SOURCE_ROOT_DIRS: &[&str] = &[
    "deploy",
    "deploy/community",
    "apps",
    "apps/server",
    "apps/server/yjs_collab",
    "apps/web",
    "packages",
    "packages/synapse-policy",
];

const REQUIRED_SOURCE_ROOT_DOCKERFILES: &[&str] = &[
    "apps/server/Dockerfile",
    "apps/server/Dockerfile.migrator",
    "apps/server/yjs_collab/Dockerfile",
    "apps/web/Dockerfile",
];

pub(super) fn verify_kodera_source_root(
    candidate_root: &Path,
) -> Result<PathBuf, CommunityDeployError> {
    if candidate_root
        .to_str()
        .is_none_or(is_unc_or_network_share_str)
        || !candidate_root.is_absolute()
        || candidate_root
            .components()
            .any(|comp| matches!(comp, Component::ParentDir))
    {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    let root_meta = fs::symlink_metadata(candidate_root)
        .map_err(|_| CommunityDeployError::ComposeConfigInvalid)?;
    if root_meta.file_type().is_symlink() {
        return Err(CommunityDeployError::SymlinkRejected);
    }
    if !root_meta.file_type().is_dir() {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    let canonical_root =
        fs::canonicalize(candidate_root).map_err(|_| CommunityDeployError::ComposeConfigInvalid)?;
    if is_sensitive_stack_root(&canonical_root) {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

    for rel_dir in REQUIRED_SOURCE_ROOT_DIRS {
        let dir_path = canonical_root.join(rel_dir);
        let meta = fs::symlink_metadata(&dir_path)
            .map_err(|_| CommunityDeployError::ComposeConfigInvalid)?;
        if meta.file_type().is_symlink() {
            return Err(CommunityDeployError::SymlinkRejected);
        }
        if !meta.file_type().is_dir() {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
        let canonical_sub =
            fs::canonicalize(&dir_path).map_err(|_| CommunityDeployError::ComposeConfigInvalid)?;
        if canonical_sub != dir_path {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
    }

    let policy_manifest = canonical_root
        .join("packages")
        .join("synapse-policy")
        .join("pyproject.toml");
    let policy_meta = fs::symlink_metadata(&policy_manifest)
        .map_err(|_| CommunityDeployError::ComposeConfigInvalid)?;
    if policy_meta.file_type().is_symlink() {
        return Err(CommunityDeployError::SymlinkRejected);
    }
    if !policy_meta.file_type().is_file() || policy_meta.len() == 0 || policy_meta.len() > 65_536 {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

    let community_compose = canonical_root
        .join("deploy")
        .join("community")
        .join("docker-compose.yml");
    validate_compose_file_policy(&community_compose)?;

    for rel_df in REQUIRED_SOURCE_ROOT_DOCKERFILES {
        let df_path = canonical_root.join(rel_df);
        let meta = fs::symlink_metadata(&df_path)
            .map_err(|_| CommunityDeployError::ComposeConfigInvalid)?;
        if meta.file_type().is_symlink() {
            return Err(CommunityDeployError::SymlinkRejected);
        }
        if !meta.file_type().is_file() || meta.len() == 0 || meta.len() > 65_536 {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
        let canonical_df =
            fs::canonicalize(&df_path).map_err(|_| CommunityDeployError::ComposeConfigInvalid)?;
        if canonical_df != df_path {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
        let df_text =
            fs::read_to_string(&df_path).map_err(|_| CommunityDeployError::ComposeConfigInvalid)?;
        if df_text.contains('\0')
            || df_text.lines().any(|line| {
                line.trim_start()
                    .to_ascii_lowercase()
                    .starts_with("# syntax=")
            })
            || !df_text
                .lines()
                .any(|line| line.trim_start().to_ascii_uppercase().starts_with("FROM "))
        {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
    }

    Ok(canonical_root)
}

pub(super) fn split_compose_volume_spec(raw: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut brace_depth = 0usize;
    let mut start = 0usize;
    let bytes = raw.as_bytes();
    let mut idx = 0usize;
    while idx < bytes.len() {
        if bytes[idx] == b'$' && bytes.get(idx + 1) == Some(&b'{') {
            brace_depth += 1;
            idx += 2;
            continue;
        }
        if bytes[idx] == b'}' && brace_depth > 0 {
            brace_depth -= 1;
            idx += 1;
            continue;
        }
        if bytes[idx] == b':' && brace_depth == 0 {
            parts.push(&raw[start..idx]);
            start = idx + 1;
        }
        idx += 1;
    }
    parts.push(&raw[start..]);
    parts
}

pub(super) fn is_admitted_named_volume_source(source: &str) -> bool {
    if source == "${KODERA_MEDIA_SECRETS_SOURCE:-media_secrets}" {
        return true;
    }
    !source.is_empty()
        && source.len() <= 64
        && source
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

pub(super) fn validate_compose_volume_entry(entry: &str) -> Result<(), CommunityDeployError> {
    let unquoted = entry
        .trim()
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| {
            entry
                .trim()
                .strip_prefix('\'')
                .and_then(|s| s.strip_suffix('\''))
        })
        .unwrap_or_else(|| entry.trim());
    if unquoted.is_empty() || unquoted.to_ascii_lowercase().contains("docker.sock") {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

    let parts = split_compose_volume_spec(unquoted);
    if parts.len() < 2 || parts.len() > 3 {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    let source = parts[0].trim();
    let target = parts[1].trim();
    let mode = parts.get(2).map(|m| m.trim());

    if source.is_empty() || !target.starts_with('/') || target == "/" {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

    let is_source_dir_synapse_policy =
        is_admitted_yaml_source_dir_expr(source, "packages/synapse-policy");
    if ADMITTED_READONLY_BIND_SOURCES.contains(&source) || is_source_dir_synapse_policy {
        if mode != Some("ro") {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
        return Ok(());
    }

    if is_admitted_named_volume_source(source) {
        if let Some(m) = mode {
            if !matches!(m, "ro" | "rw") {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            }
        }
        return Ok(());
    }

    Err(CommunityDeployError::ComposeConfigInvalid)
}

fn get_or_verify_source_root<'a>(
    canonical_stack_dir: &Path,
    cached_root: &'a mut Option<PathBuf>,
) -> Result<&'a Path, CommunityDeployError> {
    if cached_root.is_none() {
        let candidate = canonical_stack_dir
            .parent()
            .and_then(Path::parent)
            .ok_or(CommunityDeployError::ComposeConfigInvalid)?;
        let verified = verify_kodera_source_root(candidate)?;
        *cached_root = Some(verified);
    }
    Ok(cached_root.as_deref().expect("verified source root cached"))
}

pub(super) fn validate_resolved_bind_source(
    source: &str,
    canonical_stack_dir: &Path,
    verified_source_root: &mut Option<PathBuf>,
) -> Result<(), CommunityDeployError> {
    if source.is_empty()
        || source == "/"
        || is_unc_or_network_share_str(source)
        || source.to_ascii_lowercase().contains("docker.sock")
        || source.chars().any(char::is_control)
    {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

    let source_path = Path::new(source);
    if !source_path.is_absolute()
        || source_path
            .components()
            .any(|comp| matches!(comp, Component::ParentDir))
        || has_sensitive_credential_segment(source_path)
    {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

    for rel in [
        "Caddyfile",
        "Caddyfile.split",
        "configure_synapse.py",
        "livekit.yaml",
    ] {
        let expected_local = canonical_stack_dir.join(rel);
        if is_sensitive_stack_root(&expected_local) {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
        if source_path == expected_local {
            if let Ok(meta) = fs::symlink_metadata(&expected_local) {
                if meta.file_type().is_symlink() {
                    return Err(CommunityDeployError::SymlinkRejected);
                }
                if !meta.file_type().is_file() {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
                let canonical_local = fs::canonicalize(&expected_local)
                    .map_err(|_| CommunityDeployError::ComposeConfigInvalid)?;
                if canonical_local != expected_local || is_sensitive_stack_root(&canonical_local) {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
            }
            return Ok(());
        }
        if let Ok(meta) = fs::symlink_metadata(source_path) {
            if !meta.file_type().is_symlink()
                && meta.file_type().is_file()
                && fs::canonicalize(source_path).ok().as_deref() == Some(expected_local.as_path())
            {
                return Ok(());
            }
        }
    }

    let src_root = get_or_verify_source_root(canonical_stack_dir, verified_source_root)?;
    let expected_policy_dir = src_root.join("packages").join("synapse-policy");
    let meta = fs::symlink_metadata(source_path)
        .map_err(|_| CommunityDeployError::ComposeConfigInvalid)?;
    if meta.file_type().is_symlink() {
        return Err(CommunityDeployError::SymlinkRejected);
    }
    if !meta.file_type().is_dir() {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    let canonical_source =
        fs::canonicalize(source_path).map_err(|_| CommunityDeployError::ComposeConfigInvalid)?;
    if canonical_source == expected_policy_dir && !is_sensitive_stack_root(&canonical_source) {
        return Ok(());
    }

    Err(CommunityDeployError::ComposeConfigInvalid)
}

pub(super) fn is_admitted_service_image(service_name: &str, raw_image: &str) -> bool {
    if raw_image.is_empty()
        || raw_image.len() > 256
        || raw_image
            .bytes()
            .any(|b| !b.is_ascii() || b.is_ascii_control() || b.is_ascii_whitespace())
        || raw_image.contains('$')
        || raw_image.contains('{')
        || raw_image.contains('}')
    {
        return false;
    }
    let Some((repo_and_tag, digest_hex)) = raw_image.split_once("@sha256:") else {
        return false;
    };
    if digest_hex.len() != 64
        || !digest_hex
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
        || repo_and_tag.is_empty()
        || repo_and_tag.contains('@')
        || repo_and_tag.contains("..")
    {
        return false;
    }
    let (repo, tag_opt) = match repo_and_tag.split_once(':') {
        Some((r, t)) => (r, Some(t)),
        None => (repo_and_tag, None),
    };
    if repo.is_empty()
        || tag_opt.is_some_and(|t| t.is_empty() || t.contains(':') || t.contains('/'))
    {
        return false;
    }
    match service_name {
        "caddy" => matches!(repo, "caddy" | "docker.io/library/caddy"),
        "db" | "keycloak-db" | "synapse-db" => {
            matches!(repo, "postgres" | "docker.io/library/postgres")
        }
        "keycloak" => matches!(repo, "quay.io/keycloak/keycloak"),
        "livekit" => matches!(
            repo,
            "livekit/livekit-server" | "docker.io/livekit/livekit-server"
        ),
        "synapse" => matches!(
            repo,
            "matrixdotorg/synapse"
                | "docker.io/matrixdotorg/synapse"
                | "ghcr.io/element-hq/synapse"
        ),
        "valkey" => matches!(repo, "valkey/valkey" | "docker.io/valkey/valkey"),
        s if expected_service_build_spec(s).is_some() => {
            repo.starts_with("ghcr.io/kodera/") || repo.starts_with("kodera-")
        }
        _ => false,
    }
}

pub(super) const CANONICAL_SYNAPSE_ENTRYPOINT_SCRIPT: &str = concat!(
    "set -eu\n",
    "rm -rf /tmp/kodera-policy-src /tmp/kodera-policy\n",
    "cp -R /opt/kodera-policy /tmp/kodera-policy-src\n",
    "python -m pip install --no-index --no-deps --no-build-isolation --target /tmp/kodera-policy /tmp/kodera-policy-src\n",
    "if [ ! -f /data/homeserver.yaml ]; then\n",
    "  /start.py generate\n",
    "fi\n",
    "python /opt/community/configure_synapse.py /data/homeserver.yaml\n",
    "exec /start.py",
);

const CANONICAL_MIGRATE_COMMAND_SCRIPT: &str = concat!(
    "python manage.py migrate --noinput --settings config.settings.deploy &&\n",
    "python manage.py migrate --noinput --settings config.settings.deploy_operator &&\n",
    "python manage.py configure_api_role --settings config.settings.deploy &&\n",
    "python manage.py configure_collab_role --settings config.settings.deploy &&\n",
    "if [ -n \"$KODERA_DEFAULT_COMMUNITY_ORG_SLUG\" ]; then\n",
    "  python manage.py bootstrap_community_workspace --settings config.settings.deploy\n",
    "fi",
);

const CANONICAL_WEB_ENTRYPOINT_SCRIPT: &str = concat!(
    "if [ -n \"${KODERA_ATTACHMENT_BASE:-}\" ]; then ",
    "set -- \"$@\" --attachment-base \"$KODERA_ATTACHMENT_BASE\"; ",
    "fi; ",
    "exec node /app/static.mjs --root /srv/console --host 0.0.0.0 \"$@\"",
);

pub(super) fn matches_canonical_synapse_entrypoint_script(raw_script: &str) -> bool {
    let normalized = raw_script.replace("\r\n", "\n");
    normalized.trim_end_matches('\n') == CANONICAL_SYNAPSE_ENTRYPOINT_SCRIPT
}

pub(super) fn matches_canonical_web_entrypoint_script(raw_script: &str) -> bool {
    let normalized = raw_script.replace("\r\n", "\n").replace("$$", "$");
    normalized.trim_end_matches('\n') == CANONICAL_WEB_ENTRYPOINT_SCRIPT
}

pub(super) fn matches_canonical_migrate_command_script(raw_script: &str) -> bool {
    let normalized = raw_script.replace("\r\n", "\n").replace(
        "$$KODERA_DEFAULT_COMMUNITY_ORG_SLUG",
        "$KODERA_DEFAULT_COMMUNITY_ORG_SLUG",
    );
    normalized.trim_end_matches('\n') == CANONICAL_MIGRATE_COMMAND_SCRIPT
}

pub(super) fn validate_resolved_service_entrypoint(
    service_name: &str,
    val: &serde_json::Value,
) -> Result<(), CommunityDeployError> {
    if val.is_null() {
        return Ok(());
    }
    let Some(items) = val.as_array() else {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    };
    match service_name {
        "synapse" => {
            if items.len() != 3
                || items[0].as_str() != Some("/bin/sh")
                || items[1].as_str() != Some("-c")
                || items[2]
                    .as_str()
                    .is_none_or(|script| !matches_canonical_synapse_entrypoint_script(script))
            {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            }
            Ok(())
        }
        "web" => {
            if items.len() != 4
                || items[0].as_str() != Some("/bin/sh")
                || items[1].as_str() != Some("-ec")
                || items[2]
                    .as_str()
                    .is_none_or(|script| !matches_canonical_web_entrypoint_script(script))
                || items[3].as_str() != Some("sh")
            {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            }
            Ok(())
        }
        _ => Err(CommunityDeployError::ComposeConfigInvalid),
    }
}

pub(super) fn validate_service_command_argv(
    service_name: &str,
    argv: &[&str],
    allow_yaml_templates: bool,
) -> Result<(), CommunityDeployError> {
    let exact_ok = match service_name {
        "agent-state-init" => {
            argv == [
                "python",
                "-c",
                "import os; os.chown('/state', 10001, 10001); os.chmod('/state', 0o700)",
            ]
        }
        "proximity-socket-init" => {
            argv == [
                "python",
                "-c",
                "import os; os.chmod('/run/proximity', 0o700); os.chown('/run/proximity', 10001, 10001)",
            ]
        }
        "proximity-broker" => {
            argv == ["python", "-m", "apps.proximity.broker_rpc", "/run/proximity/broker.sock"]
        }
        "media-socket-init" => {
            argv == [
                "python",
                "-c",
                "import os; from pathlib import Path; Path('/run/kodera-media/media.sock').unlink(missing_ok=True); [(os.chmod(p, 0o700), os.chown(p, 10001, 10001)) for p in ('/run/kodera-media', '/run/kodera-media-secrets')]",
            ]
        }
        "media-storage-worker" => {
            argv == [
                "python",
                "-m",
                "apps.media.storage_worker",
                "--socket",
                "/run/kodera-media/media.sock",
                "--secret-directory",
                "/run/kodera-media-secrets",
            ]
        }
        "migrate" => {
            argv.len() == 3
                && argv[0] == "/bin/sh"
                && argv[1] == "-c"
                && matches_canonical_migrate_command_script(argv[2])
        }
        "tenant-agent" => argv == ["python", "-m", "tenant_agent", "run"],
        "room-access" => argv == ["python", "-m", "room_access"],
        "api-admission" => argv == [
            "python",
            "-m",
            "config.edge_admission",
            "--bind",
            "0.0.0.0:8080",
            "--upstream",
            "server:8000",
            "--require-trusted-edge",
        ],
        "valkey" => argv == ["valkey-server", "--save", "60", "1", "--loglevel", "warning"],
        "livekit" => argv == ["--config", "/etc/livekit.yaml"],
        "keycloak" => argv == ["start", "--optimized"] || argv == ["start"],
        "caddy" => {
            argv.len() == 4
                && argv[0] == "caddy"
                && argv[1] == "reverse-proxy"
                && argv[2] == "--domain"
                && validate_and_normalize_domain(argv[3]).is_ok()
        }
        "web" => {
            if argv.len() != 12
                || argv[..7]
                    != [
                        "--port",
                        "8080",
                        "--prefix",
                        "/",
                        "--claim-path",
                        "/claim",
                        "--core-origin",
                    ]
                || argv[8] != "--provider-origin"
                || argv[10] != "--matrix-domain"
            {
                false
            } else {
                let core_ok = validate_oidc_provider_origin(argv[7]).is_ok()
                    || (allow_yaml_templates
                        && argv[7] == "https://${KODERA_DOMAIN:-chat.example.org}");
                let provider_ok = validate_oidc_provider_origin(argv[9]).is_ok()
                    || (allow_yaml_templates
                        && argv[9].starts_with("${KODERA_OIDC_PROVIDER_ORIGIN:?")
                        && argv[9].ends_with('}'));
                let matrix_ok = validate_and_normalize_domain(argv[11]).is_ok()
                    || (allow_yaml_templates
                        && argv[11].starts_with("${KODERA_MATRIX_DOMAIN:?")
                        && argv[11].ends_with('}'));
                core_ok && provider_ok && matrix_ok
            }
        }
        _ => false,
    };
    if exact_ok {
        Ok(())
    } else {
        Err(CommunityDeployError::ComposeConfigInvalid)
    }
}

pub(super) fn validate_resolved_service_command(
    service_name: &str,
    val: &serde_json::Value,
) -> Result<(), CommunityDeployError> {
    if val.is_null() {
        return Ok(());
    }
    if let Some(cmd_str) = val.as_str() {
        if service_name == "livekit" && cmd_str.trim() == "--config /etc/livekit.yaml" {
            return Ok(());
        }
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    let Some(items) = val.as_array() else {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    };
    let mut argv = Vec::with_capacity(items.len());
    for item in items {
        let Some(s) = item.as_str() else {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        };
        argv.push(s);
    }
    validate_service_command_argv(service_name, &argv, false)
}

fn is_admitted_community_port_range(
    service_name: &str,
    lo: u16,
    hi: u16,
    proto_opt: Option<&str>,
) -> bool {
    if lo == 0 || lo > hi {
        return false;
    }
    let proto = proto_opt.unwrap_or("tcp");
    if !matches!(proto, "tcp" | "udp") {
        return false;
    }
    if lo < hi {
        return service_name == "livekit" && proto == "udp" && lo >= 50_000 && hi <= 60_000;
    }
    match service_name {
        "caddy" => (lo == 80 && proto == "tcp") || lo == 443,
        "livekit" => {
            (matches!(lo, 7880 | 7881 | 5349) && proto == "tcp")
                || (matches!(lo, 7882 | 3478) && proto == "udp")
                || ((50_000..=60_000).contains(&lo) && proto == "udp")
        }
        _ => false,
    }
}

fn parse_port_or_range(raw: &str) -> Option<(u16, u16)> {
    if let Some((lo_str, hi_str)) = raw.split_once('-') {
        let lo = lo_str.parse::<u16>().ok()?;
        let hi = hi_str.parse::<u16>().ok()?;
        if lo == 0 || lo > hi {
            return None;
        }
        Some((lo, hi))
    } else {
        let p = raw.parse::<u16>().ok()?;
        if p == 0 {
            return None;
        }
        Some((p, p))
    }
}

pub(super) fn validate_yaml_port_entry(
    service_name: &str,
    raw_entry: &str,
) -> Result<(), CommunityDeployError> {
    if !matches!(service_name, "caddy" | "livekit") {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    let unquoted = unquote_yaml_scalar(raw_entry)?;
    if unquoted.is_empty() || unquoted.contains('$') {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    let (without_proto, proto_opt) = match unquoted.split_once('/') {
        Some((head, proto @ ("tcp" | "udp"))) => (head, Some(proto)),
        Some(_) => return Err(CommunityDeployError::ComposeConfigInvalid),
        None => (unquoted, None),
    };
    let parts: Vec<&str> = without_proto.split(':').collect();
    match parts.as_slice() {
        [published_raw, target_raw] => {
            let (pub_lo, pub_hi) = parse_port_or_range(published_raw)
                .ok_or(CommunityDeployError::ComposeConfigInvalid)?;
            let (tgt_lo, tgt_hi) = parse_port_or_range(target_raw)
                .ok_or(CommunityDeployError::ComposeConfigInvalid)?;
            if !is_admitted_community_port_range(service_name, pub_lo, pub_hi, proto_opt)
                || !is_admitted_community_port_range(service_name, tgt_lo, tgt_hi, proto_opt)
            {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            }
            Ok(())
        }
        ["127.0.0.1", published_raw, target_raw] => {
            let (pub_lo, pub_hi) = parse_port_or_range(published_raw)
                .ok_or(CommunityDeployError::ComposeConfigInvalid)?;
            let (tgt_lo, tgt_hi) = parse_port_or_range(target_raw)
                .ok_or(CommunityDeployError::ComposeConfigInvalid)?;
            if pub_lo != pub_hi
                || pub_lo == 22
                || !is_admitted_community_port_range(service_name, tgt_lo, tgt_hi, proto_opt)
            {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            }
            Ok(())
        }
        _ => Err(CommunityDeployError::ComposeConfigInvalid),
    }
}

pub(super) fn validate_resolved_service_ports(
    service_name: &str,
    val: &serde_json::Value,
) -> Result<(), CommunityDeployError> {
    if !matches!(service_name, "caddy" | "livekit") {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    let Some(ports) = val.as_array() else {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    };
    for entry in ports {
        if let Some(short_str) = entry.as_str() {
            validate_yaml_port_entry(service_name, short_str)?;
        } else if let Some(pobj) = entry.as_object() {
            for pk in pobj.keys() {
                if !matches!(
                    pk.as_str(),
                    "mode" | "target" | "published" | "protocol" | "host_ip" | "app_protocol"
                ) {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
            }
            let proto_opt = match pobj.get("protocol") {
                Some(serde_json::Value::String(p)) if matches!(p.as_str(), "tcp" | "udp") => {
                    Some(p.as_str())
                }
                None => None,
                _ => return Err(CommunityDeployError::ComposeConfigInvalid),
            };
            let Some(target_u64) = pobj.get("target").and_then(serde_json::Value::as_u64) else {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            };
            let Ok(target_port) = u16::try_from(target_u64) else {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            };
            if !is_admitted_community_port_range(service_name, target_port, target_port, proto_opt)
            {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            }

            let (pub_lo, pub_hi) = match pobj.get("published") {
                Some(serde_json::Value::String(s)) => {
                    parse_port_or_range(s).ok_or(CommunityDeployError::ComposeConfigInvalid)?
                }
                Some(serde_json::Value::Number(n)) => {
                    let raw = n
                        .as_u64()
                        .and_then(|v| u16::try_from(v).ok())
                        .filter(|p| *p > 0)
                        .ok_or(CommunityDeployError::ComposeConfigInvalid)?;
                    (raw, raw)
                }
                _ => return Err(CommunityDeployError::ComposeConfigInvalid),
            };

            let host_ip = pobj.get("host_ip").and_then(serde_json::Value::as_str);
            if host_ip == Some("127.0.0.1") {
                if pub_lo != pub_hi || pub_lo == 22 {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
            } else {
                if let Some(ip) = host_ip {
                    if !matches!(ip, "" | "0.0.0.0" | "::") {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    }
                }
                if !is_admitted_community_port_range(service_name, pub_lo, pub_hi, proto_opt) {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
            }
        } else {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
    }
    Ok(())
}

pub(super) fn validate_resolved_service_build(
    service_name: &str,
    val: &serde_json::Value,
    canonical_stack_dir: &Path,
    verified_source_root: &mut Option<PathBuf>,
) -> Result<(), CommunityDeployError> {
    let Some(spec) = expected_service_build_spec(service_name) else {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    };
    let Some(build_obj) = val.as_object() else {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    };

    for (bk, bv) in build_obj {
        match bk.as_str() {
            "context" | "dockerfile" => {}
            "args" if spec.allow_vite_args => {
                let Some(args_obj) = bv.as_object() else {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                };
                for (arg_k, arg_v) in args_obj {
                    if !is_admitted_vite_build_arg_key(arg_k)
                        || arg_v
                            .as_str()
                            .is_none_or(|s| s.chars().any(char::is_control))
                    {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    }
                }
            }
            _ => return Err(CommunityDeployError::ComposeConfigInvalid),
        }
    }

    let Some(context_str) = build_obj.get("context").and_then(serde_json::Value::as_str) else {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    };
    let Some(dockerfile_str) = build_obj
        .get("dockerfile")
        .and_then(serde_json::Value::as_str)
    else {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    };

    if dockerfile_str != spec.dockerfile || context_str.chars().any(char::is_control) {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

    let context_path = Path::new(context_str);
    if !context_path.is_absolute()
        || context_path
            .components()
            .any(|comp| matches!(comp, Component::ParentDir))
    {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

    let src_root = get_or_verify_source_root(canonical_stack_dir, verified_source_root)?;
    let expected_context_dir = if spec.context_subpath.is_empty() {
        src_root.to_path_buf()
    } else {
        src_root.join(spec.context_subpath)
    };

    let ctx_meta = fs::symlink_metadata(context_path)
        .map_err(|_| CommunityDeployError::ComposeConfigInvalid)?;
    if ctx_meta.file_type().is_symlink() {
        return Err(CommunityDeployError::SymlinkRejected);
    }
    if !ctx_meta.file_type().is_dir() {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    let canonical_ctx =
        fs::canonicalize(context_path).map_err(|_| CommunityDeployError::ComposeConfigInvalid)?;
    if canonical_ctx != expected_context_dir {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

    let expected_dockerfile_path = expected_context_dir.join(spec.dockerfile);
    let df_meta = fs::symlink_metadata(&expected_dockerfile_path)
        .map_err(|_| CommunityDeployError::ComposeConfigInvalid)?;
    if df_meta.file_type().is_symlink() {
        return Err(CommunityDeployError::SymlinkRejected);
    }
    if !df_meta.file_type().is_file() || df_meta.len() == 0 {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    let canonical_df = fs::canonicalize(&expected_dockerfile_path)
        .map_err(|_| CommunityDeployError::ComposeConfigInvalid)?;
    if canonical_df != expected_dockerfile_path {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

    Ok(())
}
