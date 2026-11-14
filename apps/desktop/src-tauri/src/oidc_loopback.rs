//! OIDC PKCE (`S256`, RFC 7636) native desktop loopback callback handler (RFC 8252 §7.3).
//!
//! Security invariants:
//! - Only canonical HTTPS OIDC issuer origins in [`OidcIssuerAllowlist`] are admitted; cleartext,
//!   credentials, non-default ports, paths, queries, and dangerous schemes fail closed.
//! - PKCE `code_verifier` values (43–128 RFC 7636 unreserved ASCII bytes) are wrapped in
//!   [`RedactedCodeVerifier`], formatted as `[REDACTED]`, overwritten on drop, and transformed
//!   into URL-safe base64 `S256` challenges via `kodera_rs::sha256`.
//! - Loopback callbacks accept only `http://127.0.0.1:<bound_port>/auth/callback` (never
//!   `0.0.0.0`, external hosts, or DNS-rebindable `Host` headers) or admitted `kodera://auth/callback`.
//! - Open-redirect parameters (`redirect`, `redirect_uri`, `next`, `return_to`, `continue`, `url`)
//!   are unconditionally refused, `state` is verified in constant time, and a pending PKCE session
//!   is consumed on first completion so replay fails closed.

use crate::deeplink::{
    route_deep_link, AdmittedDeepLink, DeepLinkAdmissionPolicy, KoderaDeepLink, RedactedOidcCode,
};
use core::fmt;
use kodera_rs::{sha256, validate_docs_host};
use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::time::{Duration, Instant};

/// Default first-party Keycloak issuer origin admitted for Kodera OIDC login.
pub const DEFAULT_OIDC_ISSUER_ORIGIN: &str = "https://auth.kodera.io";

/// Maximum byte length accepted on an incoming OIDC callback URI or HTTP request line.
pub const MAX_OIDC_CALLBACK_URI_BYTES: usize = 2048;

/// Maximum byte size read from the single-shot loopback HTTP callback socket.
pub const MAX_LOOPBACK_HTTP_REQUEST_BYTES: usize = 4096;

/// Default timeout when waiting on a single-shot loopback HTTP callback connection.
pub const DEFAULT_LOOPBACK_TIMEOUT_MS: u64 = 2000;

/// Maximum timeout permitted for a single-shot loopback HTTP callback wait.
pub const MAX_LOOPBACK_TIMEOUT_MS: u64 = 5000;

/// Closed refusal codes for OIDC PKCE session creation and loopback callback handling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OidcLoopbackError {
    InvalidIssuerOrigin,
    UntrustedIssuerOrigin,
    InvalidClientId,
    InvalidCodeVerifier,
    InvalidState,
    InvalidLoopbackPort,
    NoPendingSession,
    CallbackMalformed,
    UnsupportedScheme,
    UntrustedCallbackHost,
    PortMismatch,
    InvalidCallbackPath,
    OpenRedirectDetected,
    StateMismatch,
    AuthorizationDenied,
    InvalidAuthorizationCode,
    ListenerBindFailed,
    ListenerTimedOut,
}

impl fmt::Display for OidcLoopbackError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            Self::InvalidIssuerOrigin => "invalid_issuer_origin",
            Self::UntrustedIssuerOrigin => "untrusted_issuer_origin",
            Self::InvalidClientId => "invalid_client_id",
            Self::InvalidCodeVerifier => "invalid_code_verifier",
            Self::InvalidState => "invalid_state",
            Self::InvalidLoopbackPort => "invalid_loopback_port",
            Self::NoPendingSession => "no_pending_session",
            Self::CallbackMalformed => "callback_malformed",
            Self::UnsupportedScheme => "unsupported_scheme",
            Self::UntrustedCallbackHost => "untrusted_callback_host",
            Self::PortMismatch => "port_mismatch",
            Self::InvalidCallbackPath => "invalid_callback_path",
            Self::OpenRedirectDetected => "open_redirect_detected",
            Self::StateMismatch => "state_mismatch",
            Self::AuthorizationDenied => "authorization_denied",
            Self::InvalidAuthorizationCode => "invalid_authorization_code",
            Self::ListenerBindFailed => "listener_bind_failed",
            Self::ListenerTimedOut => "listener_timed_out",
        };
        f.write_str(code)
    }
}

