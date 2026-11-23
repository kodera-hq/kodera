//! `unsafe`-free native OS Keychain adapter (`security`, `secret-tool`, `PasswordVault`) paired
//! with an atomic `0600` non-secret metadata index and headless CI fallback.

use super::{
    metadata_exposes_secret, validate_keychain_account_id, validate_keychain_service_id,
    EphemeralKeychainBackend, KeychainBackend, KeychainCredentialStatus, KeychainError,
    KeychainPersistence, KeychainSecretKind, KeychainSessionMetadata, KeychainSlotDescriptor,
    OsKeychainCommandSpec, OsKeychainPlatform, RedactedSessionSecret, MAX_KEYCHAIN_SECRET_BYTES,
    MAX_KEYCHAIN_SLOTS_PER_ORG, MIN_KEYCHAIN_SECRET_BYTES,
};
use crate::DESKTOP_APP_IDENTIFIER;
use kodera_rs::OrganisationId;
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

/// Maximum byte size accepted when reading `keychain-index.json` from disk (`256 KiB`).
pub const MAX_KEYCHAIN_INDEX_BYTES: usize = 256 * 1024;

/// Maximum byte length of an encoded interactive `/usr/bin/security -i` stdin command line,
/// strictly below Apple `SecurityTool/sharedTool/readline.c`'s `4,095`-byte line split threshold.
pub const MAX_MACOS_SECURITY_INTERACTIVE_LINE_BYTES: usize = 4_000;

/// Default wall-clock execution deadline (`3,000 ms`) for OS keychain CLI child processes.
pub const DEFAULT_OS_KEYCHAIN_TIMEOUT_MS: u64 = 3_000;

pub(crate) const DEFAULT_WINDOWS_SYSTEM_ROOT: &str = r"C:\Windows";
pub(crate) const WINDOWS_POWERSHELL_SUBPATH: &str =
    r"System32\WindowsPowerShell\v1.0\powershell.exe";

pub(crate) fn resolve_linux_secret_tool_program() -> String {
    if Path::new("/usr/bin/secret-tool").is_file() {
        "/usr/bin/secret-tool".to_owned()
    } else {
        "secret-tool".to_owned()
    }
}

pub(crate) fn resolve_windows_powershell_program_from_root(system_root: Option<&str>) -> String {
    let root = system_root
        .map(str::trim)
        .filter(|raw| {
            !raw.is_empty()
                && raw.len() <= 240
                && !raw.contains("..")
                && !raw
                    .bytes()
                    .any(|b| b.is_ascii_control() || matches!(b, b'"' | b'\'' | b';' | b'|' | b'&'))
                && {
                    let bytes = raw.as_bytes();
                    bytes.len() >= 3
                        && bytes[0].is_ascii_alphabetic()
                        && bytes[1] == b':'
                        && matches!(bytes[2], b'\\' | b'/')
                }
        })
        .unwrap_or(DEFAULT_WINDOWS_SYSTEM_ROOT)
        .trim_end_matches(['\\', '/']);
    format!(r"{root}\{WINDOWS_POWERSHELL_SUBPATH}")
}

pub(crate) fn resolve_windows_powershell_program() -> String {
    let env_root = std::env::var("SystemRoot").ok();
    resolve_windows_powershell_program_from_root(env_root.as_deref())
}

/// Static PowerShell command reading tab-delimited `(op, service, account[, secret])` from `stdin`
/// into `Windows.Security.Credentials.PasswordVault` with zero caller values on `argv`.
/// Only `HResult == -2147023728` (`0x80070490`, `ERROR_NOT_FOUND`) maps to exit `44`; genuine
/// COM or vault failures exit `1`.
pub(crate) const WINDOWS_PASSWORD_VAULT_COMMAND: &str = concat!(
    "$ErrorActionPreference = 'Stop'; ",
    "$null = [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; ",
    "$line = [Console]::In.ReadLine(); ",
    "if ([string]::IsNullOrEmpty($line)) { exit 2 }; ",
    "$parts = $line.Split([char]9, 4); ",
    "$op = $parts[0]; ",
    "$vault = New-Object Windows.Security.Credentials.PasswordVault; ",
    "if ($op -eq 'store') { ",
    "if ($parts.Length -lt 4) { exit 2 }; ",
    "try { $old = $vault.Retrieve($parts[1], $parts[2]); $vault.Remove($old) } catch { if ($_.Exception.HResult -ne -2147023728) { exit 1 } }; ",
    "$cred = New-Object Windows.Security.Credentials.PasswordCredential($parts[1], $parts[2], $parts[3]); ",
    "$vault.Add($cred); exit 0 ",
    "} elseif ($op -eq 'lookup') { ",
    "if ($parts.Length -lt 3) { exit 2 }; ",
    "try { $cred = $vault.Retrieve($parts[1], $parts[2]); $cred.RetrievePassword(); [Console]::Out.Write($cred.Password); exit 0 } catch { if ($_.Exception.HResult -eq -2147023728) { exit 44 }; exit 1 } ",
    "} elseif ($op -eq 'delete') { ",
    "if ($parts.Length -lt 3) { exit 2 }; ",
    "try { $cred = $vault.Retrieve($parts[1], $parts[2]); $vault.Remove($cred); exit 0 } catch { if ($_.Exception.HResult -eq -2147023728) { exit 44 }; exit 1 } ",
    "} else { exit 2 }"
);

/// Bounded, zeroized child-process execution outcome for OS keychain CLI helpers.
pub struct OsKeychainExecOutput {
    pub status_code: Option<i32>,
    pub stdout: Zeroizing<Vec<u8>>,
    pub stderr_has_bytes: bool,
    pub missing_program: bool,
    pub timed_out: bool,
}

/// Out-of-process execution seam for OS keychain CLI commands (`Stdio::piped()`, zero `argv` secrets).
pub trait OsKeychainProcessRunner: Send + Sync {
    fn run_piped(
        &self,
        program: &str,
        args: &[String],
        stdin_bytes: Option<&[u8]>,
    ) -> Result<OsKeychainExecOutput, KeychainError>;
}

