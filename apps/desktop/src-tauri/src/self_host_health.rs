//! Non-blocking health inspector and diagnostic parser for the single-node Kodera Community
//! self-host profile (`deploy/community/docker-compose.yml`: `postgres`, `synapse` with
//! `KoderaPolicy`, and `coturn`) under the `1536 MiB` (`< 1.5 GiB`) RAM ceiling.
//!
//! Supports both Docker Compose v2 JSON array output (`[{...}]`) and newline-delimited JSON
//! objects (`{...}\n{...}`), enforces strict payload and nesting bounds without external crates,
//! and provides a bounded non-blocking CLI probe with background channel polling.

use core::fmt;
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

/// Target RAM ceiling (`1.5 GiB` = `1536 MiB`) for the lightweight single-node Community profile.
pub const COMMUNITY_MEMORY_BUDGET_MIB: u32 = 1536;

/// Maximum UTF-8 byte size accepted from `docker compose ps --format json`.
pub const MAX_COMPOSE_PS_JSON_BYTES: usize = 65_536;

/// Maximum number of container records parsed from a single Compose status snapshot.
pub const MAX_COMPOSE_CONTAINERS: usize = 32;

/// Default wall-clock ceiling for a local `docker compose ps` probe.
pub const DEFAULT_PROBE_TIMEOUT_MS: u64 = 1500;

/// Maximum wall-clock ceiling permitted for a local `docker compose ps` probe.
pub const MAX_PROBE_TIMEOUT_MS: u64 = 3000;

/// Closed parse/validation errors for `docker compose ps --format json` payloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelfHostHealthError {
    PayloadTooLarge,
    TooManyContainers,
    InvalidJson,
}

impl fmt::Display for SelfHostHealthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            Self::PayloadTooLarge => "payload_too_large",
            Self::TooManyContainers => "too_many_containers",
            Self::InvalidJson => "invalid_json",
        };
        f.write_str(code)
    }
}

impl std::error::Error for SelfHostHealthError {}

/// Canonical services required by the `< 1.5 GiB` single-node Community profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CommunityServiceRole {
    Postgres,
    Synapse,
    Coturn,
}

impl CommunityServiceRole {
    pub const ALL: [Self; 3] = [Self::Postgres, Self::Synapse, Self::Coturn];

    pub const fn slug(self) -> &'static str {
        match self {
            Self::Postgres => "postgres",
            Self::Synapse => "synapse",
            Self::Coturn => "coturn",
        }
    }

    pub const fn display_name(self) -> &'static str {
        match self {
            Self::Postgres => "PostgreSQL",
            Self::Synapse => "Synapse + KoderaPolicy",
            Self::Coturn => "Coturn",
        }
    }

    fn from_compose_service(name: &str) -> Option<Self> {
        match name {
            "postgres" | "synapse-db" | "db" => Some(Self::Postgres),
            "synapse" => Some(Self::Synapse),
            "coturn" | "turn" => Some(Self::Coturn),
            _ => None,
        }
    }
}

/// Reason why local Docker Compose inspection could not reach a running daemon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DockerUnavailableReason {
    CliMissing,
    DaemonOffline,
    PermissionDenied,
    ComposeFileMissing,
    ProbeTimedOut,
}

impl DockerUnavailableReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CliMissing => "cli_missing",
            Self::DaemonOffline => "daemon_offline",
            Self::PermissionDenied => "permission_denied",
            Self::ComposeFileMissing => "compose_file_missing",
            Self::ProbeTimedOut => "probe_timed_out",
        }
    }
}

/// Per-service readiness state derived from container lifecycle and healthcheck output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceReadiness {
    Ready,
    Starting,
    Restarting,
    Unhealthy,
    Stopped,
    PolicyDegraded,
    Missing,
}

impl ServiceReadiness {
    const fn severity_rank(self) -> u8 {
        match self {
            Self::Ready => 0,
            Self::Starting => 1,
            Self::Restarting => 2,
            Self::PolicyDegraded => 3,
            Self::Unhealthy => 4,
            Self::Stopped => 5,
            Self::Missing => 6,
        }
    }
}

