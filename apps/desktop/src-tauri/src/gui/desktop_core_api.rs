//! Bounded Core HTTP transport, dispatched on the existing native IPC worker thread.
//! The destination policy mirrors the packaged CSP; callers cannot choose a new origin.
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use zeroize::{Zeroize, Zeroizing};

pub(super) const MAX_REQUEST_BODY: usize = 1_048_576;
pub(super) const MAX_CORE_ENVELOPE: usize = 1_572_864;
pub(super) const MAX_IN_FLIGHT_CORE_REQUESTS: usize = 8;
pub(super) const MAX_BODY: usize = 2 * 1024 * 1024;
const MAX_HEADERS: usize = 32 * 1024;
const ERROR: &str = "core_api_refused";

// Explicit Core metadata mirrors the server's Access-Control-Expose-Headers policy.
const EXPOSED_CORE_HEADERS: &[&str] = &[
    "etag",
    "idempotency-replayed",
    "location",
    "ratelimit-limit",
    "ratelimit-remaining",
    "ratelimit-reset",
    "retry-after",
    "www-authenticate",
    "x-job-id",
    "x-kodera-next-backup-epoch",
    "x-request-id",
];

// Browser-default response metadata is admitted separately from explicit Core exposure.
const CORS_SAFELISTED_RESPONSE_HEADERS: &[&str] = &[
    "cache-control",
    "content-language",
    "content-length",
    "content-type",
    "last-modified",
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CoreRequest {
    // The bridge adds this envelope field, rather than trusting the caller's command.
    command: String,
    #[serde(rename = "requestId")]
    pub(super) request_id: String,
    url: String,
    method: String,
    headers: BTreeMap<String, String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default, rename = "bodyBase64")]
    body_base64: Option<String>,
}