impl std::error::Error for OidcLoopbackError {}

/// Explicit allowlist of canonical HTTPS OIDC issuer origins (`https://auth.kodera.io`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OidcIssuerAllowlist {
    origins: BTreeSet<String>,
}

impl Default for OidcIssuerAllowlist {
    fn default() -> Self {
        Self::kodera_default()
    }
}

impl OidcIssuerAllowlist {
    pub fn kodera_default() -> Self {
        let mut origins = BTreeSet::new();
        origins.insert(DEFAULT_OIDC_ISSUER_ORIGIN.to_owned());
        Self { origins }
    }

    pub fn add_issuer_origin(&mut self, raw_origin: &str) -> Result<(), OidcLoopbackError> {
        let canonical = canonicalize_https_origin(raw_origin)?;
        self.origins.insert(canonical);
        Ok(())
    }

    pub fn validate_admitted_origin(&self, raw_origin: &str) -> Result<String, OidcLoopbackError> {
        let canonical = canonicalize_https_origin(raw_origin)?;
        if !self.origins.contains(&canonical) {
            return Err(OidcLoopbackError::UntrustedIssuerOrigin);
        }
        Ok(canonical)
    }
}

fn canonicalize_https_origin(raw_origin: &str) -> Result<String, OidcLoopbackError> {
    if raw_origin.is_empty()
        || raw_origin.len() > 255
        || !raw_origin.is_ascii()
        || raw_origin
            .bytes()
            .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
    {
        return Err(OidcLoopbackError::InvalidIssuerOrigin);
    }
    let Some(host) = raw_origin.strip_prefix("https://") else {
        return Err(OidcLoopbackError::InvalidIssuerOrigin);
    };
    if host.is_empty()
        || host.contains('/')
        || host.contains('?')
        || host.contains('#')
        || host.contains('@')
        || host.contains(':')
        || host.bytes().any(|b| b.is_ascii_uppercase())
    {
        return Err(OidcLoopbackError::InvalidIssuerOrigin);
    }
    validate_docs_host(host).map_err(|_| OidcLoopbackError::InvalidIssuerOrigin)?;
    Ok(format!("https://{host}"))
}

/// Ephemeral PKCE `code_verifier` wrapper whose backing buffer is overwritten on drop.
#[derive(PartialEq, Eq)]
pub struct RedactedCodeVerifier(Vec<u8>);

impl Clone for RedactedCodeVerifier {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl RedactedCodeVerifier {
    pub fn new(raw: &str) -> Result<Self, OidcLoopbackError> {
        if !(43..=128).contains(&raw.len())
            || !raw
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'))
        {
            return Err(OidcLoopbackError::InvalidCodeVerifier);
        }
        Ok(Self(raw.as_bytes().to_vec()))
    }

    pub fn expose_for_token_exchange(&self) -> &str {
        core::str::from_utf8(&self.0).expect("validated RFC 7636 verifier")
    }

    pub fn clear(&mut self) {
        self.0.fill(0);
        self.0.clear();
    }
}

impl Drop for RedactedCodeVerifier {
    fn drop(&mut self) {
        self.clear();
    }
}

impl fmt::Debug for RedactedCodeVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RedactedCodeVerifier([REDACTED])")
    }
}

impl fmt::Display for RedactedCodeVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}

/// Computes the RFC 7636 `S256` PKCE `code_challenge` (`BASE64URL_NO_PAD(SHA256(verifier))`).
pub fn pkce_s256_challenge(code_verifier: &str) -> Result<String, OidcLoopbackError> {
    let verifier = RedactedCodeVerifier::new(code_verifier)?;
    let digest = sha256(verifier.expose_for_token_exchange().as_bytes());
    Ok(encode_base64url_no_pad(&digest))
}

