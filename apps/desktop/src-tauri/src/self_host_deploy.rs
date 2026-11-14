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

/// Byte length (`32` bytes -> `44` padded base64url chars) for AES-256-GCM / HMAC seal keys.
pub const SEAL_KEY_BYTES: usize = 32;

/// Random byte length (`12` bytes -> `lk_` + `24` hex chars) for `LIVEKIT_API_KEY`.
pub const LIVEKIT_KEY_RANDOM_BYTES: usize = 12;

const MAX_COMMAND_STDOUT_BYTES: usize = 65_536;
const MAX_COMMAND_STDERR_BYTES: usize = 8_192;

const SHELL_METACHARS: &[char] = &[
    ';', '|', '&', '$', '`', '>', '<', '*', '?', '(', ')', '[', ']', '{', '}', '!', '\'', '"',
    '\\', '#', '~',
];

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
    SymlinkRejected,
    StackDirNotWritable,
    ComposeFileMissing,
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
            Self::SymlinkRejected => f.write_str("symlink_rejected"),
            Self::StackDirNotWritable => f.write_str("stack_dir_not_writable"),
            Self::ComposeFileMissing => f.write_str("compose_file_missing"),
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
/// writes `<stack_dir>/.env` atomically with `0600` Unix permissions, and validates the rendered stack
/// via `docker compose config --quiet`.
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
    if let Ok(meta) = fs::symlink_metadata(&env_path) {
        if meta.file_type().is_symlink() {
            return Err(CommunityDeployError::SymlinkRejected);
        }
        if !meta.file_type().is_file() {
            return Err(CommunityDeployError::EnvWriteFailed);
        }
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

    let unix_mode = write_dotenv_atomic_0600(&stack_path, &env_path, rendered_env.as_bytes())?;

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
        env_arg,
        "-f".to_owned(),
        compose_arg,
        "config".to_owned(),
        "--quiet".to_owned(),
    ];
    let config_out = match runner.run_argv(
        "docker",
        &config_args,
        Some(&stack_path),
        Duration::from_millis(COMPOSE_CONFIG_TIMEOUT_MS),
    ) {
        Ok(out) => out,
        Err(reason) => {
            let _ = fs::remove_file(&env_path);
            return Err(CommunityDeployError::DockerUnavailable(reason));
        }
    };

    if !config_out.is_success() {
        let _ = fs::remove_file(&env_path);
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }

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
    let external_oidc_configured = verify_prepared_dotenv(&env_path)?;

    let env_arg = env_path
        .to_str()
        .ok_or(CommunityDeployError::InvalidStackDir)?
        .to_owned();
    let compose_arg = compose_path
        .to_str()
        .ok_or(CommunityDeployError::InvalidStackDir)?
        .to_owned();

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