/// Structured readiness diagnostic for one required Community profile service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceHealthDiagnostic {
    pub role: CommunityServiceRole,
    pub compose_service: Option<String>,
    pub container_name: Option<String>,
    pub readiness: ServiceReadiness,
    pub container_state: Option<String>,
    pub health_status: Option<String>,
    pub kodera_policy_loaded: Option<bool>,
    pub memory_mib: Option<u32>,
    pub summary: String,
}

/// Warning emitted whenever measured container RAM exceeds [`COMMUNITY_MEMORY_BUDGET_MIB`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemoryBudgetWarning {
    pub observed_mib: u32,
    pub ceiling_mib: u32,
    pub excess_mib: u32,
}

/// High-level readiness state of the local Community self-host stack.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StackHealthState {
    Healthy,
    Starting,
    OverBudget,
    Restarting,
    Degraded,
    DockerUnavailable { reason: DockerUnavailableReason },
}

/// Complete diagnostic report for the single-node Community self-host stack.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfHostHealthReport {
    pub state: StackHealthState,
    pub services: Vec<ServiceHealthDiagnostic>,
    pub observed_memory_mib: u32,
    pub memory_budget_mib: u32,
    pub budget_warning: Option<MemoryBudgetWarning>,
}

impl SelfHostHealthReport {
    pub const fn is_healthy(&self) -> bool {
        matches!(self.state, StackHealthState::Healthy)
    }

    pub fn docker_unavailable(reason: DockerUnavailableReason) -> Self {
        let services = CommunityServiceRole::ALL
            .into_iter()
            .map(|role| ServiceHealthDiagnostic {
                role,
                compose_service: None,
                container_name: None,
                readiness: ServiceReadiness::Missing,
                container_state: None,
                health_status: None,
                kodera_policy_loaded: None,
                memory_mib: None,
                summary: format!("{} unavailable ({})", role.display_name(), reason.as_str()),
            })
            .collect();
        Self {
            state: StackHealthState::DockerUnavailable { reason },
            services,
            observed_memory_mib: 0,
            memory_budget_mib: COMMUNITY_MEMORY_BUDGET_MIB,
            budget_warning: None,
        }
    }
}

#[derive(Default)]
struct RawContainerEntry {
    service: String,
    name: Option<String>,
    state: String,
    health: Option<String>,
    kodera_policy: Option<String>,
    memory_mib: Option<u32>,
}

/// Parses `docker compose ps --format json` output (array or NDJSON) and evaluates readiness
/// and memory budget diagnostics for `postgres`, `synapse` (`KoderaPolicy`), and `coturn`.
pub fn inspect_community_compose_ps(
    raw_json: &str,
    memory_overrides_mib: &BTreeMap<CommunityServiceRole, u32>,
) -> Result<SelfHostHealthReport, SelfHostHealthError> {
    if raw_json.len() > MAX_COMPOSE_PS_JSON_BYTES {
        return Err(SelfHostHealthError::PayloadTooLarge);
    }
    let entries = parse_compose_ps_entries(raw_json)?;

    let mut grouped: BTreeMap<CommunityServiceRole, Vec<&RawContainerEntry>> = BTreeMap::new();
    let mut extra_running_memory_mib: u32 = 0;

    for entry in &entries {
        if let Some(role) = CommunityServiceRole::from_compose_service(&entry.service) {
            grouped.entry(role).or_default().push(entry);
        } else if entry.state.eq_ignore_ascii_case("running") {
            if let Some(mem) = entry.memory_mib {
                extra_running_memory_mib = extra_running_memory_mib.saturating_add(mem);
            }
        }
    }

    let mut services = Vec::with_capacity(CommunityServiceRole::ALL.len());
    let mut total_memory_mib: u32 = extra_running_memory_mib;

    for role in CommunityServiceRole::ALL {
        let diag = evaluate_role_diagnostic(
            role,
            grouped.get(&role).map(Vec::as_slice).unwrap_or(&[]),
            memory_overrides_mib.get(&role).copied(),
        );
        if let Some(mem) = diag.memory_mib {
            total_memory_mib = total_memory_mib.saturating_add(mem);
        }
        services.push(diag);
    }

    let budget_warning = if total_memory_mib > COMMUNITY_MEMORY_BUDGET_MIB {
        Some(MemoryBudgetWarning {
            observed_mib: total_memory_mib,
            ceiling_mib: COMMUNITY_MEMORY_BUDGET_MIB,
            excess_mib: total_memory_mib - COMMUNITY_MEMORY_BUDGET_MIB,
        })
    } else {
        None
    };

    let any_hard_degraded = services.iter().any(|s| {
        matches!(
            s.readiness,
            ServiceReadiness::Missing
                | ServiceReadiness::Stopped
                | ServiceReadiness::Unhealthy
                | ServiceReadiness::PolicyDegraded
        )
    });
    let any_restarting = services
        .iter()
        .any(|s| s.readiness == ServiceReadiness::Restarting);
    let any_starting = services
        .iter()
        .any(|s| s.readiness == ServiceReadiness::Starting);

    let state = if any_hard_degraded {
        StackHealthState::Degraded
    } else if any_restarting {
        StackHealthState::Restarting
    } else if any_starting {
        StackHealthState::Starting
    } else if budget_warning.is_some() {
        StackHealthState::OverBudget
    } else {
        StackHealthState::Healthy
    };

    Ok(SelfHostHealthReport {
        state,
        services,
        observed_memory_mib: total_memory_mib,
        memory_budget_mib: COMMUNITY_MEMORY_BUDGET_MIB,
        budget_warning,
    })
}