/// Production `std::process::Command` runner enforcing concurrent `Stdio::piped()` I/O draining,
/// bounded wall-clock process timeout, and zeroized stdout/stderr buffers.
#[derive(Debug, Clone, Copy)]
pub struct StdOsKeychainProcessRunner {
    timeout: Duration,
}

impl Default for StdOsKeychainProcessRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl StdOsKeychainProcessRunner {
    pub const fn new() -> Self {
        Self {
            timeout: Duration::from_millis(DEFAULT_OS_KEYCHAIN_TIMEOUT_MS),
        }
    }

    pub const fn with_timeout(timeout: Duration) -> Self {
        Self { timeout }
    }
}

impl OsKeychainProcessRunner for StdOsKeychainProcessRunner {
    fn run_piped(
        &self,
        program: &str,
        args: &[String],
        stdin_bytes: Option<&[u8]>,
    ) -> Result<OsKeychainExecOutput, KeychainError> {
        let mut child = match Command::new(program)
            .args(args)
            .stdin(if stdin_bytes.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Ok(OsKeychainExecOutput {
                    status_code: None,
                    stdout: Zeroizing::new(Vec::new()),
                    stderr_has_bytes: false,
                    missing_program: true,
                    timed_out: false,
                });
            }
            Err(_) => return Err(KeychainError::BackendFailure),
        };

        let child_stdin = child.stdin.take();
        let child_stdout = child.stdout.take();
        let child_stderr = child.stderr.take();
        let deadline = Instant::now() + self.timeout;

        let (stdin_tx, stdin_rx) = std::sync::mpsc::sync_channel::<bool>(1);
        let owned_stdin = stdin_bytes.map(|b| Zeroizing::new(b.to_vec()));
        std::thread::spawn(move || {
            let ok = match owned_stdin {
                None => true,
                Some(payload) => match child_stdin {
                    Some(mut pipe) => {
                        let written = pipe.write_all(&payload).is_ok() && pipe.flush().is_ok();
                        drop(pipe);
                        written
                    }
                    None => false,
                },
            };
            let _ = stdin_tx.send(ok);
        });

        let (stdout_tx, stdout_rx) =
            std::sync::mpsc::sync_channel::<Result<Zeroizing<Vec<u8>>, KeychainError>>(1);
        std::thread::spawn(move || {
            const MAX_STDOUT_BYTES: usize = MAX_KEYCHAIN_SECRET_BYTES + 16;
            let res = (|| {
                let mut buf = Zeroizing::new(Vec::with_capacity(MAX_STDOUT_BYTES + 1));
                if let Some(pipe) = child_stdout {
                    pipe.take((MAX_STDOUT_BYTES + 1) as u64)
                        .read_to_end(&mut buf)
                        .map_err(|_| KeychainError::BackendFailure)?;
                }
                if buf.len() > MAX_STDOUT_BYTES {
                    return Err(KeychainError::SecretTooLarge);
                }
                Ok(buf)
            })();
            let _ = stdout_tx.send(res);
        });

        let (stderr_tx, stderr_rx) = std::sync::mpsc::sync_channel::<bool>(1);
        std::thread::spawn(move || {
            let mut sink = Zeroizing::new(Vec::new());
            if let Some(pipe) = child_stderr {
                let _ = pipe.take(512).read_to_end(&mut sink);
            }
            let _ = stderr_tx.send(!sink.is_empty());
        });

        let exit_status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        let stderr_has_bytes = stderr_rx.try_recv().unwrap_or(false);
                        return Ok(OsKeychainExecOutput {
                            status_code: None,
                            stdout: Zeroizing::new(Vec::new()),
                            stderr_has_bytes,
                            missing_program: false,
                            timed_out: true,
                        });
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(KeychainError::BackendFailure);
                }
            }
        };

        let recv_within_deadline =
            |deadline: Instant| deadline.saturating_duration_since(Instant::now());

        let Ok(stdin_ok) = stdin_rx.recv_timeout(recv_within_deadline(deadline)) else {
            return Ok(OsKeychainExecOutput {
                status_code: None,
                stdout: Zeroizing::new(Vec::new()),
                stderr_has_bytes: stderr_rx.try_recv().unwrap_or(false),
                missing_program: false,
                timed_out: true,
            });
        };

        let Ok(stdout_res) = stdout_rx.recv_timeout(recv_within_deadline(deadline)) else {
            return Ok(OsKeychainExecOutput {
                status_code: None,
                stdout: Zeroizing::new(Vec::new()),
                stderr_has_bytes: stderr_rx.try_recv().unwrap_or(false),
                missing_program: false,
                timed_out: true,
            });
        };

        let Ok(stderr_has_bytes) = stderr_rx.recv_timeout(recv_within_deadline(deadline)) else {
            return Ok(OsKeychainExecOutput {
                status_code: None,
                stdout: Zeroizing::new(Vec::new()),
                stderr_has_bytes: false,
                missing_program: false,
                timed_out: true,
            });
        };

        if !stdin_ok && exit_status.code() == Some(0) {
            return Err(KeychainError::BackendFailure);
        }
        let stdout_buf = stdout_res?;

        Ok(OsKeychainExecOutput {
            status_code: exit_status.code(),
            stdout: stdout_buf,
            stderr_has_bytes,
            missing_program: false,
            timed_out: false,
        })
    }
}