// Reservations exist before workers start, so aborts cannot race child registration.
type RequestKey = (String, u64, String);
type ActiveRequests = Arc<Mutex<BTreeMap<RequestKey, Arc<Mutex<Transfer>>>>>;
#[derive(Default)]
struct Transfer {
    cancelled: bool,
    child: Option<Child>,
}
#[derive(Clone, Default)]
pub(super) struct CoreRequests(ActiveRequests, Arc<AtomicU64>);
pub(super) struct CoreRequestGuard {
    requests: CoreRequests,
    key: RequestKey,
    transfer: Arc<Mutex<Transfer>>,
    epoch: u64,
}
impl CoreRequests {
    pub(super) fn reserve(
        &self,
        document: &str,
        generation: u64,
        id: &str,
    ) -> Result<CoreRequestGuard, String> {
        let mut active = self.0.lock().map_err(|_| ERROR)?;
        let key = (document.to_owned(), generation, id.to_owned());
        if active.len() >= MAX_IN_FLIGHT_CORE_REQUESTS {
            return Err("core_api_busy".into());
        }
        if active.contains_key(&key) {
            return Err(ERROR.into());
        }
        let transfer = Arc::new(Mutex::new(Transfer::default()));
        active.insert(key.clone(), transfer.clone());
        Ok(CoreRequestGuard {
            requests: self.clone(),
            key,
            transfer,
            epoch: self.epoch(),
        })
    }
    pub(super) fn abort(&self, document: &str, generation: u64, id: &str) {
        if let Ok(active) = self.0.lock() {
            if let Some(transfer) = active.get(&(document.to_owned(), generation, id.to_owned())) {
                cancel_transfer(transfer);
            }
        }
    }
    pub(super) fn epoch(&self) -> u64 {
        self.1.load(Ordering::SeqCst)
    }
    pub(super) fn abort_all(&self) {
        if let Ok(active) = self.0.lock() {
            self.1.fetch_add(1, Ordering::SeqCst);
            for transfer in active.values() {
                cancel_transfer(transfer);
            }
        }
    }
}
fn cancel_transfer(transfer: &Mutex<Transfer>) {
    if let Ok(mut state) = transfer.lock() {
        state.cancelled = true;
        if let Some(child) = state.child.as_mut() {
            let _ = child.kill();
        }
    }
}
impl CoreRequestGuard {
    // Lock order is always active requests, then transfer. Retirement cannot advance
    // the epoch between this final check and child registration (including spawn).
    fn register<T>(
        &self,
        register: impl FnOnce(&mut Transfer) -> Result<T, String>,
    ) -> Result<T, String> {
        let _active = self.requests.0.lock().map_err(|_| ERROR)?;
        let mut state = self.transfer.lock().map_err(|_| ERROR)?;
        if state.cancelled || !self.is_current() {
            return Err("core_api_aborted".into());
        }
        register(&mut state)
    }
    pub(super) fn is_current(&self) -> bool {
        self.epoch == self.requests.epoch()
    }
}
// Reap before response-header file cleanup, including write/read failures on Windows.
struct TransferCleanup<'a>(&'a CoreRequestGuard);
impl Drop for TransferCleanup<'_> {
    fn drop(&mut self) {
        cancel_transfer(&self.0.transfer);
        if let Ok(mut state) = self.0.transfer.lock() {
            if let Some(mut child) = state.child.take() {
                let _ = child.wait();
            }
        }
    }
}
impl Drop for CoreRequestGuard {
    fn drop(&mut self) {
        drop(TransferCleanup(self));
        if let Ok(mut active) = self.requests.0.lock() {
            active.remove(&self.key);
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CoreAbort {
    command: String,
    #[serde(rename = "requestId")]
    pub(super) request_id: String,
}
impl CoreAbort {
    pub(super) fn validate(&self) -> bool {
        self.command == "desktop_core_api_abort" && valid_request_id(&self.request_id)
    }
}
pub(super) fn valid_request_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(super) fn core_origin() -> Result<&'static str, String> {
    crate::csp_policy::APPROVED_CONNECT_SOURCES[1]
        .strip_suffix("/api/v1/")
        .ok_or_else(|| ERROR.into())
}
pub(super) fn execute(raw: &str, guard: &CoreRequestGuard) -> Result<Value, String> {
    execute_reserved(raw, core_origin()?, guard)
}

// Standard RFC 4648 alphabet; decoding rejects noncanonical padding and trailing bits.
const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
pub(super) fn encode_base64(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let bits = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            encoded.push(if i > chunk.len() {
                '='
            } else {
                BASE64[((bits >> (18 - 6 * i)) & 63) as usize] as char
            });
        }
    }
    encoded
}
pub(super) fn decode_base64(value: &str) -> Result<Vec<u8>, String> {
    if value.len() > MAX_REQUEST_BODY.div_ceil(3) * 4 || value.len() % 4 != 0 {
        return Err(ERROR.into());
    }
    let mut bytes = Vec::with_capacity(value.len() / 4 * 3);
    for (index, chunk) in value.as_bytes().chunks_exact(4).enumerate() {
        let mut bits = 0u32;
        let padding = chunk.iter().rev().take_while(|&&b| b == b'=').count();
        if padding > 2 || (padding > 0 && (index + 1) * 4 != value.len()) {
            return Err(ERROR.into());
        }
        for (i, &b) in chunk.iter().enumerate() {
            let digit = if i >= 4 - padding {
                0
            } else {
                BASE64.iter().position(|&c| c == b).ok_or(ERROR)? as u32
            };
            bits = (bits << 6) | digit;
        }
        if (padding == 1 && bits & 255 != 0) || (padding == 2 && bits & 65535 != 0) {
            return Err(ERROR.into());
        }
        bytes.extend_from_slice(&bits.to_be_bytes()[1..4 - padding]);
    }
    if bytes.len() > MAX_REQUEST_BODY {
        return Err(ERROR.into());
    }
    Ok(bytes)
}
impl Drop for CoreRequest {
    fn drop(&mut self) {
        for value in self.headers.values_mut() {
            value.zeroize();
        }
        self.body.zeroize();
        self.body_base64.zeroize();
    }
}