fn encode_base64url_no_pad(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let triple =
            (u32::from(bytes[i]) << 16) | (u32::from(bytes[i + 1]) << 8) | u32::from(bytes[i + 2]);
        out.push(ALPHABET[((triple >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((triple >> 12) & 0x3f) as usize] as char);
        out.push(ALPHABET[((triple >> 6) & 0x3f) as usize] as char);
        out.push(ALPHABET[(triple & 0x3f) as usize] as char);
        i += 3;
    }
    match bytes.len() - i {
        1 => {
            let v = u32::from(bytes[i]) << 16;
            out.push(ALPHABET[((v >> 18) & 0x3f) as usize] as char);
            out.push(ALPHABET[((v >> 12) & 0x3f) as usize] as char);
        }
        2 => {
            let v = (u32::from(bytes[i]) << 16) | (u32::from(bytes[i + 1]) << 8);
            out.push(ALPHABET[((v >> 18) & 0x3f) as usize] as char);
            out.push(ALPHABET[((v >> 12) & 0x3f) as usize] as char);
            out.push(ALPHABET[((v >> 6) & 0x3f) as usize] as char);
        }
        _ => {}
    }
    out
}

fn constant_time_eq_bytes(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let diff = left
        .iter()
        .zip(right.iter())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b));
    diff == 0
}

fn is_valid_oidc_state(raw: &str) -> bool {
    (16..=128).contains(&raw.len())
        && raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn is_valid_client_id(raw: &str) -> bool {
    (2..=64).contains(&raw.len())
        && raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

fn is_open_redirect_param(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "redirect"
            | "redirect_uri"
            | "redirect_url"
            | "next"
            | "return_to"
            | "returnto"
            | "continue"
            | "url"
            | "target"
            | "dest"
    )
}

/// Public, non-secret descriptor returned when a native OIDC PKCE loopback session starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OidcLoopbackSessionReady {
    pub issuer_origin: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub loopback_port: u16,
    pub code_challenge: String,
    pub code_challenge_method: &'static str,
}

/// Verified single-use authorization outcome produced when the OIDC callback completes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OidcCallbackOutcome {
    pub issuer_origin: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub authorization_code: RedactedOidcCode,
    pub code_verifier: RedactedCodeVerifier,
}

/// Ephemeral single-use OIDC PKCE pending login state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OidcPkceSession {
    issuer_origin: String,
    client_id: String,
    code_verifier: RedactedCodeVerifier,
    expected_state: String,
    loopback_port: u16,
    redirect_uri: String,
    code_challenge: String,
}

impl OidcPkceSession {
    pub fn start(
        allowlist: &OidcIssuerAllowlist,
        issuer_origin: &str,
        client_id: &str,
        raw_code_verifier: &str,
        expected_state: &str,
        loopback_port: u16,
    ) -> Result<(Self, OidcLoopbackSessionReady), OidcLoopbackError> {
        let canonical_issuer = allowlist.validate_admitted_origin(issuer_origin)?;
        if !is_valid_client_id(client_id) {
            return Err(OidcLoopbackError::InvalidClientId);
        }
        let code_verifier = RedactedCodeVerifier::new(raw_code_verifier)?;
        if !is_valid_oidc_state(expected_state) {
            return Err(OidcLoopbackError::InvalidState);
        }
        if loopback_port < 1024 {
            return Err(OidcLoopbackError::InvalidLoopbackPort);
        }
        let code_challenge = pkce_s256_challenge(code_verifier.expose_for_token_exchange())?;
        let redirect_uri = format!("http://127.0.0.1:{loopback_port}/auth/callback");
        let ready = OidcLoopbackSessionReady {
            issuer_origin: canonical_issuer.clone(),
            client_id: client_id.to_owned(),
            redirect_uri: redirect_uri.clone(),
            loopback_port,
            code_challenge: code_challenge.clone(),
            code_challenge_method: "S256",
        };
        Ok((
            Self {
                issuer_origin: canonical_issuer,
                client_id: client_id.to_owned(),
                code_verifier,
                expected_state: expected_state.to_owned(),
                loopback_port,
                redirect_uri,
                code_challenge,
            },
            ready,
        ))
    }

    pub fn clear(&mut self) {
        self.code_verifier.clear();
        self.expected_state.clear();
    }

