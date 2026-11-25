//! Native TLS token exchange and single-use browser loopbacks. Refresh credentials never cross IPC.

use super::{resolve_js_promise, GuiWindowAction, WebViewIpcOutcome};
use crate::{
    DeepLinkAdmissionPolicy, KeychainCredentialStore, KeychainSecretKind, OidcIssuerAllowlist,
    OidcLoopbackListener, OidcPkceSession,
};
use kodera_rs::{sha256, validate_docs_host};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use zeroize::Zeroizing;

const INTERACTIVE_TIMEOUT_MS: u64 = 180_000;
const MAX_RESPONSE_BYTES: u64 = 128 * 1024;
type NativeResult<T> = Result<T, String>;

pub struct NativeOidcHttpResponse {
    pub status: u16,
    pub body: Zeroizing<Vec<u8>>,
}

/// The body is supplied on stdin, never through process arguments or diagnostics.
pub trait NativeOidcHttpClient: Send + Sync {
    fn post_form(&self, url: &str, body: &str) -> NativeResult<NativeOidcHttpResponse>;
}

pub trait NativeBrowserLauncher: Send + Sync {
    fn open(&self, url: &str) -> NativeResult<()>;
}

pub struct StdOidcHttpClient;
pub struct StdBrowserLauncher;

fn validate_browser_url(url: &str) -> NativeResult<()> {
    if !url.starts_with("https://")
        || url.len() > 2048
        || !url.is_ascii()
        || url
            .bytes()
            .any(|b| b <= 0x20 || b >= 0x7f || matches!(b, b'\'' | b'"' | b'\\'))
    {
        return Err("oidc_invalid_url".into());
    }
    let host = url[8..].split('/').next().unwrap_or("");
    validate_docs_host(host).map_err(|_| "oidc_invalid_url".to_string())
}

impl NativeOidcHttpClient for StdOidcHttpClient {
    fn post_form(&self, url: &str, body: &str) -> NativeResult<NativeOidcHttpResponse> {
        validate_browser_url(url)?;
        #[cfg(not(target_os = "windows"))]
        let (mut command, input) = {
            let mut command = Command::new("curl");
            command.args([
                "--disable",
                "--silent",
                "--show-error",
                "--proto",
                "=https",
                "--tlsv1.2",
                "--max-time",
                "15",
                "--header",
                "Content-Type: application/x-www-form-urlencoded",
                "--data-binary",
                "@-",
                "-w",
                "\n%{http_code}",
                url,
            ]);
            (command, Zeroizing::new(body.to_owned()))
        };
        #[cfg(target_os = "windows")]
        let (mut command, input) = {
            let mut command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $u=[Console]::In.ReadLine(); $b=[Console]::In.ReadToEnd(); try { $r=Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 15 -Method Post -Uri $u -ContentType 'application/x-www-form-urlencoded' -Body $b; [Console]::Out.Write($r.Content); [Console]::Out.Write([char]10); [Console]::Out.Write([int]$r.StatusCode) } catch { if ($null -eq $_.Exception.Response) { exit 1 }; $r=$_.Exception.Response; $s=New-Object IO.StreamReader($r.GetResponseStream()); [Console]::Out.Write($s.ReadToEnd()); [Console]::Out.Write([char]10); [Console]::Out.Write([int]$r.StatusCode) }"]);
            (command, Zeroizing::new(format!("{url}\n{body}")))
        };
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "oidc_transport".to_string())?;
        let write_result = child
            .stdin
            .take()
            .ok_or_else(|| "oidc_transport".to_string())
            .and_then(|mut stdin| {
                stdin
                    .write_all(input.as_bytes())
                    .map_err(|_| "oidc_transport".to_string())
            });
        if write_result.is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("oidc_transport".into());
        }
        let mut output = Zeroizing::new(Vec::new());
        let read_result = child
            .stdout
            .take()
            .ok_or_else(|| "oidc_transport".to_string())
            .and_then(|stdout| {
                stdout
                    .take(MAX_RESPONSE_BYTES + 1)
                    .read_to_end(&mut output)
                    .map_err(|_| "oidc_transport".to_string())
            });
        if read_result.is_err() || output.len() as u64 > MAX_RESPONSE_BYTES {
            let _ = child.kill();
            let _ = child.wait();
            return Err("oidc_transport".into());
        }
        if !child
            .wait()
            .map_err(|_| "oidc_transport".to_string())?
            .success()
        {
            return Err("oidc_transport".into());
        }
        let split = output
            .iter()
            .rposition(|b| *b == b'\n')
            .ok_or_else(|| "oidc_transport".to_string())?;
        let status = std::str::from_utf8(&output[split + 1..])
            .ok()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| "oidc_transport".to_string())?;
        output.truncate(split);
        Ok(NativeOidcHttpResponse {
            status,
            body: output,
        })
    }
}