fn evaluate_role_diagnostic(
    role: CommunityServiceRole,
    candidates: &[&RawContainerEntry],
    override_memory_mib: Option<u32>,
) -> ServiceHealthDiagnostic {
    if candidates.is_empty() {
        return ServiceHealthDiagnostic {
            role,
            compose_service: None,
            container_name: None,
            readiness: ServiceReadiness::Missing,
            container_state: None,
            health_status: None,
            kodera_policy_loaded: None,
            memory_mib: override_memory_mib,
            summary: format!(
                "{} container is missing from local Compose stack",
                role.display_name()
            ),
        };
    }

    let mut worst: Option<(&RawContainerEntry, ServiceReadiness, Option<bool>)> = None;
    let mut summed_mem: Option<u32> = None;

    for entry in candidates {
        if let Some(mem) = entry.memory_mib {
            summed_mem = Some(summed_mem.unwrap_or(0).saturating_add(mem));
        }
        let (readiness, policy_loaded) = classify_entry_readiness(role, entry);
        match worst {
            None => worst = Some((entry, readiness, policy_loaded)),
            Some((_, current_worst, _))
                if readiness.severity_rank() > current_worst.severity_rank() =>
            {
                worst = Some((entry, readiness, policy_loaded));
            }
            _ => {}
        }
    }

    let (chosen, readiness, policy_loaded) = worst.expect("non-empty candidates");
    let effective_memory = override_memory_mib.or(summed_mem);
    let health_status = chosen
        .health
        .as_deref()
        .filter(|h| !h.is_empty())
        .map(str::to_owned);

    let summary = match (role, readiness) {
        (CommunityServiceRole::Synapse, ServiceReadiness::Ready) => {
            "Synapse is running and healthy with KoderaPolicy loaded".to_owned()
        }
        (CommunityServiceRole::Synapse, ServiceReadiness::PolicyDegraded) => {
            "Synapse is running without an active KoderaPolicy module".to_owned()
        }
        (_, ServiceReadiness::Ready) => format!("{} is running and ready", role.display_name()),
        (_, ServiceReadiness::Starting) => {
            format!("{} is starting health checks", role.display_name())
        }
        (_, ServiceReadiness::Restarting) => {
            format!("{} is in a restart loop", role.display_name())
        }
        (_, ServiceReadiness::Unhealthy) => {
            format!("{} failed its container health check", role.display_name())
        }
        (_, ServiceReadiness::Stopped) => format!("{} container is stopped", role.display_name()),
        (_, ServiceReadiness::PolicyDegraded) => {
            format!("{} policy check failed", role.display_name())
        }
        (_, ServiceReadiness::Missing) => {
            format!("{} container is missing", role.display_name())
        }
    };

    ServiceHealthDiagnostic {
        role,
        compose_service: Some(chosen.service.clone()),
        container_name: chosen.name.clone(),
        readiness,
        container_state: Some(chosen.state.clone()),
        health_status,
        kodera_policy_loaded: policy_loaded,
        memory_mib: effective_memory,
        summary,
    }
}