    /// Validates a `http://127.0.0.1:<port>/auth/callback?...` or `kodera://auth/callback?...` URI
    /// and consumes this single-use PKCE session.
    pub fn consume_callback_uri(
        mut self,
        callback_uri: &str,
        deep_link_policy: &DeepLinkAdmissionPolicy,
    ) -> Result<OidcCallbackOutcome, OidcLoopbackError> {
        if callback_uri.is_empty() || callback_uri.len() > MAX_OIDC_CALLBACK_URI_BYTES {
            return Err(OidcLoopbackError::CallbackMalformed);
        }
        if !callback_uri.is_ascii()
            || callback_uri
                .bytes()
                .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
            || callback_uri.contains('#')
            || callback_uri.contains('\\')
            || callback_uri.contains('@')
        {
            return Err(OidcLoopbackError::CallbackMalformed);
        }

        let Some((scheme_raw, _)) = callback_uri.split_once(':') else {
            return Err(OidcLoopbackError::CallbackMalformed);
        };
        let scheme_lower = scheme_raw.to_ascii_lowercase();
        if matches!(
            scheme_lower.as_str(),
            "javascript" | "data" | "file" | "vbscript" | "ws" | "wss" | "https"
        ) {
            return Err(OidcLoopbackError::UnsupportedScheme);
        }

        let (code, received_state, used_redirect_uri) = if callback_uri.starts_with("kodera://") {
            if callback_uri.contains("redirect=")
                || callback_uri.contains("redirect_uri=")
                || callback_uri.contains("return_to=")
                || callback_uri.contains("next=")
            {
                return Err(OidcLoopbackError::OpenRedirectDetected);
            }
            let admitted = route_deep_link(callback_uri, deep_link_policy)
                .map_err(|_| OidcLoopbackError::CallbackMalformed)?;
            match admitted {
                AdmittedDeepLink::Kodera(KoderaDeepLink::AuthCallback { code, state, .. }) => {
                    (code, state, "kodera://auth/callback".to_owned())
                }
                _ => return Err(OidcLoopbackError::InvalidCallbackPath),
            }
        } else if let Some(after_http) = callback_uri.strip_prefix("http://") {
            let (authority, path_and_query) = after_http
                .split_once('/')
                .ok_or(OidcLoopbackError::CallbackMalformed)?;
            let (host, port_str) = authority
                .split_once(':')
                .ok_or(OidcLoopbackError::UntrustedCallbackHost)?;
            if host != "127.0.0.1" {
                return Err(OidcLoopbackError::UntrustedCallbackHost);
            }
            let port = port_str
                .parse::<u16>()
                .map_err(|_| OidcLoopbackError::InvalidLoopbackPort)?;
            if port != self.loopback_port {
                return Err(OidcLoopbackError::PortMismatch);
            }
            let (path, query) = path_and_query
                .split_once('?')
                .ok_or(OidcLoopbackError::CallbackMalformed)?;
            if path != "auth/callback" {
                return Err(OidcLoopbackError::InvalidCallbackPath);
            }
            let (code, state) = parse_loopback_callback_query(query)?;
            (code, state, self.redirect_uri.clone())
        } else {
            return Err(OidcLoopbackError::UnsupportedScheme);
        };

        if !constant_time_eq_bytes(received_state.as_bytes(), self.expected_state.as_bytes()) {
            return Err(OidcLoopbackError::StateMismatch);
        }

        let verifier = self.code_verifier.clone();
        self.clear();
        Ok(OidcCallbackOutcome {
            issuer_origin: self.issuer_origin,
            client_id: self.client_id,
            redirect_uri: used_redirect_uri,
            authorization_code: code,
            code_verifier: verifier,
        })
    }
}