impl NativeBrowserLauncher for StdBrowserLauncher {
    fn open(&self, url: &str) -> NativeResult<()> {
        validate_browser_url(url)?;
        #[cfg(target_os = "macos")]
        let mut command = {
            let mut c = Command::new("/usr/bin/open");
            c.arg(url);
            c
        };
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let mut command = {
            let mut c = Command::new("xdg-open");
            c.arg(url);
            c
        };
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut c = Command::new("powershell.exe");
            c.args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; $u=[Console]::In.ReadToEnd(); Start-Process -FilePath $u"]);
            c
        };
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "oidc_browser".to_string())?;
        #[cfg(target_os = "windows")]
        if child
            .stdin
            .take()
            .ok_or_else(|| "oidc_browser".to_string())?
            .write_all(url.as_bytes())
            .is_err()
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err("oidc_browser".into());
        }
        #[cfg(not(target_os = "windows"))]
        drop(child.stdin.take());
        if child
            .wait()
            .map_err(|_| "oidc_browser".to_string())?
            .success()
        {
            Ok(())
        } else {
            Err("oidc_browser".into())
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OidcArgs {
    command: Option<String>,
    issuer_origin: String,
    realm: String,
    client_id: String,
    #[serde(default)]
    registration: bool,
    ui_locales: Option<String>,
    prompt: Option<String>,
    kc_action: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClearArgs {
    command: Option<String>,
    realm: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MatrixArgs {
    command: Option<String>,
    homeserver_origin: String,
    state: String,
}

#[derive(Clone)]
pub(super) struct NativeOidcServices {
    pub http: Arc<dyn NativeOidcHttpClient>,
    pub browser: Arc<dyn NativeBrowserLauncher>,
    pub keychain: Arc<Mutex<KeychainCredentialStore>>,
    pub allowlist: OidcIssuerAllowlist,
    pub timeout_ms: u64,
    pub revision: Arc<AtomicU64>,
    pub epoch: Arc<AtomicU64>,
}
impl Default for NativeOidcServices {
    fn default() -> Self {
        Self {
            http: Arc::new(StdOidcHttpClient),
            browser: Arc::new(StdBrowserLauncher),
            keychain: Arc::new(Mutex::new(KeychainCredentialStore::new())),
            allowlist: OidcIssuerAllowlist::kodera_default(),
            timeout_ms: INTERACTIVE_TIMEOUT_MS,
            revision: Arc::new(AtomicU64::new(0)),
            epoch: Arc::new(AtomicU64::new(0)),
        }
    }
}

pub(super) struct NativeOidcTask {
    pub services: NativeOidcServices,
    pub policy: DeepLinkAdmissionPolicy,
    pub command: String,
    pub body: String,
    pub document_id: String,
    pub request_id: u64,
    pub epoch: u64,
}
impl NativeOidcTask {
    pub fn run(self) -> WebViewIpcOutcome {
        let interactive = matches!(
            self.command.as_str(),
            "desktop_oidc_exchange_loopback" | "desktop_matrix_sso_loopback"
        );
        let result = self
            .services
            .execute(&self.command, &self.body, &self.policy, self.epoch);
        let ok = result.is_ok();
        let payload = result.unwrap_or_else(|error| json!({"ok":false,"error":error}));
        WebViewIpcOutcome {
            eval_scripts: vec![resolve_js_promise(
                &self.document_id,
                self.request_id,
                ok,
                &payload.to_string(),
            )],
            window_action: interactive.then_some(GuiWindowAction::ShowAndFocus),
        }
    }
}

fn valid_realm(realm: &str) -> bool {
    (1..=63).contains(&realm.len())
        && realm
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && realm.as_bytes()[0].is_ascii_alphanumeric()
        && realm.as_bytes()[realm.len() - 1].is_ascii_alphanumeric()
}
fn valid_state(state: &str) -> bool {
    (16..=128).contains(&state.len())
        && state
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
fn constant_time_equal(a: &[u8], b: &[u8]) -> bool {
    let mut diff = a.len() ^ b.len();
    for (i, byte) in a.iter().enumerate() {
        diff |= usize::from(*byte ^ b.get(i).copied().unwrap_or(0));
    }
    diff == 0
}
fn encode(raw: &str) -> String {
    let mut result = String::new();
    for b in raw.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            result.push(char::from(b));
        } else {
            result.push_str(&format!("%{b:02X}"));
        }
    }
    result
}
fn form(pairs: &[(&str, &str)]) -> Zeroizing<String> {
    use std::fmt::Write as _;
    let mut result = Zeroizing::new(String::new());
    for (index, (key, value)) in pairs.iter().enumerate() {
        if index > 0 {
            result.push('&');
        }
        result.push_str(key);
        result.push('=');
        for byte in value.bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                result.push(char::from(byte));
            } else {
                let _ = write!(result, "%{byte:02X}");
            }
        }
    }
    result
}
pub(super) fn base64url(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for shift in [18, 12, 6, 0].into_iter().take(chunk.len() + 1) {
            out.push(char::from(TABLE[((value >> shift) & 63) as usize]));
        }
    }
    out
}
fn random_secret() -> NativeResult<Zeroizing<String>> {
    let mut bytes = Zeroizing::new([0u8; 32]);
    getrandom::fill(bytes.as_mut()).map_err(|_| "oidc_entropy".to_string())?;
    Ok(Zeroizing::new(base64url(bytes.as_ref())))
}
fn decode_payload(jwt: &str) -> NativeResult<Zeroizing<Vec<u8>>> {
    let parts: Vec<_> = jwt.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|s| s.is_empty()) || jwt.len() > 64 * 1024 {
        return Err("oidc_invalid_identity".into());
    }
    let mut output = Zeroizing::new(Vec::new());
    let mut bits = 0u32;
    let mut count = 0;
    for b in parts[1].bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return Err("oidc_invalid_identity".into()),
        };
        bits = (bits << 6) | u32::from(v);
        count += 6;
        if count >= 8 {
            count -= 8;
            output.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    if count >= 6 || bits != 0 {
        return Err("oidc_invalid_identity".into());
    }
    Ok(output)
}