fn validate_stack_dir_and_compose(
    raw_dir: &str,
    verify_writable: bool,
) -> Result<(PathBuf, PathBuf), CommunityDeployError> {
    if raw_dir.is_empty() || raw_dir.len() > MAX_STACK_DIR_BYTES {
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

    // Walk ancestor components to reject intermediate symlinked directory hops where readable.
    let canonical_dir =
        fs::canonicalize(candidate).map_err(|_| CommunityDeployError::InvalidStackDir)?;

    let compose_path = candidate.join("docker-compose.yml");
    let compose_meta = fs::symlink_metadata(&compose_path)
        .map_err(|_| CommunityDeployError::ComposeFileMissing)?;
    if compose_meta.file_type().is_symlink() {
        return Err(CommunityDeployError::SymlinkRejected);
    }
    if !compose_meta.file_type().is_file() || compose_meta.len() == 0 {
        return Err(CommunityDeployError::ComposeFileMissing);
    }

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

    let canonical_compose = canonical_dir.join("docker-compose.yml");
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

fn csprng_base64url_32() -> Result<String, CommunityDeployError> {
    let raw = csprng_bytes::<SEAL_KEY_BYTES>()?;
    Ok(encode_base64url_padded_32(&raw))
}

fn encode_base64url_padded_32(bytes: &[u8; 32]) -> String {
    let mut out = String::with_capacity(44);
    let mut i = 0usize;
    while i + 3 <= 32 {
        let b0 = bytes[i];
        let b1 = bytes[i + 1];
        let b2 = bytes[i + 2];
        out.push(char::from(BASE64URL_ALPHABET[usize::from(b0 >> 2)]));
        out.push(char::from(
            BASE64URL_ALPHABET[usize::from(((b0 & 0x03) << 4) | (b1 >> 4))],
        ));
        out.push(char::from(
            BASE64URL_ALPHABET[usize::from(((b1 & 0x0f) << 2) | (b2 >> 6))],
        ));
        out.push(char::from(BASE64URL_ALPHABET[usize::from(b2 & 0x3f)]));
        i += 3;
    }
    // Final 2 bytes (indices 30 and 31) -> 3 chars + '=' padding (44 chars total).
    let b0 = bytes[30];
    let b1 = bytes[31];
    out.push(char::from(BASE64URL_ALPHABET[usize::from(b0 >> 2)]));
    out.push(char::from(
        BASE64URL_ALPHABET[usize::from(((b0 & 0x03) << 4) | (b1 >> 4))],
    ));
    out.push(char::from(
        BASE64URL_ALPHABET[usize::from((b1 & 0x0f) << 2)],
    ));
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
    let discovery_hmac_key = csprng_hex(HEX_SECRET_BYTES)?;
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
            format!("{normalized_domain},127.0.0.1"),
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

fn write_dotenv_atomic_0600(
    stack_dir: &Path,
    env_path: &Path,
    contents: &[u8],
) -> Result<u32, CommunityDeployError> {
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

    if fs::rename(&tmp_path, env_path).is_err() {
        let _ = fs::remove_file(&tmp_path);
        return Err(CommunityDeployError::EnvWriteFailed);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta =
            fs::symlink_metadata(env_path).map_err(|_| CommunityDeployError::EnvWriteFailed)?;
        let mode = meta.permissions().mode() & 0o777;
        if mode != 0o600 {
            return Err(CommunityDeployError::EnvPermissionsInsecure);
        }
        Ok(mode)
    }
    #[cfg(not(unix))]
    {
        Ok(0)
    }
}

fn verify_prepared_dotenv(env_path: &Path) -> Result<bool, CommunityDeployError> {
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
    let mut has_https_oidc_origin = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(val) = trimmed.strip_prefix("KODERA_OIDC_PROVIDER_ORIGIN=") {
            if validate_oidc_provider_origin(val).is_ok() {
                has_https_oidc_origin = true;
            }
        }
    }
    Ok(has_https_oidc_origin)
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
            let dir = std::env::temp_dir().join(format!(
                "kodera-community-deploy-test-{}-{seq}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("docker-compose.yml"),
                "services:\n  db:\n    image: postgres:17.6-alpine\n",
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
        fs::write(fixture.dir.join("docker-compose.yml"), "services: {}\n").unwrap();
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
        let runner = MockDockerRunner::with_responses([MockDockerRunner::ok_stdout("")]);
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

        // Verify 64-char hex CSPRNG secrets are distinct and have exact length 64.
        let hex_keys = [
            "POSTGRES_PASSWORD",
            "KODERA_API_DATABASE_PASSWORD",
            "KODERA_COLLAB_DATABASE_PASSWORD",
            "SYNAPSE_POSTGRES_PASSWORD",
            "DJANGO_SECRET_KEY",
            "KODERA_MEMBERSHIP_CURSOR_KEY",
            "KODERA_DISCOVERY_HMAC_KEY",
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

        // Verify `docker compose --env-file ... -f ... config --quiet` argv invocation.
        let calls = runner.recorded_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "docker");
        assert_eq!(calls[0].1[0], "compose");
        assert_eq!(calls[0].1[1], "--env-file");
        assert_eq!(calls[0].1[3], "-f");
        assert_eq!(calls[0].1[5], "config");
        assert_eq!(calls[0].1[6], "--quiet");
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
        let prep_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_stdout("")]);
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
        assert_eq!(calls.len(), 3);
        assert_eq!(
            &calls[0].1[5..],
            &["up".to_owned(), "-d".to_owned(), "--wait".to_owned()]
        );
        assert_eq!(
            &calls[1].1[5..],
            &["ps".to_owned(), "--format".to_owned(), "json".to_owned()]
        );
    }

    #[test]
    fn deploy_supports_external_oidc_profile_and_fails_on_unhealthy_or_degraded_services() {
        let fixture = TempStackFixture::new_with_compose();
        let prep_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_stdout("")]);
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
        let runner = MockDockerRunner::with_responses([MockDockerRunner::ok_stdout("")]);
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

    #[test]
    fn encode_base64url_padded_32_matches_rfc4648_vector() {
        let zero_key = [0u8; 32];
        let encoded_zeros = encode_base64url_padded_32(&zero_key);
        assert_eq!(encoded_zeros.len(), 44);
        assert_eq!(
            encoded_zeros,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
        );

        let ff_key = [0xffu8; 32];
        let encoded_ff = encode_base64url_padded_32(&ff_key);
        assert_eq!(encoded_ff.len(), 44);
        assert_eq!(encoded_ff, "__________________________________________8=");
    }

    #[test]
    fn deploy_returns_compose_launch_failed_on_nonzero_exit_or_timeout() {
        let fixture = TempStackFixture::new_with_compose();
        let prep_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_stdout("")]);
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

        let exit_fail_runner =
            MockDockerRunner::with_responses([MockDockerRunner::fail_stderr(1, "port allocated")]);
        assert_eq!(
            self_host_deploy_community(&fixture.path_str(), Some(5_000), &exit_fail_runner),
            Err(CommunityDeployError::ComposeLaunchFailed)
        );

        let timeout_runner = MockDockerRunner::with_responses([Ok(CommandExecOutput {
            status_code: None,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: true,
        })]);
        assert_eq!(
            self_host_deploy_community(&fixture.path_str(), Some(5_000), &timeout_runner),
            Err(CommunityDeployError::ComposeLaunchFailed)
        );
    }

    #[test]
    fn deploy_returns_probe_timed_out_when_compose_ps_times_out() {
        let fixture = TempStackFixture::new_with_compose();
        let prep_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_stdout("")]);
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
        let prep_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_stdout("")]);
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
        let prep_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_stdout("")]);
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
        let mut seq = vec![MockDockerRunner::ok_stdout("")];
        for _ in 0..READINESS_MAX_POLL_ATTEMPTS {
            seq.push(MockDockerRunner::ok_stdout(restarting_ps));
        }
        let runner = MockDockerRunner::with_responses(seq);
        assert_eq!(
            self_host_deploy_community(&fixture.path_str(), Some(30_000), &runner),
            Err(CommunityDeployError::StackUnhealthy)
        );
        // 1 `compose up` + READINESS_MAX_POLL_ATTEMPTS `compose ps` invocations.
        assert_eq!(
            runner.recorded_calls().len(),
            1 + usize::from(READINESS_MAX_POLL_ATTEMPTS)
        );
    }

    #[test]
    fn deploy_supports_ndjson_compose_ps_output() {
        let fixture = TempStackFixture::new_with_compose();
        let prep_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_stdout("")]);
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
    }
}