fn classify_entry_readiness(
    role: CommunityServiceRole,
    entry: &RawContainerEntry,
) -> (ServiceReadiness, Option<bool>) {
    let state_lower = entry.state.to_ascii_lowercase();
    let health_lower = entry
        .health
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();

    let policy_flag = if role == CommunityServiceRole::Synapse {
        match entry
            .kodera_policy
            .as_deref()
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("missing" | "false" | "disabled" | "error" | "unloaded") => Some(false),
            Some(_) => Some(true),
            None => Some(state_lower == "running"),
        }
    } else {
        None
    };

    if state_lower == "restarting" {
        return (ServiceReadiness::Restarting, policy_flag);
    }
    if state_lower == "created" {
        return (ServiceReadiness::Starting, policy_flag);
    }
    if state_lower != "running" {
        return (ServiceReadiness::Stopped, policy_flag);
    }

    match health_lower.as_str() {
        "unhealthy" => (ServiceReadiness::Unhealthy, policy_flag),
        "starting" => (ServiceReadiness::Starting, policy_flag),
        "healthy" => {
            if role == CommunityServiceRole::Synapse && policy_flag == Some(false) {
                (ServiceReadiness::PolicyDegraded, policy_flag)
            } else {
                (ServiceReadiness::Ready, policy_flag)
            }
        }
        "" => match role {
            CommunityServiceRole::Coturn => (ServiceReadiness::Ready, None),
            CommunityServiceRole::Postgres | CommunityServiceRole::Synapse => {
                // Postgres and Synapse define healthchecks in deploy/community/docker-compose.yml;
                // if Docker omits Health while running without healthcheck failure, check policy.
                if role == CommunityServiceRole::Synapse && policy_flag == Some(false) {
                    (ServiceReadiness::PolicyDegraded, policy_flag)
                } else {
                    (ServiceReadiness::Ready, policy_flag)
                }
            }
        },
        _ => (ServiceReadiness::Unhealthy, policy_flag),
    }
}

/// Classifies non-zero Docker CLI stderr without echoing raw operator strings.
pub fn classify_docker_stderr(stderr: &str) -> DockerUnavailableReason {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("permission denied") || lower.contains("access is denied") {
        DockerUnavailableReason::PermissionDenied
    } else {
        DockerUnavailableReason::DaemonOffline
    }
}

/// Error returned if a background [`CommunityProbeHandle`] worker channel disconnects before delivering a report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProbeDisconnectedError;

impl fmt::Display for ProbeDisconnectedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("probe_disconnected")
    }
}

impl std::error::Error for ProbeDisconnectedError {}

/// Non-blocking handle for polling a background local stack health check from UI event loops.
pub struct CommunityProbeHandle {
    receiver: Receiver<SelfHostHealthReport>,
}

impl CommunityProbeHandle {
    /// Spawns a background probe thread and returns immediately without blocking the caller.
    pub fn spawn(compose_file: PathBuf, timeout: Duration) -> Self {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let report = probe_local_community_stack(&compose_file, timeout);
            let _ = tx.send(report);
        });
        Self { receiver: rx }
    }

    /// Checks whether the background probe has finished without blocking (`Ok(Some(report))`),
    /// is still running (`Ok(None)`), or disconnected unexpectedly (`Err(ProbeDisconnectedError)`).
    pub fn try_poll(&self) -> Result<Option<SelfHostHealthReport>, ProbeDisconnectedError> {
        match self.receiver.try_recv() {
            Ok(report) => Ok(Some(report)),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => Err(ProbeDisconnectedError),
        }
    }
}