/// Realm-scoped deterministic version-5 UUID-shaped keychain namespace, derived from SHA-256.
pub(super) fn credential_slot(realm: &str) -> (String, String) {
    let mut digest = sha256(format!("kodera-desktop-oidc-realm:{realm}").as_bytes());
    digest[6] = (digest[6] & 15) | 0x50;
    digest[8] = (digest[8] & 63) | 0x80;
    let hex = digest[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    (
        format!(
            "{}-{}-{}-{}-{}",
            &hex[..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..]
        ),
        format!("@{realm}:auth.kodera.io"),
    )
}
fn secret<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Zeroizing<String>>, D::Error> {
    Option::<String>::deserialize(d).map(|v| v.map(Zeroizing::new))
}
#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    expires_in: Option<u64>,
    #[serde(default, deserialize_with = "secret")]
    refresh_token: Option<Zeroizing<String>>,
    #[serde(default, deserialize_with = "secret")]
    id_token: Option<Zeroizing<String>>,
    error: Option<String>,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Audience {
    Single(String),
    Multiple(Vec<String>),
}
impl Audience {
    fn contains(&self, client_id: &str) -> bool {
        match self {
            Self::Single(value) => value == client_id,
            Self::Multiple(values) => values.iter().any(|value| value == client_id),
        }
    }
}
#[derive(Deserialize)]
struct IdentityClaims {
    iss: String,
    sub: String,
    nonce: Option<String>,
    aud: Option<Audience>,
    azp: Option<String>,
    amr: Option<Vec<String>>,
}

impl NativeOidcServices {
    fn delete(&self, realm: &str, expected_revision: Option<u64>, epoch: u64) -> NativeResult<()> {
        let (org, user) = credential_slot(realm);
        let mut store = self
            .keychain
            .lock()
            .map_err(|_| "oidc_keychain".to_string())?;
        if self.epoch.load(Ordering::SeqCst) != epoch {
            return Err("oidc_cancelled".into());
        }
        if expected_revision
            .is_some_and(|revision| self.revision.load(Ordering::SeqCst) != revision)
        {
            return Err("oidc_cancelled".into());
        }
        store
            .delete_credential(KeychainSecretKind::OidcRefresh, &org, &user)
            .map_err(|_| "oidc_keychain".to_string())?;
        Ok(())
    }
    fn token(
        &self,
        args: &OidcArgs,
        body: &str,
        nonce: Option<&str>,
        refreshing: bool,
        revision: u64,
        epoch: u64,
    ) -> NativeResult<Value> {
        let issuer = format!("{}/realms/{}", args.issuer_origin, args.realm);
        let response = self
            .http
            .post_form(&format!("{issuer}/protocol/openid-connect/token"), body)?;
        let token: TokenResponse = serde_json::from_slice(&response.body)
            .map_err(|_| "oidc_invalid_response".to_string())?;
        if response.status != 200 {
            let refusal = token.error.as_deref().filter(|error| {
                matches!(
                    *error,
                    "invalid_grant"
                        | "unauthorized_client"
                        | "invalid_client"
                        | "access_denied"
                        | "invalid_token"
                        | "invalid_scope"
                        | "invalid_request"
                )
            });
            if let Some(error) = refusal {
                if refreshing {
                    self.delete(&args.realm, Some(revision), epoch)?;
                }
                return Err(format!("oidc_refused:{error}"));
            }
            return Err("oidc_transport".into());
        }
        let access = token
            .access_token
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 64 * 1024
                    && s.bytes().all(|b| (0x21..=0x7e).contains(&b))
            })
            .ok_or_else(|| "oidc_invalid_response".to_string())?;
        let expires = token
            .expires_in
            .filter(|n| *n > 0 && *n <= 31_536_000)
            .ok_or_else(|| "oidc_invalid_response".to_string())?;
        // Claims are checked on tokens obtained directly from the admitted issuer over TLS.
        let jwt = match token.id_token.as_deref() {
            Some(id_token) => id_token.as_str(),
            None if nonce.is_none() => access.as_str(),
            None => return Err("oidc_invalid_identity".into()),
        };
        let claims: IdentityClaims = serde_json::from_slice(&decode_payload(jwt)?)
            .map_err(|_| "oidc_invalid_identity".to_string())?;
        if claims.iss != issuer
            || claims.sub.is_empty()
            || claims.sub.len() > 255
            || !claims.sub.bytes().all(|b| (0x20..=0x7e).contains(&b))
        {
            return Err("oidc_invalid_identity".into());
        }
        if token.id_token.is_some()
            && claims.azp.as_deref() != Some(args.client_id.as_str())
            && !claims
                .aud
                .as_ref()
                .is_some_and(|aud| aud.contains(&args.client_id))
        {
            return Err("oidc_invalid_identity".into());
        }
        if token.id_token.is_some()
            && nonce.is_some_and(|expected| {
                !constant_time_equal(
                    expected.as_bytes(),
                    claims.nonce.as_deref().unwrap_or("").as_bytes(),
                )
            })
        {
            return Err("oidc_invalid_nonce".into());
        }
        if claims.amr.as_ref().is_some_and(|amr| {
            amr.len() > 32
                || amr.iter().any(|s| {
                    s.is_empty() || s.len() > 128 || !s.bytes().all(|b| (0x21..=0x7e).contains(&b))
                })
        }) {
            return Err("oidc_invalid_identity".into());
        }
        if token.refresh_token.as_ref().is_some_and(|refresh| {
            refresh.is_empty() || refresh.len() > crate::keychain::MAX_KEYCHAIN_SECRET_BYTES
        }) {
            return Err("oidc_invalid_refresh".into());
        }
        let (org, user) = credential_slot(&args.realm);
        let mut store = self
            .keychain
            .lock()
            .map_err(|_| "oidc_keychain".to_string())?;
        if self.revision.load(Ordering::SeqCst) != revision
            || self.epoch.load(Ordering::SeqCst) != epoch
        {
            return Err("oidc_cancelled".into());
        }
        let wrote_refresh = token.refresh_token.is_some();
        if let Some(refresh) = token.refresh_token {
            store
                .store_credential(
                    KeychainSecretKind::OidcRefresh,
                    &org,
                    &user,
                    "kodera-desktop",
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs(),
                    None,
                    &refresh,
                )
                .map_err(|_| "oidc_keychain".to_string())?;
        } else if !refreshing {
            store
                .delete_credential(KeychainSecretKind::OidcRefresh, &org, &user)
                .map_err(|_| "oidc_keychain".to_string())?;
        }
        // A navigation or sign-out may retire an operation during an OS keychain write.
        if self.revision.load(Ordering::SeqCst) != revision
            || self.epoch.load(Ordering::SeqCst) != epoch
        {
            if wrote_refresh {
                store
                    .delete_credential(KeychainSecretKind::OidcRefresh, &org, &user)
                    .map_err(|_| "oidc_keychain".to_string())?;
            }
            return Err("oidc_cancelled".into());
        }
        Ok(
            json!({"ok":true,"access_token":access,"expires_in":expires,"realm":args.realm,"issuer":issuer,"subject":claims.sub,"amr":claims.amr.unwrap_or_default()}),
        )
    }
    fn execute(
        &self,
        command: &str,
        body: &str,
        policy: &DeepLinkAdmissionPolicy,
        epoch: u64,
    ) -> NativeResult<Value> {
        if self.epoch.load(Ordering::SeqCst) != epoch {
            return Err("oidc_cancelled".into());
        }
        if command == "desktop_oidc_clear_session" {
            let args: ClearArgs =
                serde_json::from_str(body).map_err(|_| "oidc_invalid_args".to_string())?;
            if args.command.as_deref().is_some_and(|v| v != command) || !valid_realm(&args.realm) {
                return Err("oidc_invalid_args".into());
            }
            self.delete(&args.realm, None, epoch)?;
            return Ok(json!({"ok":true}));
        }
        if command == "desktop_matrix_sso_loopback" {
            let args: MatrixArgs =
                serde_json::from_str(body).map_err(|_| "matrix_invalid_args".to_string())?;
            if args.command.as_deref().is_some_and(|v| v != command) {
                return Err("matrix_invalid_args".into());
            }
            return self.matrix(args, policy);
        }
        let revision = self.revision.load(Ordering::SeqCst);
        let args: OidcArgs =
            serde_json::from_str(body).map_err(|_| "oidc_invalid_args".to_string())?;
        if args.command.as_deref().is_some_and(|v| v != command)
            || !valid_realm(&args.realm)
            || !(2..=64).contains(&args.client_id.len())
            || !args
                .client_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
            || args.prompt.as_deref().is_some_and(|v| v != "login")
            || args
                .kc_action
                .as_deref()
                .is_some_and(|v| v != "CONFIGURE_TOTP")
            || args
                .ui_locales
                .as_deref()
                .is_some_and(|v| !matches!(v, "en" | "fr"))
        {
            return Err("oidc_invalid_args".into());
        }
        let origin = self
            .allowlist
            .validate_admitted_origin(&args.issuer_origin)
            .map_err(|_| "oidc_untrusted_issuer".to_string())?;
        if origin != args.issuer_origin {
            return Err("oidc_untrusted_issuer".into());
        }
        if command == "desktop_oidc_refresh_session" {
            let (org, user) = credential_slot(&args.realm);
            let stored = self
                .keychain
                .lock()
                .map_err(|_| "oidc_keychain".to_string())?
                .load_credential_secret(KeychainSecretKind::OidcRefresh, &org, &user)
                .map_err(|_| "oidc_keychain".to_string())?
                .ok_or_else(|| "oidc_refused:no_refresh_credential".to_string())?;
            let body = form(&[
                ("grant_type", "refresh_token"),
                ("client_id", &args.client_id),
                ("refresh_token", stored.1.expose_for_keychain_write()),
            ]);
            return self.token(&args, &body, None, true, revision, epoch);
        }
        let listener =
            OidcLoopbackListener::bind_ephemeral().map_err(|_| "oidc_loopback".to_string())?;
        let verifier = random_secret()?;
        let state = random_secret()?;
        let nonce = random_secret()?;
        let issuer = format!("{origin}/realms/{}", args.realm);
        let (session, ready) = OidcPkceSession::start(
            &self.allowlist,
            &issuer,
            &args.client_id,
            &verifier,
            &state,
            listener.port(),
        )
        .map_err(|_| "oidc_invalid_args".to_string())?;
        let mut pairs = vec![
            ("client_id", args.client_id.as_str()),
            ("redirect_uri", ready.redirect_uri.as_str()),
            ("response_type", "code"),
            ("scope", "openid profile email offline_access"),
            ("code_challenge", ready.code_challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", state.as_str()),
            ("nonce", nonce.as_str()),
            ("ui_locales", args.ui_locales.as_deref().unwrap_or("en")),
        ];
        if let Some(prompt) = args.prompt.as_deref() {
            pairs.push(("prompt", prompt));
        }
        if let Some(action) = args.kc_action.as_deref() {
            pairs.push(("kc_action", action));
        }
        let endpoint = if args.registration {
            "registrations"
        } else {
            "auth"
        };
        self.browser.open(&format!(
            "{issuer}/protocol/openid-connect/{endpoint}?{}",
            form(&pairs).as_str()
        ))?;
        let callback = listener
            .accept_once_interactive(session, policy, self.timeout_ms)
            .map_err(|_| "oidc_loopback".to_string())?;
        let body = form(&[
            ("grant_type", "authorization_code"),
            ("client_id", &args.client_id),
            ("redirect_uri", &ready.redirect_uri),
            (
                "code",
                callback.authorization_code.expose_for_token_exchange(),
            ),
            (
                "code_verifier",
                callback.code_verifier.expose_for_token_exchange(),
            ),
        ]);
        self.token(&args, &body, Some(&nonce), false, revision, epoch)
    }

    fn matrix(&self, args: MatrixArgs, policy: &DeepLinkAdmissionPolicy) -> NativeResult<Value> {
        validate_browser_url(&args.homeserver_origin)?;
        let host = args
            .homeserver_origin
            .strip_prefix("https://")
            .ok_or_else(|| "matrix_invalid_origin".to_string())?;
        validate_docs_host(host).map_err(|_| "matrix_invalid_origin".to_string())?;
        let admitted = policy.is_domain_admitted(host)
            || policy.admitted_domains().iter().any(|root| {
                host.strip_suffix(root.as_str())
                    .is_some_and(|prefix| prefix.ends_with('.'))
            });
        if !admitted || !valid_state(&args.state) {
            return Err("matrix_invalid_args".into());
        }
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).map_err(|_| "matrix_loopback".to_string())?;
        let port = listener
            .local_addr()
            .map_err(|_| "matrix_loopback".to_string())?
            .port();
        let redirect = format!(
            "http://127.0.0.1:{port}/espace/callback?state={}",
            args.state
        );
        self.browser.open(&format!(
            "{}/_matrix/client/v3/login/sso/redirect?redirectUrl={}",
            args.homeserver_origin,
            encode(&redirect)
        ))?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "matrix_loopback".to_string())?;
        let deadline = Instant::now()
            + Duration::from_millis(self.timeout_ms.clamp(50, INTERACTIVE_TIMEOUT_MS));
        let (mut stream, peer) = loop {
            match listener.accept() {
                Ok(conn) => break conn,
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(10))
                }
                _ => return Err("matrix_loopback".into()),
            }
        };
        drop(listener);
        if !peer.ip().is_loopback() {
            return Err("matrix_loopback".into());
        }
        let callback = read_matrix_callback(&mut stream, port, &args.state);
        let (status, text) = if callback.is_ok() {
            (
                "200 OK",
                "Authentication complete. You may return to Kodera.",
            )
        } else {
            ("400 Bad Request", "Authentication could not be completed.")
        };
        let _ = stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{text}", text.len()).as_bytes());
        Ok(json!({"ok":true,"callback_uri":callback?}))
    }
}