/// Resolves the default app-support path for the non-secret `keychain-index.json` file,
/// mirroring `default_window_state_path()` in `gui/native_runtime.rs`.
pub fn default_keychain_index_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        if home.is_empty() {
            return None;
        }
        Some(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(DESKTOP_APP_IDENTIFIER)
                .join("keychain-index.json"),
        )
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA")?;
        if appdata.is_empty() {
            return None;
        }
        Some(
            PathBuf::from(appdata)
                .join(DESKTOP_APP_IDENTIFIER)
                .join("keychain-index.json"),
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
            if !xdg.is_empty() {
                return Some(
                    PathBuf::from(xdg)
                        .join(DESKTOP_APP_IDENTIFIER)
                        .join("keychain-index.json"),
                );
            }
        }
        let home = std::env::var_os("HOME")?;
        if home.is_empty() {
            return None;
        }
        Some(
            PathBuf::from(home)
                .join(".config")
                .join(DESKTOP_APP_IDENTIFIER)
                .join("keychain-index.json"),
        )
    }
}

#[cfg(not(test))]
pub(crate) fn default_runtime_keychain_backend() -> Arc<dyn KeychainBackend> {
    #[cfg(debug_assertions)]
    {
        if let Some(vault_raw) = std::env::var_os("KODERA_DESKTOP_DEBUG_KEYCHAIN_VAULT") {
            if !vault_raw.is_empty() {
                return Arc::new(DebugVaultKeychainBackend::new(PathBuf::from(vault_raw)));
            }
        }
    }
    Arc::new(OsNativeKeychainBackend::default_host())
}

/// Formats the interactive `/usr/bin/security -i` stdin command line with strict escaping and
/// injection refusal so secret material never appears on `argv`.
pub(crate) fn format_macos_security_interactive_store_line(
    slot: &KeychainSlotDescriptor,
    secret: &RedactedSessionSecret,
) -> Result<Zeroizing<Vec<u8>>, KeychainError> {
    validate_keychain_service_id(&slot.service_name)?;
    validate_keychain_account_id(&slot.account_name)?;
    if slot
        .service_name
        .bytes()
        .any(|b| matches!(b, b'"' | b'\'' | b'\\'))
    {
        return Err(KeychainError::InvalidServiceIdentifier);
    }
    if slot
        .account_name
        .bytes()
        .any(|b| matches!(b, b'"' | b'\'' | b'\\'))
    {
        return Err(KeychainError::InvalidAccountIdentifier);
    }
    let raw_secret = secret.expose_for_keychain_write();
    if raw_secret.len() < MIN_KEYCHAIN_SECRET_BYTES {
        return Err(KeychainError::SecretTooShort);
    }
    if raw_secret.len() > MAX_KEYCHAIN_SECRET_BYTES {
        return Err(KeychainError::SecretTooLarge);
    }
    if !raw_secret.bytes().all(|b| (0x21..=0x7E).contains(&b)) {
        return Err(KeychainError::SecretInvalidCharacters);
    }

    let mut escaped_secret = Zeroizing::new(String::with_capacity(raw_secret.len() * 2 + 128));
    for ch in raw_secret.chars() {
        match ch {
            '\\' => escaped_secret.push_str("\\\\"),
            '"' => escaped_secret.push_str("\\\""),
            other => escaped_secret.push(other),
        }
    }

    let mut line = Zeroizing::new(Vec::with_capacity(
        64 + slot.service_name.len() + slot.account_name.len() + escaped_secret.len(),
    ));
    line.extend_from_slice(b"add-generic-password -U -s \"");
    line.extend_from_slice(slot.service_name.as_bytes());
    line.extend_from_slice(b"\" -a \"");
    line.extend_from_slice(slot.account_name.as_bytes());
    line.extend_from_slice(b"\" -w \"");
    line.extend_from_slice(escaped_secret.as_bytes());
    line.extend_from_slice(b"\"\n");
    if line.len() > MAX_MACOS_SECURITY_INTERACTIVE_LINE_BYTES {
        return Err(KeychainError::SecretTooLarge);
    }
    Ok(line)
}

pub(crate) fn format_windows_vault_stdin_line(
    op: &str,
    slot: &KeychainSlotDescriptor,
    secret: Option<&RedactedSessionSecret>,
) -> Result<Zeroizing<Vec<u8>>, KeychainError> {
    validate_keychain_service_id(&slot.service_name)?;
    validate_keychain_account_id(&slot.account_name)?;
    let secret_len = secret
        .map(|s| s.expose_for_keychain_write().len())
        .unwrap_or(0);
    let mut line = Zeroizing::new(Vec::with_capacity(
        op.len() + slot.service_name.len() + slot.account_name.len() + secret_len + 16,
    ));
    line.extend_from_slice(op.as_bytes());
    line.push(b'\t');
    line.extend_from_slice(slot.service_name.as_bytes());
    line.push(b'\t');
    line.extend_from_slice(slot.account_name.as_bytes());
    if let Some(sec) = secret {
        let raw = sec.expose_for_keychain_write();
        if !raw.bytes().all(|b| (0x21..=0x7E).contains(&b)) {
            return Err(KeychainError::SecretInvalidCharacters);
        }
        line.push(b'\t');
        line.extend_from_slice(raw.as_bytes());
    }
    line.push(b'\n');
    Ok(line)
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct PersistedMetadataIndex {
    version: u8,
    entries: Vec<PersistedMetadataRecord>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct PersistedMetadataRecord {
    secret_kind: String,
    organisation_id: String,
    matrix_user_id: String,
    device_id: String,
    issued_at_unix_secs: u64,
    expires_at_unix_secs: Option<u64>,
}

fn write_atomic_0600(path: &Path, bytes: &[u8]) -> Result<(), KeychainError> {
    let Some(parent) = path.parent() else {
        return Err(KeychainError::BackendFailure);
    };
    fs::create_dir_all(parent).map_err(|_| KeychainError::BackendFailure)?;
    if path.exists() {
        let meta = fs::symlink_metadata(path).map_err(|_| KeychainError::BackendFailure)?;
        if !meta.file_type().is_file() {
            return Err(KeychainError::BackendFailure);
        }
    }
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or(KeychainError::BackendFailure)?;
    let tmp_path = parent.join(format!(".{file_name}.tmp.{}", std::process::id()));
    let _ = fs::remove_file(&tmp_path);

    let mut open_opts = fs::OpenOptions::new();
    open_opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open_opts.mode(0o600);
    }
    let mut file = open_opts.open(&tmp_path).map_err(|_| {
        let _ = fs::remove_file(&tmp_path);
        KeychainError::BackendFailure
    })?;
    if file.write_all(bytes).is_err() || file.flush().is_err() {
        drop(file);
        let _ = fs::remove_file(&tmp_path);
        return Err(KeychainError::BackendFailure);
    }
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600)).is_err() {
            let _ = fs::remove_file(&tmp_path);
            return Err(KeychainError::BackendFailure);
        }
    }
    fs::rename(&tmp_path, path).map_err(|_| {
        let _ = fs::remove_file(&tmp_path);
        KeychainError::BackendFailure
    })
}