fn parse_loopback_callback_query(
    query: &str,
) -> Result<(RedactedOidcCode, String), OidcLoopbackError> {
    if query.is_empty() {
        return Err(OidcLoopbackError::CallbackMalformed);
    }
    let mut code: Option<RedactedOidcCode> = None;
    let mut state: Option<String> = None;
    let mut oauth_error: Option<&str> = None;

    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            return Err(OidcLoopbackError::CallbackMalformed);
        };
        if key.is_empty() || value.is_empty() || value.contains('=') || value.contains('%') {
            return Err(OidcLoopbackError::CallbackMalformed);
        }
        if is_open_redirect_param(key) {
            return Err(OidcLoopbackError::OpenRedirectDetected);
        }
        match key {
            "code" => {
                if code.is_some() {
                    return Err(OidcLoopbackError::CallbackMalformed);
                }
                code = Some(
                    RedactedOidcCode::new(value)
                        .map_err(|_| OidcLoopbackError::InvalidAuthorizationCode)?,
                );
            }
            "state" => {
                if state.is_some() || !is_valid_oidc_state(value) {
                    return Err(OidcLoopbackError::InvalidState);
                }
                state = Some(value.to_owned());
            }
            "error" => {
                if oauth_error.is_some() {
                    return Err(OidcLoopbackError::CallbackMalformed);
                }
                oauth_error = Some(value);
            }
            "iss" | "session_state" => {}
            _ => return Err(OidcLoopbackError::CallbackMalformed),
        }
    }

    if oauth_error.is_some() {
        return Err(OidcLoopbackError::AuthorizationDenied);
    }
    let verified_code = code.ok_or(OidcLoopbackError::InvalidAuthorizationCode)?;
    let verified_state = state.ok_or(OidcLoopbackError::InvalidState)?;
    Ok((verified_code, verified_state))
}

/// Single-shot RFC 8252 `127.0.0.1:<ephemeral>` HTTP listener for native desktop OIDC login.
pub struct OidcLoopbackListener {
    listener: TcpListener,
    port: u16,
}

impl OidcLoopbackListener {
    /// Binds strictly to `127.0.0.1:0` (IPv4 loopback only; never `0.0.0.0`).
    pub fn bind_ephemeral() -> Result<Self, OidcLoopbackError> {
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .map_err(|_| OidcLoopbackError::ListenerBindFailed)?;
        let addr = listener
            .local_addr()
            .map_err(|_| OidcLoopbackError::ListenerBindFailed)?;
        Ok(Self {
            listener,
            port: addr.port(),
        })
    }