/// Runs `docker compose -f <compose_file> ps --format json` with a strict non-blocking poll
/// deadline capped at [`MAX_PROBE_TIMEOUT_MS`]. Never blocks indefinitely if the Docker daemon
/// hangs or is unreachable.
pub fn probe_local_community_stack(compose_file: &Path, timeout: Duration) -> SelfHostHealthReport {
    probe_with_binary("docker", compose_file, timeout)
}

fn probe_with_binary(
    docker_bin: &str,
    compose_file: &Path,
    timeout: Duration,
) -> SelfHostHealthReport {
    if !is_safe_compose_file_path(compose_file) || !compose_file.is_file() {
        return SelfHostHealthReport::docker_unavailable(
            DockerUnavailableReason::ComposeFileMissing,
        );
    }
    let capped_timeout = timeout.min(Duration::from_millis(MAX_PROBE_TIMEOUT_MS));

    let mut child = match Command::new(docker_bin)
        .arg("compose")
        .arg("-f")
        .arg(compose_file)
        .arg("ps")
        .arg("--format")
        .arg("json")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return SelfHostHealthReport::docker_unavailable(DockerUnavailableReason::CliMissing);
        }
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
            return SelfHostHealthReport::docker_unavailable(
                DockerUnavailableReason::PermissionDenied,
            );
        }
        Err(_) => {
            return SelfHostHealthReport::docker_unavailable(
                DockerUnavailableReason::DaemonOffline,
            );
        }
    };

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stdout_reader = thread::spawn(move || -> Vec<u8> {
        let mut buf = Vec::new();
        if let Some(pipe) = stdout_pipe {
            let _ = pipe
                .take((MAX_COMPOSE_PS_JSON_BYTES + 1) as u64)
                .read_to_end(&mut buf);
        }
        buf
    });
    let stderr_reader = thread::spawn(move || -> Vec<u8> {
        let mut buf = Vec::new();
        if let Some(pipe) = stderr_pipe {
            let _ = pipe.take(4096).read_to_end(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + capped_timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return SelfHostHealthReport::docker_unavailable(
                        DockerUnavailableReason::ProbeTimedOut,
                    );
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return SelfHostHealthReport::docker_unavailable(
                    DockerUnavailableReason::DaemonOffline,
                );
            }
        }
    };

    let stdout_bytes = stdout_reader.join().unwrap_or_default();
    let stderr_bytes = stderr_reader.join().unwrap_or_default();

    if !status.success() {
        let stderr_text = String::from_utf8_lossy(&stderr_bytes);
        return SelfHostHealthReport::docker_unavailable(classify_docker_stderr(&stderr_text));
    }

    let Ok(stdout_text) = core::str::from_utf8(&stdout_bytes) else {
        return SelfHostHealthReport::docker_unavailable(DockerUnavailableReason::DaemonOffline);
    };

    match inspect_community_compose_ps(stdout_text, &BTreeMap::new()) {
        Ok(report) => report,
        Err(_) => SelfHostHealthReport {
            state: StackHealthState::Degraded,
            services: CommunityServiceRole::ALL
                .into_iter()
                .map(|role| ServiceHealthDiagnostic {
                    role,
                    compose_service: None,
                    container_name: None,
                    readiness: ServiceReadiness::Missing,
                    container_state: None,
                    health_status: None,
                    kodera_policy_loaded: None,
                    memory_mib: None,
                    summary: format!("{} status output could not be decoded", role.display_name()),
                })
                .collect(),
            observed_memory_mib: 0,
            memory_budget_mib: COMMUNITY_MEMORY_BUDGET_MIB,
            budget_warning: None,
        },
    }
}

fn is_safe_compose_file_path(path: &Path) -> bool {
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return false;
    }
    matches!(
        path.file_name().and_then(|n| n.to_str()),
        Some("docker-compose.yml" | "docker-compose.yaml" | "compose.yml" | "compose.yaml")
    )
}