fn read_bounded_regular_file(
    path: &Path,
    max_bytes: usize,
) -> Result<Option<Zeroizing<String>>, KeychainError> {
    if !path.exists() {
        return Ok(None);
    }
    let meta = fs::symlink_metadata(path).map_err(|_| KeychainError::BackendFailure)?;
    if !meta.file_type().is_file() || meta.len() > max_bytes as u64 {
        return Err(KeychainError::BackendFailure);
    }
    let mut raw_bytes = Zeroizing::new(Vec::with_capacity(meta.len() as usize));
    let file = fs::File::open(path).map_err(|_| KeychainError::BackendFailure)?;
    file.take((max_bytes + 1) as u64)
        .read_to_end(&mut raw_bytes)
        .map_err(|_| KeychainError::BackendFailure)?;
    if raw_bytes.len() > max_bytes {
        return Err(KeychainError::BackendFailure);
    }
    let text = core::str::from_utf8(&raw_bytes)
        .map_err(|_| KeychainError::BackendFailure)?
        .to_owned();
    Ok(Some(Zeroizing::new(text)))
}

enum OsStoreAttempt {
    NativeStored,
    HeadlessFallback,
}

enum OsLookupOutcome {
    Found(RedactedSessionSecret),
    ConfirmedAbsent,
    Unavailable(KeychainError),
}

enum OsDeleteOutcome {
    Deleted,
    ConfirmedAbsent,
}

type ClockFn = dyn Fn() -> u64 + Send + Sync;
type MetadataIndexMap = BTreeMap<(String, String), KeychainSessionMetadata>;

/// Persistent cross-platform OS Keychain backend (`security` on macOS, `secret-tool` on Linux,
/// `PasswordVault` on Windows) with an atomic `0600` non-secret JSON metadata index and automatic
/// headless Linux CI fallback.
pub struct OsNativeKeychainBackend {
    platform: OsKeychainPlatform,
    index_path: Option<PathBuf>,
    runner: Arc<dyn OsKeychainProcessRunner>,
    clock: Arc<ClockFn>,
    linux_dbus_available: bool,
    io_lock: Mutex<()>,
    fallback: EphemeralKeychainBackend,
}

impl OsNativeKeychainBackend {
    pub fn default_host() -> Self {
        let linux_dbus_available =
            std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some_and(|val| !val.is_empty());
        let clock: Arc<ClockFn> = Arc::new(kodera_rs::system_unix_secs);
        Self {
            platform: OsKeychainPlatform::host(),
            index_path: default_keychain_index_path(),
            runner: Arc::new(StdOsKeychainProcessRunner::new()),
            fallback: EphemeralKeychainBackend::with_clock(clock.clone()),
            clock,
            linux_dbus_available,
            io_lock: Mutex::new(()),
        }
    }

    pub fn with_custom_runner(
        platform: OsKeychainPlatform,
        index_path: Option<PathBuf>,
        runner: Arc<dyn OsKeychainProcessRunner>,
        clock: Arc<ClockFn>,
        linux_dbus_available: bool,
    ) -> Self {
        Self {
            platform,
            index_path,
            runner,
            fallback: EphemeralKeychainBackend::with_clock(clock.clone()),
            clock,
            linux_dbus_available,
            io_lock: Mutex::new(()),
        }
    }

    fn now_unix_secs(&self) -> u64 {
        (self.clock)()
    }

    fn load_index_map(&self, path: &Path) -> Result<MetadataIndexMap, KeychainError> {
        let Some(raw) = read_bounded_regular_file(path, MAX_KEYCHAIN_INDEX_BYTES)? else {
            return Ok(BTreeMap::new());
        };
        let parsed: PersistedMetadataIndex =
            serde_json::from_str(&raw).map_err(|_| KeychainError::BackendFailure)?;
        if parsed.version != 1 {
            return Err(KeychainError::BackendFailure);
        }
        let mut out = BTreeMap::new();
        for item in parsed.entries {
            let kind = KeychainSecretKind::parse(&item.secret_kind)?;
            let meta = KeychainSessionMetadata::validate(
                kind,
                &item.organisation_id,
                &item.matrix_user_id,
                &item.device_id,
                item.issued_at_unix_secs,
                item.expires_at_unix_secs,
            )?;
            out.insert(
                (
                    meta.slot.service_name.clone(),
                    meta.slot.account_name.clone(),
                ),
                meta,
            );
        }
        Ok(out)
    }

    fn save_index_map(&self, path: &Path, map: &MetadataIndexMap) -> Result<(), KeychainError> {
        let index = PersistedMetadataIndex {
            version: 1,
            entries: map
                .values()
                .map(|m| PersistedMetadataRecord {
                    secret_kind: m.slot.secret_kind.as_slug().to_owned(),
                    organisation_id: m.organisation_id.clone(),
                    matrix_user_id: m.matrix_user_id.clone(),
                    device_id: m.device_id.clone(),
                    issued_at_unix_secs: m.issued_at_unix_secs,
                    expires_at_unix_secs: m.expires_at_unix_secs,
                })
                .collect(),
        };
        let serialized = serde_json::to_vec(&index).map_err(|_| KeychainError::BackendFailure)?;
        write_atomic_0600(path, &serialized)
    }

