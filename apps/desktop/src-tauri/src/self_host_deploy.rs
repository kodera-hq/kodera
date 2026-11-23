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
    DockerUnavailableReason, SelfHostHealthError, SelfHostHealthReport, ServiceReadiness,
};
use core::fmt;
use std::io::Read;
use std::path::Path;
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
    "api-admission",
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

mod compose_env;
mod compose_json;
mod compose_service_policy;
mod compose_yaml;
mod dotenv;
mod input_and_stack;
mod ps_parser;
#[cfg(test)]
mod tests;
mod workflow;

pub use compose_env::admitted_service_environment_keys;
pub use compose_json::{
    validate_resolved_compose_config_json, validate_resolved_compose_config_json_with_source,
};
pub use input_and_stack::canonicalize_authorized_stack_dir;
#[cfg(test)]
pub(crate) use tests::non_shared_test_scratch_root;
pub use workflow::{
    self_host_deploy_community, self_host_preflight_community, self_host_prepare_community,
};
