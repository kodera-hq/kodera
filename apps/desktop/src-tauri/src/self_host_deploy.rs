//! Automated local `deploy/community` Docker Compose driver for the Kodera Desktop Self-Host Wizard.
//!
//! Security invariants:
//! - `#![forbid(unsafe_code)]` inherited from the crate root; all process execution uses strict
//!   argv-only `std::process::Command` (`docker` binary only, zero `sh -c` or shell interpolation).
//! - All operator inputs (`stack_dir`, `domain`, `acme_email`, `oidc_provider_origin`, `tls_mode`,
//!   ports) reject control characters, whitespace, newlines, `..` traversal, symlinks, and shell
//!   metacharacters before touching disk or spawning a subprocess.
//! - Generated `.env` secrets come exclusively from the OS CSPRNG (`getrandom::fill`), are written
//!   atomically with `0600` file permissions on Unix, and are never echoed in return values or
//!   error types.

use crate::self_host_health::{
    classify_docker_stderr, inspect_community_compose_ps, DockerUnavailableReason,
    SelfHostHealthError, SelfHostHealthReport, ServiceReadiness,
};
use core::fmt;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// Maximum UTF-8 byte length accepted for a local `deploy/community` directory path.
pub const MAX_STACK_DIR_BYTES: usize = 512;

/// Maximum RFC 1035 / RFC 1123 DNS hostname length.
pub const MAX_DOMAIN_BYTES: usize = 253;

/// Maximum RFC 5321 email address length.
pub const MAX_EMAIL_BYTES: usize = 254;

/// Maximum UTF-8 byte length for an HTTPS OIDC provider origin.
pub const MAX_OIDC_ORIGIN_BYTES: usize = 256;

/// Default bounded timeout (`120s`) for `docker compose up -d --wait` + readiness verification.
pub const DEFAULT_DEPLOY_TIMEOUT_MS: u64 = 120_000;

/// Minimum bounded timeout (`1s`) for `self_host_deploy_community`.
pub const MIN_DEPLOY_TIMEOUT_MS: u64 = 1_000;

/// Maximum bounded timeout (`300s`) for `self_host_deploy_community`.
pub const MAX_DEPLOY_TIMEOUT_MS: u64 = 300_000;

/// Timeout (`5s`) for `docker --version` and `docker compose version` preflight checks.
pub const PREFLIGHT_COMMAND_TIMEOUT_MS: u64 = 5_000;

/// Timeout (`15s`) for `docker compose config --quiet` validation.
pub const COMPOSE_CONFIG_TIMEOUT_MS: u64 = 15_000;

/// Maximum readiness poll iterations after `docker compose up -d --wait` completes.
pub const READINESS_MAX_POLL_ATTEMPTS: u8 = 12;

/// Byte length (`32` bytes -> `64` lowercase hex chars) for hex-encoded secrets.
pub const HEX_SECRET_BYTES: usize = 32;

/// Byte length (`32` bytes -> `44` padded base64 / base64url chars) for 32-byte seal and HMAC keys.
pub const SEAL_KEY_BYTES: usize = 32;

/// Random byte length (`12` bytes -> `lk_` + `24` hex chars) for `LIVEKIT_API_KEY`.
pub const LIVEKIT_KEY_RANDOM_BYTES: usize = 12;

const MAX_COMMAND_STDOUT_BYTES: usize = 65_536;
const MAX_COMMAND_STDERR_BYTES: usize = 8_192;
const MAX_COMPOSE_FILE_BYTES: u64 = 262_144;

const ADMITTED_COMMUNITY_COMPOSE_SERVICES: &[&str] = &[
    "agent-state-init",
    "caddy",
    "db",
    "keycloak",
    "keycloak-db",
    "livekit",
    "media-socket-init",
    "media-storage-worker",
    "migrate",
    "proximity-broker",
    "proximity-socket-init",
    "room-access",
    "server",
    "synapse",
    "synapse-db",
    "tenant-agent",
    "valkey",
    "web",
    "yjs-collab",
];

const ADMITTED_READONLY_BIND_SOURCES: &[&str] = &[
    "./Caddyfile",
    "./Caddyfile.split",
    "./configure_synapse.py",
    "./livekit.yaml",
    "../../packages/synapse-policy",
];

/// Sorted allowlist of the 18 Compose service directives used by canonical Community manifests.
/// Every directive is paired with per-service structural/value validation in both YAML and JSON.
const ADMITTED_COMPOSE_SERVICE_DIRECTIVES: &[&str] = &[
    "build",
    "cap_add",
    "cap_drop",
    "command",
    "depends_on",
    "entrypoint",
    "environment",
    "healthcheck",
    "image",
    "mem_limit",
    "networks",
    "ports",
    "profiles",
    "read_only",
    "restart",
    "security_opt",
    "user",
    "volumes",
];

/// Host-escape and privilege-escalation Compose service directives that are unconditionally denied
/// and compile-time verified disjoint from `ADMITTED_COMPOSE_SERVICE_DIRECTIVES`.
pub const FORBIDDEN_PRIVILEGED_COMPOSE_DIRECTIVES: &[&str] = &[
    "cgroup",
    "cgroup_parent",
    "configs",
    "container_name",
    "devices",
    "dns",
    "env_file",
    "extra_hosts",
    "ipc",
    "network_mode",
    "pid",
    "privileged",
    "secrets",
    "sysctls",
    "tmpfs",
    "ulimits",
    "userns_mode",
    "uts",
];

const SHELL_METACHARS: &[char] = &[
    ';', '|', '&', '$', '`', '>', '<', '*', '?', '(', ')', '[', ']', '{', '}', '!', '\'', '"',
    '\\', '#', '~',
];

const BASE64_STANDARD_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BASE64URL_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// TLS termination mode configured for the local Community reverse proxy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommunityTlsMode {
    Acme,
    Internal,
    Off,
}

impl CommunityTlsMode {
    pub fn parse(raw: &str) -> Result<Self, CommunityDeployError> {
        match raw {
            "acme" => Ok(Self::Acme),
            "internal" => Ok(Self::Internal),
            "off" => Ok(Self::Off),
            _ => Err(CommunityDeployError::InvalidTlsMode),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Acme => "acme",
            Self::Internal => "internal",
            Self::Off => "off",
        }
    }
}

/// Closed error taxonomy for local `deploy/community` preflight, preparation, and deployment.
/// Carries zero raw user inputs, paths, or secret material.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommunityDeployError {
    InvalidStackDir,
    StackDirNotAuthorized,
    StackDirPickerUnavailable,
    SymlinkRejected,
    StackDirNotWritable,
    ComposeFileMissing,
    EnvAlreadyExists,
    EnvFileMissing,
    EnvPermissionsInsecure,
    InvalidDomain,
    InvalidAcmeEmail,
    InvalidOidcOrigin,
    InvalidTlsMode,
    InvalidPort,
    EntropyUnavailable,
    EnvWriteFailed,
    DockerUnavailable(DockerUnavailableReason),
    DockerVersionUnsupported,
    ComposePluginMissing,
    ComposeConfigInvalid,
    ComposeLaunchFailed,
    ReadinessProbeFailed(SelfHostHealthError),
    StackUnhealthy,
}

impl fmt::Display for CommunityDeployError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidStackDir => f.write_str("invalid_stack_dir"),
            Self::StackDirNotAuthorized => f.write_str("stack_dir_not_authorized"),
            Self::StackDirPickerUnavailable => f.write_str("stack_dir_picker_unavailable"),
            Self::SymlinkRejected => f.write_str("symlink_rejected"),
            Self::StackDirNotWritable => f.write_str("stack_dir_not_writable"),
            Self::ComposeFileMissing => f.write_str("compose_file_missing"),
            Self::EnvAlreadyExists => f.write_str("env_already_exists"),
            Self::EnvFileMissing => f.write_str("env_file_missing"),
            Self::EnvPermissionsInsecure => f.write_str("env_permissions_insecure"),
            Self::InvalidDomain => f.write_str("invalid_domain"),
            Self::InvalidAcmeEmail => f.write_str("invalid_acme_email"),
            Self::InvalidOidcOrigin => f.write_str("invalid_oidc_origin"),
            Self::InvalidTlsMode => f.write_str("invalid_tls_mode"),
            Self::InvalidPort => f.write_str("invalid_port"),
            Self::EntropyUnavailable => f.write_str("entropy_unavailable"),
            Self::EnvWriteFailed => f.write_str("env_write_failed"),
            Self::DockerUnavailable(reason) => write!(f, "docker_unavailable:{}", reason.as_str()),
            Self::DockerVersionUnsupported => f.write_str("docker_version_unsupported"),
            Self::ComposePluginMissing => f.write_str("compose_plugin_missing"),
            Self::ComposeConfigInvalid => f.write_str("compose_config_invalid"),
            Self::ComposeLaunchFailed => f.write_str("compose_launch_failed"),
            Self::ReadinessProbeFailed(err) => write!(f, "readiness_probe_failed:{err}"),
            Self::StackUnhealthy => f.write_str("stack_unhealthy"),
        }
    }
}

impl std::error::Error for CommunityDeployError {}

/// Bounded subprocess execution outcome returned by [`CommunityCommandRunner`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandExecOutput {
    pub status_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

impl CommandExecOutput {
    pub const fn is_success(&self) -> bool {
        !self.timed_out && matches!(self.status_code, Some(0))
    }
}

/// Argv-only subprocess seam for local Docker CLI invocations.
pub trait CommunityCommandRunner: Send + Sync {
    fn run_argv(
        &self,
        program: &str,
        args: &[String],
        working_dir: Option<&Path>,
        timeout: Duration,
    ) -> Result<CommandExecOutput, DockerUnavailableReason>;

    /// Optional poll delay between readiness retries (`50ms` in production, `0ms` in unit mocks).
    fn poll_backoff(&self) -> Duration {
        Duration::from_millis(50)
    }
}

/// Production argv-only runner executing the local `docker` CLI directly via [`Command`].
#[derive(Debug, Default, Clone, Copy)]
pub struct StdProcessCommunityRunner;

impl StdProcessCommunityRunner {
    pub const fn new() -> Self {
        Self
    }
}

impl CommunityCommandRunner for StdProcessCommunityRunner {
    fn run_argv(
        &self,
        program: &str,
        args: &[String],
        working_dir: Option<&Path>,
        timeout: Duration,
    ) -> Result<CommandExecOutput, DockerUnavailableReason> {
        // Defense-in-depth: never permit any executable other than `docker`, and reject control chars.
        if program != "docker" {
            return Err(DockerUnavailableReason::PermissionDenied);
        }
        if args
            .iter()
            .any(|arg| arg.bytes().any(|b| b < 0x20 || b == 0x7f))
        {
            return Err(DockerUnavailableReason::PermissionDenied);
        }

        let mut cmd = Command::new("docker");
        cmd.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(dir) = working_dir {
            cmd.current_dir(dir);
        }

        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Err(DockerUnavailableReason::CliMissing);
            }
            Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
                return Err(DockerUnavailableReason::PermissionDenied);
            }
            Err(_) => return Err(DockerUnavailableReason::DaemonOffline),
        };

        let stdout_pipe = child.stdout.take();
        let stderr_pipe = child.stderr.take();

        let stdout_reader = thread::spawn(move || -> Vec<u8> {
            let mut buf = Vec::new();
            if let Some(pipe) = stdout_pipe {
                let _ = pipe
                    .take((MAX_COMMAND_STDOUT_BYTES + 1) as u64)
                    .read_to_end(&mut buf);
            }
            buf
        });
        let stderr_reader = thread::spawn(move || -> Vec<u8> {
            let mut buf = Vec::new();
            if let Some(pipe) = stderr_pipe {
                let _ = pipe
                    .take((MAX_COMMAND_STDERR_BYTES + 1) as u64)
                    .read_to_end(&mut buf);
            }
            buf
        });

        let capped = timeout.clamp(
            Duration::from_millis(50),
            Duration::from_millis(MAX_DEPLOY_TIMEOUT_MS),
        );
        let deadline = Instant::now() + capped;
        let mut timed_out = false;
        let status_code = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.code(),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        timed_out = true;
                        let _ = child.kill();
                        let _ = child.wait();
                        break None;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(DockerUnavailableReason::DaemonOffline);
                }
            }
        };

        let stdout_bytes = stdout_reader.join().unwrap_or_default();
        let stderr_bytes = stderr_reader.join().unwrap_or_default();

        Ok(CommandExecOutput {
            status_code,
            stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
            stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
            timed_out,
        })
    }
}

/// Validated operator inputs for `self_host_preflight_community`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommunityPreflightSpec<'a> {
    pub stack_dir: &'a str,
    pub domain: &'a str,
    pub acme_email: &'a str,
    pub tls_mode: CommunityTlsMode,
    pub http_port: u16,
    pub https_port: u16,
}

/// Structured preflight diagnostic returned by `self_host_preflight_community`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommunityPreflightReport {
    pub docker_version: String,
    pub compose_version: String,
    pub compose_file_present: bool,
    pub stack_dir_writable: bool,
    pub normalized_domain: String,
    pub matrix_base_domain: String,
    pub tls_mode: CommunityTlsMode,
    pub http_port: u16,
    pub https_port: u16,
}

/// Validated operator inputs for `self_host_prepare_community`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommunityPrepareSpec<'a> {
    pub stack_dir: &'a str,
    pub domain: &'a str,
    pub acme_email: &'a str,
    pub oidc_provider_origin: &'a str,
    pub tls_mode: CommunityTlsMode,
    pub http_port: u16,
    pub https_port: u16,
}

/// Secret-free confirmation returned by `self_host_prepare_community`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommunityPrepareReport {
    pub env_file_written: bool,
    pub unix_file_mode: u32,
    pub compose_config_valid: bool,
    pub generated_secret_keys: Vec<String>,
    pub normalized_domain: String,
    pub matrix_base_domain: String,
    pub oidc_issuer: String,
    pub tls_mode: CommunityTlsMode,
    pub http_port: u16,
    pub https_port: u16,
}

/// Core application services verified after `docker compose up -d --wait`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CommunityCoreService {
    Keycloak,
    Server,
    Web,
    LiveKit,
}

impl CommunityCoreService {
    pub const ALL: [Self; 4] = [Self::Keycloak, Self::Server, Self::Web, Self::LiveKit];

    pub const fn slug(self) -> &'static str {
        match self {
            Self::Keycloak => "keycloak",
            Self::Server => "server",
            Self::Web => "web",
            Self::LiveKit => "livekit",
        }
    }
}

/// Per-service readiness entry reported by `self_host_deploy_community`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommunityDeployServiceStatus {
    pub service: CommunityCoreService,
    pub readiness: ServiceReadiness,
    pub external_oidc: bool,
}

/// Complete deployment and health verification report returned by `self_host_deploy_community`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommunityDeployReport {
    pub stack_healthy: bool,
    pub poll_attempts: u8,
    pub core_services: Vec<CommunityDeployServiceStatus>,
    pub health_report: SelfHostHealthReport,
}

/// Runs local Docker Engine & `deploy/community` preflight checks without side effects on stack files.
pub fn self_host_preflight_community(
    spec: &CommunityPreflightSpec<'_>,
    runner: &dyn CommunityCommandRunner,
) -> Result<CommunityPreflightReport, CommunityDeployError> {
    validate_ports(spec.http_port, spec.https_port)?;
    let normalized_domain = validate_and_normalize_domain(spec.domain)?;
    let _validated_email = validate_acme_email(spec.acme_email)?;
    let (stack_path, _compose_path) = validate_stack_dir_and_compose(spec.stack_dir, true)?;

    let timeout = Duration::from_millis(PREFLIGHT_COMMAND_TIMEOUT_MS);
    let docker_out = runner
        .run_argv(
            "docker",
            &["--version".to_owned()],
            Some(&stack_path),
            timeout,
        )
        .map_err(CommunityDeployError::DockerUnavailable)?;
    if docker_out.timed_out {
        return Err(CommunityDeployError::DockerUnavailable(
            DockerUnavailableReason::ProbeTimedOut,
        ));
    }
    if !docker_out.is_success() {
        let reason = classify_docker_stderr(&docker_out.stderr);
        if reason == DockerUnavailableReason::PermissionDenied {
            return Err(CommunityDeployError::DockerUnavailable(reason));
        }
        return Err(CommunityDeployError::DockerVersionUnsupported);
    }
    let docker_version = sanitize_version_line(&docker_out.stdout)
        .ok_or(CommunityDeployError::DockerVersionUnsupported)?;

    let compose_out = runner
        .run_argv(
            "docker",
            &["compose".to_owned(), "version".to_owned()],
            Some(&stack_path),
            timeout,
        )
        .map_err(CommunityDeployError::DockerUnavailable)?;
    if compose_out.timed_out {
        return Err(CommunityDeployError::DockerUnavailable(
            DockerUnavailableReason::ProbeTimedOut,
        ));
    }
    if !compose_out.is_success() {
        return Err(CommunityDeployError::ComposePluginMissing);
    }
    let compose_version = sanitize_version_line(&compose_out.stdout)
        .ok_or(CommunityDeployError::ComposePluginMissing)?;

    let matrix_base_domain = derive_matrix_base_domain(&normalized_domain);

    Ok(CommunityPreflightReport {
        docker_version,
        compose_version,
        compose_file_present: true,
        stack_dir_writable: true,
        normalized_domain,
        matrix_base_domain,
        tls_mode: spec.tls_mode,
        http_port: spec.http_port,
        https_port: spec.https_port,
    })
}

/// Generates CSPRNG secrets for Postgres, Synapse, LiveKit, Server, and Keycloak community bootstrap,
/// validates the rendered stack via `docker compose config --quiet` against an isolated `0600`
/// temporary candidate file, and publishes `<stack_dir>/.env` atomically with strict `create_new`
/// semantics without ever overwriting an existing `.env`.
pub fn self_host_prepare_community(
    spec: &CommunityPrepareSpec<'_>,
    runner: &dyn CommunityCommandRunner,
) -> Result<CommunityPrepareReport, CommunityDeployError> {
    validate_ports(spec.http_port, spec.https_port)?;
    let normalized_domain = validate_and_normalize_domain(spec.domain)?;
    let acme_email = validate_acme_email(spec.acme_email)?;
    let oidc_origin = validate_oidc_provider_origin(spec.oidc_provider_origin)?;
    let (stack_path, compose_path) = validate_stack_dir_and_compose(spec.stack_dir, true)?;

    let env_path = stack_path.join(".env");
    match fs::symlink_metadata(&env_path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err(CommunityDeployError::SymlinkRejected);
            }
            return Err(CommunityDeployError::EnvAlreadyExists);
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(CommunityDeployError::EnvWriteFailed),
    }

    let matrix_base_domain = derive_matrix_base_domain(&normalized_domain);
    let oidc_issuer = format!("{oidc_origin}/realms/community");
    let (rendered_env, secret_keys) = render_community_dotenv(
        &normalized_domain,
        &matrix_base_domain,
        &acme_email,
        &oidc_origin,
        &oidc_issuer,
        spec.tls_mode,
        spec.http_port,
        spec.https_port,
    )?;

    let candidate_path = create_dotenv_candidate_0600(&stack_path, rendered_env.as_bytes())?;

    let candidate_arg = match candidate_path.to_str() {
        Some(raw) => raw.to_owned(),
        None => {
            let _ = fs::remove_file(&candidate_path);
            return Err(CommunityDeployError::InvalidStackDir);
        }
    };
    let compose_arg = match compose_path.to_str() {
        Some(raw) => raw.to_owned(),
        None => {
            let _ = fs::remove_file(&candidate_path);
            return Err(CommunityDeployError::InvalidStackDir);
        }
    };

    let config_args = vec![
        "compose".to_owned(),
        "--env-file".to_owned(),
        candidate_arg,
        "-f".to_owned(),
        compose_arg,
        "config".to_owned(),
        "--format".to_owned(),
        "json".to_owned(),
    ];
    let config_out = match runner.run_argv(
        "docker",
        &config_args,
        Some(&stack_path),
        Duration::from_millis(COMPOSE_CONFIG_TIMEOUT_MS),
    ) {
        Ok(out) => out,
        Err(reason) => {
            let _ = fs::remove_file(&candidate_path);
            return Err(CommunityDeployError::DockerUnavailable(reason));
        }
    };

    if !config_out.is_success() {
        let _ = fs::remove_file(&candidate_path);
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    if let Err(err) =
        validate_resolved_compose_config_json_with_source(&config_out.stdout, &stack_path, None)
    {
        let _ = fs::remove_file(&candidate_path);
        return Err(err);
    }

    let unix_mode = publish_candidate_dotenv_no_replace(&candidate_path, &env_path)?;

    Ok(CommunityPrepareReport {
        env_file_written: true,
        unix_file_mode: unix_mode,
        compose_config_valid: true,
        generated_secret_keys: secret_keys,
        normalized_domain,
        matrix_base_domain,
        oidc_issuer,
        tls_mode: spec.tls_mode,
        http_port: spec.http_port,
        https_port: spec.https_port,
    })
}