    fn purge_expired_entries(
        &self,
        path: &Path,
        map: &mut MetadataIndexMap,
        now_secs: u64,
    ) -> Result<(), KeychainError> {
        let expired_slots: Vec<KeychainSlotDescriptor> = map
            .values()
            .filter(|m| m.is_expired(now_secs))
            .map(|m| m.slot.clone())
            .collect();
        if expired_slots.is_empty() {
            return Ok(());
        }
        let mut removed_any = false;
        for slot in &expired_slots {
            if self.delete_from_os(slot).is_ok() {
                map.remove(&(slot.service_name.clone(), slot.account_name.clone()));
                removed_any = true;
            }
        }
        if removed_any {
            self.save_index_map(path, map)?;
        }
        Ok(())
    }

    fn store_in_os(
        &self,
        slot: &KeychainSlotDescriptor,
        secret: &RedactedSessionSecret,
    ) -> Result<OsStoreAttempt, KeychainError> {
        if self.platform == OsKeychainPlatform::LinuxSecretTool && !self.linux_dbus_available {
            return Ok(OsStoreAttempt::HeadlessFallback);
        }
        let spec = OsKeychainCommandSpec::build_store(self.platform, slot)?;
        let stdin_buf: Zeroizing<Vec<u8>> = match self.platform {
            OsKeychainPlatform::MacOsSecurity => {
                format_macos_security_interactive_store_line(slot, secret)?
            }
            OsKeychainPlatform::LinuxSecretTool => {
                Zeroizing::new(secret.expose_for_keychain_write().as_bytes().to_vec())
            }
            OsKeychainPlatform::WindowsPasswordVault => {
                format_windows_vault_stdin_line("store", slot, Some(secret))?
            }
        };
        let out = self
            .runner
            .run_piped(&spec.program, &spec.args, Some(&stdin_buf))?;
        if out.timed_out {
            return Err(KeychainError::BackendTimeout);
        }
        if out.missing_program {
            if self.platform == OsKeychainPlatform::LinuxSecretTool {
                return Ok(OsStoreAttempt::HeadlessFallback);
            }
            return Err(KeychainError::BackendUnavailable);
        }
        if out.status_code == Some(0) {
            return Ok(OsStoreAttempt::NativeStored);
        }
        if self.platform == OsKeychainPlatform::LinuxSecretTool {
            return Ok(OsStoreAttempt::HeadlessFallback);
        }
        Err(KeychainError::BackendFailure)
    }

    fn lookup_from_os(
        &self,
        slot: &KeychainSlotDescriptor,
    ) -> Result<OsLookupOutcome, KeychainError> {
        if self.platform == OsKeychainPlatform::LinuxSecretTool && !self.linux_dbus_available {
            return Ok(OsLookupOutcome::Unavailable(
                KeychainError::BackendUnavailable,
            ));
        }
        let spec = OsKeychainCommandSpec::build_lookup(self.platform, slot)?;
        let win_stdin = if self.platform == OsKeychainPlatform::WindowsPasswordVault {
            Some(format_windows_vault_stdin_line("lookup", slot, None)?)
        } else {
            None
        };
        let out = self.runner.run_piped(
            &spec.program,
            &spec.args,
            win_stdin.as_ref().map(|b| b.as_slice()),
        )?;
        if out.timed_out {
            return Ok(OsLookupOutcome::Unavailable(KeychainError::BackendTimeout));
        }
        if out.missing_program {
            return Ok(OsLookupOutcome::Unavailable(
                KeychainError::BackendUnavailable,
            ));
        }
        match (self.platform, out.status_code) {
            (_, Some(0)) => {
                let raw_str =
                    core::str::from_utf8(&out.stdout).map_err(|_| KeychainError::BackendFailure)?;
                let trimmed = raw_str.trim_end_matches(['\r', '\n']);
                if trimmed.is_empty() {
                    if self.platform == OsKeychainPlatform::LinuxSecretTool && out.stderr_has_bytes
                    {
                        return Ok(OsLookupOutcome::Unavailable(
                            KeychainError::BackendUnavailable,
                        ));
                    }
                    return Ok(OsLookupOutcome::ConfirmedAbsent);
                }
                RedactedSessionSecret::new(trimmed).map(OsLookupOutcome::Found)
            }
            (OsKeychainPlatform::MacOsSecurity, Some(44))
            | (OsKeychainPlatform::WindowsPasswordVault, Some(44)) => {
                Ok(OsLookupOutcome::ConfirmedAbsent)
            }
            (OsKeychainPlatform::LinuxSecretTool, Some(1))
                if out.stdout.is_empty() && !out.stderr_has_bytes =>
            {
                Ok(OsLookupOutcome::ConfirmedAbsent)
            }
            (OsKeychainPlatform::LinuxSecretTool, _) => Ok(OsLookupOutcome::Unavailable(
                KeychainError::BackendUnavailable,
            )),
            _ => Ok(OsLookupOutcome::Unavailable(KeychainError::BackendFailure)),
        }
    }