    pub const fn port(&self) -> u16 {
        self.port
    }

    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}/auth/callback", self.port)
    }

    /// Accepts exactly one loopback HTTP callback within `timeout_ms`, verifies `Host`, replies
    /// with a `Cache-Control: no-store` + `CSP: default-src 'none'` page, and closes the socket.
    pub fn accept_once(
        self,
        session: OidcPkceSession,
        deep_link_policy: &DeepLinkAdmissionPolicy,
        timeout_ms: u64,
    ) -> Result<OidcCallbackOutcome, OidcLoopbackError> {
        let clamped_ms = timeout_ms.clamp(50, MAX_LOOPBACK_TIMEOUT_MS);
        let deadline = Instant::now() + Duration::from_millis(clamped_ms);
        self.listener
            .set_nonblocking(true)
            .map_err(|_| OidcLoopbackError::ListenerBindFailed)?;

        let (mut stream, peer) = loop {
            match self.listener.accept() {
                Ok(conn) => break conn,
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err(OidcLoopbackError::ListenerTimedOut);
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(_) => return Err(OidcLoopbackError::CallbackMalformed),
            }
        };
        drop(self.listener);

        if !peer.ip().is_loopback() {
            return Err(OidcLoopbackError::UntrustedCallbackHost);
        }
        stream
            .set_nonblocking(false)
            .map_err(|_| OidcLoopbackError::CallbackMalformed)?;
        let _ = stream.set_read_timeout(Some(Duration::from_millis(1000)));
        let _ = stream.set_write_timeout(Some(Duration::from_millis(1000)));

        let mut buf = [0u8; MAX_LOOPBACK_HTTP_REQUEST_BYTES];
        let read_len = stream
            .read(&mut buf)
            .map_err(|_| OidcLoopbackError::CallbackMalformed)?;
        if read_len == 0 || read_len == MAX_LOOPBACK_HTTP_REQUEST_BYTES {
            return Err(OidcLoopbackError::CallbackMalformed);
        }
        let request_text = core::str::from_utf8(&buf[..read_len])
            .map_err(|_| OidcLoopbackError::CallbackMalformed)?;
        let mut lines = request_text.split("\r\n");
        let request_line = lines.next().ok_or(OidcLoopbackError::CallbackMalformed)?;
        let mut parts = request_line.split(' ');
        let method = parts.next().ok_or(OidcLoopbackError::CallbackMalformed)?;
        let target = parts.next().ok_or(OidcLoopbackError::CallbackMalformed)?;
        let version = parts.next().ok_or(OidcLoopbackError::CallbackMalformed)?;
        if method != "GET" || !version.starts_with("HTTP/1.") || parts.next().is_some() {
            let _ = write_loopback_http_response(&mut stream, 405, "Method Not Allowed");
            return Err(OidcLoopbackError::CallbackMalformed);
        }

        let expected_host = format!("127.0.0.1:{}", self.port);
        let mut saw_valid_host = false;
        for line in lines {
            if line.is_empty() {
                break;
            }
            if let Some((name, val)) = line.split_once(':') {
                if name.trim_end() != name {
                    let _ = write_loopback_http_response(&mut stream, 400, "Malformed Header");
                    return Err(OidcLoopbackError::CallbackMalformed);
                }
                if name.eq_ignore_ascii_case("host") {
                    if saw_valid_host {
                        let _ = write_loopback_http_response(&mut stream, 400, "Duplicate Host");
                        return Err(OidcLoopbackError::UntrustedCallbackHost);
                    }
                    if val.trim() != expected_host {
                        let _ = write_loopback_http_response(&mut stream, 400, "Invalid Host");
                        return Err(OidcLoopbackError::UntrustedCallbackHost);
                    }
                    saw_valid_host = true;
                }
            }
        }
        if !saw_valid_host {
            let _ = write_loopback_http_response(&mut stream, 400, "Missing Host");
            return Err(OidcLoopbackError::UntrustedCallbackHost);
        }

        let synthetic_uri = format!("http://127.0.0.1:{}{target}", self.port);
        let outcome = session.consume_callback_uri(&synthetic_uri, deep_link_policy);
        match &outcome {
            Ok(_) => {
                let _ = write_loopback_http_response(
                    &mut stream,
                    200,
                    "Authentication complete. You may return to Kodera.",
                );
            }
            Err(_) => {
                let _ = write_loopback_http_response(
                    &mut stream,
                    400,
                    "Authentication could not be completed.",
                );
            }
        }
        outcome
    }
}