/// Launches the prepared local `deploy/community` stack via `docker compose up -d --wait` and polls
/// `docker compose ps --format json` through [`inspect_community_compose_ps`] until Keycloak, Server,
/// Web, LiveKit, PostgreSQL, and Synapse report healthy.
pub fn self_host_deploy_community(
    stack_dir: &str,
    timeout_ms: Option<u64>,
    runner: &dyn CommunityCommandRunner,
) -> Result<CommunityDeployReport, CommunityDeployError> {
    let total_timeout_ms = timeout_ms
        .unwrap_or(DEFAULT_DEPLOY_TIMEOUT_MS)
        .clamp(MIN_DEPLOY_TIMEOUT_MS, MAX_DEPLOY_TIMEOUT_MS);
    let total_budget = Duration::from_millis(total_timeout_ms);
    let started_at = Instant::now();

    let (stack_path, compose_path) = validate_stack_dir_and_compose(stack_dir, false)?;
    let env_path = stack_path.join(".env");
    let dotenv_policy = verify_prepared_dotenv(&env_path)?;
    let external_oidc_configured = dotenv_policy.external_oidc_configured;

    let env_arg = env_path
        .to_str()
        .ok_or(CommunityDeployError::InvalidStackDir)?
        .to_owned();
    let compose_arg = compose_path
        .to_str()
        .ok_or(CommunityDeployError::InvalidStackDir)?
        .to_owned();

    let config_args = vec![
        "compose".to_owned(),
        "--env-file".to_owned(),
        env_arg.clone(),
        "-f".to_owned(),
        compose_arg.clone(),
        "config".to_owned(),
        "--format".to_owned(),
        "json".to_owned(),
    ];
    let config_out = runner
        .run_argv(
            "docker",
            &config_args,
            Some(&stack_path),
            Duration::from_millis(COMPOSE_CONFIG_TIMEOUT_MS),
        )
        .map_err(CommunityDeployError::DockerUnavailable)?;
    if config_out.timed_out || !config_out.is_success() {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    validate_resolved_compose_config_json_with_source(
        &config_out.stdout,
        &stack_path,
        dotenv_policy.configured_source_root.as_deref(),
    )?;

    let up_args = vec![
        "compose".to_owned(),
        "--env-file".to_owned(),
        env_arg.clone(),
        "-f".to_owned(),
        compose_arg.clone(),
        "up".to_owned(),
        "-d".to_owned(),
        "--wait".to_owned(),
    ];
    let up_out = runner
        .run_argv("docker", &up_args, Some(&stack_path), total_budget)
        .map_err(CommunityDeployError::DockerUnavailable)?;
    if up_out.timed_out || !up_out.is_success() {
        return Err(CommunityDeployError::ComposeLaunchFailed);
    }

    let ps_args = vec![
        "compose".to_owned(),
        "--env-file".to_owned(),
        env_arg,
        "-f".to_owned(),
        compose_arg,
        "ps".to_owned(),
        "--format".to_owned(),
        "json".to_owned(),
    ];

    for attempt in 1..=READINESS_MAX_POLL_ATTEMPTS {
        let elapsed = started_at.elapsed();
        let remaining = total_budget
            .checked_sub(elapsed)
            .unwrap_or(Duration::from_millis(250))
            .max(Duration::from_millis(250));
        let probe_timeout = remaining.min(Duration::from_millis(3_000));

        let ps_out = runner
            .run_argv("docker", &ps_args, Some(&stack_path), probe_timeout)
            .map_err(CommunityDeployError::DockerUnavailable)?;
        if ps_out.timed_out {
            return Err(CommunityDeployError::DockerUnavailable(
                DockerUnavailableReason::ProbeTimedOut,
            ));
        }
        if !ps_out.is_success() {
            return Err(CommunityDeployError::DockerUnavailable(
                classify_docker_stderr(&ps_out.stderr),
            ));
        }

        let health_report = inspect_community_compose_ps(&ps_out.stdout, &BTreeMap::new())
            .map_err(CommunityDeployError::ReadinessProbeFailed)?;
        let core_services =
            evaluate_core_services_from_ps(&ps_out.stdout, external_oidc_configured)?;

        let all_core_ready = core_services
            .iter()
            .all(|item| item.readiness == ServiceReadiness::Ready);
        if all_core_ready && health_report.is_healthy() {
            return Ok(CommunityDeployReport {
                stack_healthy: true,
                poll_attempts: attempt,
                core_services,
                health_report,
            });
        }

        let any_transient = core_services.iter().any(|item| {
            matches!(
                item.readiness,
                ServiceReadiness::Starting | ServiceReadiness::Restarting
            )
        }) || matches!(
            health_report.state,
            crate::self_host_health::StackHealthState::Starting
                | crate::self_host_health::StackHealthState::Restarting
        );

        if !any_transient
            || attempt == READINESS_MAX_POLL_ATTEMPTS
            || started_at.elapsed() >= total_budget
        {
            return Err(CommunityDeployError::StackUnhealthy);
        }

        let backoff = runner.poll_backoff();
        if !backoff.is_zero() {
            thread::sleep(backoff);
        }
    }

    Err(CommunityDeployError::StackUnhealthy)
}

fn validate_ports(http_port: u16, https_port: u16) -> Result<(), CommunityDeployError> {
    if http_port == 0 || https_port == 0 || http_port == https_port {
        return Err(CommunityDeployError::InvalidPort);
    }
    Ok(())
}

fn has_unsafe_input_chars(raw: &str) -> bool {
    raw.chars()
        .any(|ch| ch.is_control() || ch.is_whitespace() || SHELL_METACHARS.contains(&ch))
}

fn validate_and_normalize_domain(raw: &str) -> Result<String, CommunityDeployError> {
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

fn derive_matrix_base_domain(normalized_domain: &str) -> String {
    let labels: Vec<&str> = normalized_domain.split('.').collect();
    if labels.len() >= 3 {
        labels[1..].join(".")
    } else {
        normalized_domain.to_owned()
    }
}

fn validate_acme_email(raw: &str) -> Result<String, CommunityDeployError> {
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

fn validate_oidc_provider_origin(raw: &str) -> Result<String, CommunityDeployError> {
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

fn is_unc_or_network_share_str(raw: &str) -> bool {
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

fn has_sensitive_credential_segment(path: &Path) -> bool {
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

fn is_sensitive_stack_root(canonical_dir: &Path) -> bool {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ServiceBuildPolicySpec {
    context_subpath: &'static str,
    dockerfile: &'static str,
    allow_vite_args: bool,
}

fn expected_service_build_spec(service_name: &str) -> Option<ServiceBuildPolicySpec> {
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

fn is_admitted_vite_build_arg_key(key: &str) -> bool {
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

fn is_admitted_yaml_build_context(raw_context: &str, expected_subpath: &str) -> bool {
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

fn verify_kodera_source_root(candidate_root: &Path) -> Result<PathBuf, CommunityDeployError> {
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

fn split_compose_volume_spec(raw: &str) -> Vec<&str> {
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

fn is_admitted_named_volume_source(source: &str) -> bool {
    if source == "${KODERA_MEDIA_SECRETS_SOURCE:-media_secrets}" {
        return true;
    }
    !source.is_empty()
        && source.len() <= 64
        && source
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn validate_compose_volume_entry(entry: &str) -> Result<(), CommunityDeployError> {
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

fn strip_inline_yaml_comment(raw: &str) -> &str {
    let bytes = raw.as_bytes();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    for (idx, &b) in bytes.iter().enumerate() {
        if in_double {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_double = false;
            }
            continue;
        }
        if in_single {
            if b == b'\'' {
                in_single = false;
            }
            continue;
        }
        match b {
            b'"' => in_double = true,
            b'\'' => in_single = true,
            b'#' if idx == 0 || bytes[idx - 1].is_ascii_whitespace() => {
                return &raw[..idx];
            }
            _ => {}
        }
    }
    raw
}

fn contains_unquoted_yaml_anchor_or_alias(uncommented: &str) -> bool {
    let bytes = uncommented.as_bytes();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    for (idx, &b) in bytes.iter().enumerate() {
        if in_double {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_double = false;
            }
            continue;
        }
        if in_single {
            if b == b'\'' {
                in_single = false;
            }
            continue;
        }
        match b {
            b'"' => in_double = true,
            b'\'' => in_single = true,
            b'&' | b'*' => {
                let prev_boundary =
                    idx == 0 || matches!(bytes[idx - 1], b' ' | b':' | b'[' | b',' | b'-');
                if prev_boundary {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

fn is_admitted_cap_add_token(raw: &str) -> bool {
    let trimmed = raw.trim().trim_matches(|c| matches!(c, '"' | '\''));
    let normalized = trimmed.to_ascii_uppercase();
    let cap = normalized.strip_prefix("CAP_").unwrap_or(&normalized);
    matches!(cap, "CHOWN" | "FOWNER" | "DAC_OVERRIDE")
}

fn is_admitted_cap_drop_token(raw: &str) -> bool {
    let trimmed = raw.trim().trim_matches(|c| matches!(c, '"' | '\''));
    let normalized = trimmed.to_ascii_uppercase();
    let cap = normalized.strip_prefix("CAP_").unwrap_or(&normalized);
    cap == "ALL"
}

fn validate_inline_cap_add_list(rest: &str) -> Result<(), CommunityDeployError> {
    let Some(inner) = rest.strip_prefix('[').and_then(|s| s.strip_suffix(']')) else {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    };
    if inner.trim().is_empty() {
        return Ok(());
    }
    for token in inner.split(',') {
        if !is_admitted_cap_add_token(token) {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
    }
    Ok(())
}

fn validate_inline_cap_drop_list(rest: &str) -> Result<(), CommunityDeployError> {
    let Some(inner) = rest.strip_prefix('[').and_then(|s| s.strip_suffix(']')) else {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    };
    if inner.trim().is_empty() {
        return Ok(());
    }
    for token in inner.split(',') {
        if !is_admitted_cap_drop_token(token) {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
    }
    Ok(())
}

fn validate_inline_security_opt_list(rest: &str) -> Result<(), CommunityDeployError> {
    let Some(inner) = rest.strip_prefix('[').and_then(|s| s.strip_suffix(']')) else {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    };
    if inner.trim().is_empty() {
        return Ok(());
    }
    for token in inner.split(',') {
        let opt = token.trim().trim_matches(|c| matches!(c, '"' | '\''));
        if opt != "no-new-privileges:true" {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
    }
    Ok(())
}

fn unquote_yaml_scalar(raw: &str) -> Result<&str, CommunityDeployError> {
    let trimmed = raw.trim();
    if trimmed.starts_with('{')
        || trimmed.starts_with('[')
        || trimmed.starts_with('|')
        || trimmed.starts_with('>')
        || trimmed.chars().any(char::is_control)
    {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    if trimmed.starts_with('"') {
        let Some(inner) = trimmed.strip_prefix('"').and_then(|s| s.strip_suffix('"')) else {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        };
        if inner.contains('"') || inner.contains('\\') {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
        return Ok(inner);
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
    if trimmed.contains('"') || trimmed.contains('\'') {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    Ok(trimmed)
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

fn validate_resolved_bind_source(
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

fn is_admitted_service_image(service_name: &str, raw_image: &str) -> bool {
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

const CANONICAL_SYNAPSE_ENTRYPOINT_SCRIPT: &str = concat!(
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

fn matches_canonical_synapse_entrypoint_script(raw_script: &str) -> bool {
    let normalized = raw_script.replace("\r\n", "\n");
    normalized.trim_end_matches('\n') == CANONICAL_SYNAPSE_ENTRYPOINT_SCRIPT
}

fn matches_canonical_web_entrypoint_script(raw_script: &str) -> bool {
    let normalized = raw_script.replace("\r\n", "\n").replace("$$", "$");
    normalized.trim_end_matches('\n') == CANONICAL_WEB_ENTRYPOINT_SCRIPT
}

fn matches_canonical_migrate_command_script(raw_script: &str) -> bool {
    let normalized = raw_script.replace("\r\n", "\n").replace(
        "$$KODERA_DEFAULT_COMMUNITY_ORG_SLUG",
        "$KODERA_DEFAULT_COMMUNITY_ORG_SLUG",
    );
    normalized.trim_end_matches('\n') == CANONICAL_MIGRATE_COMMAND_SCRIPT
}

fn validate_resolved_service_entrypoint(
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

fn is_admitted_service_user(service_name: &str, user_val: &str) -> bool {
    match service_name {
        "agent-state-init" | "media-socket-init" | "proximity-socket-init" => user_val == "0:0",
        "media-storage-worker" => user_val == "10001:10001",
        _ => false,
    }
}

const CADDY_ADMITTED_ENV_KEYS: &[&str] =
    &["KODERA_ACME_EMAIL", "KODERA_DOMAIN", "KODERA_MATRIX_DOMAIN"];

const DB_ADMITTED_ENV_KEYS: &[&str] = &["POSTGRES_DB", "POSTGRES_PASSWORD", "POSTGRES_USER"];

const LIVEKIT_ADMITTED_ENV_KEYS: &[&str] = &["LIVEKIT_KEYS"];

const MIGRATE_ADMITTED_ENV_KEYS: &[&str] = &[
    "DATABASE_URL",
    "DJANGO_ALLOWED_HOSTS",
    "DJANGO_SECRET_KEY",
    "KODERA_API_DATABASE_URL",
    "KODERA_AUTH_TRUST",
    "KODERA_BILLING_ENABLED",
    "KODERA_COLLAB_DATABASE_URL",
    "KODERA_CONSOLE_CLIENT_ID",
    "KODERA_CONTACT_SEAL_KEY",
    "KODERA_DEFAULT_COMMUNITY_ISSUER",
    "KODERA_DEFAULT_COMMUNITY_ORG_SLUG",
    "KODERA_DEFAULT_COMMUNITY_OWNER_USER_ID",
    "KODERA_DISCOVERY_HMAC_KEY",
    "KODERA_MEMBERSHIP_CURSOR_KEY",
    "KODERA_OUTBOX_SEAL_KEY",
    "KODERA_STAFF_ISSUER",
];

const ROOM_ACCESS_ADMITTED_ENV_KEYS: &[&str] = &[
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "LIVEKIT_URL",
    "LIVEKIT_WS_URL",
    "ROOM_ACCESS_AGENT_USER",
    "ROOM_ACCESS_ALLOWED_ORIGINS",
    "ROOM_ACCESS_API_BIND",
    "ROOM_ACCESS_API_PORT",
    "ROOM_ACCESS_MATRIX_TOKEN",
    "ROOM_ACCESS_SYNAPSE_URL",
    "ROOM_ACCESS_WEBHOOK_BIND",
    "ROOM_ACCESS_WEBHOOK_PORT",
];

const SERVER_ADMITTED_ENV_KEYS: &[&str] = &[
    "DATABASE_URL",
    "DJANGO_ALLOWED_HOSTS",
    "DJANGO_SECRET_KEY",
    "KODERA_ANDROID_ASSETLINKS_SHA256",
    "KODERA_AUTH_TRUST",
    "KODERA_BILLING_ENABLED",
    "KODERA_COLLAB_ENGINE_URL",
    "KODERA_COLLAB_PUBLIC_URL",
    "KODERA_COLLAB_TICKET_KEY",
    "KODERA_CONSOLE_CLIENT_ID",
    "KODERA_CONSOLE_ORIGINS",
    "KODERA_CONTACT_SEAL_KEY",
    "KODERA_DEFAULT_COMMUNITY_ISSUER",
    "KODERA_DEFAULT_COMMUNITY_ORG_SLUG",
    "KODERA_DISCOVERY_HMAC_KEY",
    "KODERA_EDITION",
    "KODERA_IOS_APP_IDS",
    "KODERA_MEDIA_GATEWAY_SOCKET",
    "KODERA_MEDIA_ROOM_VERIFIER_URL",
    "KODERA_MEMBERSHIP_CURSOR_KEY",
    "KODERA_OUTBOX_SEAL_KEY",
    "KODERA_PROXIMITY_BROKER_SOCKET",
    "KODERA_STAFF_ISSUER",
    "KODERA_TRUSTED_EDGE_ADDRESSES",
];

const SYNAPSE_ADMITTED_ENV_KEYS: &[&str] = &[
    "KODERA_COMPOSE_TOPOLOGY",
    "KODERA_DEFAULT_COMMUNITY_ISSUER",
    "KODERA_DEFAULT_COMMUNITY_ORG_SLUG",
    "KODERA_FEDERATION_MODE",
    "KODERA_MATRIX_FEDERATION_ALLOWLIST",
    "KODERA_SYNAPSE_OIDC_CLIENT_SECRET",
    "KODERA_SYNAPSE_OIDC_ISSUER",
    "KODERA_TOPOLOGY",
    "PGPASSWORD",
    "PYTHONPATH",
    "SYNAPSE_REPORT_STATS",
    "SYNAPSE_SERVER_NAME",
];

const SYNAPSE_DB_ADMITTED_ENV_KEYS: &[&str] = &[
    "POSTGRES_DB",
    "POSTGRES_INITDB_ARGS",
    "POSTGRES_PASSWORD",
    "POSTGRES_USER",
];

const TENANT_AGENT_ADMITTED_ENV_KEYS: &[&str] = &[
    "KODERA_AGENT_STATE_DIR",
    "KODERA_AGENT_TOKEN",
    "KODERA_APPS",
    "KODERA_COMPOSE_PROJECT",
    "KODERA_CORE_URL",
    "KODERA_FEDERATION_MODE",
    "KODERA_MATRIX_FEDERATION_ALLOWLIST",
    "KODERA_MATRIX_PARTNER_CHANNELS",
    "KODERA_MATRIX_SERVER_NAME",
    "KODERA_ROOM_ACCESS_USER",
    "KODERA_SYNAPSE_TOKEN",
    "KODERA_SYNAPSE_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "LIVEKIT_URL",
];

const WEB_ADMITTED_ENV_KEYS: &[&str] = &["KODERA_ATTACHMENT_BASE"];

const YJS_COLLAB_ADMITTED_ENV_KEYS: &[&str] = &[
    "DATABASE_URL",
    "KODERA_COLLAB_ALLOWED_ORIGINS",
    "KODERA_COLLAB_TICKET_KEY",
];

const fn slice_is_strictly_sorted_ascii(items: &[&str]) -> bool {
    let mut i = 1;
    while i < items.len() {
        let prev = items[i - 1].as_bytes();
        let curr = items[i].as_bytes();
        let mut k = 0;
        let min_len = if prev.len() < curr.len() {
            prev.len()
        } else {
            curr.len()
        };
        let mut decided = false;
        while k < min_len {
            if prev[k] < curr[k] {
                decided = true;
                break;
            }
            if prev[k] > curr[k] {
                return false;
            }
            k += 1;
        }
        if !decided && prev.len() >= curr.len() {
            return false;
        }
        i += 1;
    }
    true
}

const _: () = {
    assert!(slice_is_strictly_sorted_ascii(CADDY_ADMITTED_ENV_KEYS));
    assert!(slice_is_strictly_sorted_ascii(DB_ADMITTED_ENV_KEYS));
    assert!(slice_is_strictly_sorted_ascii(LIVEKIT_ADMITTED_ENV_KEYS));
    assert!(slice_is_strictly_sorted_ascii(MIGRATE_ADMITTED_ENV_KEYS));
    assert!(slice_is_strictly_sorted_ascii(
        ROOM_ACCESS_ADMITTED_ENV_KEYS
    ));
    assert!(slice_is_strictly_sorted_ascii(SERVER_ADMITTED_ENV_KEYS));
    assert!(slice_is_strictly_sorted_ascii(SYNAPSE_ADMITTED_ENV_KEYS));
    assert!(slice_is_strictly_sorted_ascii(SYNAPSE_DB_ADMITTED_ENV_KEYS));
    assert!(slice_is_strictly_sorted_ascii(
        TENANT_AGENT_ADMITTED_ENV_KEYS
    ));
    assert!(slice_is_strictly_sorted_ascii(WEB_ADMITTED_ENV_KEYS));
    assert!(slice_is_strictly_sorted_ascii(YJS_COLLAB_ADMITTED_ENV_KEYS));
};

/// Returns the sorted per-service allowlist of `environment:` variable names derived from
/// canonical `deploy/community/docker-compose.yml` (services without an `environment:` block
/// admit zero environment keys).
pub fn admitted_service_environment_keys(service_name: &str) -> &'static [&'static str] {
    match service_name {
        "caddy" => CADDY_ADMITTED_ENV_KEYS,
        "db" => DB_ADMITTED_ENV_KEYS,
        "livekit" => LIVEKIT_ADMITTED_ENV_KEYS,
        "migrate" => MIGRATE_ADMITTED_ENV_KEYS,
        "room-access" => ROOM_ACCESS_ADMITTED_ENV_KEYS,
        "server" => SERVER_ADMITTED_ENV_KEYS,
        "synapse" => SYNAPSE_ADMITTED_ENV_KEYS,
        "synapse-db" => SYNAPSE_DB_ADMITTED_ENV_KEYS,
        "tenant-agent" => TENANT_AGENT_ADMITTED_ENV_KEYS,
        "web" => WEB_ADMITTED_ENV_KEYS,
        "yjs-collab" => YJS_COLLAB_ADMITTED_ENV_KEYS,
        _ => &[],
    }
}

fn is_admitted_service_env_var(service_name: &str, key: &str, val_opt: Option<&str>) -> bool {
    if admitted_service_environment_keys(service_name)
        .binary_search(&key)
        .is_err()
    {
        return false;
    }
    match key {
        "PYTHONPATH" => service_name == "synapse" && val_opt == Some("/tmp/kodera-policy"),
        "KODERA_BILLING_ENABLED" => {
            matches!(service_name, "migrate" | "server") && val_opt == Some("false")
        }
        "KODERA_EDITION" => service_name == "server" && val_opt == Some("community"),
        "KODERA_ATTACHMENT_BASE" => {
            service_name == "web"
                && match val_opt {
                    None | Some("" | "${KODERA_ATTACHMENT_BASE:-}") => true,
                    Some(v) => is_valid_https_attachment_base(v),
                }
        }
        _ => val_opt.is_none_or(|v| !v.contains('\0')),
    }
}

fn is_valid_https_attachment_base(raw: &str) -> bool {
    if !raw.starts_with("https://")
        || !raw.ends_with('/')
        || raw.chars().any(|c| {
            c.is_control()
                || c.is_whitespace()
                || matches!(c, '%' | '?' | '#' | '\\' | ';' | '\'' | '"' | '*')
        })
    {
        return false;
    }
    let Some(authority_end) = raw["https://".len()..]
        .find('/')
        .map(|idx| idx + "https://".len())
    else {
        return false;
    };
    let origin = &raw[..authority_end];
    let full_path = &raw[authority_end..];
    if validate_oidc_provider_origin(origin).is_err() || origin.contains('@') {
        return false;
    }
    full_path.len() >= 3
        && full_path.starts_with('/')
        && full_path.ends_with('/')
        && !full_path.contains("//")
        && !full_path[1..full_path.len() - 1]
            .split('/')
            .any(|seg| seg.is_empty() || matches!(seg, "." | ".."))
}

fn validate_resolved_service_environment(
    service_name: &str,
    val: &serde_json::Value,
) -> Result<(), CommunityDeployError> {
    if val.is_null() {
        return Ok(());
    }
    if let Some(env_obj) = val.as_object() {
        for (k, v) in env_obj {
            let v_str = match v {
                serde_json::Value::Null => None,
                serde_json::Value::String(s) => Some(s.as_str()),
                _ => return Err(CommunityDeployError::ComposeConfigInvalid),
            };
            if !is_admitted_service_env_var(service_name, k, v_str) {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            }
        }
        return Ok(());
    }
    if let Some(env_arr) = val.as_array() {
        for item in env_arr {
            let Some(raw_pair) = item.as_str() else {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            };
            let (k, v_opt) = match raw_pair.split_once('=') {
                Some((k, v)) => (k, Some(v)),
                None => (raw_pair, None),
            };
            if !is_admitted_service_env_var(service_name, k, v_opt) {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            }
        }
        return Ok(());
    }
    Err(CommunityDeployError::ComposeConfigInvalid)
}

fn validate_service_command_argv(
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

fn validate_resolved_service_command(
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

fn validate_yaml_port_entry(
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

fn validate_resolved_service_ports(
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

fn validate_resolved_service_build(
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

/// Validates the resolved JSON configuration emitted by `docker compose ... config --format json`,
/// eliminating YAML indentation, merge-key (`<<:`), anchor/alias, build-context, and volume bypasses.
pub fn validate_resolved_compose_config_json(
    raw_json: &str,
    canonical_stack_dir: &Path,
) -> Result<(), CommunityDeployError> {
    validate_resolved_compose_config_json_with_source(raw_json, canonical_stack_dir, None)
}

/// Validates the resolved JSON configuration emitted by `docker compose ... config --format json`
/// against `canonical_stack_dir` and an optional operator-configured `KODERA_SOURCE_DIR` root.
pub fn validate_resolved_compose_config_json_with_source(
    raw_json: &str,
    canonical_stack_dir: &Path,
    configured_source_root: Option<&Path>,
) -> Result<(), CommunityDeployError> {
    if !canonical_stack_dir.is_absolute()
        || canonical_stack_dir
            .components()
            .any(|comp| matches!(comp, Component::ParentDir))
        || is_sensitive_stack_root(canonical_stack_dir)
    {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    if raw_json.trim().is_empty() || raw_json.len() > (MAX_COMPOSE_FILE_BYTES as usize) * 4 {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

    let mut verified_source_root: Option<PathBuf> = match configured_source_root {
        Some(raw_root) => Some(verify_kodera_source_root(raw_root)?),
        None => None,
    };

    let parsed: serde_json::Value =
        serde_json::from_str(raw_json).map_err(|_| CommunityDeployError::ComposeConfigInvalid)?;
    let Some(root) = parsed.as_object() else {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    };

    for root_key in root.keys() {
        if !matches!(
            root_key.as_str(),
            "name" | "services" | "volumes" | "networks"
        ) {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
    }

    let Some(services) = root.get("services").and_then(serde_json::Value::as_object) else {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    };
    if services.is_empty() {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

    for (svc_name, svc_val) in services {
        if ADMITTED_COMMUNITY_COMPOSE_SERVICES
            .binary_search(&svc_name.as_str())
            .is_err()
        {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
        let Some(svc_obj) = svc_val.as_object() else {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        };
        let has_build = svc_obj.get("build").is_some_and(|v| !v.is_null());
        let has_image = svc_obj
            .get("image")
            .and_then(serde_json::Value::as_str)
            .is_some();
        if !has_build && !has_image {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
        for (directive, val) in svc_obj {
            if ADMITTED_COMPOSE_SERVICE_DIRECTIVES
                .binary_search(&directive.as_str())
                .is_err()
            {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            }
            match directive.as_str() {
                "build" => {
                    validate_resolved_service_build(
                        svc_name,
                        val,
                        canonical_stack_dir,
                        &mut verified_source_root,
                    )?;
                }
                "image" => {
                    if !val.is_null() {
                        let Some(img_str) = val.as_str() else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        if !is_admitted_service_image(svc_name, img_str) {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                }
                "entrypoint" => {
                    validate_resolved_service_entrypoint(svc_name, val)?;
                }
                "command" => {
                    validate_resolved_service_command(svc_name, val)?;
                }
                "environment" => {
                    validate_resolved_service_environment(svc_name, val)?;
                }
                "user" => {
                    if !val.is_null() {
                        let Some(u_str) = val.as_str() else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        if !is_admitted_service_user(svc_name, u_str) {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                }
                "ports" => {
                    if !val.is_null() {
                        validate_resolved_service_ports(svc_name, val)?;
                    }
                }
                "cap_add" => {
                    let Some(caps) = val.as_array() else {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    };
                    for cap in caps {
                        let Some(cap_str) = cap.as_str() else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        if !is_admitted_cap_add_token(cap_str) {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                }
                "cap_drop" => {
                    let Some(caps) = val.as_array() else {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    };
                    for cap in caps {
                        let Some(cap_str) = cap.as_str() else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        if !is_admitted_cap_drop_token(cap_str) {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                }
                "security_opt" => {
                    let Some(opts) = val.as_array() else {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    };
                    for opt in opts {
                        if opt.as_str() != Some("no-new-privileges:true") {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                }
                "volumes" => {
                    let Some(vols) = val.as_array() else {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    };
                    for entry in vols {
                        if let Some(short_spec) = entry.as_str() {
                            if short_spec.contains("${") {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                            validate_compose_volume_entry(short_spec)?;
                        } else if let Some(vobj) = entry.as_object() {
                            for vk in vobj.keys() {
                                if !matches!(
                                    vk.as_str(),
                                    "type"
                                        | "source"
                                        | "target"
                                        | "read_only"
                                        | "bind"
                                        | "volume"
                                        | "consistency"
                                ) {
                                    return Err(CommunityDeployError::ComposeConfigInvalid);
                                }
                            }
                            let Some(vtype) = vobj.get("type").and_then(serde_json::Value::as_str)
                            else {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            };
                            let Some(source) =
                                vobj.get("source").and_then(serde_json::Value::as_str)
                            else {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            };
                            let Some(target) =
                                vobj.get("target").and_then(serde_json::Value::as_str)
                            else {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            };
                            if !target.starts_with('/')
                                || target == "/"
                                || target.to_ascii_lowercase().contains("docker.sock")
                            {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                            match vtype {
                                "volume" => {
                                    if source.contains("${")
                                        || !is_admitted_named_volume_source(source)
                                    {
                                        return Err(CommunityDeployError::ComposeConfigInvalid);
                                    }
                                    if let Some(sub) = vobj
                                        .get("volume")
                                        .and_then(serde_json::Value::as_object)
                                        .and_then(|m| m.get("subpath"))
                                        .and_then(serde_json::Value::as_str)
                                    {
                                        if sub.contains("..") || sub.starts_with('/') {
                                            return Err(CommunityDeployError::ComposeConfigInvalid);
                                        }
                                    }
                                }
                                "bind" => {
                                    if vobj.get("read_only") != Some(&serde_json::Value::Bool(true))
                                    {
                                        return Err(CommunityDeployError::ComposeConfigInvalid);
                                    }
                                    if let Some(bind_opts) =
                                        vobj.get("bind").and_then(serde_json::Value::as_object)
                                    {
                                        if let Some(prop) = bind_opts
                                            .get("propagation")
                                            .and_then(serde_json::Value::as_str)
                                        {
                                            if !matches!(prop, "rprivate" | "private") {
                                                return Err(
                                                    CommunityDeployError::ComposeConfigInvalid,
                                                );
                                            }
                                        }
                                    }
                                    validate_resolved_bind_source(
                                        source,
                                        canonical_stack_dir,
                                        &mut verified_source_root,
                                    )?;
                                }
                                _ => return Err(CommunityDeployError::ComposeConfigInvalid),
                            }
                        } else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    if let Some(top_vols_val) = root.get("volumes") {
        if !top_vols_val.is_null() {
            let Some(top_vols) = top_vols_val.as_object() else {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            };
            for (vol_name, vol_cfg) in top_vols {
                if !is_admitted_named_volume_source(vol_name) {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
                if !vol_cfg.is_null() {
                    let Some(vobj) = vol_cfg.as_object() else {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    };
                    if let Some(ext) = vobj.get("external") {
                        if ext != &serde_json::Value::Bool(false) {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                    if let Some(driver) = vobj.get("driver") {
                        if driver.as_str() != Some("local") {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                    if let Some(driver_opts) = vobj.get("driver_opts") {
                        if !driver_opts.is_null()
                            && driver_opts.as_object().is_none_or(|m| !m.is_empty())
                        {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                }
            }
        }
    }

    if let Some(top_nets_val) = root.get("networks") {
        if !top_nets_val.is_null() {
            let Some(top_nets) = top_nets_val.as_object() else {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            };
            for (_net_name, net_cfg) in top_nets {
                if !net_cfg.is_null() {
                    let Some(nobj) = net_cfg.as_object() else {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    };
                    if let Some(ext) = nobj.get("external") {
                        if ext != &serde_json::Value::Bool(false) {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                    if let Some(driver) = nobj.get("driver").and_then(serde_json::Value::as_str) {
                        if !matches!(driver, "bridge" | "default" | "") {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

const fn is_sorted_str_slice(slice: &[&str]) -> bool {
    let mut i = 1;
    while i < slice.len() {
        let left = slice[i - 1].as_bytes();
        let right = slice[i].as_bytes();
        let min_len = if left.len() < right.len() {
            left.len()
        } else {
            right.len()
        };
        let mut j = 0;
        let mut decided = false;
        while j < min_len {
            if left[j] < right[j] {
                decided = true;
                break;
            }
            if left[j] > right[j] {
                return false;
            }
            j += 1;
        }
        if !decided && left.len() >= right.len() {
            return false;
        }
        i += 1;
    }
    true
}

fn is_yaml_block_scalar_header(uncommented: &str) -> bool {
    let rhs = if let Some((_, after_colon)) = uncommented.split_once(':') {
        after_colon.trim()
    } else if let Some(after_dash) = uncommented.strip_prefix("- ") {
        after_dash.trim()
    } else {
        return false;
    };
    matches!(rhs, "|" | "|-" | "|+" | ">" | ">-" | ">+")
}

const fn str_eq_const(a: &str, b: &str) -> bool {
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    if ab.len() != bb.len() {
        return false;
    }
    let mut idx = 0;
    while idx < ab.len() {
        if ab[idx] != bb[idx] {
            return false;
        }
        idx += 1;
    }
    true
}

const fn slices_are_disjoint(a: &[&str], b: &[&str]) -> bool {
    let mut i = 0;
    while i < a.len() {
        let mut j = 0;
        while j < b.len() {
            if str_eq_const(a[i], b[j]) {
                return false;
            }
            j += 1;
        }
        i += 1;
    }
    true
}

#[derive(Default)]
struct YamlBuildBlockState {
    active: bool,
    subkey_indent: Option<usize>,
    in_args_block: bool,
    args_item_indent: Option<usize>,
    saw_context: bool,
    saw_dockerfile: bool,
}

#[derive(Default)]
struct YamlArgvBlockState {
    active: bool,
    service_name: String,
    is_entrypoint: bool,
    items: Vec<String>,
    collecting_script: bool,
    script_base_indent: Option<usize>,
    script_lines: Vec<String>,
}

fn finalize_yaml_build_block(state: &mut YamlBuildBlockState) -> Result<(), CommunityDeployError> {
    if state.active && (!state.saw_context || !state.saw_dockerfile) {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    *state = YamlBuildBlockState::default();
    Ok(())
}

fn finalize_yaml_argv_block(state: &mut YamlArgvBlockState) -> Result<(), CommunityDeployError> {
    if state.active {
        let mut complete_items = state.items.clone();
        if state.collecting_script {
            complete_items.push(state.script_lines.join("\n"));
        }
        if complete_items.is_empty() {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }
        if state.is_entrypoint {
            let entrypoint_ok = match state.service_name.as_str() {
                "synapse" => {
                    complete_items.len() == 3
                        && complete_items[0] == "/bin/sh"
                        && complete_items[1] == "-c"
                        && matches_canonical_synapse_entrypoint_script(&complete_items[2])
                }
                "web" => {
                    complete_items.len() == 4
                        && complete_items[0] == "/bin/sh"
                        && complete_items[1] == "-ec"
                        && matches_canonical_web_entrypoint_script(&complete_items[2])
                        && complete_items[3] == "sh"
                }
                _ => false,
            };
            if !entrypoint_ok {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            }
        } else {
            let refs: Vec<&str> = complete_items.iter().map(String::as_str).collect();
            validate_service_command_argv(&state.service_name, &refs, true)?;
        }
    }
    *state = YamlArgvBlockState::default();
    Ok(())
}

fn validate_inline_yaml_command(
    service_name: &str,
    rest: &str,
) -> Result<(), CommunityDeployError> {
    if rest.starts_with('[') {
        let parsed: Vec<String> =
            serde_json::from_str(rest).map_err(|_| CommunityDeployError::ComposeConfigInvalid)?;
        let refs: Vec<&str> = parsed.iter().map(String::as_str).collect();
        return validate_service_command_argv(service_name, &refs, true);
    }
    let unquoted = unquote_yaml_scalar(rest)?;
    if service_name == "livekit" && unquoted == "--config /etc/livekit.yaml" {
        return Ok(());
    }
    Err(CommunityDeployError::ComposeConfigInvalid)
}

fn finalize_yaml_service(
    current_service: &mut Option<String>,
    saw_image_or_build: &mut bool,
    build_state: &mut YamlBuildBlockState,
    argv_state: &mut YamlArgvBlockState,
) -> Result<(), CommunityDeployError> {
    finalize_yaml_build_block(build_state)?;
    finalize_yaml_argv_block(argv_state)?;
    if current_service.is_some() && !*saw_image_or_build {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    *current_service = None;
    *saw_image_or_build = false;
    Ok(())
}

fn validate_compose_file_policy(compose_path: &Path) -> Result<(), CommunityDeployError> {
    const {
        assert!(
            is_sorted_str_slice(ADMITTED_COMPOSE_SERVICE_DIRECTIVES),
            "ADMITTED_COMPOSE_SERVICE_DIRECTIVES must be sorted"
        );
        assert!(
            is_sorted_str_slice(FORBIDDEN_PRIVILEGED_COMPOSE_DIRECTIVES),
            "FORBIDDEN_PRIVILEGED_COMPOSE_DIRECTIVES must be sorted"
        );
        assert!(
            slices_are_disjoint(
                ADMITTED_COMPOSE_SERVICE_DIRECTIVES,
                FORBIDDEN_PRIVILEGED_COMPOSE_DIRECTIVES,
            ),
            "forbidden directives must never appear in ADMITTED_COMPOSE_SERVICE_DIRECTIVES"
        );
    }

    let meta =
        fs::symlink_metadata(compose_path).map_err(|_| CommunityDeployError::ComposeFileMissing)?;
    if meta.file_type().is_symlink() {
        return Err(CommunityDeployError::SymlinkRejected);
    }
    if !meta.file_type().is_file() || meta.len() == 0 {
        return Err(CommunityDeployError::ComposeFileMissing);
    }
    if meta.len() > MAX_COMPOSE_FILE_BYTES {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

    let raw =
        fs::read_to_string(compose_path).map_err(|_| CommunityDeployError::ComposeConfigInvalid)?;
    if raw.contains('\0') {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

    let mut saw_services_root = false;
    let mut service_count = 0usize;
    let mut root_section: Option<&str> = None;
    let mut service_indent: Option<usize> = None;
    let mut current_service: Option<String> = None;
    let mut current_service_has_image_or_build = false;
    let mut directive_indent: Option<usize> = None;
    let mut current_directive: Option<String> = None;
    let mut current_directive_inline_scalar = false;
    let mut build_state = YamlBuildBlockState::default();
    let mut argv_state = YamlArgvBlockState::default();
    let mut env_item_indent: Option<usize> = None;
    let mut top_vol_indent: Option<usize> = None;
    let mut top_net_indent: Option<usize> = None;
    let mut in_multiline_scalar_indent: Option<usize> = None;

    for line in raw.lines() {
        let trimmed_ws = line.trim();
        if trimmed_ws.is_empty() {
            continue;
        }
        let indent = line.bytes().take_while(|b| *b == b' ').count();
        if line.as_bytes().get(indent) == Some(&b'\t') {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }

        if let Some(block_indent) = in_multiline_scalar_indent {
            if indent > block_indent {
                if argv_state.active && argv_state.collecting_script {
                    let base = *argv_state.script_base_indent.get_or_insert(indent);
                    if indent < base {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    }
                    argv_state.script_lines.push(line[base..].to_owned());
                }
                continue;
            }
            in_multiline_scalar_indent = None;
        }

        if trimmed_ws.starts_with('#') {
            continue;
        }

        let uncommented = strip_inline_yaml_comment(trimmed_ws).trim();
        if uncommented.is_empty() {
            continue;
        }
        if uncommented == "---"
            || uncommented == "..."
            || uncommented.contains("<<:")
            || contains_unquoted_yaml_anchor_or_alias(uncommented)
        {
            return Err(CommunityDeployError::ComposeConfigInvalid);
        }

        if is_yaml_block_scalar_header(uncommented) {
            in_multiline_scalar_indent = Some(indent);
        }

        if indent == 0 {
            finalize_yaml_service(
                &mut current_service,
                &mut current_service_has_image_or_build,
                &mut build_state,
                &mut argv_state,
            )?;
            service_indent = None;
            directive_indent = None;
            current_directive = None;
            top_vol_indent = None;
            top_net_indent = None;

            let Some((root_key, root_rest)) = uncommented.split_once(':') else {
                return Err(CommunityDeployError::ComposeConfigInvalid);
            };
            let key = root_key.trim();
            let rest = root_rest.trim();
            match key {
                "services" => {
                    if !rest.is_empty() {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    }
                    saw_services_root = true;
                    root_section = Some("services");
                }
                "volumes" => {
                    if !rest.is_empty() && rest != "{}" {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    }
                    root_section = Some("volumes");
                }
                "networks" => {
                    if !rest.is_empty() && rest != "{}" {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    }
                    root_section = Some("networks");
                }
                "name" | "version" => {
                    if rest.starts_with('{') || rest.starts_with('[') {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    }
                    root_section = Some("scalar");
                }
                _ => return Err(CommunityDeployError::ComposeConfigInvalid),
            }
            continue;
        }

        match root_section {
            Some("services") => {
                let svc_ind = *service_indent.get_or_insert(indent);
                if indent < svc_ind {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
                if indent == svc_ind {
                    finalize_yaml_service(
                        &mut current_service,
                        &mut current_service_has_image_or_build,
                        &mut build_state,
                        &mut argv_state,
                    )?;
                    directive_indent = None;
                    current_directive = None;
                    env_item_indent = None;
                    let Some((svc_name_raw, svc_rest_raw)) = uncommented.split_once(':') else {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    };
                    let svc = svc_name_raw.trim();
                    let rest = svc_rest_raw.trim();
                    if !rest.is_empty()
                        || ADMITTED_COMMUNITY_COMPOSE_SERVICES
                            .binary_search(&svc)
                            .is_err()
                    {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    }
                    current_service = Some(svc.to_owned());
                    current_service_has_image_or_build = false;
                    service_count += 1;
                    continue;
                }

                let dir_ind = *directive_indent.get_or_insert(indent);
                if indent < dir_ind {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
                if indent == dir_ind {
                    finalize_yaml_build_block(&mut build_state)?;
                    finalize_yaml_argv_block(&mut argv_state)?;
                    env_item_indent = None;
                    let Some((dir_raw, dir_rest_raw)) = uncommented.split_once(':') else {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    };
                    let directive = dir_raw.trim();
                    let rest = dir_rest_raw.trim();
                    if ADMITTED_COMPOSE_SERVICE_DIRECTIVES
                        .binary_search(&directive)
                        .is_err()
                    {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    }
                    match directive {
                        "build" => {
                            let svc_name = current_service.as_deref().unwrap_or("");
                            if !rest.is_empty() || expected_service_build_spec(svc_name).is_none() {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                            build_state.active = true;
                            current_service_has_image_or_build = true;
                        }
                        "image" => {
                            let svc_name = current_service.as_deref().unwrap_or("");
                            let img_val = unquote_yaml_scalar(rest)?;
                            if !is_admitted_service_image(svc_name, img_val) {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                            current_service_has_image_or_build = true;
                        }
                        "entrypoint" => {
                            let Some(svc_name) = current_service
                                .as_deref()
                                .filter(|s| matches!(*s, "synapse" | "web"))
                            else {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            };
                            if !rest.is_empty() {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                            argv_state = YamlArgvBlockState {
                                active: true,
                                service_name: svc_name.to_owned(),
                                is_entrypoint: true,
                                ..YamlArgvBlockState::default()
                            };
                        }
                        "command" => {
                            let svc_name = current_service.as_deref().unwrap_or("");
                            if rest.is_empty() {
                                argv_state = YamlArgvBlockState {
                                    active: true,
                                    service_name: svc_name.to_owned(),
                                    is_entrypoint: false,
                                    ..YamlArgvBlockState::default()
                                };
                            } else {
                                validate_inline_yaml_command(svc_name, rest)?;
                            }
                        }
                        "user" => {
                            let svc_name = current_service.as_deref().unwrap_or("");
                            let user_val = unquote_yaml_scalar(rest)?;
                            if !is_admitted_service_user(svc_name, user_val) {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                        }
                        "environment" => {
                            let svc_name = current_service.as_deref().unwrap_or("");
                            if !rest.is_empty()
                                || admitted_service_environment_keys(svc_name).is_empty()
                            {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                        }
                        "ports" => {
                            let svc_name = current_service.as_deref().unwrap_or("");
                            if !matches!(svc_name, "caddy" | "livekit")
                                || (!rest.is_empty() && rest != "[]")
                            {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                        }
                        "cap_add" => {
                            if !rest.is_empty() {
                                validate_inline_cap_add_list(rest)?;
                            }
                        }
                        "cap_drop" => {
                            if !rest.is_empty() {
                                validate_inline_cap_drop_list(rest)?;
                            }
                        }
                        "security_opt" => {
                            if !rest.is_empty() {
                                validate_inline_security_opt_list(rest)?;
                            }
                        }
                        "volumes" if !rest.is_empty() && rest != "[]" => {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                        _ => {}
                    }
                    current_directive = Some(directive.to_owned());
                    current_directive_inline_scalar =
                        !rest.is_empty() && !is_yaml_block_scalar_header(uncommented);
                    continue;
                }

                // `indent > dir_ind` — nested content inside `current_directive`.
                if current_directive_inline_scalar {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
                match current_directive.as_deref() {
                    Some("build") => {
                        if in_multiline_scalar_indent.is_some() {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                        let svc_name = current_service.as_deref().unwrap_or("");
                        let Some(spec) = expected_service_build_spec(svc_name) else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        let b_ind = *build_state.subkey_indent.get_or_insert(indent);
                        if indent < b_ind {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                        if indent == b_ind {
                            build_state.in_args_block = false;
                            build_state.args_item_indent = None;
                            let Some((bk_raw, bv_raw)) = uncommented.split_once(':') else {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            };
                            let bk = bk_raw.trim();
                            let bv_trimmed = bv_raw.trim();
                            match bk {
                                "context" => {
                                    if build_state.saw_context {
                                        return Err(CommunityDeployError::ComposeConfigInvalid);
                                    }
                                    let ctx_val = unquote_yaml_scalar(bv_trimmed)?;
                                    if !is_admitted_yaml_build_context(
                                        ctx_val,
                                        spec.context_subpath,
                                    ) {
                                        return Err(CommunityDeployError::ComposeConfigInvalid);
                                    }
                                    build_state.saw_context = true;
                                }
                                "dockerfile" => {
                                    if build_state.saw_dockerfile {
                                        return Err(CommunityDeployError::ComposeConfigInvalid);
                                    }
                                    let df_val = unquote_yaml_scalar(bv_trimmed)?;
                                    if df_val != spec.dockerfile {
                                        return Err(CommunityDeployError::ComposeConfigInvalid);
                                    }
                                    build_state.saw_dockerfile = true;
                                }
                                "args" if spec.allow_vite_args => {
                                    if !bv_trimmed.is_empty() {
                                        return Err(CommunityDeployError::ComposeConfigInvalid);
                                    }
                                    build_state.in_args_block = true;
                                }
                                _ => return Err(CommunityDeployError::ComposeConfigInvalid),
                            }
                        } else {
                            if !build_state.in_args_block || !spec.allow_vite_args {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                            let a_ind = *build_state.args_item_indent.get_or_insert(indent);
                            if indent != a_ind {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                            let Some((arg_k_raw, arg_v_raw)) = uncommented.split_once(':') else {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            };
                            let arg_k = arg_k_raw.trim();
                            let arg_v = arg_v_raw.trim();
                            if !is_admitted_vite_build_arg_key(arg_k)
                                || arg_v.is_empty()
                                || arg_v.starts_with('{')
                                || arg_v.starts_with('[')
                                || arg_v.starts_with('|')
                                || arg_v.starts_with('>')
                            {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                        }
                    }
                    Some("volumes") => {
                        let Some(volume_spec) = uncommented.strip_prefix("- ") else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        if volume_spec.contains("type:")
                            || volume_spec.starts_with('{')
                            || volume_spec.starts_with('[')
                        {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                        validate_compose_volume_entry(volume_spec)?;
                    }
                    Some("cap_add") => {
                        let Some(cap_spec) = uncommented.strip_prefix("- ") else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        if !is_admitted_cap_add_token(cap_spec) {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                    Some("cap_drop") => {
                        let Some(cap_spec) = uncommented.strip_prefix("- ") else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        if !is_admitted_cap_drop_token(cap_spec) {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                    Some("security_opt") => {
                        let Some(opt_spec) = uncommented.strip_prefix("- ") else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        let opt = opt_spec.trim().trim_matches(|c| matches!(c, '"' | '\''));
                        if opt != "no-new-privileges:true" {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                    }
                    Some("ports") => {
                        let Some(port_spec) = uncommented.strip_prefix("- ") else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        let svc_name = current_service.as_deref().unwrap_or("");
                        validate_yaml_port_entry(svc_name, port_spec)?;
                    }
                    Some("entrypoint" | "command") => {
                        if !argv_state.active || argv_state.collecting_script {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                        let Some(item_spec) = uncommented.strip_prefix("- ") else {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        };
                        let trimmed_item = item_spec.trim();
                        if matches!(trimmed_item, "|" | "|-" | "|+") {
                            argv_state.collecting_script = true;
                        } else {
                            let item_val = unquote_yaml_scalar(trimmed_item)?;
                            argv_state.items.push(item_val.to_owned());
                        }
                    }
                    Some("environment") => {
                        if in_multiline_scalar_indent.is_some() {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                        let e_ind = *env_item_indent.get_or_insert(indent);
                        if indent != e_ind {
                            return Err(CommunityDeployError::ComposeConfigInvalid);
                        }
                        let svc_name = current_service.as_deref().unwrap_or("");
                        if let Some(list_item) = uncommented.strip_prefix("- ") {
                            let cleaned = unquote_yaml_scalar(list_item)?;
                            let (k, v_opt) = match cleaned.split_once('=') {
                                Some((k, v)) => (k.trim(), Some(v.trim())),
                                None => (cleaned.trim(), None),
                            };
                            if !is_admitted_service_env_var(svc_name, k, v_opt) {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                        } else {
                            let Some((env_k_raw, env_v_raw)) = uncommented.split_once(':') else {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            };
                            let env_k = env_k_raw.trim();
                            let env_v = env_v_raw.trim();
                            if env_v.starts_with('{')
                                || env_v.starts_with('[')
                                || env_v.starts_with('|')
                                || env_v.starts_with('>')
                            {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                            let unquoted_v = if env_v.is_empty() {
                                ""
                            } else {
                                unquote_yaml_scalar(env_v)?
                            };
                            if !is_admitted_service_env_var(svc_name, env_k, Some(unquoted_v)) {
                                return Err(CommunityDeployError::ComposeConfigInvalid);
                            }
                        }
                    }
                    Some("depends_on" | "healthcheck" | "networks" | "profiles") => {}
                    _ => return Err(CommunityDeployError::ComposeConfigInvalid),
                }
            }
            Some("volumes") => {
                let v_ind = *top_vol_indent.get_or_insert(indent);
                if indent != v_ind {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
                let Some((vol_raw, vol_rest_raw)) = uncommented.split_once(':') else {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                };
                let vol_name = vol_raw.trim();
                let rest = vol_rest_raw.trim();
                if !is_admitted_named_volume_source(vol_name)
                    || (!rest.is_empty() && rest != "{}" && rest != "null")
                {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
            }
            Some("networks") => {
                let n_ind = *top_net_indent.get_or_insert(indent);
                if indent < n_ind {
                    return Err(CommunityDeployError::ComposeConfigInvalid);
                }
                if indent == n_ind {
                    let Some((net_name_raw, net_rest_raw)) = uncommented.split_once(':') else {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    };
                    let net_name = net_name_raw.trim();
                    let rest = net_rest_raw.trim();
                    if !is_admitted_named_volume_source(net_name)
                        || (!rest.is_empty() && rest != "{}" && rest != "null")
                    {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    }
                } else {
                    let cleaned = uncommented.strip_prefix("- ").unwrap_or(uncommented);
                    let Some((net_k, net_v)) = cleaned.split_once(':') else {
                        return Err(CommunityDeployError::ComposeConfigInvalid);
                    };
                    let nk = net_k.trim();
                    let nv = net_v.trim().trim_matches(|c| matches!(c, '"' | '\''));
                    match nk {
                        "internal" if matches!(nv, "true" | "false") => {}
                        "driver" if nv == "bridge" => {}
                        "ipam" | "config" if nv.is_empty() => {}
                        "subnet" | "ip_range" if !nv.is_empty() => {}
                        _ => return Err(CommunityDeployError::ComposeConfigInvalid),
                    }
                }
            }
            _ => return Err(CommunityDeployError::ComposeConfigInvalid),
        }
    }

    finalize_yaml_service(
        &mut current_service,
        &mut current_service_has_image_or_build,
        &mut build_state,
        &mut argv_state,
    )?;

    if !saw_services_root || service_count == 0 {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

    Ok(())
}

fn validate_stack_dir_and_compose(
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

fn csprng_bytes<const N: usize>() -> Result<[u8; N], CommunityDeployError> {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).map_err(|_| CommunityDeployError::EntropyUnavailable)?;
    Ok(buf)
}

fn csprng_hex(byte_len: usize) -> Result<String, CommunityDeployError> {
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

fn encode_base64_padded_32(bytes: &[u8; 32]) -> String {
    encode_base64_alphabet_padded_32(bytes, BASE64_STANDARD_ALPHABET)
}

fn encode_base64url_padded_32(bytes: &[u8; 32]) -> String {
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
fn render_community_dotenv(
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

fn create_dotenv_candidate_0600(
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

fn publish_candidate_dotenv_no_replace(
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

struct PreparedDotenvPolicy {
    external_oidc_configured: bool,
    configured_source_root: Option<PathBuf>,
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

fn verify_prepared_dotenv(env_path: &Path) -> Result<PreparedDotenvPolicy, CommunityDeployError> {
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

fn sanitize_version_line(stdout: &str) -> Option<String> {
    let first = stdout.lines().find(|line| !line.trim().is_empty())?.trim();
    if first.is_empty() || first.len() > 160 {
        return None;
    }
    let cleaned: String = first
        .chars()
        .filter(|ch| !ch.is_control())
        .take(120)
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

#[derive(Default)]
struct PsServiceRow {
    service: String,
    state: String,
    health: String,
}

fn evaluate_core_services_from_ps(
    raw_json: &str,
    external_oidc_configured: bool,
) -> Result<Vec<CommunityDeployServiceStatus>, CommunityDeployError> {
    let rows =
        parse_ps_service_rows(raw_json).map_err(CommunityDeployError::ReadinessProbeFailed)?;
    let mut by_name: BTreeMap<String, Vec<&PsServiceRow>> = BTreeMap::new();
    for row in &rows {
        by_name
            .entry(row.service.to_ascii_lowercase())
            .or_default()
            .push(row);
    }

    let mut statuses = Vec::with_capacity(CommunityCoreService::ALL.len());
    for core_svc in CommunityCoreService::ALL {
        let candidates = by_name
            .get(core_svc.slug())
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        if candidates.is_empty() {
            if core_svc == CommunityCoreService::Keycloak && external_oidc_configured {
                statuses.push(CommunityDeployServiceStatus {
                    service: core_svc,
                    readiness: ServiceReadiness::Ready,
                    external_oidc: true,
                });
            } else {
                statuses.push(CommunityDeployServiceStatus {
                    service: core_svc,
                    readiness: ServiceReadiness::Missing,
                    external_oidc: false,
                });
            }
            continue;
        }

        let readiness = worst_row_readiness(candidates);
        statuses.push(CommunityDeployServiceStatus {
            service: core_svc,
            readiness,
            external_oidc: false,
        });
    }
    Ok(statuses)
}

fn worst_row_readiness(rows: &[&PsServiceRow]) -> ServiceReadiness {
    let mut chosen = ServiceReadiness::Ready;
    for row in rows {
        let current = classify_ps_row(row);
        if readiness_rank(current) > readiness_rank(chosen) {
            chosen = current;
        }
    }
    chosen
}

const fn readiness_rank(readiness: ServiceReadiness) -> u8 {
    match readiness {
        ServiceReadiness::Ready => 0,
        ServiceReadiness::Starting => 1,
        ServiceReadiness::Restarting => 2,
        ServiceReadiness::PolicyDegraded => 3,
        ServiceReadiness::Unhealthy => 4,
        ServiceReadiness::Stopped => 5,
        ServiceReadiness::Missing => 6,
    }
}

fn classify_ps_row(row: &PsServiceRow) -> ServiceReadiness {
    let state = row.state.trim().to_ascii_lowercase();
    let health = row.health.trim().to_ascii_lowercase();
    if state == "restarting" {
        return ServiceReadiness::Restarting;
    }
    if state == "created" {
        return ServiceReadiness::Starting;
    }
    if state != "running" {
        return ServiceReadiness::Stopped;
    }
    match health.as_str() {
        "" | "healthy" => ServiceReadiness::Ready,
        "starting" => ServiceReadiness::Starting,
        _ => ServiceReadiness::Unhealthy,
    }
}

fn parse_ps_service_rows(raw_json: &str) -> Result<Vec<PsServiceRow>, SelfHostHealthError> {
    if raw_json.len() > crate::self_host_health::MAX_COMPOSE_PS_JSON_BYTES {
        return Err(SelfHostHealthError::PayloadTooLarge);
    }
    let mut parser = MiniPsParser {
        raw: raw_json,
        offset: 0,
    };
    parser.whitespace();
    if parser.peek().is_none() {
        return Ok(Vec::new());
    }
    let mut rows = Vec::new();
    if parser.peek() == Some(b'[') {
        parser.offset += 1;
        parser.whitespace();
        if parser.peek() == Some(b']') {
            parser.offset += 1;
            parser.whitespace();
            if parser.offset != parser.raw.len() {
                return Err(SelfHostHealthError::InvalidJson);
            }
            return Ok(rows);
        }
        loop {
            if rows.len() >= crate::self_host_health::MAX_COMPOSE_CONTAINERS {
                return Err(SelfHostHealthError::TooManyContainers);
            }
            rows.push(parser.parse_object()?);
            parser.whitespace();
            match parser.peek() {
                Some(b',') => {
                    parser.offset += 1;
                    parser.whitespace();
                }
                Some(b']') => {
                    parser.offset += 1;
                    break;
                }
                _ => return Err(SelfHostHealthError::InvalidJson),
            }
        }
        parser.whitespace();
        if parser.offset != parser.raw.len() {
            return Err(SelfHostHealthError::InvalidJson);
        }
    } else {
        while parser.peek().is_some() {
            if rows.len() >= crate::self_host_health::MAX_COMPOSE_CONTAINERS {
                return Err(SelfHostHealthError::TooManyContainers);
            }
            rows.push(parser.parse_object()?);
            parser.whitespace();
        }
    }
    Ok(rows)
}

struct MiniPsParser<'a> {
    raw: &'a str,
    offset: usize,
}

impl MiniPsParser<'_> {
    fn peek(&self) -> Option<u8> {
        self.raw.as_bytes().get(self.offset).copied()
    }

    fn whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\r' | b'\n' | b'\t')) {
            self.offset += 1;
        }
    }

    fn expect(&mut self, expected: u8) -> Result<(), SelfHostHealthError> {
        if self.peek() != Some(expected) {
            return Err(SelfHostHealthError::InvalidJson);
        }
        self.offset += 1;
        Ok(())
    }

    fn parse_object(&mut self) -> Result<PsServiceRow, SelfHostHealthError> {
        self.expect(b'{')?;
        self.whitespace();
        let mut row = PsServiceRow::default();
        let mut keys = BTreeSet::new();
        if self.peek() == Some(b'}') {
            return Err(SelfHostHealthError::InvalidJson);
        }
        loop {
            if keys.len() >= 48 {
                return Err(SelfHostHealthError::InvalidJson);
            }
            let key = self.parse_string()?;
            if !keys.insert(key.clone()) {
                return Err(SelfHostHealthError::InvalidJson);
            }
            self.whitespace();
            self.expect(b':')?;
            self.whitespace();
            match key.as_str() {
                "Service" => row.service = self.parse_string()?,
                "State" => row.state = self.parse_string()?,
                "Health" => {
                    if self.peek() == Some(b'"') {
                        row.health = self.parse_string()?;
                    } else {
                        self.skip_value(0)?;
                    }
                }
                _ => self.skip_value(0)?,
            }
            self.whitespace();
            match self.peek() {
                Some(b',') => {
                    self.offset += 1;
                    self.whitespace();
                }
                Some(b'}') => {
                    self.offset += 1;
                    break;
                }
                _ => return Err(SelfHostHealthError::InvalidJson),
            }
        }
        if row.service.is_empty() || row.state.is_empty() {
            return Err(SelfHostHealthError::InvalidJson);
        }
        Ok(row)
    }

    fn skip_value(&mut self, depth: u8) -> Result<(), SelfHostHealthError> {
        if depth > 4 {
            return Err(SelfHostHealthError::InvalidJson);
        }
        match self.peek() {
            Some(b'"') => {
                let _ = self.parse_string()?;
                Ok(())
            }
            Some(b't') if self.raw[self.offset..].starts_with("true") => {
                self.offset += 4;
                Ok(())
            }
            Some(b'f') if self.raw[self.offset..].starts_with("false") => {
                self.offset += 5;
                Ok(())
            }
            Some(b'n') if self.raw[self.offset..].starts_with("null") => {
                self.offset += 4;
                Ok(())
            }
            Some(b'-' | b'0'..=b'9') => {
                if self.peek() == Some(b'-') {
                    self.offset += 1;
                }
                while matches!(
                    self.peek(),
                    Some(b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-')
                ) {
                    self.offset += 1;
                }
                Ok(())
            }
            Some(b'[') => {
                self.offset += 1;
                self.whitespace();
                if self.peek() == Some(b']') {
                    self.offset += 1;
                    return Ok(());
                }
                let mut count = 0usize;
                loop {
                    count += 1;
                    if count > 32 {
                        return Err(SelfHostHealthError::InvalidJson);
                    }
                    self.skip_value(depth + 1)?;
                    self.whitespace();
                    match self.peek() {
                        Some(b',') => {
                            self.offset += 1;
                            self.whitespace();
                        }
                        Some(b']') => {
                            self.offset += 1;
                            return Ok(());
                        }
                        _ => return Err(SelfHostHealthError::InvalidJson),
                    }
                }
            }
            Some(b'{') => {
                self.offset += 1;
                self.whitespace();
                if self.peek() == Some(b'}') {
                    self.offset += 1;
                    return Ok(());
                }
                let mut count = 0usize;
                loop {
                    count += 1;
                    if count > 32 {
                        return Err(SelfHostHealthError::InvalidJson);
                    }
                    let _ = self.parse_string()?;
                    self.whitespace();
                    self.expect(b':')?;
                    self.whitespace();
                    self.skip_value(depth + 1)?;
                    self.whitespace();
                    match self.peek() {
                        Some(b',') => {
                            self.offset += 1;
                            self.whitespace();
                        }
                        Some(b'}') => {
                            self.offset += 1;
                            return Ok(());
                        }
                        _ => return Err(SelfHostHealthError::InvalidJson),
                    }
                }
            }
            _ => Err(SelfHostHealthError::InvalidJson),
        }
    }

    fn hex_quad(&mut self) -> Result<u32, SelfHostHealthError> {
        let mut value = 0u32;
        for _ in 0..4 {
            let digit = match self.peek() {
                Some(b'0'..=b'9') => u32::from(self.peek().unwrap() - b'0'),
                Some(b'a'..=b'f') => u32::from(self.peek().unwrap() - b'a' + 10),
                Some(b'A'..=b'F') => u32::from(self.peek().unwrap() - b'A' + 10),
                _ => return Err(SelfHostHealthError::InvalidJson),
            };
            self.offset += 1;
            value = (value << 4) | digit;
        }
        Ok(value)
    }

    fn parse_string(&mut self) -> Result<String, SelfHostHealthError> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let next = self.raw[self.offset..]
                .chars()
                .next()
                .ok_or(SelfHostHealthError::InvalidJson)?;
            self.offset += next.len_utf8();
            match next {
                '"' => return Ok(out),
                '\\' => {
                    let esc = self.peek().ok_or(SelfHostHealthError::InvalidJson)?;
                    self.offset += 1;
                    out.push(match esc {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let mut scalar = self.hex_quad()?;
                            if (0xd800..=0xdbff).contains(&scalar) {
                                self.expect(b'\\')?;
                                self.expect(b'u')?;
                                let low = self.hex_quad()?;
                                if !(0xdc00..=0xdfff).contains(&low) {
                                    return Err(SelfHostHealthError::InvalidJson);
                                }
                                scalar = 0x10000 + ((scalar - 0xd800) << 10) + (low - 0xdc00);
                            }
                            char::from_u32(scalar).ok_or(SelfHostHealthError::InvalidJson)?
                        }
                        _ => return Err(SelfHostHealthError::InvalidJson),
                    });
                }
                c if c <= '\u{1f}' => return Err(SelfHostHealthError::InvalidJson),
                other => out.push(other),
            }
        }
    }
}

#[cfg(test)]
pub(crate) fn non_shared_test_scratch_root() -> PathBuf {
    let sys_tmp = std::env::temp_dir();
    if let Ok(canonical_tmp) = fs::canonicalize(&sys_tmp) {
        if !is_sensitive_stack_root(&canonical_tmp) {
            return sys_tmp;
        }
    }
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && !is_sensitive_stack_root(p))
        .or_else(|| {
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(|h| PathBuf::from(h).join(".cache"))
        })
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.cache"));
    let root = base.join("kodera-desktop-test-scratch");
    let _ = fs::create_dir_all(&root);
    root
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;

    static TEST_DIR_SEQ: AtomicU64 = AtomicU64::new(1);

    struct TempStackFixture {
        dir: PathBuf,
    }

    impl TempStackFixture {
        fn new_with_compose() -> Self {
            let seq = TEST_DIR_SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = non_shared_test_scratch_root().join(format!(
                "kodera-community-deploy-test-{}-{seq}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("docker-compose.yml"),
                "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n",
            )
            .unwrap();
            Self { dir }
        }

        fn path_str(&self) -> String {
            self.dir.to_str().unwrap().to_owned()
        }
    }

    impl Drop for TempStackFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    type RecordedCall = (String, Vec<String>);

    struct MockDockerRunner {
        calls: Mutex<Vec<RecordedCall>>,
        responses: Mutex<VecDeque<Result<CommandExecOutput, DockerUnavailableReason>>>,
    }

    impl MockDockerRunner {
        fn with_responses(
            items: impl IntoIterator<Item = Result<CommandExecOutput, DockerUnavailableReason>>,
        ) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                responses: Mutex::new(items.into_iter().collect()),
            }
        }

        fn ok_stdout(stdout: &str) -> Result<CommandExecOutput, DockerUnavailableReason> {
            Ok(CommandExecOutput {
                status_code: Some(0),
                stdout: stdout.to_owned(),
                stderr: String::new(),
                timed_out: false,
            })
        }

        fn ok_compose_json() -> Result<CommandExecOutput, DockerUnavailableReason> {
            Self::ok_stdout(
                r#"{"name":"community","services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7"}}}"#,
            )
        }

        fn fail_stderr(
            code: i32,
            stderr: &str,
        ) -> Result<CommandExecOutput, DockerUnavailableReason> {
            Ok(CommandExecOutput {
                status_code: Some(code),
                stdout: String::new(),
                stderr: stderr.to_owned(),
                timed_out: false,
            })
        }

        fn recorded_calls(&self) -> Vec<RecordedCall> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl CommunityCommandRunner for MockDockerRunner {
        fn run_argv(
            &self,
            program: &str,
            args: &[String],
            _working_dir: Option<&Path>,
            _timeout: Duration,
        ) -> Result<CommandExecOutput, DockerUnavailableReason> {
            self.calls
                .lock()
                .unwrap()
                .push((program.to_owned(), args.to_vec()));
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Self::ok_stdout(""))
        }

        fn poll_backoff(&self) -> Duration {
            Duration::ZERO
        }
    }

    fn healthy_full_stack_ps_json() -> &'static str {
        r#"[
            {"Service":"keycloak","State":"running","Health":"healthy","MemoryMiB":256},
            {"Service":"db","State":"running","Health":"healthy","MemoryMiB":192},
            {"Service":"synapse","State":"running","Health":"healthy","KoderaPolicy":"0.1.4","MemoryMiB":420},
            {"Service":"server","State":"running","Health":"healthy","MemoryMiB":220},
            {"Service":"web","State":"running","Health":"healthy","MemoryMiB":64},
            {"Service":"livekit","State":"running","Health":"healthy","MemoryMiB":128}
        ]"#
    }

    #[test]
    fn preflight_validates_argv_docker_and_compose_versions_without_shell() {
        let fixture = TempStackFixture::new_with_compose();
        let runner = MockDockerRunner::with_responses([
            MockDockerRunner::ok_stdout("Docker version 28.1.0, build 4d8c241\n"),
            MockDockerRunner::ok_stdout("Docker Compose version v2.36.0\n"),
        ]);
        let spec = CommunityPreflightSpec {
            stack_dir: &fixture.path_str(),
            domain: "Chat.Example.org",
            acme_email: "ops@Example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        let report = self_host_preflight_community(&spec, &runner).unwrap();
        assert_eq!(
            report.docker_version,
            "Docker version 28.1.0, build 4d8c241"
        );
        assert_eq!(report.compose_version, "Docker Compose version v2.36.0");
        assert!(report.compose_file_present);
        assert!(report.stack_dir_writable);
        assert_eq!(report.normalized_domain, "chat.example.org");
        assert_eq!(report.matrix_base_domain, "example.org");
        assert_eq!(report.tls_mode, CommunityTlsMode::Acme);

        let calls = runner.recorded_calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[0],
            ("docker".to_owned(), vec!["--version".to_owned()])
        );
        assert_eq!(
            calls[1],
            (
                "docker".to_owned(),
                vec!["compose".to_owned(), "version".to_owned()]
            )
        );
    }

    #[test]
    fn preflight_rejects_newlines_and_crlf_injection_in_every_field() {
        let fixture = TempStackFixture::new_with_compose();
        let runner = MockDockerRunner::with_responses([]);

        for poisoned_domain in [
            "chat.example.org\nEVIL=1",
            "chat.example.org\r\nEVIL=1",
            "\nchat.example.org",
        ] {
            let spec = CommunityPreflightSpec {
                stack_dir: &fixture.path_str(),
                domain: poisoned_domain,
                acme_email: "ops@example.org",
                tls_mode: CommunityTlsMode::Acme,
                http_port: 80,
                https_port: 443,
            };
            assert_eq!(
                self_host_preflight_community(&spec, &runner),
                Err(CommunityDeployError::InvalidDomain)
            );
        }

        for poisoned_email in [
            "ops@example.org\nKODERA_AUTH_TRUST=bad",
            "ops\r@example.org",
        ] {
            let spec = CommunityPreflightSpec {
                stack_dir: &fixture.path_str(),
                domain: "chat.example.org",
                acme_email: poisoned_email,
                tls_mode: CommunityTlsMode::Acme,
                http_port: 80,
                https_port: 443,
            };
            assert_eq!(
                self_host_preflight_community(&spec, &runner),
                Err(CommunityDeployError::InvalidAcmeEmail)
            );
        }

        let bad_dir_spec = CommunityPreflightSpec {
            stack_dir: "/tmp/kodera\n/deploy",
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_preflight_community(&bad_dir_spec, &runner),
            Err(CommunityDeployError::InvalidStackDir)
        );
        assert!(runner.recorded_calls().is_empty());
    }

    #[test]
    fn preflight_rejects_path_traversal_relative_paths_and_shell_metacharacters() {
        let fixture = TempStackFixture::new_with_compose();
        let runner = MockDockerRunner::with_responses([]);
        let traversal = format!("{}/../{}", fixture.path_str(), "escape");

        for bad_dir in [
            traversal.as_str(),
            "deploy/community",
            "./deploy/community",
            "/tmp/kodera;id",
            "/tmp/kodera|whoami",
            "/tmp/kodera$(uname)",
            "/tmp/kodera`id`",
            "/tmp/kodera&true",
        ] {
            let spec = CommunityPreflightSpec {
                stack_dir: bad_dir,
                domain: "chat.example.org",
                acme_email: "ops@example.org",
                tls_mode: CommunityTlsMode::Internal,
                http_port: 80,
                https_port: 443,
            };
            assert_eq!(
                self_host_preflight_community(&spec, &runner),
                Err(CommunityDeployError::InvalidStackDir),
                "expected InvalidStackDir for {bad_dir}"
            );
        }
        assert!(runner.recorded_calls().is_empty());
    }

    #[test]
    fn preflight_rejects_invalid_domains_emails_ports_and_tls_modes() {
        let fixture = TempStackFixture::new_with_compose();
        let runner = MockDockerRunner::with_responses([]);

        assert_eq!(
            CommunityTlsMode::parse("self-signed"),
            Err(CommunityDeployError::InvalidTlsMode)
        );

        for bad_domain in [
            "",
            "localhost",
            "127.0.0.1",
            "-chat.example.org",
            "chat-.example.org",
            "chat..example.org",
            "chat.example.org;id",
            "chat example.org",
            "chat.example.123",
        ] {
            let spec = CommunityPreflightSpec {
                stack_dir: &fixture.path_str(),
                domain: bad_domain,
                acme_email: "ops@example.org",
                tls_mode: CommunityTlsMode::Acme,
                http_port: 80,
                https_port: 443,
            };
            assert_eq!(
                self_host_preflight_community(&spec, &runner),
                Err(CommunityDeployError::InvalidDomain),
                "expected InvalidDomain for {bad_domain}"
            );
        }

        for bad_email in [
            "",
            "ops.example.org",
            "@example.org",
            "ops@@example.org",
            ".ops@example.org",
            "ops@localhost",
            "ops;id@example.org",
        ] {
            let spec = CommunityPreflightSpec {
                stack_dir: &fixture.path_str(),
                domain: "chat.example.org",
                acme_email: bad_email,
                tls_mode: CommunityTlsMode::Acme,
                http_port: 80,
                https_port: 443,
            };
            assert_eq!(
                self_host_preflight_community(&spec, &runner),
                Err(CommunityDeployError::InvalidAcmeEmail),
                "expected InvalidAcmeEmail for {bad_email}"
            );
        }

        for (http_port, https_port) in [(0, 443), (80, 0), (443, 443)] {
            let spec = CommunityPreflightSpec {
                stack_dir: &fixture.path_str(),
                domain: "chat.example.org",
                acme_email: "ops@example.org",
                tls_mode: CommunityTlsMode::Off,
                http_port,
                https_port,
            };
            assert_eq!(
                self_host_preflight_community(&spec, &runner),
                Err(CommunityDeployError::InvalidPort)
            );
        }
    }

    #[test]
    fn preflight_rejects_missing_compose_file_and_docker_daemon_errors() {
        let fixture = TempStackFixture::new_with_compose();
        fs::remove_file(fixture.dir.join("docker-compose.yml")).unwrap();
        let runner = MockDockerRunner::with_responses([]);
        let spec = CommunityPreflightSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_preflight_community(&spec, &runner),
            Err(CommunityDeployError::ComposeFileMissing)
        );

        // Restore compose file and verify Docker CLI missing / Compose plugin missing handling.
        fs::write(
            fixture.dir.join("docker-compose.yml"),
            "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n",
        )
        .unwrap();
        let cli_missing_runner =
            MockDockerRunner::with_responses([Err(DockerUnavailableReason::CliMissing)]);
        assert_eq!(
            self_host_preflight_community(&spec, &cli_missing_runner),
            Err(CommunityDeployError::DockerUnavailable(
                DockerUnavailableReason::CliMissing
            ))
        );

        let compose_missing_runner = MockDockerRunner::with_responses([
            MockDockerRunner::ok_stdout("Docker version 28.1.0\n"),
            MockDockerRunner::fail_stderr(1, "docker: 'compose' is not a docker command"),
        ]);
        assert_eq!(
            self_host_preflight_community(&spec, &compose_missing_runner),
            Err(CommunityDeployError::ComposePluginMissing)
        );
    }

    #[cfg(unix)]
    #[test]
    fn preflight_and_prepare_reject_symlinked_stack_dir_compose_and_dotenv() {
        use std::os::unix::fs::symlink;

        let real_fixture = TempStackFixture::new_with_compose();
        let link_parent = TempStackFixture::new_with_compose();
        let symlink_dir = link_parent.dir.join("linked-stack");
        symlink(&real_fixture.dir, &symlink_dir).unwrap();

        let runner = MockDockerRunner::with_responses([]);
        let spec = CommunityPreflightSpec {
            stack_dir: symlink_dir.to_str().unwrap(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_preflight_community(&spec, &runner),
            Err(CommunityDeployError::SymlinkRejected)
        );

        // Symlinked docker-compose.yml inside a real directory is also refused.
        let compose_link_fixture = TempStackFixture::new_with_compose();
        let compose_file = compose_link_fixture.dir.join("docker-compose.yml");
        fs::remove_file(&compose_file).unwrap();
        symlink(real_fixture.dir.join("docker-compose.yml"), &compose_file).unwrap();
        let spec_compose_link = CommunityPreflightSpec {
            stack_dir: &compose_link_fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_preflight_community(&spec_compose_link, &runner),
            Err(CommunityDeployError::SymlinkRejected)
        );

        // Symlinked .env target during prepare is refused without overwriting target file.
        let outside_target = link_parent.dir.join("victim.txt");
        fs::write(&outside_target, "keep-safe").unwrap();
        symlink(&outside_target, real_fixture.dir.join(".env")).unwrap();
        let prep_spec = CommunityPrepareSpec {
            stack_dir: &real_fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            oidc_provider_origin: "https://id.example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_prepare_community(&prep_spec, &runner),
            Err(CommunityDeployError::SymlinkRejected)
        );
        assert_eq!(fs::read_to_string(&outside_target).unwrap(), "keep-safe");
    }

    #[test]
    fn prepare_generates_distinct_csprng_secrets_writes_0600_dotenv_and_runs_compose_config() {
        let fixture = TempStackFixture::new_with_compose();
        let runner = MockDockerRunner::with_responses([MockDockerRunner::ok_compose_json()]);
        let spec = CommunityPrepareSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            oidc_provider_origin: "https://id.example.org:443",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        let report = self_host_prepare_community(&spec, &runner).unwrap();
        assert!(report.env_file_written);
        assert!(report.compose_config_valid);
        assert_eq!(report.normalized_domain, "chat.example.org");
        assert_eq!(report.matrix_base_domain, "example.org");
        assert_eq!(
            report.oidc_issuer,
            "https://id.example.org/realms/community"
        );
        assert_eq!(report.generated_secret_keys.len(), 16);

        let env_path = fixture.dir.join(".env");
        assert!(env_path.is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(report.unix_file_mode, 0o600);
            let mode = fs::symlink_metadata(&env_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }

        let raw_env = fs::read_to_string(&env_path).unwrap();
        let parsed: BTreeMap<&str, &str> = raw_env
            .lines()
            .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
            .map(|l| l.split_once('=').unwrap())
            .collect();

        assert_eq!(
            parsed.get("DJANGO_ALLOWED_HOSTS").copied(),
            Some("chat.example.org,127.0.0.1,server"),
            "DJANGO_ALLOWED_HOSTS must admit internal server host for tenant-agent polling"
        );

        // Verify 64-char hex CSPRNG secrets are distinct and have exact length 64.
        let hex_keys = [
            "POSTGRES_PASSWORD",
            "KODERA_API_DATABASE_PASSWORD",
            "KODERA_COLLAB_DATABASE_PASSWORD",
            "SYNAPSE_POSTGRES_PASSWORD",
            "DJANGO_SECRET_KEY",
            "KODERA_MEMBERSHIP_CURSOR_KEY",
            "ROOM_ACCESS_MATRIX_TOKEN",
            "LIVEKIT_API_SECRET",
            "KODERA_SYNAPSE_OIDC_CLIENT_SECRET",
            "KEYCLOAK_ADMIN_PASSWORD",
            "KEYCLOAK_DB_PASSWORD",
        ];
        let mut unique_secrets = BTreeSet::new();
        for key in hex_keys {
            let val = parsed.get(key).copied().expect(key);
            assert_eq!(val.len(), 64, "{key} must be 64 hex chars");
            assert!(
                val.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                "{key} must be lowercase hex"
            );
            assert!(unique_secrets.insert(val), "{key} reused entropy");
            assert!(
                !format!("{report:?}").contains(val),
                "prepare report leaked secret {key}"
            );
        }

        // Verify canonical 44-char padded standard Base64 discovery HMAC key (32 bytes).
        let discovery_val = parsed
            .get("KODERA_DISCOVERY_HMAC_KEY")
            .copied()
            .expect("KODERA_DISCOVERY_HMAC_KEY");
        let decoded_discovery = decode_canonical_standard_base64_32(discovery_val)
            .expect("KODERA_DISCOVERY_HMAC_KEY must be canonical 44-char standard Base64");
        assert_eq!(encode_base64_padded_32(&decoded_discovery), discovery_val);
        assert!(
            unique_secrets.insert(discovery_val),
            "KODERA_DISCOVERY_HMAC_KEY reused entropy"
        );
        assert!(
            !format!("{report:?}").contains(discovery_val),
            "prepare report leaked KODERA_DISCOVERY_HMAC_KEY"
        );

        // Verify 44-char padded base64url seal keys.
        for seal_key in [
            "KODERA_CONTACT_SEAL_KEY",
            "KODERA_OUTBOX_SEAL_KEY",
            "KODERA_COLLAB_TICKET_KEY",
        ] {
            let val = parsed.get(seal_key).copied().expect(seal_key);
            assert_eq!(val.len(), 44, "{seal_key} must be 44 base64url chars");
            assert!(val.ends_with('='));
            assert!(unique_secrets.insert(val), "{seal_key} reused entropy");
            assert!(!format!("{report:?}").contains(val));
        }

        let lk_key = parsed.get("LIVEKIT_API_KEY").copied().unwrap();
        assert_eq!(lk_key.len(), 27);
        assert!(lk_key.starts_with("lk_"));
        assert!(!format!("{report:?}").contains(lk_key));

        // Verify `docker compose --env-file ... -f ... config --format json` argv invocation.
        let calls = runner.recorded_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "docker");
        assert_eq!(calls[0].1[0], "compose");
        assert_eq!(calls[0].1[1], "--env-file");
        assert_eq!(calls[0].1[3], "-f");
        assert_eq!(calls[0].1[5], "config");
        assert_eq!(calls[0].1[6], "--format");
        assert_eq!(calls[0].1[7], "json");
    }

    #[test]
    fn prepare_rejects_oidc_injection_and_removes_dotenv_when_compose_config_fails() {
        let fixture = TempStackFixture::new_with_compose();
        let runner = MockDockerRunner::with_responses([]);

        for bad_oidc in [
            "http://id.example.org",
            "https://id.example.org/realms/community",
            "https://id.example.org?next=evil",
            "https://user@id.example.org",
            "https://id.example.org\nEVIL=1",
            "javascript:alert(1)",
        ] {
            let spec = CommunityPrepareSpec {
                stack_dir: &fixture.path_str(),
                domain: "chat.example.org",
                acme_email: "ops@example.org",
                oidc_provider_origin: bad_oidc,
                tls_mode: CommunityTlsMode::Acme,
                http_port: 80,
                https_port: 443,
            };
            assert_eq!(
                self_host_prepare_community(&spec, &runner),
                Err(CommunityDeployError::InvalidOidcOrigin),
                "expected InvalidOidcOrigin for {bad_oidc}"
            );
        }
        assert!(!fixture.dir.join(".env").exists());

        // When `docker compose config --quiet` fails, `.env` is removed cleanly.
        let failing_runner =
            MockDockerRunner::with_responses([MockDockerRunner::fail_stderr(1, "invalid yaml")]);
        let valid_spec = CommunityPrepareSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            oidc_provider_origin: "https://id.example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_prepare_community(&valid_spec, &failing_runner),
            Err(CommunityDeployError::ComposeConfigInvalid)
        );
        assert!(!fixture.dir.join(".env").exists());
    }

    #[test]
    fn deploy_launches_compose_and_polls_until_keycloak_server_web_and_livekit_are_healthy() {
        let fixture = TempStackFixture::new_with_compose();
        let prep_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_compose_json()]);
        let prep_spec = CommunityPrepareSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            oidc_provider_origin: "https://id.example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        self_host_prepare_community(&prep_spec, &prep_runner).unwrap();

        let starting_ps = r#"[
            {"Service":"keycloak","State":"running","Health":"starting","MemoryMiB":220},
            {"Service":"db","State":"running","Health":"healthy","MemoryMiB":180},
            {"Service":"synapse","State":"running","Health":"healthy","KoderaPolicy":"0.1.4","MemoryMiB":400},
            {"Service":"server","State":"running","Health":"starting","MemoryMiB":200},
            {"Service":"web","State":"running","Health":"healthy","MemoryMiB":64},
            {"Service":"livekit","State":"running","Health":"healthy","MemoryMiB":120}
        ]"#;

        let deploy_runner = MockDockerRunner::with_responses([
            MockDockerRunner::ok_compose_json(),
            MockDockerRunner::ok_stdout(""),
            MockDockerRunner::ok_stdout(starting_ps),
            MockDockerRunner::ok_stdout(healthy_full_stack_ps_json()),
        ]);

        let report =
            self_host_deploy_community(&fixture.path_str(), Some(30_000), &deploy_runner).unwrap();
        assert!(report.stack_healthy);
        assert_eq!(report.poll_attempts, 2);
        assert!(report.health_report.is_healthy());
        assert_eq!(report.core_services.len(), 4);
        assert!(report
            .core_services
            .iter()
            .all(|s| s.readiness == ServiceReadiness::Ready));

        let calls = deploy_runner.recorded_calls();
        assert_eq!(calls.len(), 4);
        assert_eq!(
            &calls[0].1[5..],
            &[
                "config".to_owned(),
                "--format".to_owned(),
                "json".to_owned()
            ]
        );
        assert_eq!(
            &calls[1].1[5..],
            &["up".to_owned(), "-d".to_owned(), "--wait".to_owned()]
        );
        assert_eq!(
            &calls[2].1[5..],
            &["ps".to_owned(), "--format".to_owned(), "json".to_owned()]
        );
    }

    #[test]
    fn deploy_supports_external_oidc_profile_and_fails_on_unhealthy_or_degraded_services() {
        let fixture = TempStackFixture::new_with_compose();
        let prep_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_compose_json()]);
        let prep_spec = CommunityPrepareSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            oidc_provider_origin: "https://id.example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        self_host_prepare_community(&prep_spec, &prep_runner).unwrap();

        // External OIDC topology (no local keycloak container, valid https KODERA_OIDC_PROVIDER_ORIGIN).
        let external_oidc_ps = r#"[
            {"Service":"db","State":"running","Health":"healthy","MemoryMiB":180},
            {"Service":"synapse","State":"running","Health":"healthy","KoderaPolicy":"0.1.4","MemoryMiB":410},
            {"Service":"server","State":"running","Health":"healthy","MemoryMiB":210},
            {"Service":"web","State":"running","Health":"","MemoryMiB":64},
            {"Service":"livekit","State":"running","Health":"","MemoryMiB":128}
        ]"#;
        let ok_runner = MockDockerRunner::with_responses([
            MockDockerRunner::ok_compose_json(),
            MockDockerRunner::ok_stdout(""),
            MockDockerRunner::ok_stdout(external_oidc_ps),
        ]);
        let ok_report =
            self_host_deploy_community(&fixture.path_str(), Some(10_000), &ok_runner).unwrap();
        assert!(ok_report.stack_healthy);
        assert!(ok_report.core_services[0].external_oidc);

        // Unhealthy Keycloak container fails closed with StackUnhealthy.
        let unhealthy_keycloak_ps = r#"[
            {"Service":"keycloak","State":"running","Health":"unhealthy"},
            {"Service":"db","State":"running","Health":"healthy"},
            {"Service":"synapse","State":"running","Health":"healthy"},
            {"Service":"server","State":"running","Health":"healthy"},
            {"Service":"web","State":"running","Health":"healthy"},
            {"Service":"livekit","State":"running","Health":"healthy"}
        ]"#;
        let bad_kc_runner = MockDockerRunner::with_responses([
            MockDockerRunner::ok_compose_json(),
            MockDockerRunner::ok_stdout(""),
            MockDockerRunner::ok_stdout(unhealthy_keycloak_ps),
        ]);
        assert_eq!(
            self_host_deploy_community(&fixture.path_str(), Some(10_000), &bad_kc_runner),
            Err(CommunityDeployError::StackUnhealthy)
        );

        // Synapse missing KoderaPolicy in self_host_health fails closed with StackUnhealthy.
        let degraded_policy_ps = r#"[
            {"Service":"keycloak","State":"running","Health":"healthy"},
            {"Service":"db","State":"running","Health":"healthy"},
            {"Service":"synapse","State":"running","Health":"healthy","KoderaPolicy":false},
            {"Service":"server","State":"running","Health":"healthy"},
            {"Service":"web","State":"running","Health":"healthy"},
            {"Service":"livekit","State":"running","Health":"healthy"}
        ]"#;
        let bad_policy_runner = MockDockerRunner::with_responses([
            MockDockerRunner::ok_compose_json(),
            MockDockerRunner::ok_stdout(""),
            MockDockerRunner::ok_stdout(degraded_policy_ps),
        ]);
        assert_eq!(
            self_host_deploy_community(&fixture.path_str(), Some(10_000), &bad_policy_runner),
            Err(CommunityDeployError::StackUnhealthy)
        );
    }

    #[cfg(unix)]
    #[test]
    fn deploy_refuses_missing_or_world_readable_dotenv_before_invoking_docker() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = TempStackFixture::new_with_compose();
        let runner = MockDockerRunner::with_responses([]);
        assert_eq!(
            self_host_deploy_community(&fixture.path_str(), Some(5_000), &runner),
            Err(CommunityDeployError::EnvFileMissing)
        );

        let env_path = fixture.dir.join(".env");
        fs::write(
            &env_path,
            "KODERA_OIDC_PROVIDER_ORIGIN=https://id.example.org\n",
        )
        .unwrap();
        fs::set_permissions(&env_path, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            self_host_deploy_community(&fixture.path_str(), Some(5_000), &runner),
            Err(CommunityDeployError::EnvPermissionsInsecure)
        );
        assert!(runner.recorded_calls().is_empty());
    }

    #[test]
    fn std_process_runner_refuses_non_docker_binaries_and_control_characters() {
        let runner = StdProcessCommunityRunner::new();
        assert_eq!(
            runner.run_argv(
                "sh",
                &["-c".to_owned(), "id".to_owned()],
                None,
                Duration::from_millis(100)
            ),
            Err(DockerUnavailableReason::PermissionDenied)
        );
        assert_eq!(
            runner.run_argv(
                "docker",
                &["compose\nmalicious".to_owned()],
                None,
                Duration::from_millis(100)
            ),
            Err(DockerUnavailableReason::PermissionDenied)
        );
    }

    #[test]
    fn preflight_rejects_docker_daemon_permission_denied_stderr() {
        let fixture = TempStackFixture::new_with_compose();
        let runner = MockDockerRunner::with_responses([MockDockerRunner::fail_stderr(
            1,
            "permission denied while trying to connect to the Docker daemon socket",
        )]);
        let spec = CommunityPreflightSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_preflight_community(&spec, &runner),
            Err(CommunityDeployError::DockerUnavailable(
                DockerUnavailableReason::PermissionDenied
            ))
        );
    }

    #[test]
    fn preflight_rejects_docker_version_timeout() {
        let fixture = TempStackFixture::new_with_compose();
        let runner = MockDockerRunner::with_responses([Ok(CommandExecOutput {
            status_code: None,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: true,
        })]);
        let spec = CommunityPreflightSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_preflight_community(&spec, &runner),
            Err(CommunityDeployError::DockerUnavailable(
                DockerUnavailableReason::ProbeTimedOut
            ))
        );
    }

    #[test]
    fn preflight_rejects_compose_version_timeout() {
        let fixture = TempStackFixture::new_with_compose();
        let runner = MockDockerRunner::with_responses([
            MockDockerRunner::ok_stdout("Docker version 28.1.0\n"),
            Ok(CommandExecOutput {
                status_code: None,
                stdout: String::new(),
                stderr: String::new(),
                timed_out: true,
            }),
        ]);
        let spec = CommunityPreflightSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_preflight_community(&spec, &runner),
            Err(CommunityDeployError::DockerUnavailable(
                DockerUnavailableReason::ProbeTimedOut
            ))
        );
    }

    #[test]
    fn preflight_rejects_empty_or_oversized_docker_version_stdout() {
        let fixture = TempStackFixture::new_with_compose();
        let spec = CommunityPreflightSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        let empty_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_stdout("   \n")]);
        assert_eq!(
            self_host_preflight_community(&spec, &empty_runner),
            Err(CommunityDeployError::DockerVersionUnsupported)
        );

        let huge_line = "x".repeat(200);
        let oversized_runner =
            MockDockerRunner::with_responses([MockDockerRunner::ok_stdout(&huge_line)]);
        assert_eq!(
            self_host_preflight_community(&spec, &oversized_runner),
            Err(CommunityDeployError::DockerVersionUnsupported)
        );
    }

    #[test]
    fn preflight_rejects_empty_compose_yaml_file() {
        let fixture = TempStackFixture::new_with_compose();
        fs::write(fixture.dir.join("docker-compose.yml"), "").unwrap();
        let runner = MockDockerRunner::with_responses([]);
        let spec = CommunityPreflightSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            tls_mode: CommunityTlsMode::Internal,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_preflight_community(&spec, &runner),
            Err(CommunityDeployError::ComposeFileMissing)
        );
    }

    #[test]
    fn preflight_rejects_oversized_stack_dir_path() {
        let runner = MockDockerRunner::with_responses([]);
        let long_dir = format!("/tmp/{}", "a".repeat(MAX_STACK_DIR_BYTES + 1));
        let spec = CommunityPreflightSpec {
            stack_dir: &long_dir,
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_preflight_community(&spec, &runner),
            Err(CommunityDeployError::InvalidStackDir)
        );
    }

    #[test]
    fn preflight_derives_two_label_and_subdomain_matrix_base_domains() {
        assert_eq!(derive_matrix_base_domain("example.org"), "example.org");
        assert_eq!(derive_matrix_base_domain("chat.example.org"), "example.org");
        assert_eq!(
            derive_matrix_base_domain("chat.eu.example.org"),
            "eu.example.org"
        );
    }

    #[test]
    fn tls_mode_round_trips_acme_internal_and_off() {
        for (raw, expected) in [
            ("acme", CommunityTlsMode::Acme),
            ("internal", CommunityTlsMode::Internal),
            ("off", CommunityTlsMode::Off),
        ] {
            let parsed = CommunityTlsMode::parse(raw).unwrap();
            assert_eq!(parsed, expected);
            assert_eq!(parsed.as_str(), raw);
        }
        assert_eq!(
            CommunityTlsMode::parse("ACME"),
            Err(CommunityDeployError::InvalidTlsMode)
        );
    }

    #[test]
    fn prepare_cleans_up_dotenv_when_docker_unavailable_during_config_check() {
        let fixture = TempStackFixture::new_with_compose();
        let runner =
            MockDockerRunner::with_responses([Err(DockerUnavailableReason::DaemonOffline)]);
        let spec = CommunityPrepareSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            oidc_provider_origin: "https://id.example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_prepare_community(&spec, &runner),
            Err(CommunityDeployError::DockerUnavailable(
                DockerUnavailableReason::DaemonOffline
            ))
        );
        assert!(!fixture.dir.join(".env").exists());
    }

    #[test]
    fn prepare_accepts_custom_https_port_and_strips_default_443_on_oidc_origin() {
        let fixture = TempStackFixture::new_with_compose();
        let runner = MockDockerRunner::with_responses([MockDockerRunner::ok_compose_json()]);
        let spec = CommunityPrepareSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops+admin@example.org",
            oidc_provider_origin: "https://id.example.org:8443",
            tls_mode: CommunityTlsMode::Internal,
            http_port: 8080,
            https_port: 8443,
        };
        let report = self_host_prepare_community(&spec, &runner).unwrap();
        assert_eq!(
            report.oidc_issuer,
            "https://id.example.org:8443/realms/community"
        );
        assert_eq!(report.http_port, 8080);
        assert_eq!(report.https_port, 8443);
        assert_eq!(report.tls_mode, CommunityTlsMode::Internal);
    }

    #[test]
    fn prepare_rejects_oidc_origin_with_port_zero_or_overflow() {
        let fixture = TempStackFixture::new_with_compose();
        let runner = MockDockerRunner::with_responses([]);
        for bad_origin in [
            "https://id.example.org:0",
            "https://id.example.org:65536",
            "https://id.example.org:abc",
            "https://id.example.org:",
        ] {
            let spec = CommunityPrepareSpec {
                stack_dir: &fixture.path_str(),
                domain: "chat.example.org",
                acme_email: "ops@example.org",
                oidc_provider_origin: bad_origin,
                tls_mode: CommunityTlsMode::Acme,
                http_port: 80,
                https_port: 443,
            };
            assert_eq!(
                self_host_prepare_community(&spec, &runner),
                Err(CommunityDeployError::InvalidOidcOrigin)
            );
        }
    }

    fn decode_canonical_standard_base64_32(raw: &str) -> Option<[u8; 32]> {
        if raw.len() != 44 || !raw.ends_with('=') {
            return None;
        }
        let sextet = |b: u8| -> Option<u8> {
            match b {
                b'A'..=b'Z' => Some(b - b'A'),
                b'a'..=b'z' => Some(b - b'a' + 26),
                b'0'..=b'9' => Some(b - b'0' + 52),
                b'+' => Some(62),
                b'/' => Some(63),
                _ => None,
            }
        };
        let bytes = raw.as_bytes();
        let mut out = [0u8; 32];
        let mut in_idx = 0usize;
        let mut out_idx = 0usize;
        while in_idx < 40 {
            let s0 = sextet(bytes[in_idx])?;
            let s1 = sextet(bytes[in_idx + 1])?;
            let s2 = sextet(bytes[in_idx + 2])?;
            let s3 = sextet(bytes[in_idx + 3])?;
            out[out_idx] = (s0 << 2) | (s1 >> 4);
            out[out_idx + 1] = (s1 << 4) | (s2 >> 2);
            out[out_idx + 2] = (s2 << 6) | s3;
            in_idx += 4;
            out_idx += 3;
        }
        let s0 = sextet(bytes[40])?;
        let s1 = sextet(bytes[41])?;
        let s2 = sextet(bytes[42])?;
        if (s2 & 0x03) != 0 {
            return None;
        }
        out[30] = (s0 << 2) | (s1 >> 4);
        out[31] = (s1 << 4) | (s2 >> 2);
        if encode_base64_padded_32(&out) == raw {
            Some(out)
        } else {
            None
        }
    }

    #[test]
    fn encode_base64_and_base64url_padded_32_match_rfc4648_vectors() {
        let zero_key = [0u8; 32];
        let encoded_zeros = encode_base64url_padded_32(&zero_key);
        assert_eq!(encoded_zeros.len(), 44);
        assert_eq!(
            encoded_zeros,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
        );
        assert_eq!(
            encode_base64_padded_32(&zero_key),
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
        );
        assert_eq!(
            decode_canonical_standard_base64_32(&encode_base64_padded_32(&zero_key)),
            Some(zero_key)
        );

        let ff_key = [0xffu8; 32];
        let encoded_ff = encode_base64url_padded_32(&ff_key);
        assert_eq!(encoded_ff.len(), 44);
        assert_eq!(encoded_ff, "__________________________________________8=");

        let std_ff = encode_base64_padded_32(&ff_key);
        assert_eq!(std_ff.len(), 44);
        assert_eq!(std_ff, "//////////////////////////////////////////8=");
        assert_eq!(decode_canonical_standard_base64_32(&std_ff), Some(ff_key));

        let fb_key = [0xfbu8; 32];
        let std_fb = encode_base64_padded_32(&fb_key);
        assert_eq!(std_fb, "+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/s=");
        assert_eq!(decode_canonical_standard_base64_32(&std_fb), Some(fb_key));

        // Non-standard or non-canonical encodings must be rejected, matching server configured_key().
        assert_eq!(decode_canonical_standard_base64_32(&encoded_ff), None);
        assert_eq!(decode_canonical_standard_base64_32(&"ab".repeat(32)), None);
        assert_eq!(
            decode_canonical_standard_base64_32(&format!("{}B=", "A".repeat(42))),
            None
        );
        assert_eq!(
            decode_canonical_standard_base64_32("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            None
        );
    }

    #[test]
    fn deploy_returns_compose_launch_failed_on_nonzero_exit_or_timeout() {
        let fixture = TempStackFixture::new_with_compose();
        let prep_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_compose_json()]);
        let prep_spec = CommunityPrepareSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            oidc_provider_origin: "https://id.example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        self_host_prepare_community(&prep_spec, &prep_runner).unwrap();

        let exit_fail_runner = MockDockerRunner::with_responses([
            MockDockerRunner::ok_compose_json(),
            MockDockerRunner::fail_stderr(1, "port allocated"),
        ]);
        assert_eq!(
            self_host_deploy_community(&fixture.path_str(), Some(5_000), &exit_fail_runner),
            Err(CommunityDeployError::ComposeLaunchFailed)
        );

        let timeout_runner = MockDockerRunner::with_responses([
            MockDockerRunner::ok_compose_json(),
            Ok(CommandExecOutput {
                status_code: None,
                stdout: String::new(),
                stderr: String::new(),
                timed_out: true,
            }),
        ]);
        assert_eq!(
            self_host_deploy_community(&fixture.path_str(), Some(5_000), &timeout_runner),
            Err(CommunityDeployError::ComposeLaunchFailed)
        );
    }

    #[test]
    fn deploy_returns_probe_timed_out_when_compose_ps_times_out() {
        let fixture = TempStackFixture::new_with_compose();
        let prep_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_compose_json()]);
        let prep_spec = CommunityPrepareSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            oidc_provider_origin: "https://id.example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        self_host_prepare_community(&prep_spec, &prep_runner).unwrap();

        let runner = MockDockerRunner::with_responses([
            MockDockerRunner::ok_compose_json(),
            MockDockerRunner::ok_stdout(""),
            Ok(CommandExecOutput {
                status_code: None,
                stdout: String::new(),
                stderr: String::new(),
                timed_out: true,
            }),
        ]);
        assert_eq!(
            self_host_deploy_community(&fixture.path_str(), Some(5_000), &runner),
            Err(CommunityDeployError::DockerUnavailable(
                DockerUnavailableReason::ProbeTimedOut
            ))
        );
    }

    #[test]
    fn deploy_returns_readiness_probe_failed_on_malformed_compose_ps_json() {
        let fixture = TempStackFixture::new_with_compose();
        let prep_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_compose_json()]);
        let prep_spec = CommunityPrepareSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            oidc_provider_origin: "https://id.example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        self_host_prepare_community(&prep_spec, &prep_runner).unwrap();

        let runner = MockDockerRunner::with_responses([
            MockDockerRunner::ok_compose_json(),
            MockDockerRunner::ok_stdout(""),
            MockDockerRunner::ok_stdout("{broken_json"),
        ]);
        assert_eq!(
            self_host_deploy_community(&fixture.path_str(), Some(5_000), &runner),
            Err(CommunityDeployError::ReadinessProbeFailed(
                SelfHostHealthError::InvalidJson
            ))
        );
    }

    #[test]
    fn deploy_exhausts_retry_polls_when_service_stays_restarting() {
        let fixture = TempStackFixture::new_with_compose();
        let prep_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_compose_json()]);
        let prep_spec = CommunityPrepareSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            oidc_provider_origin: "https://id.example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        self_host_prepare_community(&prep_spec, &prep_runner).unwrap();

        let restarting_ps = r#"[
            {"Service":"keycloak","State":"restarting","Health":""},
            {"Service":"db","State":"running","Health":"healthy"},
            {"Service":"synapse","State":"running","Health":"healthy"},
            {"Service":"server","State":"running","Health":"healthy"},
            {"Service":"web","State":"running","Health":"healthy"},
            {"Service":"livekit","State":"running","Health":"healthy"}
        ]"#;
        let mut seq = vec![
            MockDockerRunner::ok_compose_json(),
            MockDockerRunner::ok_stdout(""),
        ];
        for _ in 0..READINESS_MAX_POLL_ATTEMPTS {
            seq.push(MockDockerRunner::ok_stdout(restarting_ps));
        }
        let runner = MockDockerRunner::with_responses(seq);
        assert_eq!(
            self_host_deploy_community(&fixture.path_str(), Some(30_000), &runner),
            Err(CommunityDeployError::StackUnhealthy)
        );
        // 1 `compose config --format json` + 1 `compose up` + READINESS_MAX_POLL_ATTEMPTS `compose ps` invocations.
        assert_eq!(
            runner.recorded_calls().len(),
            2 + usize::from(READINESS_MAX_POLL_ATTEMPTS)
        );
    }

    #[test]
    fn deploy_supports_ndjson_compose_ps_output() {
        let fixture = TempStackFixture::new_with_compose();
        let prep_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_compose_json()]);
        let prep_spec = CommunityPrepareSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            oidc_provider_origin: "https://id.example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        self_host_prepare_community(&prep_spec, &prep_runner).unwrap();

        let ndjson = concat!(
            r#"{"Service":"keycloak","State":"running","Health":"healthy","Publishers":[{"TargetPort":8080}]}"#,
            "\n",
            r#"{"Service":"db","State":"running","Health":"healthy"}"#,
            "\n",
            r#"{"Service":"synapse","State":"running","Health":"healthy","KoderaPolicy":"0.1.4"}"#,
            "\n",
            r#"{"Service":"server","State":"running","Health":"healthy"}"#,
            "\n",
            r#"{"Service":"web","State":"running","Health":"healthy"}"#,
            "\n",
            r#"{"Service":"livekit","State":"running","Health":"healthy"}"#,
            "\n",
        );
        let runner = MockDockerRunner::with_responses([
            MockDockerRunner::ok_compose_json(),
            MockDockerRunner::ok_stdout(""),
            MockDockerRunner::ok_stdout(ndjson),
        ]);
        let report =
            self_host_deploy_community(&fixture.path_str(), Some(10_000), &runner).unwrap();
        assert!(report.stack_healthy);
        assert_eq!(report.poll_attempts, 1);
    }

    #[test]
    fn error_display_slugs_are_secret_free_and_deterministic() {
        assert_eq!(
            CommunityDeployError::InvalidStackDir.to_string(),
            "invalid_stack_dir"
        );
        assert_eq!(
            CommunityDeployError::SymlinkRejected.to_string(),
            "symlink_rejected"
        );
        assert_eq!(
            CommunityDeployError::EnvPermissionsInsecure.to_string(),
            "env_permissions_insecure"
        );
        assert_eq!(
            CommunityDeployError::DockerUnavailable(DockerUnavailableReason::CliMissing)
                .to_string(),
            "docker_unavailable:cli_missing"
        );
        assert_eq!(
            CommunityDeployError::StackUnhealthy.to_string(),
            "stack_unhealthy"
        );
        assert_eq!(
            CommunityDeployError::EnvAlreadyExists.to_string(),
            "env_already_exists"
        );
        assert_eq!(
            CommunityDeployError::StackDirNotAuthorized.to_string(),
            "stack_dir_not_authorized"
        );
    }

    #[test]
    fn prepare_never_overwrites_or_deletes_preexisting_dotenv_under_any_outcome() {
        let fixture = TempStackFixture::new_with_compose();
        let env_path = fixture.dir.join(".env");
        let sentinel = "POSTGRES_PASSWORD=live_production_database_secret_do_not_clobber\n";
        fs::write(&env_path, sentinel).unwrap();

        for response in [
            MockDockerRunner::ok_stdout(""),
            MockDockerRunner::fail_stderr(1, "compose invalid"),
            Err(DockerUnavailableReason::DaemonOffline),
        ] {
            let runner = MockDockerRunner::with_responses([response]);
            let spec = CommunityPrepareSpec {
                stack_dir: &fixture.path_str(),
                domain: "chat.example.org",
                acme_email: "ops@example.org",
                oidc_provider_origin: "https://id.example.org",
                tls_mode: CommunityTlsMode::Acme,
                http_port: 80,
                https_port: 443,
            };
            assert_eq!(
                self_host_prepare_community(&spec, &runner),
                Err(CommunityDeployError::EnvAlreadyExists)
            );
            assert!(runner.recorded_calls().is_empty());
            assert_eq!(fs::read_to_string(&env_path).unwrap(), sentinel);
        }
    }

    #[test]
    fn prepare_validates_against_temp_candidate_and_preserves_concurrently_created_dotenv() {
        struct RacingRunner {
            env_path: PathBuf,
            sentinel: &'static str,
            succeed: bool,
        }

        impl CommunityCommandRunner for RacingRunner {
            fn run_argv(
                &self,
                _program: &str,
                args: &[String],
                _working_dir: Option<&Path>,
                _timeout: Duration,
            ) -> Result<CommandExecOutput, DockerUnavailableReason> {
                // Verify `--env-file` points to the isolated candidate file, not `.env`.
                assert_eq!(args[1], "--env-file");
                assert!(args[2].contains(".env.kodera-tmp-"));
                assert!(Path::new(&args[2]).is_file());
                assert!(!self.env_path.exists());
                // Simulate another operator writing `.env` while `docker compose config` runs.
                fs::write(&self.env_path, self.sentinel).unwrap();
                if self.succeed {
                    MockDockerRunner::ok_compose_json()
                } else {
                    MockDockerRunner::fail_stderr(1, "compose config failed")
                }
            }

            fn poll_backoff(&self) -> Duration {
                Duration::ZERO
            }
        }

        // Case 1: Compose config fails after concurrent `.env` creation -> candidate deleted, `.env` intact.
        let fail_fixture = TempStackFixture::new_with_compose();
        let fail_env = fail_fixture.dir.join(".env");
        let fail_runner = RacingRunner {
            env_path: fail_env.clone(),
            sentinel: "CONCURRENT_OPERATOR_SECRET=keep_on_config_failure\n",
            succeed: false,
        };
        let fail_spec = CommunityPrepareSpec {
            stack_dir: &fail_fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            oidc_provider_origin: "https://id.example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_prepare_community(&fail_spec, &fail_runner),
            Err(CommunityDeployError::ComposeConfigInvalid)
        );
        assert_eq!(
            fs::read_to_string(&fail_env).unwrap(),
            "CONCURRENT_OPERATOR_SECRET=keep_on_config_failure\n"
        );
        assert_eq!(
            fs::read_dir(&fail_fixture.dir)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".env.kodera-tmp-"))
                .count(),
            0
        );

        // Case 2: Compose config succeeds after concurrent `.env` creation -> hard_link refuses overwrite!
        let ok_fixture = TempStackFixture::new_with_compose();
        let ok_env = ok_fixture.dir.join(".env");
        let ok_runner = RacingRunner {
            env_path: ok_env.clone(),
            sentinel: "CONCURRENT_OPERATOR_SECRET=keep_on_atomic_publish\n",
            succeed: true,
        };
        let ok_spec = CommunityPrepareSpec {
            stack_dir: &ok_fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            oidc_provider_origin: "https://id.example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_prepare_community(&ok_spec, &ok_runner),
            Err(CommunityDeployError::EnvAlreadyExists)
        );
        assert_eq!(
            fs::read_to_string(&ok_env).unwrap(),
            "CONCURRENT_OPERATOR_SECRET=keep_on_atomic_publish\n"
        );
        assert_eq!(
            fs::read_dir(&ok_fixture.dir)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".env.kodera-tmp-"))
                .count(),
            0
        );
    }

    #[test]
    fn compose_policy_accepts_canonical_community_manifests_and_rejects_host_escape_directives() {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let repo_root = manifest_dir.join("../../..");
        let community_compose = repo_root.join("deploy/community/docker-compose.yml");
        let create_kodera_compose =
            repo_root.join("packages/create-kodera/assets/docker-compose.yml");
        assert_eq!(validate_compose_file_policy(&community_compose), Ok(()));
        assert_eq!(validate_compose_file_policy(&create_kodera_compose), Ok(()));

        // Verify forward compatibility with `api_ingress` static IPv4 & IPAM bridge configuration.
        let ipam_fixture = TempStackFixture::new_with_compose();
        fs::write(
            ipam_fixture.dir.join("docker-compose.yml"),
            "services:\n  caddy:\n    image: caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0\n    networks:\n      api_ingress:\n        ipv4_address: ${KODERA_CADDY_API_ADDRESS:-172.30.240.2}\nnetworks:\n  default:\n  edge:\n    driver: bridge\n  api_ingress:\n    driver: bridge\n    ipam:\n      config:\n        - subnet: ${KODERA_API_INGRESS_SUBNET:-172.30.240.0/28}\n",
        )
        .unwrap();
        assert_eq!(
            validate_compose_file_policy(&ipam_fixture.dir.join("docker-compose.yml")),
            Ok(())
        );

        let hostile_payloads = [
            "services:\n  attacker:\n    image: alpine:3.20\n",
            "services:\n    attacker:\n        image: alpine:3.20\n        privileged: true\n        volumes:\n            - /:/host:rw\n",
            "services:\n    db:\n        image: postgres:17.6-alpine\n        privileged: true\n",
            "services:\n    db:\n        image: postgres:17.6-alpine\n        volumes:\n            - /:/host:rw\n",
            "x-escape: &escape\n  privileged: true\nservices:\n  db:\n    image: postgres:17.6-alpine\n    <<: *escape\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    volumes:\n      - postgres_data:/var/lib/postgresql/data\nvolumes:\n  postgres_data:\n    driver_opts:\n      type: none\n      o: bind\n      device: /\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    volumes:\n      - postgres_data:/var/lib/postgresql/data\nvolumes:\n  postgres_data:\n    external: true\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    privileged: true\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    network_mode: host\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    pid: host\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    cap_add: [\"SYS_ADMIN\"]\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    cap_add:\n      - SYS_ADMIN\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    security_opt: [\"apparmor:unconfined\"]\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    security_opt:\n      - apparmor:unconfined\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    volumes:\n      - /:/host:rw\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n",
            "services:\n  caddy:\n    image: caddy:2.11.9-alpine\n    volumes:\n      - ./Caddyfile:/etc/caddy/Caddyfile:rw\n",
            "services:\n  caddy:\n    image: caddy:2.11.9-alpine\n    volumes:\n      - ./evil.sh:/entrypoint.sh:ro\n",
            "services:\n  caddy:\n    image: caddy:2.11.9-alpine\n    volumes:\n      - type: bind\n        source: /etc\n        target: /host-etc\n",
        ];

        for hostile in hostile_payloads {
            let fixture = TempStackFixture::new_with_compose();
            fs::write(fixture.dir.join("docker-compose.yml"), hostile).unwrap();
            let runner = MockDockerRunner::with_responses([]);
            let spec = CommunityPreflightSpec {
                stack_dir: &fixture.path_str(),
                domain: "chat.example.org",
                acme_email: "ops@example.org",
                tls_mode: CommunityTlsMode::Acme,
                http_port: 80,
                https_port: 443,
            };
            assert_eq!(
                self_host_preflight_community(&spec, &runner),
                Err(CommunityDeployError::ComposeConfigInvalid),
                "expected ComposeConfigInvalid for payload:\n{hostile}"
            );
            assert!(runner.recorded_calls().is_empty());
        }

        // Verify resolved `docker compose config --format json` validator directly against canonical & hostile ASTs.
        let canonical_fixture = TempStackFixture::new_with_compose();
        let canonical_dir = fs::canonicalize(&canonical_fixture.dir).unwrap();
        let caddyfile_str = canonical_dir.join("Caddyfile").to_str().unwrap().to_owned();
        let valid_resolved_json = serde_json::json!({
            "name": "community",
            "services": {
                "caddy": {
                    "image": "caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0",
                    "volumes": [
                        {
                            "type": "bind",
                            "source": caddyfile_str,
                            "target": "/etc/caddy/Caddyfile",
                            "read_only": true
                        },
                        {
                            "type": "volume",
                            "source": "caddy_data",
                            "target": "/data"
                        }
                    ]
                },
                "media-socket-init": {
                    "image": "ghcr.io/kodera/server:0.1.1@sha256:1111111111111111111111111111111111111111111111111111111111111111",
                    "cap_add": ["CHOWN", "FOWNER", "DAC_OVERRIDE"],
                    "security_opt": ["no-new-privileges:true"]
                }
            },
            "volumes": {
                "caddy_data": { "driver": "local" }
            }
        })
        .to_string();
        assert_eq!(
            validate_resolved_compose_config_json(&valid_resolved_json, &canonical_dir),
            Ok(())
        );

        let hostile_resolved_jsons = [
            "",
            "{not_json",
            r#"{"services":{}}"#,
            r#"{"services":{"attacker":{"image":"alpine:3.20","privileged":true,"volumes":[{"type":"bind","source":"/","target":"/host"}]}}}"#,
            r#"{"services":{"db":{"image":"postgres:17.6-alpine","privileged":true}}}"#,
            r#"{"services":{"db":{"image":"postgres:17.6-alpine","network_mode":"host"}}}"#,
            r#"{"services":{"db":{"image":"postgres:17.6-alpine","cap_add":["SYS_ADMIN"]}}}"#,
            r#"{"services":{"db":{"image":"postgres:17.6-alpine","volumes":[{"type":"bind","source":"/","target":"/host","read_only":true}]}}}"#,
            &serde_json::json!({
                "services": {
                    "caddy": {
                        "image": "caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0",
                        "volumes": [{
                            "type": "bind",
                            "source": canonical_dir.join("Caddyfile").to_str().unwrap(),
                            "target": "/etc/caddy/Caddyfile",
                            "read_only": false
                        }]
                    }
                }
            })
            .to_string(),
            r#"{"services":{"db":{"image":"postgres:17.6-alpine","volumes":[{"type":"volume","source":"postgres_data","target":"/var/lib/postgresql/data"}]}},"volumes":{"postgres_data":{"driver":"local","driver_opts":{"type":"none","o":"bind","device":"/"}}}}"#,
            r#"{"services":{"db":{"image":"postgres:17.6-alpine","volumes":[{"type":"volume","source":"postgres_data","target":"/var/lib/postgresql/data"}]}},"volumes":{"postgres_data":{"external":true}}}"#,
        ];
        for bad_json in hostile_resolved_jsons {
            assert_eq!(
                validate_resolved_compose_config_json(bad_json, &canonical_dir),
                Err(CommunityDeployError::ComposeConfigInvalid),
                "expected ComposeConfigInvalid for resolved JSON: {bad_json}"
            );
        }

        // Sensitive system and credential roots are rejected before compose inspection.
        let ssh_like = TempStackFixture::new_with_compose();
        let dot_ssh = ssh_like.dir.join(".ssh");
        fs::create_dir_all(&dot_ssh).unwrap();
        fs::write(
            dot_ssh.join("docker-compose.yml"),
            "services:\n  db:\n    image: postgres:17.6-alpine\n",
        )
        .unwrap();
        assert_eq!(
            canonicalize_authorized_stack_dir(dot_ssh.to_str().unwrap()),
            Err(CommunityDeployError::InvalidStackDir)
        );
        assert_eq!(
            canonicalize_authorized_stack_dir("/"),
            Err(CommunityDeployError::InvalidStackDir)
        );
    }

    #[test]
    fn compose_build_policy_accepts_canonical_builds_and_rejects_external_context_and_inline_dockerfile(
    ) {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let canonical_repo_root = fs::canonicalize(manifest_dir.join("../../..")).unwrap();
        let canonical_community_dir = canonical_repo_root.join("deploy").join("community");
        let server_ctx = canonical_repo_root.join("apps").join("server");
        let yjs_ctx = server_ctx.join("yjs_collab");
        let policy_dir = canonical_repo_root.join("packages").join("synapse-policy");

        let valid_build_resolved_json = serde_json::json!({
            "name": "community",
            "services": {
                "migrate": {
                    "build": {
                        "context": server_ctx.to_str().unwrap(),
                        "dockerfile": "Dockerfile.migrator"
                    }
                },
                "server": {
                    "build": {
                        "context": server_ctx.to_str().unwrap(),
                        "dockerfile": "Dockerfile"
                    }
                },
                "yjs-collab": {
                    "build": {
                        "context": yjs_ctx.to_str().unwrap(),
                        "dockerfile": "Dockerfile"
                    }
                },
                "web": {
                    "build": {
                        "context": canonical_repo_root.to_str().unwrap(),
                        "dockerfile": "apps/web/Dockerfile",
                        "args": {
                            "VITE_CORE_API_URL": "https://chat.example.org/api/v1",
                            "VITE_OIDC_CLIENT_ID": "console"
                        }
                    }
                },
                "synapse": {
                    "image": "matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62",
                    "volumes": [{
                        "type": "bind",
                        "source": policy_dir.to_str().unwrap(),
                        "target": "/opt/kodera-policy",
                        "read_only": true
                    }]
                },
                "media-socket-init": {
                    "build": {
                        "context": server_ctx.to_str().unwrap(),
                        "dockerfile": "Dockerfile"
                    },
                    "cap_drop": ["ALL"],
                    "cap_add": ["CHOWN", "FOWNER", "DAC_OVERRIDE"],
                    "security_opt": ["no-new-privileges:true"]
                }
            }
        })
        .to_string();

        // 1. Positive: monorepo `deploy/community` resolves `<stack_dir>/../..` automatically.
        assert_eq!(
            validate_resolved_compose_config_json(
                &valid_build_resolved_json,
                &canonical_community_dir
            ),
            Ok(())
        );

        // 2. Positive: external `create-kodera` workspace with explicit `KODERA_SOURCE_DIR` in `.env`.
        let external_ws = TempStackFixture::new_with_compose();
        let canonical_ext_dir = fs::canonicalize(&external_ws.dir).unwrap();
        assert_eq!(
            validate_resolved_compose_config_json_with_source(
                &valid_build_resolved_json,
                &canonical_ext_dir,
                Some(&canonical_repo_root),
            ),
            Ok(())
        );

        fs::write(
            external_ws.dir.join("docker-compose.yml"),
            "services:\n  server:\n    build:\n      context: ${KODERA_SOURCE_DIR:?Set Community source root}/apps/server\n      dockerfile: Dockerfile\n",
        )
        .unwrap();
        let ext_env_path = external_ws.dir.join(".env");
        fs::write(
            &ext_env_path,
            format!(
                "KODERA_OIDC_PROVIDER_ORIGIN=https://id.example.org\nKODERA_SOURCE_DIR='{}'\n",
                canonical_repo_root.display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&ext_env_path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let deploy_runner = MockDockerRunner::with_responses([
            MockDockerRunner::ok_stdout(&valid_build_resolved_json),
            MockDockerRunner::ok_stdout(""),
            MockDockerRunner::ok_stdout(healthy_full_stack_ps_json()),
        ]);
        let deploy_report =
            self_host_deploy_community(&external_ws.path_str(), Some(10_000), &deploy_runner)
                .unwrap();
        assert!(deploy_report.stack_healthy);

        // 3. Refusal: YAML build-policy escape vectors (including exact R2 PoC).
        let hostile_build_yaml_payloads = [
            "services:\n  db:\n    build:\n      context: ${HOME}\n      dockerfile_inline: |\n        FROM alpine:3.20\n        COPY .ssh /captured-ssh\n",
            "services:\n  db:\n    build:\n      context: ../../apps/server\n      dockerfile: Dockerfile\n",
            "services:\n  server:\n    build: ../../apps/server\n",
            "services:\n  server:\n    build:\n      context: ${HOME}\n      dockerfile: Dockerfile\n",
            "services:\n  server:\n    build:\n      context: ../../apps/server\n      dockerfile_inline: |\n        FROM alpine:3.20\n        COPY .ssh /captured-ssh\n",
            "services:\n  server:\n    build:\n      context: ../../apps/server\n      dockerfile: Dockerfile\n      additional_contexts:\n        host_ssh: /root/.ssh\n",
            "services:\n  server:\n    build:\n      context: ../../apps/server\n      dockerfile: Dockerfile\n      ssh:\n        - default\n",
            "services:\n  server:\n    build:\n      context: ../../apps/server\n      dockerfile: Dockerfile\n      network: host\n",
            "services:\n  server:\n    build:\n      context: ../../apps/server\n      dockerfile: Dockerfile\n      privileged: true\n",
            "services:\n  server:\n    build:\n      context: ../../apps/server\n      dockerfile: Dockerfile.migrator\n",
            "services:\n  server:\n    build:\n      context: ../../apps/server\n",
            "services:\n  server:\n    build:\n      context: ${KODERA_SOURCE_DIR:-/tmp/attacker}/apps/server\n      dockerfile: Dockerfile\n",
            "services:\n  server:\n    build:\n      context: ../../apps/server\n      dockerfile: Dockerfile\n      args:\n        VITE_CORE_API_URL: https://chat.example.org/api/v1\n",
            "services:\n  web:\n    build:\n      context: ../..\n      dockerfile: apps/web/Dockerfile\n      args:\n        HTTP_PROXY: http://127.0.0.1:8080\n",
            "services:\n  server:\n    image: alpine:3.20\n    env_file:\n      - /etc/passwd\n",
        ];

        for bad_yaml in hostile_build_yaml_payloads {
            let fixture = TempStackFixture::new_with_compose();
            fs::write(fixture.dir.join("docker-compose.yml"), bad_yaml).unwrap();
            assert_eq!(
                validate_compose_file_policy(&fixture.dir.join("docker-compose.yml")),
                Err(CommunityDeployError::ComposeConfigInvalid),
                "expected ComposeConfigInvalid for build YAML:\n{bad_yaml}"
            );
        }

        // 4. Refusal: Resolved JSON build/bind escape vectors.
        let fake_policy_parent = TempStackFixture::new_with_compose();
        let fake_policy_dir = fake_policy_parent.dir.join("packages/synapse-policy");
        fs::create_dir_all(&fake_policy_dir).unwrap();

        let hostile_build_jsons = [
            serde_json::json!({
                "services": {
                    "db": {
                        "build": {
                            "context": canonical_ext_dir.to_str().unwrap(),
                            "dockerfile_inline": "FROM alpine:3.20\nCOPY .ssh /captured-ssh\n"
                        }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "services": {
                    "server": {
                        "build": {
                            "context": server_ctx.to_str().unwrap(),
                            "dockerfile": "Dockerfile",
                            "dockerfile_inline": "FROM alpine:3.20\n"
                        }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "services": {
                    "server": {
                        "build": {
                            "context": server_ctx.to_str().unwrap(),
                            "dockerfile": "Dockerfile",
                            "additional_contexts": { "ssh": "/tmp" }
                        }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "services": {
                    "server": {
                        "build": {
                            "context": server_ctx.to_str().unwrap(),
                            "dockerfile": "Dockerfile",
                            "ssh": ["default"]
                        }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "services": {
                    "server": {
                        "build": {
                            "context": canonical_repo_root.to_str().unwrap(),
                            "dockerfile": "Dockerfile"
                        }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "services": {
                    "server": {
                        "build": {
                            "context": server_ctx.to_str().unwrap(),
                            "dockerfile": "Dockerfile.migrator"
                        }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "services": {
                    "web": {
                        "build": {
                            "context": canonical_repo_root.to_str().unwrap(),
                            "dockerfile": "apps/web/Dockerfile",
                            "args": {
                                "BUILDKIT_SYNTAX": "attacker/frontend:latest"
                            }
                        }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "services": {
                    "synapse": {
                        "image": "matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62",
                        "volumes": [{
                            "type": "bind",
                            "source": fake_policy_dir.to_str().unwrap(),
                            "target": "/opt/kodera-policy",
                            "read_only": true
                        }]
                    }
                }
            })
            .to_string(),
        ];

        for bad_json in hostile_build_jsons {
            assert_eq!(
                validate_resolved_compose_config_json_with_source(
                    &bad_json,
                    &canonical_ext_dir,
                    Some(&canonical_repo_root),
                ),
                Err(CommunityDeployError::ComposeConfigInvalid),
                "expected ComposeConfigInvalid for resolved build JSON: {bad_json}"
            );
        }

        // 5. Refusal: `.env` pointing `KODERA_SOURCE_DIR` to non-Kodera dir or `KODERA_MEDIA_SECRETS_SOURCE` to host path.
        for bad_dotenv in [
            format!("KODERA_SOURCE_DIR='{}'\n", canonical_ext_dir.display()),
            "KODERA_MEDIA_SECRETS_SOURCE=/etc\n".to_owned(),
            "COMPOSE_FILE=/etc/passwd\n".to_owned(),
        ] {
            let bad_ws = TempStackFixture::new_with_compose();
            let bad_env = bad_ws.dir.join(".env");
            fs::write(&bad_env, &bad_dotenv).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&bad_env, fs::Permissions::from_mode(0o600)).unwrap();
            }
            let runner = MockDockerRunner::with_responses([]);
            assert_eq!(
                self_host_deploy_community(&bad_ws.path_str(), Some(5_000), &runner),
                Err(CommunityDeployError::ComposeConfigInvalid),
                "expected ComposeConfigInvalid for dotenv: {bad_dotenv}"
            );
            assert!(runner.recorded_calls().is_empty());
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::{symlink, PermissionsExt};

            let sym_parent = TempStackFixture::new_with_compose();
            let sym_source_link = sym_parent.dir.join("linked-source");
            symlink(&canonical_repo_root, &sym_source_link).unwrap();

            let sym_ws = TempStackFixture::new_with_compose();
            let sym_env = sym_ws.dir.join(".env");
            fs::write(
                &sym_env,
                format!("KODERA_SOURCE_DIR='{}'\n", sym_source_link.display()),
            )
            .unwrap();
            fs::set_permissions(&sym_env, fs::Permissions::from_mode(0o600)).unwrap();

            let runner = MockDockerRunner::with_responses([]);
            assert_eq!(
                self_host_deploy_community(&sym_ws.path_str(), Some(5_000), &runner),
                Err(CommunityDeployError::SymlinkRejected)
            );
            assert!(runner.recorded_calls().is_empty());
        }
    }

    #[test]
    fn compose_image_digest_ports_entrypoint_and_sensitive_root_policies_enforce_strict_invariants()
    {
        // 1. Forbidden host-escape service directives and capabilities are never admitted.
        for forbidden_directive in FORBIDDEN_PRIVILEGED_COMPOSE_DIRECTIVES {
            assert!(
                ADMITTED_COMPOSE_SERVICE_DIRECTIVES
                    .binary_search(forbidden_directive)
                    .is_err(),
                "directive {forbidden_directive} must never be admitted"
            );
        }
        for forbidden_cap in [
            "SYS_ADMIN",
            "NET_ADMIN",
            "SYS_PTRACE",
            "SYS_MODULE",
            "DAC_READ_SEARCH",
            "SETUID",
            "SETGID",
            "NET_RAW",
            "ALL",
        ] {
            assert!(
                !is_admitted_cap_add_token(forbidden_cap),
                "capability {forbidden_cap} must never be admitted"
            );
        }

        for zero_env_svc in [
            "agent-state-init",
            "keycloak",
            "keycloak-db",
            "media-socket-init",
            "media-storage-worker",
            "proximity-broker",
            "proximity-socket-init",
            "valkey",
        ] {
            assert!(
                admitted_service_environment_keys(zero_env_svc).is_empty(),
                "service {zero_env_svc} has no canonical environment block and must admit zero keys"
            );
        }
        assert_eq!(
            admitted_service_environment_keys("web"),
            ["KODERA_ATTACHMENT_BASE"]
        );

        // 2. World-writable temp roots, macOS `/private/*` & `/var/folders`, UNC roots, and credential segments are sensitive.
        for sensitive in [
            "/tmp",
            "/tmp/kodera-stack",
            "/private/tmp/kodera-stack",
            "/var/tmp/kodera-stack",
            "/private/var/tmp/kodera-stack",
            "/var/folders/ab/cd/T/kodera-stack",
            "/private/var/folders/ab/cd/T/kodera-stack",
            "/dev/shm/kodera-stack",
            "/etc",
            "/private/etc",
            "/private/var/root",
            "/Users/alice",
            "/home/alice",
            "//fileserver/share/kodera",
            "\\\\fileserver\\share\\kodera",
            "\\\\?\\UNC\\fileserver\\share\\kodera",
            "/srv/kodera/.ssh/stack",
            "/srv/kodera/.aws/stack",
            "/srv/kodera/.gnupg/stack",
            "/srv/kodera/.kube/stack",
            "/srv/kodera/.docker/stack",
            "/srv/kodera/Keychains/stack",
        ] {
            assert!(
                is_sensitive_stack_root(Path::new(sensitive)),
                "expected sensitive root rejection for {sensitive}"
            );
        }
        for unc in ["//fileserver/share/kodera", "\\\\fileserver\\share\\kodera"] {
            assert_eq!(
                canonicalize_authorized_stack_dir(unc),
                Err(CommunityDeployError::InvalidStackDir)
            );
        }

        // 3. Candidate `.env` cleanup on `publish_candidate_dotenv_no_replace` failure leaves zero leftover files.
        let race_fixture = TempStackFixture::new_with_compose();
        let existing_env = race_fixture.dir.join(".env");
        fs::write(&existing_env, "POSTGRES_PASSWORD=keep_existing_secret\n").unwrap();
        let candidate_env =
            create_dotenv_candidate_0600(&race_fixture.dir, b"POSTGRES_PASSWORD=discard\n")
                .unwrap();
        assert!(candidate_env.exists());
        assert_eq!(
            publish_candidate_dotenv_no_replace(&candidate_env, &existing_env),
            Err(CommunityDeployError::EnvAlreadyExists)
        );
        assert!(!candidate_env.exists());

        // 4. Positive & negative `image` digest, `entrypoint`, `command`, `user`, `environment`, and `ports` enforcement in YAML & resolved JSON.
        let fixture = TempStackFixture::new_with_compose();
        let canonical_dir = fs::canonicalize(&fixture.dir).unwrap();

        let valid_ports_and_synapse_json = serde_json::json!({
            "name": "community",
            "services": {
                "caddy": {
                    "image": "caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0",
                    "command": ["caddy", "reverse-proxy", "--domain", "kodera.example.org"],
                    "ports": [
                        { "mode": "ingress", "target": 80, "published": "80", "protocol": "tcp" },
                        { "mode": "ingress", "target": 443, "published": "443", "protocol": "tcp" },
                        { "mode": "ingress", "target": 443, "published": "443", "protocol": "udp" },
                        { "host_ip": "127.0.0.1", "target": 80, "published": "8080", "protocol": "tcp" }
                    ]
                },
                "livekit": {
                    "image": "livekit/livekit-server:v1.13.11@sha256:25cd902de7cacbd5f1f779f6a6ac1eae20ba8f56b0935934ce6b0ab80d1e3d20",
                    "command": ["--config", "/etc/livekit.yaml"],
                    "ports": [
                        { "mode": "ingress", "target": 7881, "published": "7881", "protocol": "tcp" },
                        { "mode": "ingress", "target": 50000, "published": "50000-50200", "protocol": "udp" }
                    ]
                },
                "valkey": {
                    "image": "valkey/valkey:8.1-alpine@sha256:1b426a5a4d7d4fcad15e9d40f0bd8bc2e5c1f09061f5cc8b2a5f6653d5bd5949",
                    "command": ["valkey-server", "--save", "60", "1", "--loglevel", "warning"]
                },
                "media-socket-init": {
                    "image": "ghcr.io/kodera/server:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a",
                    "user": "0:0",
                    "command": [
                        "python",
                        "-c",
                        "import os; from pathlib import Path; Path('/run/kodera-media/media.sock').unlink(missing_ok=True); [(os.chmod(p, 0o700), os.chown(p, 10001, 10001)) for p in ('/run/kodera-media', '/run/kodera-media-secrets')]"
                    ]
                },
                "server": {
                    "image": "ghcr.io/kodera/server:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a",
                    "environment": {
                        "KODERA_EDITION": "community",
                        "KODERA_BILLING_ENABLED": "false",
                        "KODERA_MEDIA_ROOM_VERIFIER_URL": "http://room-access:8096/internal/room-member"
                    }
                },
                "synapse": {
                    "image": "matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62",
                    "environment": {
                        "PYTHONPATH": "/tmp/kodera-policy",
                        "SYNAPSE_REPORT_STATS": "no"
                    },
                    "entrypoint": [
                        "/bin/sh",
                        "-c",
                        CANONICAL_SYNAPSE_ENTRYPOINT_SCRIPT
                    ]
                }
            }
        })
        .to_string();
        assert_eq!(
            validate_resolved_compose_config_json(&valid_ports_and_synapse_json, &canonical_dir),
            Ok(())
        );

        let comment_bypass_synapse_yaml = format!(
            "services:\n  synapse:\n    image: matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62\n    entrypoint:\n      - /bin/sh\n      - -c\n      - |\n        id\n        {}\n",
            CANONICAL_SYNAPSE_ENTRYPOINT_SCRIPT.replace('\n', "\n        ")
        );
        let bad_yaml_cases = [
            // Unpinned tag (missing `@sha256:...`).
            "services:\n  db:\n    image: postgres:17.12-alpine\n",
            // Wrong image repository for `db`.
            "services:\n  db:\n    image: alpine:3.20@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n",
            // Non-synapse entrypoint override.
            "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n    entrypoint:\n      - /bin/sh\n",
            // Comment-bypass `synapse` entrypoint (substring match would falsely pass).
            "services:\n  synapse:\n    image: matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62\n    entrypoint:\n      - /bin/sh\n      - -c\n      - |\n        exec /bin/true\n        # /opt/community/configure_synapse.py /data/homeserver.yaml\n        # exec /start.py\n",
            comment_bypass_synapse_yaml.as_str(),
            // `command` override on `db` (service without canonical `command`) or tampered `valkey` `command`.
            "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n    command:\n      - sh\n      - -c\n      - id\n",
            "services:\n  valkey:\n    image: valkey/valkey:8.1-alpine@sha256:1b426a5a4d7d4fcad15e9d40f0bd8bc2e5c1f09061f5cc8b2a5f6653d5bd5949\n    command: valkey-server --loadmodule /tmp/evil.so\n",
            // `user` root escalation on `db`.
            "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n    user: \"0:0\"\n",
            // Code-execution `environment` injection (`LD_PRELOAD`, `NODE_OPTIONS`, `PYTHONPATH`, CPython `PYTHONWARNINGS` + `BROWSER`, zero-env service).
            "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n    environment:\n      LD_PRELOAD: /tmp/evil.so\n",
            "services:\n  synapse:\n    image: matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62\n    environment:\n      PYTHONPATH: /tmp/evil\n",
            "services:\n  synapse:\n    image: matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62\n    environment:\n      PYTHONWARNINGS: \"ignore::antigravity.Example\"\n      BROWSER: '/bin/sh -c \"printf R5_ENV_BYPASS >&2\" %s'\n",
            "services:\n  valkey:\n    image: valkey/valkey:8.1-alpine@sha256:1b426a5a4d7d4fcad15e9d40f0bd8bc2e5c1f09061f5cc8b2a5f6653d5bd5949\n    environment:\n      POSTGRES_USER: kodera\n",
            "services:\n  server:\n    image: ghcr.io/kodera/server:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a\n    environment:\n      KODERA_BILLING_ENABLED: \"true\"\n",
            "services:\n  web:\n    image: ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a\n    environment:\n      NODE_OPTIONS: \"--require /tmp/evil.js\"\n",
            "services:\n  web:\n    image: ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a\n    environment:\n      KODERA_ATTACHMENT_BASE: \"http://insecure.example.org/bucket/\"\n",
            "services:\n  web:\n    image: ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a\n    environment:\n      KODERA_ATTACHMENT_BASE: \"https://media.example.org//\"\n",
            "services:\n  web:\n    image: ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a\n    environment:\n      KODERA_ATTACHMENT_BASE: \"https://media.example.org/bucket//\"\n",
            "services:\n  web:\n    image: ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a\n    environment:\n      KODERA_ATTACHMENT_BASE: \"https://media.example.org/%2e/\"\n",
            "services:\n  web:\n    image: ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a\n    entrypoint:\n      - \"/bin/sh\"\n      - \"-ec\"\n      - \"id; exec node /app/static.mjs\"\n      - \"sh\"\n",
            // Publishing Postgres 5432, SSH 22, or mixed single-port range `3478-7882:7881/tcp` on host.
            "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n    ports:\n      - \"5432:5432\"\n",
            "services:\n  caddy:\n    image: caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0\n    ports:\n      - \"22:80\"\n",
            "services:\n  livekit:\n    image: livekit/livekit-server:v1.13.11@sha256:25cd902de7cacbd5f1f779f6a6ac1eae20ba8f56b0935934ce6b0ab80d1e3d20\n    ports:\n      - \"3478-7882:7881/tcp\"\n",
            "services:\n  caddy:\n    image: caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0\n    ports:\n      - \"127.0.0.1:8080-8090:80\"\n",
            // Plain scalar ending in `|` must NOT swallow a subsequent unapproved directive.
            "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n    command: echo foo|\n      privileged: true\n",
        ];
        for bad_yaml in bad_yaml_cases {
            let f = TempStackFixture::new_with_compose();
            fs::write(f.dir.join("docker-compose.yml"), bad_yaml).unwrap();
            assert_eq!(
                validate_compose_file_policy(&f.dir.join("docker-compose.yml")),
                Err(CommunityDeployError::ComposeConfigInvalid),
                "expected ComposeConfigInvalid for YAML:\n{bad_yaml}"
            );
        }

        let prefixed_synapse_json = serde_json::json!({
            "services": {
                "synapse": {
                    "image": "matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62",
                    "entrypoint": [
                        "/bin/sh",
                        "-c",
                        format!("id\n{CANONICAL_SYNAPSE_ENTRYPOINT_SCRIPT}")
                    ]
                }
            }
        })
        .to_string();
        let bad_synapse_pythonpath_json = serde_json::json!({
            "services": {
                "synapse": {
                    "image": "matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62",
                    "environment": { "PYTHONPATH": "/tmp/evil" },
                    "entrypoint": ["/bin/sh", "-c", CANONICAL_SYNAPSE_ENTRYPOINT_SCRIPT]
                }
            }
        })
        .to_string();
        let bad_synapse_pythonwarnings_browser_json = serde_json::json!({
            "services": {
                "synapse": {
                    "image": "matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62",
                    "environment": {
                        "PYTHONWARNINGS": "ignore::antigravity.Example",
                        "BROWSER": "/bin/sh -c \"printf R5_ENV_BYPASS >&2\" %s"
                    },
                    "entrypoint": ["/bin/sh", "-c", CANONICAL_SYNAPSE_ENTRYPOINT_SCRIPT]
                }
            }
        })
        .to_string();
        let bad_json_cases = [
            // Missing `@sha256:...` digest.
            r#"{"services":{"db":{"image":"postgres:17.12-alpine"}}}"#,
            // Wrong repository for `db`.
            r#"{"services":{"db":{"image":"attacker/evil:1.0@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7"}}}"#,
            // Service omitting both `image` and `build`.
            r#"{"services":{"db":{"restart":"unless-stopped"}}}"#,
            // `entrypoint` on non-`synapse` service.
            r#"{"services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7","entrypoint":["/bin/sh","-c","id"]}}}"#,
            // Tampered `synapse` entrypoint omitting policy configurator or using comment/prefix bypass.
            r#"{"services":{"synapse":{"image":"matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62","entrypoint":["/bin/sh","-c","exec /bin/sh"]}}}"#,
            r#"{"services":{"synapse":{"image":"matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62","entrypoint":["/bin/sh","-c","exec /bin/true\n# /opt/community/configure_synapse.py /data/homeserver.yaml\n# exec /start.py\n"]}}}"#,
            prefixed_synapse_json.as_str(),
            // `command` override on `db` or tampered `command` on `valkey`.
            r#"{"services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7","command":["/bin/sh","-c","id"]}}}"#,
            r#"{"services":{"valkey":{"image":"valkey/valkey:8.1-alpine@sha256:1b426a5a4d7d4fcad15e9d40f0bd8bc2e5c1f09061f5cc8b2a5f6653d5bd5949","command":["valkey-server","--loadmodule","/tmp/evil.so"]}}}"#,
            // `user` escalation on non-init service (`db`).
            r#"{"services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7","user":"0:0"}}}"#,
            // Dangerous `environment` keys (`LD_PRELOAD`, `NODE_OPTIONS`, `BASH_ENV`, `PYTHONPATH` on `db`, non-canonical `PYTHONPATH` on `synapse`).
            r#"{"services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7","environment":{"LD_PRELOAD":"/tmp/evil.so"}}}}"#,
            r#"{"services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7","environment":{"NODE_OPTIONS":"--require /tmp/evil.js"}}}}"#,
            r#"{"services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7","environment":["BASH_ENV=/tmp/evil.sh"]}}}"#,
            r#"{"services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7","environment":{"PYTHONPATH":"/tmp/kodera-policy"}}}}"#,
            bad_synapse_pythonpath_json.as_str(),
            bad_synapse_pythonwarnings_browser_json.as_str(),
            r#"{"services":{"valkey":{"image":"valkey/valkey:8.1-alpine@sha256:1b426a5a4d7d4fcad15e9d40f0bd8bc2e5c1f09061f5cc8b2a5f6653d5bd5949","environment":{"POSTGRES_USER":"kodera"}}}}"#,
            r#"{"services":{"server":{"image":"ghcr.io/kodera/server:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a","environment":{"KODERA_BILLING_ENABLED":"true"}}}}"#,
            r#"{"services":{"web":{"image":"ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a","environment":{"NODE_OPTIONS":"--require /tmp/evil.js"}}}}"#,
            r#"{"services":{"web":{"image":"ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a","environment":{"KODERA_ATTACHMENT_BASE":"https://media.example.org/no-trailing-slash"}}}}"#,
            r#"{"services":{"web":{"image":"ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a","environment":{"KODERA_ATTACHMENT_BASE":"https://media.example.org//"}}}}"#,
            r#"{"services":{"web":{"image":"ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a","environment":{"KODERA_ATTACHMENT_BASE":"https://media.example.org/bucket//"}}}}"#,
            r#"{"services":{"web":{"image":"ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a","environment":{"KODERA_ATTACHMENT_BASE":"https://media.example.org/%2e%2e/"}}}}"#,
            r#"{"services":{"web":{"image":"ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a","entrypoint":["/bin/sh","-ec","id","sh"]}}}"#,
            // Publishing `5432` on `db`, `22` on `caddy`, `"3478-7882"` TCP range on `livekit`, or `"8080-8090"` range on loopback `caddy`.
            r#"{"services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7","ports":[{"target":5432,"published":"5432","protocol":"tcp"}]}}}"#,
            r#"{"services":{"caddy":{"image":"caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0","ports":[{"target":80,"published":"22","protocol":"tcp"}]}}}"#,
            r#"{"services":{"caddy":{"image":"caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0","ports":[{"host_ip":"127.0.0.1","target":80,"published":"22","protocol":"tcp"}]}}}"#,
            r#"{"services":{"livekit":{"image":"livekit/livekit-server:v1.13.11@sha256:25cd902de7cacbd5f1f779f6a6ac1eae20ba8f56b0935934ce6b0ab80d1e3d20","ports":[{"target":7881,"published":"3478-7882","protocol":"tcp"}]}}}"#,
            r#"{"services":{"caddy":{"image":"caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0","ports":[{"host_ip":"127.0.0.1","target":80,"published":"8080-8090","protocol":"tcp"}]}}}"#,
        ];
        for bad_json in bad_json_cases {
            assert_eq!(
                validate_resolved_compose_config_json(bad_json, &canonical_dir),
                Err(CommunityDeployError::ComposeConfigInvalid),
                "expected ComposeConfigInvalid for JSON: {bad_json}"
            );
        }

        // 5. Symlink hops to `/etc` (`/private/etc` on macOS) and `.ssh` are rejected.
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let hop_fixture = TempStackFixture::new_with_compose();
            let etc_link = hop_fixture.dir.join("etc-hop");
            symlink("/etc", &etc_link).unwrap();
            assert_eq!(
                canonicalize_authorized_stack_dir(etc_link.to_str().unwrap()),
                Err(CommunityDeployError::SymlinkRejected)
            );
            if let Ok(canon_etc) = fs::canonicalize("/etc") {
                assert!(is_sensitive_stack_root(&canon_etc));
            }

            let dot_ssh_target = hop_fixture.dir.join(".ssh");
            fs::create_dir_all(&dot_ssh_target).unwrap();
            let ssh_caddy_link = hop_fixture.dir.join("Caddyfile");
            fs::write(dot_ssh_target.join("id_ed25519"), "secret\n").unwrap();
            symlink(dot_ssh_target.join("id_ed25519"), &ssh_caddy_link).unwrap();
            let caddy_bind_json = serde_json::json!({
                "services": {
                    "caddy": {
                        "image": "caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0",
                        "volumes": [{
                            "type": "bind",
                            "source": canonical_dir.join("Caddyfile").to_str().unwrap(),
                            "target": "/etc/caddy/Caddyfile",
                            "read_only": true
                        }]
                    }
                }
            })
            .to_string();
            let canon_hop = fs::canonicalize(&hop_fixture.dir).unwrap();
            let hop_bind_json = caddy_bind_json
                .replace(canonical_dir.to_str().unwrap(), canon_hop.to_str().unwrap());
            assert_eq!(
                validate_resolved_compose_config_json(&hop_bind_json, &canon_hop),
                Err(CommunityDeployError::SymlinkRejected)
            );
        }
    }
}