    fn delete_from_os(
        &self,
        slot: &KeychainSlotDescriptor,
    ) -> Result<OsDeleteOutcome, KeychainError> {
        if self.platform == OsKeychainPlatform::LinuxSecretTool && !self.linux_dbus_available {
            return Err(KeychainError::BackendUnavailable);
        }
        let spec = OsKeychainCommandSpec::build_delete(self.platform, slot)?;
        let win_stdin = if self.platform == OsKeychainPlatform::WindowsPasswordVault {
            Some(format_windows_vault_stdin_line("delete", slot, None)?)
        } else {
            None
        };
        let out = self.runner.run_piped(
            &spec.program,
            &spec.args,
            win_stdin.as_ref().map(|b| b.as_slice()),
        )?;
        if out.timed_out {
            return Err(KeychainError::BackendTimeout);
        }
        if out.missing_program {
            return Err(KeychainError::BackendUnavailable);
        }
        match (self.platform, out.status_code) {
            (OsKeychainPlatform::LinuxSecretTool, Some(0)) if !out.stderr_has_bytes => {
                Ok(OsDeleteOutcome::Deleted)
            }
            (OsKeychainPlatform::LinuxSecretTool, Some(1))
                if out.stdout.is_empty() && !out.stderr_has_bytes =>
            {
                Ok(OsDeleteOutcome::ConfirmedAbsent)
            }
            (OsKeychainPlatform::LinuxSecretTool, _) => Err(KeychainError::BackendFailure),
            (_, Some(0)) => Ok(OsDeleteOutcome::Deleted),
            (OsKeychainPlatform::MacOsSecurity, Some(44))
            | (OsKeychainPlatform::WindowsPasswordVault, Some(44)) => {
                Ok(OsDeleteOutcome::ConfirmedAbsent)
            }
            _ => Err(KeychainError::BackendFailure),
        }
    }
}

impl KeychainBackend for OsNativeKeychainBackend {
    fn store(
        &self,
        metadata: &KeychainSessionMetadata,
        secret: &RedactedSessionSecret,
    ) -> Result<KeychainPersistence, KeychainError> {
        if metadata_exposes_secret(metadata, secret.expose_for_keychain_write()) {
            return Err(KeychainError::SecretLeakedInMetadata);
        }
        let Some(ref index_path) = self.index_path else {
            return self.fallback.store(metadata, secret);
        };
        let _guard = self
            .io_lock
            .lock()
            .map_err(|_| KeychainError::BackendFailure)?;
        let now = self.now_unix_secs();
        let mut index_map = self.load_index_map(index_path)?;
        self.purge_expired_entries(index_path, &mut index_map, now)?;

        let key = (
            metadata.slot.service_name.clone(),
            metadata.slot.account_name.clone(),
        );
        if !index_map.contains_key(&key) {
            let org_count = index_map
                .values()
                .filter(|m| m.organisation_id == metadata.organisation_id)
                .count();
            if org_count >= MAX_KEYCHAIN_SLOTS_PER_ORG {
                return Err(KeychainError::CapacityExceeded);
            }
        }

        match self.store_in_os(&metadata.slot, secret)? {
            OsStoreAttempt::NativeStored => {
                let _ = self.fallback.delete(&metadata.slot);
                index_map.insert(key, metadata.clone());
                self.save_index_map(index_path, &index_map)?;
                Ok(KeychainPersistence::NativeOsKeychain)
            }
            OsStoreAttempt::HeadlessFallback => self.fallback.store(metadata, secret),
        }
    }

    fn load_status(
        &self,
        slot: &KeychainSlotDescriptor,
    ) -> Result<KeychainCredentialStatus, KeychainError> {
        validate_keychain_service_id(&slot.service_name)?;
        validate_keychain_account_id(&slot.account_name)?;
        let Some(ref index_path) = self.index_path else {
            return self.fallback.load_status(slot);
        };
        let _guard = self
            .io_lock
            .lock()
            .map_err(|_| KeychainError::BackendFailure)?;
        let now = self.now_unix_secs();
        let mut index_map = self.load_index_map(index_path)?;
        self.purge_expired_entries(index_path, &mut index_map, now)?;

        let key = (slot.service_name.clone(), slot.account_name.clone());
        if let Some(meta) = index_map.get(&key).cloned() {
            if meta.is_expired(now) {
                return Ok(KeychainCredentialStatus {
                    slot: slot.clone(),
                    present: false,
                    native_keychain: false,
                    metadata: None,
                });
            }
            match self.lookup_from_os(slot)? {
                OsLookupOutcome::Found(secret) => {
                    if metadata_exposes_secret(&meta, secret.expose_for_keychain_write()) {
                        if self.delete_from_os(slot).is_ok() {
                            index_map.remove(&key);
                            self.save_index_map(index_path, &index_map)?;
                        }
                        return Err(KeychainError::SecretLeakedInMetadata);
                    }
                    return Ok(KeychainCredentialStatus {
                        slot: slot.clone(),
                        present: true,
                        native_keychain: true,
                        metadata: Some(meta),
                    });
                }
                OsLookupOutcome::ConfirmedAbsent => {
                    index_map.remove(&key);
                    self.save_index_map(index_path, &index_map)?;
                }
                OsLookupOutcome::Unavailable(err) => {
                    return Err(err);
                }
            }
        }
        self.fallback.load_status(slot)
    }

    fn load_secret(
        &self,
        slot: &KeychainSlotDescriptor,
    ) -> Result<Option<(KeychainSessionMetadata, RedactedSessionSecret)>, KeychainError> {
        validate_keychain_service_id(&slot.service_name)?;
        validate_keychain_account_id(&slot.account_name)?;
        let Some(ref index_path) = self.index_path else {
            return self.fallback.load_secret(slot);
        };
        let _guard = self
            .io_lock
            .lock()
            .map_err(|_| KeychainError::BackendFailure)?;
        let now = self.now_unix_secs();
        let mut index_map = self.load_index_map(index_path)?;
        self.purge_expired_entries(index_path, &mut index_map, now)?;

        let key = (slot.service_name.clone(), slot.account_name.clone());
        if let Some(meta) = index_map.get(&key).cloned() {
            if meta.is_expired(now) {
                return Ok(None);
            }
            match self.lookup_from_os(slot)? {
                OsLookupOutcome::Found(secret) => {
                    if metadata_exposes_secret(&meta, secret.expose_for_keychain_write()) {
                        if self.delete_from_os(slot).is_ok() {
                            index_map.remove(&key);
                            self.save_index_map(index_path, &index_map)?;
                        }
                        return Err(KeychainError::SecretLeakedInMetadata);
                    }
                    return Ok(Some((meta, secret)));
                }
                OsLookupOutcome::ConfirmedAbsent => {
                    index_map.remove(&key);
                    self.save_index_map(index_path, &index_map)?;
                }
                OsLookupOutcome::Unavailable(err) => {
                    return Err(err);
                }
            }
        }
        self.fallback.load_secret(slot)
    }