fn parse_memory_usage_mib(raw: &str) -> Option<u32> {
    // Accepts e.g. "412MiB / 1024MiB", "1.25GiB / 1.5GiB", "512MB", "65536KiB", or "384".
    let first_segment = raw.split('/').next()?.trim();
    if first_segment.is_empty() {
        return None;
    }
    let split_idx = first_segment
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(first_segment.len());
    let (num_part, unit_part) = first_segment.split_at(split_idx);
    let value: f64 = num_part.trim().parse().ok()?;
    if !value.is_finite() || value < 0.0 {
        return None;
    }
    let mib = match unit_part.trim().to_ascii_lowercase().as_str() {
        "" | "mib" | "m" | "mb" => value,
        "gib" | "g" | "gb" => value * 1024.0,
        "kib" | "k" | "kb" => value / 1024.0,
        "b" => value / (1024.0 * 1024.0),
        _ => return None,
    };
    if mib > f64::from(u32::MAX) {
        None
    } else {
        Some(mib.ceil() as u32)
    }
}

fn parse_compose_ps_entries(raw_json: &str) -> Result<Vec<RawContainerEntry>, SelfHostHealthError> {
    let mut parser = ComposeJsonParser {
        raw: raw_json,
        offset: 0,
    };
    parser.whitespace();
    if parser.peek().is_none() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    if parser.peek() == Some(b'[') {
        parser.offset += 1;
        parser.whitespace();
        if parser.peek() == Some(b']') {
            parser.offset += 1;
            parser.whitespace();
            if parser.offset != parser.raw.len() {
                return Err(SelfHostHealthError::InvalidJson);
            }
            return Ok(entries);
        }
        loop {
            if entries.len() >= MAX_COMPOSE_CONTAINERS {
                return Err(SelfHostHealthError::TooManyContainers);
            }
            entries.push(parser.parse_entry_object()?);
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
            if entries.len() >= MAX_COMPOSE_CONTAINERS {
                return Err(SelfHostHealthError::TooManyContainers);
            }
            entries.push(parser.parse_entry_object()?);
            parser.whitespace();
        }
    }
    Ok(entries)
}

struct ComposeJsonParser<'a> {
    raw: &'a str,
    offset: usize,
}