fn allowed_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization"
            | "content-type"
            | "accept"
            | "accept-language"
            | "if-match"
            | "if-none-match"
            | "idempotency-key"
            | "x-request-id"
    )
}

impl CoreRequest {
    pub(super) fn validate(&self, origin: &str) -> Result<(), String> {
        let valid_scheme = origin.starts_with("https://")
            || (cfg!(test) && origin.starts_with("http://127.0.0.1:"));
        let path = self.url.strip_prefix(origin).ok_or(ERROR)?;
        if self.command != "desktop_core_api_request"
            || !valid_request_id(&self.request_id)
            || !valid_scheme
            || self.url.len() > 2048
            || !path.starts_with("/api/v1/")
            || !self.url.is_ascii()
            || self
                .url
                .bytes()
                .any(|b| b <= 0x20 || b >= 0x7f || matches!(b, b'\\' | b'#' | b'@' | b'"'))
            || !matches!(
                self.method.as_str(),
                "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
            )
            || self
                .body
                .as_ref()
                .is_some_and(|b| b.len() > MAX_REQUEST_BODY)
            || (matches!(self.method.as_str(), "GET" | "HEAD")
                && (self.body.is_some() || self.body_base64.is_some()))
            || (self.body.is_some() && self.body_base64.is_some())
            || self.headers.len() > 8
        {
            return Err(ERROR.into());
        }
        if self
            .body_base64
            .as_ref()
            .is_some_and(|body| body.len() > MAX_REQUEST_BODY.div_ceil(3) * 4)
        {
            return Err(ERROR.into());
        }
        // Refuse encoded separators, recursive encoding and dot segments before curl can normalize.
        let route = path.split('?').next().unwrap_or("").to_ascii_lowercase();
        if ["%2e", "%2f", "%5c", "%25"]
            .iter()
            .any(|part| route.contains(part))
            || route.split('/').any(|part| matches!(part, "." | ".."))
        {
            return Err(ERROR.into());
        }
        let mut seen = std::collections::BTreeSet::new();
        for (name, value) in &self.headers {
            if !allowed_header(name)
                || !seen.insert(name.to_ascii_lowercase())
                || value.len() > 8192
                || !value.is_ascii()
                || value.bytes().any(|b| b < 0x20 || b == 0x7f)
            {
                return Err(ERROR.into());
            }
        }
        Ok(())
    }
}

// curl config quoting keeps bearer headers and bodies off process arguments and the filesystem.
fn quoted(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
            .replace('\t', "\\t")
            .replace('\0', "\\0")
    )
}

#[cfg(test)]
pub(super) fn execute_at_origin(raw: &str, origin: &str) -> Result<Value, String> {
    let request: CoreRequest = serde_json::from_str(raw).map_err(|_| ERROR)?;
    let guard = CoreRequests::default().reserve("test", 0, &request.request_id)?;
    execute_reserved(raw, origin, &guard)
}