    fn delete(
        &self,
        slot: &KeychainSlotDescriptor,
    ) -> Result<KeychainCredentialStatus, KeychainError> {
        validate_keychain_service_id(&slot.service_name)?;
        validate_keychain_account_id(&slot.account_name)?;
        let fallback_deleted = self.fallback.delete(slot)?;
        let Some(ref index_path) = self.index_path else {
            return Ok(fallback_deleted);
        };
        let _guard = self
            .io_lock
            .lock()
            .map_err(|_| KeychainError::BackendFailure)?;
        let mut index_map = self.load_index_map(index_path)?;
        let key = (slot.service_name.clone(), slot.account_name.clone());
        let in_index = index_map.contains_key(&key);

        match self.delete_from_os(slot) {
            Ok(outcome) => {
                let had_os = matches!(outcome, OsDeleteOutcome::Deleted);
                if in_index {
                    index_map.remove(&key);
                    self.save_index_map(index_path, &index_map)?;
                }
                let native_existed = in_index || had_os;
                Ok(KeychainCredentialStatus {
                    slot: slot.clone(),
                    present: native_existed || fallback_deleted.present,
                    native_keychain: native_existed,
                    metadata: None,
                })
            }
            Err(err) => {
                if !in_index
                    && self.platform == OsKeychainPlatform::LinuxSecretTool
                    && matches!(err, KeychainError::BackendUnavailable)
                {
                    return Ok(fallback_deleted);
                }
                Err(err)
            }
        }
    }

    fn clear_organisation(&self, organisation_id: &str) -> Result<usize, KeychainError> {
        let org = OrganisationId::parse(organisation_id)
            .map_err(|_| KeychainError::InvalidOrganisation)?;
        let target = org.as_str();
        let fallback_count = self.fallback.clear_organisation(target)?;
        let Some(ref index_path) = self.index_path else {
            return Ok(fallback_count);
        };
        let _guard = self
            .io_lock
            .lock()
            .map_err(|_| KeychainError::BackendFailure)?;
        let mut index_map = self.load_index_map(index_path)?;
        let matching_slots: Vec<KeychainSlotDescriptor> = index_map
            .values()
            .filter(|m| m.organisation_id == target)
            .map(|m| m.slot.clone())
            .collect();
        if matching_slots.is_empty() {
            return Ok(fallback_count);
        }
        let mut removed_count = 0usize;
        let mut first_err: Option<KeychainError> = None;
        for slot in &matching_slots {
            match self.delete_from_os(slot) {
                Ok(_) => {
                    index_map.remove(&(slot.service_name.clone(), slot.account_name.clone()));
                    removed_count += 1;
                }
                Err(err) => {
                    if first_err.is_none() {
                        first_err = Some(err);
                    }
                }
            }
        }
        if removed_count > 0 {
            self.save_index_map(index_path, &index_map)?;
        }
        if let Some(err) = first_err {
            return Err(err);
        }
        Ok(removed_count.max(fallback_count))
    }

    fn clear_ephemeral_cache(&self) {
        self.fallback.clear_ephemeral_cache();
    }
}

/// Debug-only file-backed test vault (`KODERA_DESKTOP_DEBUG_KEYCHAIN_VAULT`) used strictly for
/// cross-process `--ipc-stdio` integration verification without touching the host OS login keychain.
/// Compiled completely out of `--release` builds.
#[cfg(any(debug_assertions, test))]
pub(crate) struct DebugVaultKeychainBackend {
    vault_path: PathBuf,
    io_lock: Mutex<()>,
}

#[cfg(any(debug_assertions, test))]
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct DebugVaultFile {
    version: u8,
    entries: Vec<DebugVaultEntry>,
}

#[cfg(any(debug_assertions, test))]
#[derive(serde::Serialize, serde::Deserialize)]
struct DebugVaultEntry {
    secret_kind: String,
    organisation_id: String,
    matrix_user_id: String,
    device_id: String,
    issued_at_unix_secs: u64,
    expires_at_unix_secs: Option<u64>,
    secret: String,
}

#[cfg(any(debug_assertions, test))]
impl Drop for DebugVaultEntry {
    fn drop(&mut self) {
        zeroize::Zeroize::zeroize(&mut self.secret);
    }
}

#[cfg(any(debug_assertions, test))]
type DebugVaultMap = BTreeMap<(String, String), (KeychainSessionMetadata, RedactedSessionSecret)>;

#[cfg(any(debug_assertions, test))]
impl DebugVaultKeychainBackend {
    pub(crate) fn new(vault_path: PathBuf) -> Self {
        Self {
            vault_path,
            io_lock: Mutex::new(()),
        }
    }

    fn load_entries(&self) -> Result<DebugVaultMap, KeychainError> {
        let Some(raw) = read_bounded_regular_file(&self.vault_path, MAX_KEYCHAIN_INDEX_BYTES)?
        else {
            return Ok(BTreeMap::new());
        };
        let parsed: DebugVaultFile =
            serde_json::from_str(&raw).map_err(|_| KeychainError::BackendFailure)?;
        if parsed.version != 1 {
            return Err(KeychainError::BackendFailure);
        }
        let mut out = BTreeMap::new();
        for item in parsed.entries {
            let kind = KeychainSecretKind::parse(&item.secret_kind)?;
            let (meta, wrapped) = KeychainSessionMetadata::validate_with_secret(
                kind,
                &item.organisation_id,
                &item.matrix_user_id,
                &item.device_id,
                item.issued_at_unix_secs,
                item.expires_at_unix_secs,
                Some(&item.secret),
            )?;
            if let Some(secret) = wrapped {
                out.insert(
                    (
                        meta.slot.service_name.clone(),
                        meta.slot.account_name.clone(),
                    ),
                    (meta, secret),
                );
            }
        }
        Ok(out)
    }