impl ComposeJsonParser<'_> {
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

    fn parse_entry_object(&mut self) -> Result<RawContainerEntry, SelfHostHealthError> {
        self.expect(b'{')?;
        self.whitespace();
        let mut entry = RawContainerEntry::default();
        let mut seen_keys = std::collections::BTreeSet::new();
        let mut has_service = false;
        let mut has_state = false;

        if self.peek() == Some(b'}') {
            return Err(SelfHostHealthError::InvalidJson);
        }

        loop {
            if seen_keys.len() >= 48 {
                return Err(SelfHostHealthError::InvalidJson);
            }
            let key = self.parse_string()?;
            if !seen_keys.insert(key.clone()) {
                return Err(SelfHostHealthError::InvalidJson);
            }
            self.whitespace();
            self.expect(b':')?;
            self.whitespace();

            match key.as_str() {
                "Service" => {
                    entry.service = self.parse_string()?;
                    has_service = !entry.service.is_empty();
                }
                "Name" => {
                    if self.peek() == Some(b'"') {
                        entry.name = Some(self.parse_string()?);
                    } else {
                        self.skip_value(0)?;
                    }
                }
                "State" => {
                    entry.state = self.parse_string()?;
                    has_state = !entry.state.is_empty();
                }
                "Health" => {
                    if self.peek() == Some(b'"') {
                        entry.health = Some(self.parse_string()?);
                    } else {
                        self.skip_value(0)?;
                    }
                }
                "KoderaPolicy" => match self.peek() {
                    Some(b'"') => entry.kodera_policy = Some(self.parse_string()?),
                    Some(b't') if self.raw[self.offset..].starts_with("true") => {
                        self.offset += 4;
                        entry.kodera_policy = Some("true".to_owned());
                    }
                    Some(b'f') if self.raw[self.offset..].starts_with("false") => {
                        self.offset += 5;
                        entry.kodera_policy = Some("false".to_owned());
                    }
                    _ => self.skip_value(0)?,
                },
                "MemoryMiB" => {
                    let val = self.parse_u32()?;
                    entry.memory_mib = Some(val);
                }
                "MemUsage" => {
                    let raw_mem = self.parse_string()?;
                    if entry.memory_mib.is_none() {
                        entry.memory_mib = parse_memory_usage_mib(&raw_mem);
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

        if !has_service || !has_state {
            return Err(SelfHostHealthError::InvalidJson);
        }
        Ok(entry)
    }

    fn parse_u32(&mut self) -> Result<u32, SelfHostHealthError> {
        let start = self.offset;
        if self.peek() == Some(b'0') {
            self.offset += 1;
        } else if matches!(self.peek(), Some(b'1'..=b'9')) {
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.offset += 1;
            }
        } else {
            return Err(SelfHostHealthError::InvalidJson);
        }
        self.raw[start..self.offset]
            .parse::<u32>()
            .map_err(|_| SelfHostHealthError::InvalidJson)
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
            Some(b'-' | b'0'..=b'9') => self.skip_number(),
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

    fn skip_number(&mut self) -> Result<(), SelfHostHealthError> {
        if self.peek() == Some(b'-') {
            self.offset += 1;
        }
        match self.peek() {
            Some(b'0') => self.offset += 1,
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.offset += 1;
                }
            }
            _ => return Err(SelfHostHealthError::InvalidJson),
        }
        if self.peek() == Some(b'.') {
            self.offset += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(SelfHostHealthError::InvalidJson);
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.offset += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.offset += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.offset += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(SelfHostHealthError::InvalidJson);
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.offset += 1;
            }
        }
        Ok(())
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

    #[test]
    fn healthy_ndjson_and_array_profiles_under_memory_budget_pass() {
        // Docker Compose v2 NDJSON output with Publishers arrays and KoderaPolicy metadata.
        let ndjson = concat!(
            r#"{"Service":"postgres","Name":"community-postgres-1","State":"running","Health":"healthy","MemoryMiB":240,"Publishers":[{"URL":"","TargetPort":5432,"PublishedPort":0,"Protocol":"tcp"}]}"#,
            "\n",
            r#"{"Service":"synapse","Name":"community-synapse-1","State":"running","Health":"healthy","KoderaPolicy":"0.1.4","MemUsage":"640MiB / 1024MiB"}"#,
            "\n",
            r#"{"Service":"coturn","Name":"community-coturn-1","State":"running","Health":"","MemoryMiB":96}"#,
            "\n"
        );
        let report = inspect_community_compose_ps(ndjson, &BTreeMap::new()).unwrap();
        assert!(report.is_healthy());
        assert_eq!(report.state, StackHealthState::Healthy);
        assert_eq!(report.observed_memory_mib, 976);
        assert_eq!(report.memory_budget_mib, COMMUNITY_MEMORY_BUDGET_MIB);
        assert_eq!(report.budget_warning, None);
        assert_eq!(report.services.len(), 3);
        assert!(report
            .services
            .iter()
            .all(|s| s.readiness == ServiceReadiness::Ready));
        assert_eq!(report.services[1].kodera_policy_loaded, Some(true));

        // Equivalent JSON array using `synapse-db` service alias from deploy/community/docker-compose.yml.
        let array_json = r#"[
            {"Service":"synapse-db","State":"running","Health":"healthy","MemoryMiB":256},
            {"Service":"synapse","State":"running","Health":"healthy","MemoryMiB":768},
            {"Service":"coturn","State":"running","Health":"healthy","MemoryMiB":128}
        ]"#;
        let array_report = inspect_community_compose_ps(array_json, &BTreeMap::new()).unwrap();
        assert_eq!(array_report.state, StackHealthState::Healthy);
        assert_eq!(array_report.observed_memory_mib, 1152);
    }

    #[test]
    fn over_budget_profile_emits_structured_ceiling_warning() {
        let json = r#"[
            {"Service":"postgres","State":"running","Health":"healthy","MemoryMiB":480},
            {"Service":"synapse","State":"running","Health":"healthy","MemUsage":"1.05GiB / 1.5GiB"},
            {"Service":"coturn","State":"running","Health":"","MemoryMiB":120}
        ]"#;
        let report = inspect_community_compose_ps(json, &BTreeMap::new()).unwrap();
        assert!(!report.is_healthy());
        assert_eq!(report.state, StackHealthState::OverBudget);
        assert!(report.observed_memory_mib > COMMUNITY_MEMORY_BUDGET_MIB);
        let warning = report.budget_warning.expect("expected budget warning");
        assert_eq!(warning.ceiling_mib, 1536);
        assert_eq!(warning.excess_mib, warning.observed_mib - 1536);
    }

    #[test]
    fn restarting_and_degraded_services_surface_per_service_diagnostics() {
        let restarting_json = r#"[
            {"Service":"postgres","State":"running","Health":"healthy","MemoryMiB":200},
            {"Service":"synapse","State":"running","Health":"healthy","MemoryMiB":500},
            {"Service":"coturn","State":"restarting","Health":"","MemoryMiB":32}
        ]"#;
        let restarting = inspect_community_compose_ps(restarting_json, &BTreeMap::new()).unwrap();
        assert_eq!(restarting.state, StackHealthState::Restarting);
        assert_eq!(
            restarting.services[2].readiness,
            ServiceReadiness::Restarting
        );

        // Synapse running without KoderaPolicy -> PolicyDegraded -> StackHealthState::Degraded.
        let policy_missing_json = r#"[
            {"Service":"postgres","State":"running","Health":"healthy"},
            {"Service":"synapse","State":"running","Health":"healthy","KoderaPolicy":false},
            {"Service":"coturn","State":"running","Health":""}
        ]"#;
        let policy_report =
            inspect_community_compose_ps(policy_missing_json, &BTreeMap::new()).unwrap();
        assert_eq!(policy_report.state, StackHealthState::Degraded);
        assert_eq!(
            policy_report.services[1].readiness,
            ServiceReadiness::PolicyDegraded
        );
        assert_eq!(policy_report.services[1].kodera_policy_loaded, Some(false));

        // Missing Coturn + unhealthy Postgres -> Degraded.
        let degraded_json = r#"[
            {"Service":"postgres","State":"running","Health":"unhealthy"},
            {"Service":"synapse","State":"running","Health":"healthy"}
        ]"#;
        let degraded = inspect_community_compose_ps(degraded_json, &BTreeMap::new()).unwrap();
        assert_eq!(degraded.state, StackHealthState::Degraded);
        assert_eq!(degraded.services[0].readiness, ServiceReadiness::Unhealthy);
        assert_eq!(degraded.services[2].readiness, ServiceReadiness::Missing);
    }

    #[test]
    fn docker_unavailable_states_cover_missing_cli_compose_file_and_offline_daemon() {
        let compose_path = Path::new("../../../deploy/community/docker-compose.yml");
        assert_eq!(
            probe_local_community_stack(compose_path, Duration::from_millis(50)).state,
            StackHealthState::DockerUnavailable {
                reason: DockerUnavailableReason::ComposeFileMissing
            }
        );

        let missing_file = Path::new("nonexistent/docker-compose.yml");
        assert_eq!(
            probe_local_community_stack(missing_file, Duration::from_millis(50)).state,
            StackHealthState::DockerUnavailable {
                reason: DockerUnavailableReason::ComposeFileMissing
            }
        );

        // Real existing compose file in repo + missing binary -> CliMissing without blocking.
        let repo_compose = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("deploy/community/docker-compose.yml");
        assert!(repo_compose.is_file());
        let missing_cli = probe_with_binary(
            "kodera-missing-docker-cli-test-bin",
            &repo_compose,
            Duration::from_millis(200),
        );
        assert_eq!(
            missing_cli.state,
            StackHealthState::DockerUnavailable {
                reason: DockerUnavailableReason::CliMissing
            }
        );

        assert_eq!(
            classify_docker_stderr(
                "Cannot connect to the Docker daemon at unix:///var/run/docker.sock"
            ),
            DockerUnavailableReason::DaemonOffline
        );
        assert_eq!(
            classify_docker_stderr(
                "Got permission denied while trying to connect to the Docker daemon"
            ),
            DockerUnavailableReason::PermissionDenied
        );
    }
}