fn sanitize_child_environment(command: &mut Command) {
    command.env_clear();
    if let Some(value) = std::env::var_os("PATH") {
        command.env("PATH", value);
    }
    #[cfg(windows)]
    for name in ["SYSTEMROOT", "SystemDrive"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
}

// Each request owns a private directory and an exclusively created header file.
// File handles are closed before removal on Windows as well as Unix.
struct ResponseHeaders {
    directory: PathBuf,
    path: PathBuf,
    file: Option<File>,
}
impl ResponseHeaders {
    fn create() -> Result<Self, String> {
        let mut entropy = [0u8; 32];
        getrandom::fill(&mut entropy).map_err(|_| ERROR)?;
        let name: String = entropy.iter().map(|b| format!("{b:02x}")).collect();
        let directory = std::env::temp_dir().join(format!("kodera-core-{name}"));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&directory).map_err(|_| ERROR)?;
        let mut headers = Self {
            path: directory.join("headers"),
            directory,
            file: None,
        };
        let mut options = OpenOptions::new();
        options.write(true).read(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        headers.file = Some(options.open(&headers.path).map_err(|_| ERROR)?);
        Ok(headers)
    }
    fn read(&mut self) -> Result<Vec<u8>, String> {
        let mut bytes = Vec::new();
        self.file
            .as_mut()
            .ok_or(ERROR)?
            .take((MAX_HEADERS + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| ERROR)?;
        if bytes.len() > MAX_HEADERS {
            return Err(ERROR.into());
        }
        Ok(bytes)
    }
}
impl Drop for ResponseHeaders {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_dir(&self.directory);
    }
}

pub(super) fn execute_reserved(
    raw: &str,
    origin: &str,
    guard: &CoreRequestGuard,
) -> Result<Value, String> {
    if !guard.is_current() {
        return Err("core_api_aborted".into());
    }
    let request: CoreRequest = serde_json::from_str(raw).map_err(|_| ERROR)?;
    request.validate(origin)?;
    let mut response_headers = ResponseHeaders::create()?;
    let _transfer_cleanup = TransferCleanup(guard);
    let mut input = Zeroizing::new(format!(
        "url = {}\nrequest = {}\n",
        quoted(&request.url),
        quoted(&request.method)
    ));
    for (name, value) in &request.headers {
        input.push_str(&format!(
            "header = {}\n",
            quoted(&format!("{name}: {value}"))
        ));
    }
    // Suppress Expect and implicit form content types. Cookie headers are never admitted.
    input.push_str("header = \"Expect:\"\n");
    if !request
        .headers
        .keys()
        .any(|name| name.eq_ignore_ascii_case("content-type"))
    {
        input.push_str("header = \"Content-Type:\"\n");
    }
    let body = Zeroizing::new(match &request.body_base64 {
        Some(body) => Some(decode_base64(body)?),
        None => request.body.as_ref().map(|body| body.as_bytes().to_vec()),
    });
    input.push_str(&format!(
        "dump-header = {}\n",
        quoted(response_headers.path.to_str().ok_or(ERROR)?)
    ));
    // This must be the final config option: curl consumes the remaining stdin as
    // raw upload bytes while parsing @-, preserving NULs without files or argv data.
    if body.is_some() {
        input.push_str("data-binary = \"@-\"\n");
    }
    #[cfg(target_os = "windows")]
    let executable = "curl.exe";
    #[cfg(not(target_os = "windows"))]
    let executable = "curl";
    let protocol = if cfg!(test) && origin.starts_with("http://127.0.0.1:") {
        "=http"
    } else {
        "=https"
    };
    // No --location: 3xx responses are returned for refusal, never followed. --disable
    // must be first to ignore user curlrc, and proxies are disabled to avoid ambient routing.
    let mut command = Command::new(executable);
    sanitize_child_environment(&mut command);
    command.arg("--disable");
    if request.method == "HEAD" {
        command.args([
            "--head",
            "--output",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        ]);
    }
    let (mut stdin, stdout) = guard.register(|state| {
        let mut child = command
            .args([
                "--silent",
                "--globoff",
                "--noproxy",
                "*",
                "--proto",
                protocol,
                "--tlsv1.2",
                "--connect-timeout",
                "5",
                "--max-time",
                "15",
                "--max-filesize",
                "2097152",
                "--config",
                "-",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "core_api_transport")?;
        let stdin = child.stdin.take().ok_or("core_api_transport")?;
        let stdout = child.stdout.take().ok_or("core_api_transport")?;
        state.child = Some(child);
        Ok((stdin, stdout))
    })?;
    // Drain pipes off the monitor thread: a stalled upload or stdout read must not
    // prevent checking the cumulative header-file size while curl is still alive.
    let output = std::thread::scope(|scope| -> Result<_, String> {
        let io = std::thread::Builder::new()
            .name("core-pipes".into())
            .spawn_scoped(scope, || -> Result<_, String> {
                stdin
                    .write_all(input.as_bytes())
                    .map_err(|_| "core_api_transport")?;
                if let Some(body) = body.as_ref() {
                    stdin.write_all(body).map_err(|_| "core_api_transport")?;
                }
                drop(stdin);
                let mut output = Zeroizing::new(Vec::new());
                stdout
                    .take((MAX_BODY + 1) as u64)
                    .read_to_end(&mut output)
                    .map_err(|_| "core_api_transport")?;
                if output.len() > MAX_BODY {
                    return Err("core_api_transport".into());
                }
                Ok(output)
            })
            .map_err(|_| "core_api_transport")?;
        let result = wait_for_transfer(guard, &response_headers.path);
        if result.is_err() {
            cancel_transfer(&guard.transfer);
        }
        let output = io.join().map_err(|_| "core_api_transport")?;
        result?;
        output
    })?;
    parse_response(&response_headers.read()?, &output)
}

fn wait_for_transfer(
    guard: &CoreRequestGuard,
    header_path: &std::path::Path,
) -> Result<(), String> {
    loop {
        let mut state = guard.transfer.lock().map_err(|_| ERROR)?;
        if state.cancelled || !guard.is_current() {
            return Err("core_api_aborted".into());
        }
        if std::fs::metadata(header_path).map_err(|_| ERROR)?.len() > MAX_HEADERS as u64 {
            return Err(ERROR.into());
        }
        if let Some(status) = state
            .child
            .as_mut()
            .ok_or(ERROR)?
            .try_wait()
            .map_err(|_| "core_api_transport")?
        {
            return if status.success() {
                Ok(())
            } else {
                Err("core_api_transport".into())
            };
        }
        drop(state);
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

pub(super) fn parse_response(mut output: &[u8], body: &[u8]) -> Result<Value, String> {
    if output.len() > MAX_HEADERS || body.len() > MAX_BODY {
        return Err(ERROR.into());
    }
    let mut consumed = 0;
    loop {
        let end = output
            .windows(4)
            .position(|p| p == b"\r\n\r\n")
            .ok_or(ERROR)?;
        consumed += end + 4;
        if consumed > MAX_HEADERS {
            return Err(ERROR.into());
        }
        let header = std::str::from_utf8(&output[..end]).map_err(|_| ERROR)?;
        let mut lines = header.split("\r\n");
        let mut status_line = lines.next().ok_or(ERROR)?.split_whitespace();
        if !status_line
            .next()
            .is_some_and(|v| matches!(v, "HTTP/1.0" | "HTTP/1.1" | "HTTP/2" | "HTTP/3"))
        {
            return Err(ERROR.into());
        }
        let status: u16 = status_line
            .next()
            .ok_or(ERROR)?
            .parse()
            .map_err(|_| ERROR)?;
        output = &output[end + 4..];
        if (100..200).contains(&status) && status != 101 {
            continue;
        }
        if !(200..=599).contains(&status) || (300..400).contains(&status) && status != 304 {
            return Err(ERROR.into());
        }
        let mut headers = BTreeMap::new();
        for line in lines {
            let (name, value) = line.split_once(':').ok_or(ERROR)?;
            let name = name.to_ascii_lowercase();
            // Mirror browser-readable headers; never Set-Cookie or transport headers.
            if EXPOSED_CORE_HEADERS.contains(&name.as_str())
                || CORS_SAFELISTED_RESPONSE_HEADERS.contains(&name.as_str())
            {
                headers.insert(name, value.trim().to_owned());
            }
        }
        return Ok(json!({"status":status,"headers":headers,"body_base64":encode_base64(body)}));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn exposed_core_headers_exactly_match_server_edge_policy() {
        let edge = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../server/core/api/edge.py"
        ));
        let declaration = edge
            .split_once("EXPOSED_HEADERS = (")
            .unwrap()
            .1
            .split_once("\n)")
            .unwrap()
            .0;
        let server_headers: std::collections::BTreeSet<_> = declaration
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(|line| {
                line.trim_end_matches(',')
                    .trim_matches('"')
                    .to_ascii_lowercase()
            })
            .collect();
        let native_headers: std::collections::BTreeSet<_> = EXPOSED_CORE_HEADERS
            .iter()
            .map(|name| (*name).to_owned())
            .collect();
        assert_eq!(EXPOSED_CORE_HEADERS.len(), 11);
        assert_eq!(server_headers.len(), 11);
        assert_eq!(native_headers, server_headers);
    }

    #[test]
    fn chunked_trailers_never_enter_binary_body_or_exposed_headers() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let binary = b"%PDF-\0\x80\xff\r\nabc";
        assert_eq!(binary.len(), 13);
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = [0; 4096];
            assert!(socket.read(&mut request).unwrap() > 0);
            socket.write_all(b"HTTP/1.1 103 Early Hints\r\nX-Request-Id: interim\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/pdf\r\nTrailer: Content-Type\r\nConnection: close\r\n\r\nd\r\n").unwrap();
            socket.write_all(binary).unwrap();
            socket
                .write_all(b"\r\n0\r\nContent-Type: corrupted\r\n\r\n")
                .unwrap();
        });
        let raw = json!({"command":"desktop_core_api_request", "requestId":"a".repeat(32), "url":format!("{origin}/api/v1/document"), "method":"GET", "headers":{}}).to_string();
        let result = execute_at_origin(&raw, &origin).unwrap();
        let bytes = decode_base64(result["body_base64"].as_str().unwrap()).unwrap();
        assert_eq!(bytes.len(), 13);
        assert_eq!(bytes, binary);
        assert_eq!(result["headers"]["content-type"], "application/pdf");
        assert!(result["headers"].get("x-request-id").is_none());
        server.join().unwrap();
    }

    #[test]
    fn header_files_are_private_unique_and_removed_on_all_drop_paths() {
        let first = ResponseHeaders::create().unwrap();
        let second = ResponseHeaders::create().unwrap();
        assert_ne!(first.path, second.path);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&first.directory)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&first.path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let directory = first.directory.clone();
        let path = first.path.clone();
        let failed: Result<(), String> = {
            let _owned = first;
            Err(ERROR.into())
        };
        assert!(failed.is_err());
        assert!(!path.exists());
        assert!(!directory.exists());
    }

    #[test]
    fn retirement_cancels_pre_spawn_work_and_advances_reply_epoch() {
        let requests = CoreRequests::default();
        let guard = requests.reserve("document", 0, &"a".repeat(32)).unwrap();
        let epoch = requests.epoch();
        requests.abort_all();
        assert_ne!(requests.epoch(), epoch);
        assert!(!guard.is_current());
        let raw = json!({"command":"desktop_core_api_request", "requestId":"a".repeat(32), "url":"http://127.0.0.1:1/api/v1/me", "method":"GET", "headers":{}}).to_string();
        assert_eq!(
            execute_reserved(&raw, "http://127.0.0.1:1", &guard).unwrap_err(),
            "core_api_aborted"
        );
        drop(guard);
        assert!(requests
            .reserve("document", 0, &"a".repeat(32))
            .unwrap()
            .is_current());
    }

    #[test]
    fn base64_is_canonical_and_bounded_for_arbitrary_bytes() {
        for (plain, encoded) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(encode_base64(plain.as_bytes()), encoded);
            assert_eq!(decode_base64(encoded).unwrap(), plain.as_bytes());
        }
        let bytes: Vec<u8> = (0..=255).cycle().take(MAX_REQUEST_BODY).collect();
        assert_eq!(decode_base64(&encode_base64(&bytes)).unwrap(), bytes);
        assert!(decode_base64(&encode_base64(&vec![0; MAX_REQUEST_BODY + 1])).is_err());
        for invalid in [
            "a", "====", "Z===", "Zg=Z", "Zg==Zg==", "Zh==", "Zm9=", "Zm_v", "Zm9v\n",
        ] {
            assert!(decode_base64(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn curl_environment_contains_only_explicit_os_lookup_variables() {
        let mut command = Command::new(if cfg!(windows) { "cmd.exe" } else { "env" });
        for name in [
            "SSLKEYLOGFILE",
            "CURL_CA_BUNDLE",
            "SSL_CERT_FILE",
            "LD_PRELOAD",
            "HTTPS_PROXY",
        ] {
            command.env(name, "synthetic-refused");
        }
        sanitize_child_environment(&mut command);
        let allowed = if cfg!(windows) {
            vec!["PATH", "SYSTEMROOT", "SystemDrive"]
        } else {
            vec!["PATH"]
        };
        assert!(command
            .get_envs()
            .all(|(key, _)| allowed.iter().any(|name| key.eq_ignore_ascii_case(name))));
        #[cfg(not(windows))]
        {
            let output = command.output().unwrap();
            assert!(output.status.success());
            assert!(String::from_utf8(output.stdout)
                .unwrap()
                .lines()
                .all(|line| line.starts_with("PATH=")));
        }
    }

    #[test]
    fn raw_binary_and_maximum_document_body_survive_real_curl() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let body = "🦀".repeat(262_144).into_bytes();
        let binary = b"RIFF\0\0\0\0WEBP\x80\xff\0";
        let expected = body.clone();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut received = Vec::new();
            let mut buffer = [0; 8192];
            loop {
                let count = socket.read(&mut buffer).unwrap();
                assert_ne!(count, 0);
                received.extend_from_slice(&buffer[..count]);
                if let Some(end) = received.windows(4).position(|b| b == b"\r\n\r\n") {
                    if received.len() >= end + 4 + expected.len() {
                        assert_eq!(&received[end + 4..], expected);
                        break;
                    }
                }
            }
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: image/webp\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", binary.len()).as_bytes()).unwrap();
            socket.write_all(binary).unwrap();
        });
        let raw = json!({"command":"desktop_core_api_request", "requestId":"a".repeat(32), "url":format!("{origin}/api/v1/documents"), "method":"PUT", "headers":{}, "bodyBase64":encode_base64(&body)}).to_string();
        assert!(raw.len() < MAX_CORE_ENVELOPE);
        let result = execute_at_origin(&raw, &origin).unwrap();
        assert_eq!(result["body_base64"], encode_base64(binary));
        server.join().unwrap();

        // NULs, high bytes, config-looking lines and file syntax remain literal upload data.
        let bytes = b"\0\x80\xff\nurl = https://refused.test/\n@/not-a-file";
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut received = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let count = socket.read(&mut buffer).unwrap();
                assert_ne!(count, 0);
                received.extend_from_slice(&buffer[..count]);
                if let Some(end) = received.windows(4).position(|b| b == b"\r\n\r\n") {
                    if received.len() >= end + 4 + bytes.len() {
                        assert_eq!(&received[end + 4..], bytes);
                        break;
                    }
                }
            }
            socket
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .unwrap();
        });
        let raw = json!({"command":"desktop_core_api_request", "requestId":"b".repeat(32), "url":format!("{origin}/api/v1/emoji"), "method":"POST", "headers":{}, "bodyBase64":encode_base64(bytes)}).to_string();
        assert_eq!(execute_at_origin(&raw, &origin).unwrap()["status"], 204);
        server.join().unwrap();
    }

    #[test]
    fn exposes_all_core_metadata_including_backup_epoch_on_empty_and_error_responses() {
        let exposed = [
            "content-type",
            "cache-control",
            "content-language",
            "last-modified",
            "etag",
            "idempotency-replayed",
            "location",
            "ratelimit-limit",
            "ratelimit-remaining",
            "ratelimit-reset",
            "retry-after",
            "www-authenticate",
            "x-job-id",
            "x-kodera-next-backup-epoch",
            "x-request-id",
            "content-length",
        ];
        for status in [200, 204, 404, 409] {
            let mut raw = format!("HTTP/1.1 {status} Test\r\n");
            for name in exposed {
                raw.push_str(&format!("{}: 7\r\n", name.to_ascii_uppercase()));
            }
            raw.push_str("Set-Cookie: secret\r\nX-Private: hidden\r\nContent-Disposition: attachment\r\n\r\n");
            let result = parse_response(raw.as_bytes(), b"").unwrap();
            assert_eq!(result["status"], status);
            for name in exposed {
                assert_eq!(result["headers"][name], "7", "{status} {name}");
            }
            assert_eq!(result["headers"].as_object().unwrap().len(), exposed.len());
            assert!(result["headers"].get("content-disposition").is_none());
            assert_eq!(result["body_base64"], "");
        }
    }

    #[test]
    fn registration_serializes_final_epoch_check_with_retirement() {
        let requests = CoreRequests::default();
        let guard = requests.reserve("document", 1, &"a".repeat(32)).unwrap();
        let epoch = requests.epoch();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            guard
                .register(|_| {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    assert!(guard.is_current());
                    Ok(())
                })
                .unwrap();
            guard
        });
        entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        // The same lock used by abort_all must cover the entire spawn/registration closure.
        assert!(matches!(
            requests.0.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        ));
        assert_eq!(requests.epoch(), epoch);
        let retiring = requests.clone();
        let retire = std::thread::spawn(move || retiring.abort_all());
        release_tx.send(()).unwrap();
        let guard = worker.join().unwrap();
        retire.join().unwrap();
        assert_ne!(requests.epoch(), epoch);
        assert_eq!(
            guard
                .register::<()>(|_| panic!("retired worker spawned a child"))
                .unwrap_err(),
            "core_api_aborted"
        );
    }

    #[test]
    fn oversized_headers_kill_curl_while_response_body_is_still_stalled() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut buffer = [0; 4096];
            assert!(socket.read(&mut buffer).unwrap() > 0);
            let mut headers = String::from("HTTP/1.1 200 OK\r\nContent-Length: 1\r\n");
            for _ in 0..40 {
                headers.push_str(&format!("X-Padding: {}\r\n", "p".repeat(1024)));
            }
            headers.push_str("\r\n");
            socket.write_all(headers.as_bytes()).unwrap();
            // Never send the body or close the socket: the live cap must kill curl.
            match socket.read(&mut buffer) {
                Ok(0) => {}
                Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
                other => panic!("curl did not close the stalled response: {other:?}"),
            }
        });
        let raw = json!({"command":"desktop_core_api_request", "requestId":"a".repeat(32), "url":format!("{origin}/api/v1/me"), "method":"GET", "headers":{}}).to_string();
        assert_eq!(execute_at_origin(&raw, &origin).unwrap_err(), ERROR);
        server.join().unwrap();
    }

    #[test]
    fn abort_is_scoped_and_kills_live_transfer_and_pre_spawn_reservation() {
        let requests = CoreRequests::default();
        let id = "a".repeat(32);
        let guard = requests.reserve("document", 1, &id).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (connected_tx, connected_rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut buffer = [0; 4096];
            assert!(socket.read(&mut buffer).unwrap() > 0);
            connected_tx.send(()).unwrap();
            // Killing curl closes the socket before the server ever sends a response.
            assert_eq!(socket.read(&mut buffer).unwrap(), 0);
        });
        let raw = json!({"command":"desktop_core_api_request", "requestId":id, "url":format!("{origin}/api/v1/me"), "method":"GET", "headers":{}}).to_string();
        let (done_tx, done_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            done_tx
                .send(execute_reserved(&raw, &origin, &guard))
                .unwrap();
        });
        connected_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        requests.abort("other-document", 1, &id);
        requests.abort("document", 2, &id);
        requests.abort("document", 1, &"b".repeat(32));
        assert!(matches!(done_rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
        requests.abort_all();
        assert_eq!(
            done_rx
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap_err(),
            "core_api_aborted"
        );
        worker.join().unwrap();
        server.join().unwrap();
        assert!(requests.0.lock().unwrap().is_empty());
        let guard = requests.reserve("document", 1, &id).unwrap();
        requests.abort("document", 1, &id);
        let raw = json!({"command":"desktop_core_api_request", "requestId":id, "url":"http://127.0.0.1:1/api/v1/me", "method":"GET", "headers":{}}).to_string();
        assert_eq!(
            execute_reserved(&raw, "http://127.0.0.1:1", &guard).unwrap_err(),
            "core_api_aborted"
        );
    }
}