fn decode_query(value: &str) -> NativeResult<String> {
    let mut bytes = Vec::new();
    let mut iter = value.bytes();
    while let Some(b) = iter.next() {
        if b == b'%' {
            let hi = iter
                .next()
                .and_then(|b| char::from(b).to_digit(16))
                .ok_or_else(|| "matrix_invalid_callback".to_string())?;
            let lo = iter
                .next()
                .and_then(|b| char::from(b).to_digit(16))
                .ok_or_else(|| "matrix_invalid_callback".to_string())?;
            bytes.push((hi * 16 + lo) as u8);
        } else {
            bytes.push(if b == b'+' { b' ' } else { b });
        }
    }
    String::from_utf8(bytes).map_err(|_| "matrix_invalid_callback".to_string())
}
fn read_matrix_callback(
    stream: &mut TcpStream,
    port: u16,
    expected_state: &str,
) -> NativeResult<String> {
    let invalid = || "matrix_invalid_callback".to_string();
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|_| invalid())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(1)))
        .map_err(|_| invalid())?;
    let mut request = Zeroizing::new(Vec::new());
    let mut byte = [0u8; 1];
    let deadline = Instant::now() + Duration::from_secs(1);
    while !request.ends_with(b"\r\n\r\n") {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(invalid());
        }
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|_| invalid())?;
        if request.len() >= 4096 || stream.read(&mut byte).map_err(|_| invalid())? == 0 {
            return Err(invalid());
        }
        request.push(byte[0]);
    }
    let text = std::str::from_utf8(&request).map_err(|_| invalid())?;
    let mut lines = text.split("\r\n");
    let mut parts = lines.next().ok_or_else(invalid)?.split(' ');
    if parts.next() != Some("GET") {
        return Err(invalid());
    }
    let target = parts.next().ok_or_else(invalid)?;
    if !matches!(parts.next(), Some("HTTP/1.1" | "HTTP/1.0")) || parts.next().is_some() {
        return Err(invalid());
    }
    let mut host_seen = false;
    for line in lines.take_while(|l| !l.is_empty()) {
        let (name, value) = line.split_once(':').ok_or_else(invalid)?;
        if name.trim() != name {
            return Err(invalid());
        }
        if name.eq_ignore_ascii_case("host") {
            if host_seen || value.trim() != format!("127.0.0.1:{port}") {
                return Err(invalid());
            }
            host_seen = true;
        }
    }
    if !host_seen {
        return Err(invalid());
    }
    let query = target
        .strip_prefix("/espace/callback?")
        .ok_or_else(invalid)?;
    let mut token = None;
    let mut state = None;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').ok_or_else(invalid)?;
        let value = decode_query(value)?;
        match key {
            "loginToken"
                if token.is_none()
                    && (1..=1024).contains(&value.len())
                    && value.bytes().all(|b| (0x21..=0x7e).contains(&b)) =>
            {
                token = Some(value)
            }
            "state" if state.is_none() && valid_state(&value) => state = Some(value),
            _ => return Err(invalid()),
        }
    }
    let state = state.ok_or_else(invalid)?;
    if !constant_time_equal(state.as_bytes(), expected_state.as_bytes()) {
        return Err(invalid());
    }
    Ok(format!(
        "http://127.0.0.1:{port}/espace/callback?loginToken={}&state={}",
        encode(&token.ok_or_else(invalid)?),
        encode(&state)
    ))
}