fn write_loopback_http_response(
    stream: &mut std::net::TcpStream,
    status: u16,
    body: &str,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Content-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Connection: close\r\n\r\n\
         {body}",
        body.len()
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpStream;

    const RFC7636_VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const RFC7636_CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const FIXTURE_STATE: &str = "state_alpha_bravo_charlie_0001";
    const FIXTURE_AUTH_CODE: &str = "code_delta_echo_foxtrot_9999";

    #[test]
    fn computes_exact_rfc7636_appendix_b_pkce_s256_challenge() {
        let challenge = pkce_s256_challenge(RFC7636_VERIFIER).unwrap();
        assert_eq!(challenge, RFC7636_CHALLENGE);
        assert_eq!(
            pkce_s256_challenge("too-short"),
            Err(OidcLoopbackError::InvalidCodeVerifier)
        );
    }

    #[test]
    fn enforces_issuer_allowlist_and_validates_loopback_and_kodera_callbacks() {
        let allowlist = OidcIssuerAllowlist::kodera_default();
        let policy = DeepLinkAdmissionPolicy::kodera_default();

        // Rejects untrusted / non-HTTPS / credentialed / path-bearing issuer origins.
        assert_eq!(
            OidcPkceSession::start(
                &allowlist,
                "https://evil.example.org",
                "kodera-desktop",
                RFC7636_VERIFIER,
                FIXTURE_STATE,
                49152
            ),
            Err(OidcLoopbackError::UntrustedIssuerOrigin)
        );
        assert_eq!(
            OidcPkceSession::start(
                &allowlist,
                "http://auth.kodera.io",
                "kodera-desktop",
                RFC7636_VERIFIER,
                FIXTURE_STATE,
                49152
            ),
            Err(OidcLoopbackError::InvalidIssuerOrigin)
        );

        let (session, ready) = OidcPkceSession::start(
            &allowlist,
            "https://auth.kodera.io",
            "kodera-desktop",
            RFC7636_VERIFIER,
            FIXTURE_STATE,
            51920,
        )
        .unwrap();
        assert_eq!(ready.code_challenge, RFC7636_CHALLENGE);
        assert_eq!(ready.code_challenge_method, "S256");
        assert_eq!(ready.redirect_uri, "http://127.0.0.1:51920/auth/callback");
        assert!(!format!("{session:?}").contains(RFC7636_VERIFIER));

        // Rejects dangerous schemes, wrong host, wrong port, open redirects, and state mismatch.
        for (bad_uri, expected_err) in [
            (
                "javascript:alert(1)",
                OidcLoopbackError::UnsupportedScheme,
            ),
            (
                "data:text/html,<script>alert(1)</script>",
                OidcLoopbackError::UnsupportedScheme,
            ),
            (
                "file:///etc/passwd",
                OidcLoopbackError::UnsupportedScheme,
            ),
            (
                "http://localhost:51920/auth/callback?code=code_delta_echo_foxtrot_9999&state=state_alpha_bravo_charlie_0001",
                OidcLoopbackError::UntrustedCallbackHost,
            ),
            (
                "http://0.0.0.0:51920/auth/callback?code=code_delta_echo_foxtrot_9999&state=state_alpha_bravo_charlie_0001",
                OidcLoopbackError::UntrustedCallbackHost,
            ),
            (
                "http://127.0.0.1:51921/auth/callback?code=code_delta_echo_foxtrot_9999&state=state_alpha_bravo_charlie_0001",
                OidcLoopbackError::PortMismatch,
            ),
            (
                "http://127.0.0.1:51920/auth/callback?code=code_delta_echo_foxtrot_9999&state=state_alpha_bravo_charlie_0001&redirect_uri=https://evil.example",
                OidcLoopbackError::OpenRedirectDetected,
            ),
            (
                "kodera://auth/callback?code=code_delta_echo_foxtrot_9999&state=state_alpha_bravo_charlie_0001&next=https://evil.example",
                OidcLoopbackError::OpenRedirectDetected,
            ),
            (
                "http://127.0.0.1:51920/auth/callback?code=code_delta_echo_foxtrot_9999&state=wrong_state_value_000000000",
                OidcLoopbackError::StateMismatch,
            ),
        ] {
            assert_eq!(
                session
                    .clone()
                    .consume_callback_uri(bad_uri, &policy)
                    .unwrap_err(),
                expected_err,
                "expected {expected_err:?} for {bad_uri}"
            );
        }

        // Admits valid loopback callback and redacts authorization code + verifier in Debug.
        let ok_loopback = session
            .clone()
            .consume_callback_uri(
                &format!(
                    "http://127.0.0.1:51920/auth/callback?code={FIXTURE_AUTH_CODE}&state={FIXTURE_STATE}"
                ),
                &policy,
            )
            .unwrap();
        assert_eq!(
            ok_loopback.authorization_code.expose_for_token_exchange(),
            FIXTURE_AUTH_CODE
        );
        assert!(!format!("{ok_loopback:?}").contains(FIXTURE_AUTH_CODE));
        assert!(!format!("{ok_loopback:?}").contains(RFC7636_VERIFIER));

        // Admits valid `kodera://auth/callback` deep-link callback too.
        let ok_scheme = session
            .consume_callback_uri(
                &format!(
                    "kodera://auth/callback?code={FIXTURE_AUTH_CODE}&state={FIXTURE_STATE}&origin=kodera.io"
                ),
                &policy,
            )
            .unwrap();
        assert_eq!(ok_scheme.redirect_uri, "kodera://auth/callback");
    }

    #[test]
    fn real_loopback_tcp_listener_accepts_valid_callback_and_refuses_dns_rebinding_host() {
        let allowlist = OidcIssuerAllowlist::kodera_default();
        let policy = DeepLinkAdmissionPolicy::kodera_default();

        // 1. Valid loopback HTTP callback over real 127.0.0.1 socket.
        let listener = OidcLoopbackListener::bind_ephemeral().unwrap();
        let port = listener.port();
        let (session, _) = OidcPkceSession::start(
            &allowlist,
            "https://auth.kodera.io",
            "kodera-desktop",
            RFC7636_VERIFIER,
            FIXTURE_STATE,
            port,
        )
        .unwrap();

        let client_handle = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            let req = format!(
                "GET /auth/callback?code={FIXTURE_AUTH_CODE}&state={FIXTURE_STATE} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(req.as_bytes()).unwrap();
            let mut resp = String::new();
            stream.read_to_string(&mut resp).unwrap();
            resp
        });

        let outcome = listener.accept_once(session, &policy, 2000).unwrap();
        let http_resp = client_handle.join().unwrap();
        assert!(http_resp.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(http_resp.contains("Cache-Control: no-store"));
        assert!(http_resp.contains("Content-Security-Policy: default-src 'none'"));
        assert_eq!(
            outcome.authorization_code.expose_for_token_exchange(),
            FIXTURE_AUTH_CODE
        );

        // 2. DNS-rebinding Host header spoofing (`Host: evil.rebind.test`) is refused with 400.
        let listener_rebind = OidcLoopbackListener::bind_ephemeral().unwrap();
        let rebind_port = listener_rebind.port();
        let (session_rebind, _) = OidcPkceSession::start(
            &allowlist,
            "https://auth.kodera.io",
            "kodera-desktop",
            RFC7636_VERIFIER,
            FIXTURE_STATE,
            rebind_port,
        )
        .unwrap();

        let attacker = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(("127.0.0.1", rebind_port)).unwrap();
            let req = format!(
                "GET /auth/callback?code={FIXTURE_AUTH_CODE}&state={FIXTURE_STATE} HTTP/1.1\r\nHost: evil.rebind.test:{rebind_port}\r\n\r\n"
            );
            stream.write_all(req.as_bytes()).unwrap();
            let mut resp = String::new();
            let _ = stream.read_to_string(&mut resp);
            resp
        });

        let rebind_err = listener_rebind
            .accept_once(session_rebind, &policy, 2000)
            .unwrap_err();
        let attacker_resp = attacker.join().unwrap();
        assert_eq!(rebind_err, OidcLoopbackError::UntrustedCallbackHost);
        assert!(attacker_resp.starts_with("HTTP/1.1 400 Bad Request"));

        // 3. RFC 9112 §3.2 duplicate Host header smuggling (`Host: 127.0.0.1:<port>` x2) is refused with 400.
        let listener_dup = OidcLoopbackListener::bind_ephemeral().unwrap();
        let dup_port = listener_dup.port();
        let (session_dup, _) = OidcPkceSession::start(
            &allowlist,
            "https://auth.kodera.io",
            "kodera-desktop",
            RFC7636_VERIFIER,
            FIXTURE_STATE,
            dup_port,
        )
        .unwrap();

        let dup_client = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(("127.0.0.1", dup_port)).unwrap();
            let req = format!(
                "GET /auth/callback?code={FIXTURE_AUTH_CODE}&state={FIXTURE_STATE} HTTP/1.1\r\nHost: 127.0.0.1:{dup_port}\r\nHost: 127.0.0.1:{dup_port}\r\n\r\n"
            );
            stream.write_all(req.as_bytes()).unwrap();
            let mut resp = String::new();
            let _ = stream.read_to_string(&mut resp);
            resp
        });

        let dup_err = listener_dup
            .accept_once(session_dup, &policy, 2000)
            .unwrap_err();
        let dup_resp = dup_client.join().unwrap();
        assert_eq!(dup_err, OidcLoopbackError::UntrustedCallbackHost);
        assert!(dup_resp.starts_with("HTTP/1.1 400 Bad Request"));
        assert!(dup_resp.contains("Duplicate Host"));
    }
}