    fn save_entries(&self, map: &DebugVaultMap) -> Result<(), KeychainError> {
        let vault = DebugVaultFile {
            version: 1,
            entries: map
                .values()
                .map(|(m, s)| DebugVaultEntry {
                    secret_kind: m.slot.secret_kind.as_slug().to_owned(),
                    organisation_id: m.organisation_id.clone(),
                    matrix_user_id: m.matrix_user_id.clone(),
                    device_id: m.device_id.clone(),
                    issued_at_unix_secs: m.issued_at_unix_secs,
                    expires_at_unix_secs: m.expires_at_unix_secs,
                    secret: s.expose_for_keychain_write().to_owned(),
                })
                .collect(),
        };
        let serialized =
            Zeroizing::new(serde_json::to_vec(&vault).map_err(|_| KeychainError::BackendFailure)?);
        write_atomic_0600(&self.vault_path, &serialized)
    }
}

#[cfg(any(debug_assertions, test))]
impl KeychainBackend for DebugVaultKeychainBackend {
    fn store(
        &self,
        metadata: &KeychainSessionMetadata,
        secret: &RedactedSessionSecret,
    ) -> Result<KeychainPersistence, KeychainError> {
        if metadata_exposes_secret(metadata, secret.expose_for_keychain_write()) {
            return Err(KeychainError::SecretLeakedInMetadata);
        }
        let _guard = self
            .io_lock
            .lock()
            .map_err(|_| KeychainError::BackendFailure)?;
        let now = kodera_rs::system_unix_secs();
        let mut entries = self.load_entries()?;
        entries.retain(|_, (m, s)| {
            if m.is_expired(now) {
                s.clear();
                false
            } else {
                true
            }
        });
        let key = (
            metadata.slot.service_name.clone(),
            metadata.slot.account_name.clone(),
        );
        if !entries.contains_key(&key) {
            let org_count = entries
                .values()
                .filter(|(m, _)| m.organisation_id == metadata.organisation_id)
                .count();
            if org_count >= MAX_KEYCHAIN_SLOTS_PER_ORG {
                return Err(KeychainError::CapacityExceeded);
            }
        }
        if let Some((_, mut prev)) = entries.insert(key, (metadata.clone(), secret.clone())) {
            prev.clear();
        }
        self.save_entries(&entries)?;
        Ok(KeychainPersistence::NativeOsKeychain)
    }

    fn load_status(
        &self,
        slot: &KeychainSlotDescriptor,
    ) -> Result<KeychainCredentialStatus, KeychainError> {
        validate_keychain_service_id(&slot.service_name)?;
        validate_keychain_account_id(&slot.account_name)?;
        let _guard = self
            .io_lock
            .lock()
            .map_err(|_| KeychainError::BackendFailure)?;
        let now = kodera_rs::system_unix_secs();
        let mut entries = self.load_entries()?;
        let before_len = entries.len();
        entries.retain(|_, (m, s)| {
            if m.is_expired(now) {
                s.clear();
                false
            } else {
                true
            }
        });
        if entries.len() != before_len {
            self.save_entries(&entries)?;
        }
        let key = (slot.service_name.clone(), slot.account_name.clone());
        let metadata = entries.get(&key).map(|(m, _)| m.clone());
        let present = metadata.is_some();
        Ok(KeychainCredentialStatus {
            slot: slot.clone(),
            present,
            native_keychain: present,
            metadata,
        })
    }

    fn load_secret(
        &self,
        slot: &KeychainSlotDescriptor,
    ) -> Result<Option<(KeychainSessionMetadata, RedactedSessionSecret)>, KeychainError> {
        validate_keychain_service_id(&slot.service_name)?;
        validate_keychain_account_id(&slot.account_name)?;
        let _guard = self
            .io_lock
            .lock()
            .map_err(|_| KeychainError::BackendFailure)?;
        let now = kodera_rs::system_unix_secs();
        let mut entries = self.load_entries()?;
        let before_len = entries.len();
        entries.retain(|_, (m, s)| {
            if m.is_expired(now) {
                s.clear();
                false
            } else {
                true
            }
        });
        if entries.len() != before_len {
            self.save_entries(&entries)?;
        }
        let key = (slot.service_name.clone(), slot.account_name.clone());
        Ok(entries.get(&key).cloned())
    }

    fn delete(
        &self,
        slot: &KeychainSlotDescriptor,
    ) -> Result<KeychainCredentialStatus, KeychainError> {
        validate_keychain_service_id(&slot.service_name)?;
        validate_keychain_account_id(&slot.account_name)?;
        let _guard = self
            .io_lock
            .lock()
            .map_err(|_| KeychainError::BackendFailure)?;
        let mut entries = self.load_entries()?;
        let key = (slot.service_name.clone(), slot.account_name.clone());
        let existed = if let Some((_, mut s)) = entries.remove(&key) {
            s.clear();
            self.save_entries(&entries)?;
            true
        } else {
            false
        };
        Ok(KeychainCredentialStatus {
            slot: slot.clone(),
            present: existed,
            native_keychain: existed,
            metadata: None,
        })
    }

    fn clear_organisation(&self, organisation_id: &str) -> Result<usize, KeychainError> {
        let org = OrganisationId::parse(organisation_id)
            .map_err(|_| KeychainError::InvalidOrganisation)?;
        let target = org.as_str();
        let _guard = self
            .io_lock
            .lock()
            .map_err(|_| KeychainError::BackendFailure)?;
        let mut entries = self.load_entries()?;
        let keys: Vec<(String, String)> = entries
            .iter()
            .filter(|(_, (m, _))| m.organisation_id == target)
            .map(|(k, _)| k.clone())
            .collect();
        let count = keys.len();
        if count > 0 {
            for key in keys {
                if let Some((_, mut s)) = entries.remove(&key) {
                    s.clear();
                }
            }
            self.save_entries(&entries)?;
        }
        Ok(count)
    }
}
