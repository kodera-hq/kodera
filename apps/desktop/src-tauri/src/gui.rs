//! Native cross-platform OS WebView window runtime, custom asset protocol, navigation security
//! guard, and JavaScript IPC invoke bridge (`window.__TAURI_INTERNALS__` + `window.koderaDesktop`).
//!
//! Security invariants:
//! - Every navigation request and IPC sender URL is checked through [`validate_navigation_url`]
//!   with fail-closed rejection of `javascript:`, `data:`, `file:`, `vbscript:`, `blob:`, `about:`,
//!   cleartext `http:` (unless explicit local dev mode is enabled for `127.0.0.1:5173` /
//!   `localhost:5173`), embedded `@` credentials, path traversal (`..`, `%2e`, `%2f`, `%5c`), and
//!   non-allowlisted external hosts.
//! - `kodera://` and `matrix:` protocol navigations inside the WebView are intercepted through
//!   [`crate::deeplink::route_deep_link`], blocked from direct browser navigation, and forwarded
//!   as canonical deep-link events to registered WebView listeners.
//! - Embedded and bundled static assets served over `kodera-asset://localhost/*` always attach the
//!   verified `tauri.conf.json` Content Security Policy (`default-src 'self'; style-src 'self'`,
//!   zero `'unsafe-eval'`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and
//!   `Cache-Control: no-store`.

use crate::{
    route_deep_link, AdmittedDeepLink, DeepLinkAdmissionPolicy, DeepLinkError, DesktopShellHost,
    RestoredWindowPlacement, DESKTOP_APP_IDENTIFIER, DESKTOP_APP_VERSION, DESKTOP_PRODUCT_NAME,
    MAX_IPC_COMMAND_BYTES,
};
use core::fmt;
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};

/// Native desktop window title when unread count is zero.
pub const DESKTOP_WINDOW_TITLE: &str = DESKTOP_PRODUCT_NAME;

/// Default logical desktop window width (`1280px`).
pub const GUI_DEFAULT_WIDTH: u32 = 1280;

/// Default logical desktop window height (`820px`).
pub const GUI_DEFAULT_HEIGHT: u32 = 820;

/// Minimum logical desktop window width (`900px`).
pub const GUI_MIN_WIDTH: u32 = 900;

/// Minimum logical desktop window height (`600px`).
pub const GUI_MIN_HEIGHT: u32 = 600;

/// Custom asset protocol scheme registered on the native OS WebView.
pub const CUSTOM_ASSET_SCHEME: &str = "kodera-asset";

/// Maximum UTF-8 byte length accepted by [`validate_navigation_url`].
pub const MAX_NAVIGATION_URL_BYTES: usize = 2048;

/// Maximum concurrent native event listeners registered by the WebView.
pub const MAX_REGISTERED_EVENT_LISTENERS: usize = 64;

/// Maximum startup/intercepted deep links buffered while waiting for JS listener registration.
pub const MAX_PENDING_DEEP_LINKS: usize = 16;

/// Maximum static asset file size served from `apps/web/dist` (`32 MiB`).
const MAX_STATIC_ASSET_BYTES: u64 = 32 * 1024 * 1024;

/// Production HTTPS origins permitted to load as top-level Kodera Web documents.
pub const APPROVED_WEB_APP_ORIGINS: [&str; 3] = [
    "https://app.kodera.io",
    "https://staging.kodera.io",
    "https://community.kodera.io",
];

/// Path-scoped OIDC identity origin permitted during native authentication redirects.
pub const APPROVED_AUTH_ORIGIN_PREFIX: &str = "https://auth.kodera.io/realms/";

/// Local Vite dev server origins permitted strictly when `allow_dev_origin` is enabled.
pub const APPROVED_DEV_ORIGINS: [&str; 2] = ["http://localhost:5173", "http://127.0.0.1:5173"];

const DANGEROUS_SCHEMES: [&str; 9] = [
    "javascript",
    "data",
    "file",
    "vbscript",
    "blob",
    "about",
    "chrome",
    "edge",
    "view-source",
];

const BOOTSTRAP_INDEX_HTML: &str = r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Kodera</title>
    <link rel="stylesheet" href="/bootstrap.css" />
    <script src="/bootstrap.js" defer></script>
  </head>
  <body>
    <main class="shell-card" aria-labelledby="shell-title">
      <header class="shell-header">
        <div class="monogram" aria-hidden="true">K</div>
        <div>
          <p class="eyebrow">Sovereign Real-Time Workspace</p>
          <h1 id="shell-title">Kodera Desktop</h1>
        </div>
      </header>
      <p class="lead">
        Native desktop host active with strict Content Security Policy, deep-link filtering,
        OS keychain isolation, and multi-monitor window state protection.
      </p>
      <dl class="meta-grid">
        <div>
          <dt>Runtime</dt>
          <dd id="runtime-version">Connecting to native host...</dd>
        </div>
        <div>
          <dt>Audio Mute</dt>
          <dd id="mute-status">Unmuted</dd>
        </div>
        <div>
          <dt>Last Deep Link</dt>
          <dd id="deep-link-status">None received</dd>
        </div>
      </dl>
      <div class="actions">
        <a class="btn btn-primary" href="https://app.kodera.io/">Open Kodera Web</a>
        <button id="btn-toggle-mute" class="btn" type="button">Toggle Mute</button>
        <button id="btn-clear-unread" class="btn" type="button">Clear Unread Badge</button>
        <button id="btn-quit" class="btn btn-danger" type="button">Quit Kodera</button>
      </div>
    </main>
  </body>
</html>
"#;

const BOOTSTRAP_CSS: &str = r#":root {
  color-scheme: light;
  font-family: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background-color: #f8fafc;
  color: #0f172a;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%);
}

.shell-card {
  width: 100%;
  max-width: 680px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  padding: 32px;
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.06);
}

.shell-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}

.monogram {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  background: #2563eb;
  color: #ffffff;
  font-weight: 700;
  font-size: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.eyebrow {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #2563eb;
}

h1 {
  margin: 2px 0 0;
  font-size: 24px;
  line-height: 1.25;
}

.lead {
  margin: 0 0 24px;
  color: #475569;
  line-height: 1.6;
  font-size: 15px;
}

.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin: 0 0 24px;
}

.meta-grid > div {
  padding: 12px 14px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
}

dt {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
  margin-bottom: 4px;
}

dd {
  margin: 0;
  font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  color: #0f172a;
  word-break: break-all;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.btn {
  appearance: none;
  border: 1px solid #cbd5e1;
  background: #ffffff;
  color: #0f172a;
  border-radius: 10px;
  padding: 10px 16px;
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}

.btn:hover {
  background: #f1f5f9;
}

.btn-primary {
  background: #2563eb;
  border-color: #2563eb;
  color: #ffffff;
}

.btn-primary:hover {
  background: #1d4ed8;
}

.btn-danger {
  border-color: #fecaca;
  color: #b91c1c;
}

.btn-danger:hover {
  background: #fef2f2;
}
"#;

const BOOTSTRAP_JS: &str = r#"(function () {
  const DEFAULT_ORG = '019a5e62-6ca0-7303-8303-030303030303';
  const runtimeEl = document.getElementById('runtime-version');
  const muteEl = document.getElementById('mute-status');
  const deepLinkEl = document.getElementById('deep-link-status');
  const bridge = window.koderaDesktop;

  if (!bridge || typeof bridge.invoke !== 'function') {
    if (runtimeEl) runtimeEl.textContent = 'Bridge unavailable';
    return;
  }

  bridge.invoke('get_app_metadata', {}).then(function (meta) {
    if (runtimeEl && meta) {
      runtimeEl.textContent = meta.productName + ' v' + meta.version + ' (' + meta.identifier + ')';
    }
  }).catch(function () {
    if (runtimeEl) runtimeEl.textContent = 'Metadata error';
  });

  bridge.onEvent('kodera://deep-link', function (uri) {
    if (deepLinkEl && typeof uri === 'string') {
      deepLinkEl.textContent = uri;
    }
  });

  const btnMute = document.getElementById('btn-toggle-mute');
  if (btnMute) {
    btnMute.addEventListener('click', function () {
      bridge.invoke('trigger_tray_menu_action', {
        organisation_id: DEFAULT_ORG,
        action: 'toggle_mute'
      }).then(function (res) {
        if (muteEl && res && typeof res.muted === 'boolean') {
          muteEl.textContent = res.muted ? 'Muted' : 'Unmuted';
        }
      });
    });
  }

  const btnClear = document.getElementById('btn-clear-unread');
  if (btnClear) {
    btnClear.addEventListener('click', function () {
      bridge.invoke('set_unread_badge', {
        organisation_id: DEFAULT_ORG,
        unread_count: 0
      });
    });
  }

  const btnQuit = document.getElementById('btn-quit');
  if (btnQuit) {
    btnQuit.addEventListener('click', function () {
      bridge.invoke('quit', {});
    });
  }
})();
"#;

const IPC_INIT_SCRIPT: &str = r#"(function () {
  if (typeof window === 'undefined' || window.__KODERA_IPC_READY__ === true) {
    return;
  }
  const pending = new Map();
  const callbacks = new Map();
  let nextReqId = 1;
  let nextCbId = 1;

  function postEnvelope(reqId, cmd, payloadObj) {
    if (!window.ipc || typeof window.ipc.postMessage !== 'function') {
      return false;
    }
    const line = String(reqId) + '\t' + String(cmd) + '\n' + JSON.stringify(payloadObj);
    window.ipc.postMessage(line);
    return true;
  }

  function sanitizeFlatArgs(cmd, rawArgs) {
    const out = { command: String(cmd) };
    if (rawArgs && typeof rawArgs === 'object') {
      for (const [k, v] of Object.entries(rawArgs)) {
        if (k === 'command' || v === undefined || v === null) {
          continue;
        }
        out[k] = v;
      }
    }
    return out;
  }

  function invoke(cmd, args) {
    return new Promise(function (resolve, reject) {
      if (typeof cmd !== 'string' || cmd.length === 0 || cmd.length > 64) {
        reject(new Error('invalid_ipc_command'));
        return;
      }
      const reqId = nextReqId++;
      let payload;
      if (cmd === 'plugin:event|listen') {
        payload = {
          event: typeof (args && args.event) === 'string' ? args.event : '',
          handler: Number((args && args.handler) || 0)
        };
      } else if (cmd === 'plugin:event|unlisten') {
        payload = {
          event: typeof (args && args.event) === 'string' ? args.event : '',
          eventId: Number((args && args.eventId) || 0)
        };
      } else {
        payload = sanitizeFlatArgs(cmd, args);
      }
      pending.set(reqId, { resolve: resolve, reject: reject });
      if (!postEnvelope(reqId, cmd, payload)) {
        pending.delete(reqId);
        reject(new Error('ipc_transport_unavailable'));
      }
    });
  }

  function transformCallback(cb, once) {
    if (typeof cb !== 'function') {
      throw new TypeError('invalid_callback');
    }
    const id = nextCbId++;
    callbacks.set(id, { cb: cb, once: Boolean(once) });
    return id;
  }

  function onEvent(eventName, listener) {
    const handlerId = transformCallback(listener, false);
    const regPromise = invoke('plugin:event|listen', {
      event: eventName,
      target: { kind: 'Any' },
      handler: handlerId
    });
    return function () {
      return regPromise.then(function (eventId) {
        callbacks.delete(handlerId);
        return invoke('plugin:event|unlisten', { event: eventName, eventId: eventId });
      });
    };
  }

  Object.defineProperty(window, '__KODERA_IPC_READY__', {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  Object.defineProperty(window, '__KODERA_IPC_RESOLVE__', {
    value: function (reqId, ok, payload) {
      const entry = pending.get(reqId);
      if (!entry) {
        return;
      }
      pending.delete(reqId);
      if (ok) {
        entry.resolve(payload);
      } else {
        const message = (payload && typeof payload.error === 'string')
          ? payload.error
          : 'ipc_command_failed';
        entry.reject(new Error(message));
      }
    },
    configurable: false,
    enumerable: false,
    writable: false
  });

  Object.defineProperty(window, '__KODERA_IPC_DISPATCH_EVENT__', {
    value: function (cbId, payload) {
      const entry = callbacks.get(cbId);
      if (!entry) {
        return;
      }
      if (entry.once) {
        callbacks.delete(cbId);
      }
      try {
        entry.cb({ payload: payload });
      } catch (_err) {
        // Listener exceptions stay isolated inside userland.
      }
    },
    configurable: false,
    enumerable: false,
    writable: false
  });

  const tauriInternals = Object.freeze({
    invoke: invoke,
    transformCallback: transformCallback
  });

  const koderaDesktop = Object.freeze({
    identifier: 'io.kodera.desktop',
    productName: 'Kodera',
    version: '0.1.0',
    invoke: invoke,
    onEvent: onEvent
  });

  if (!Object.prototype.hasOwnProperty.call(window, '__TAURI_INTERNALS__')) {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: tauriInternals,
      configurable: false,
      enumerable: false,
      writable: false
    });
  }

  if (!Object.prototype.hasOwnProperty.call(window, 'koderaDesktop')) {
    Object.defineProperty(window, 'koderaDesktop', {
      value: koderaDesktop,
      configurable: false,
      enumerable: true,
      writable: false
    });
  }
})();
"#;

/// Closed refusal codes for the WebView navigation security guard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NavigationGuardError {
    EmptyUrl,
    UrlTooLarge,
    ControlOrWhitespace,
    DangerousScheme,
    UnsupportedScheme,
    EmbeddedCredentials,
    PathTraversal,
    UntrustedOrigin,
    RejectedDeepLink(DeepLinkError),
}

impl fmt::Display for NavigationGuardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyUrl => f.write_str("empty_url"),
            Self::UrlTooLarge => f.write_str("url_too_large"),
            Self::ControlOrWhitespace => f.write_str("control_or_whitespace"),
            Self::DangerousScheme => f.write_str("dangerous_scheme"),
            Self::UnsupportedScheme => f.write_str("unsupported_scheme"),
            Self::EmbeddedCredentials => f.write_str("embedded_credentials"),
            Self::PathTraversal => f.write_str("path_traversal"),
            Self::UntrustedOrigin => f.write_str("untrusted_origin"),
            Self::RejectedDeepLink(err) => write!(f, "rejected_deep_link:{err}"),
        }
    }
}

impl std::error::Error for NavigationGuardError {}

/// Policy outcome for a candidate WebView navigation URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NavigationDecision {
    /// Internal bundled/bootstrap asset on `kodera-asset://localhost/...`.
    AllowInternalAsset { normalized_path: String },
    /// Approved Kodera Web HTTPS origin (or explicit local Vite dev origin in dev mode).
    AllowTrustedWebOrigin { origin: String },
    /// Validated `kodera://` or `matrix:` URI intercepted for in-app routing instead of navigation.
    InterceptDeepLink(AdmittedDeepLink),
}

/// Validates any URL before loading it into the native WebView, admitting navigation, or accepting
/// an IPC message from its frame. Fails closed on unknown schemes, untrusted origins, credentials,
/// and traversal sequences.
pub fn validate_navigation_url(
    raw_url: &str,
    policy: &DeepLinkAdmissionPolicy,
    allow_dev_origin: bool,
) -> Result<NavigationDecision, NavigationGuardError> {
    if raw_url.is_empty() {
        return Err(NavigationGuardError::EmptyUrl);
    }
    if raw_url.len() > MAX_NAVIGATION_URL_BYTES {
        return Err(NavigationGuardError::UrlTooLarge);
    }
    if raw_url
        .bytes()
        .any(|b| b <= 0x20 || b >= 0x7F || b == b'\\')
    {
        return Err(NavigationGuardError::ControlOrWhitespace);
    }
    if contains_forbidden_percent_escape(raw_url) {
        return Err(NavigationGuardError::PathTraversal);
    }

    let Some((scheme_raw, _after_colon)) = raw_url.split_once(':') else {
        return Err(NavigationGuardError::UnsupportedScheme);
    };
    if scheme_raw.is_empty() {
        return Err(NavigationGuardError::UnsupportedScheme);
    }
    let scheme_lower = scheme_raw.to_ascii_lowercase();
    if DANGEROUS_SCHEMES.contains(&scheme_lower.as_str()) {
        return Err(NavigationGuardError::DangerousScheme);
    }

    if scheme_lower == "kodera" || scheme_lower == "matrix" {
        if scheme_raw != scheme_lower {
            return Err(NavigationGuardError::UnsupportedScheme);
        }
        return route_deep_link(raw_url, policy)
            .map(NavigationDecision::InterceptDeepLink)
            .map_err(NavigationGuardError::RejectedDeepLink);
    }

    if scheme_lower == CUSTOM_ASSET_SCHEME {
        let Some(rest) = raw_url
            .get(CUSTOM_ASSET_SCHEME.len()..)
            .and_then(|s| s.strip_prefix("://"))
        else {
            return Err(NavigationGuardError::UntrustedOrigin);
        };
        return validate_internal_asset_authority_and_path(rest);
    }

    if scheme_lower == "https" || scheme_lower == "http" {
        let prefix_len = scheme_raw.len() + 3;
        if !raw_url[scheme_raw.len()..].starts_with("://") {
            return Err(NavigationGuardError::UnsupportedScheme);
        }
        let after_slashes = &raw_url[prefix_len..];
        let (authority, path_and_more) = split_authority_and_tail(after_slashes);
        if authority.is_empty() {
            return Err(NavigationGuardError::UntrustedOrigin);
        }
        if authority.contains('@') {
            return Err(NavigationGuardError::EmbeddedCredentials);
        }
        let authority_lower = authority.to_ascii_lowercase();

        // Windows WebView2 maps custom protocol `kodera-asset://localhost/...` onto
        // `https://kodera-asset.localhost/...` or `http://kodera-asset.localhost/...`.
        if authority_lower == "kodera-asset.localhost" {
            let normalized_path = normalize_asset_path(path_and_more)?;
            return Ok(NavigationDecision::AllowInternalAsset { normalized_path });
        }

        validate_url_path_segments(path_and_more)?;

        if scheme_lower == "https" {
            let candidate_origin = format!("https://{authority_lower}");
            if APPROVED_WEB_APP_ORIGINS.contains(&candidate_origin.as_str()) {
                return Ok(NavigationDecision::AllowTrustedWebOrigin {
                    origin: candidate_origin,
                });
            }
            let normalized_full = format!("https://{authority_lower}{path_and_more}");
            if normalized_full.starts_with(APPROVED_AUTH_ORIGIN_PREFIX) {
                return Ok(NavigationDecision::AllowTrustedWebOrigin {
                    origin: "https://auth.kodera.io".to_owned(),
                });
            }
            return Err(NavigationGuardError::UntrustedOrigin);
        }

        // Cleartext `http:` is unconditionally rejected unless explicit local dev mode is active.
        if allow_dev_origin {
            let candidate_origin = format!("http://{authority_lower}");
            if APPROVED_DEV_ORIGINS.contains(&candidate_origin.as_str()) {
                return Ok(NavigationDecision::AllowTrustedWebOrigin {
                    origin: candidate_origin,
                });
            }
        }
        return Err(NavigationGuardError::UntrustedOrigin);
    }

    Err(NavigationGuardError::UnsupportedScheme)
}

fn validate_internal_asset_authority_and_path(
    rest: &str,
) -> Result<NavigationDecision, NavigationGuardError> {
    let (authority, tail) = split_authority_and_tail(rest);
    if authority.contains('@') {
        return Err(NavigationGuardError::EmbeddedCredentials);
    }
    if !authority.eq_ignore_ascii_case("localhost") {
        return Err(NavigationGuardError::UntrustedOrigin);
    }
    let normalized_path = normalize_asset_path(tail)?;
    Ok(NavigationDecision::AllowInternalAsset { normalized_path })
}

fn split_authority_and_tail(input: &str) -> (&str, &str) {
    let split_idx = input.find(['/', '?', '#']).unwrap_or(input.len());
    (&input[..split_idx], &input[split_idx..])
}

fn validate_url_path_segments(tail: &str) -> Result<(), NavigationGuardError> {
    let path_only = tail.split(['?', '#']).next().unwrap_or("");
    for seg in path_only.split('/') {
        if seg == ".." {
            return Err(NavigationGuardError::PathTraversal);
        }
    }
    Ok(())
}

fn normalize_asset_path(tail: &str) -> Result<String, NavigationGuardError> {
    let path_only = tail.split(['?', '#']).next().unwrap_or("");
    if path_only.is_empty() || path_only == "/" {
        return Ok("/index.html".to_owned());
    }
    if !path_only.starts_with('/') {
        return Err(NavigationGuardError::UntrustedOrigin);
    }
    let mut segments = Vec::new();
    for seg in path_only.split('/').skip(1) {
        if seg.is_empty() || seg == "." {
            return Err(NavigationGuardError::PathTraversal);
        }
        if seg == ".." {
            return Err(NavigationGuardError::PathTraversal);
        }
        if !seg
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'@'))
        {
            return Err(NavigationGuardError::PathTraversal);
        }
        segments.push(seg);
    }
    Ok(format!("/{}", segments.join("/")))
}

fn contains_forbidden_percent_escape(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    let mut idx = 0;
    while idx + 2 < bytes.len() {
        if bytes[idx] == b'%' {
            let hi = bytes[idx + 1].to_ascii_lowercase();
            let lo = bytes[idx + 2].to_ascii_lowercase();
            let pair = [hi, lo];
            // Control bytes %00-%1f, %7f, dot %2e, slash %2f, backslash %5c.
            if matches!(hi, b'0' | b'1') && lo.is_ascii_hexdigit() {
                return true;
            }
            if pair == *b"7f" || pair == *b"2e" || pair == *b"2f" || pair == *b"5c" {
                return true;
            }
        }
        idx += 1;
    }
    false
}

/// Returns the JavaScript main-frame initialization bridge exposing `window.__TAURI_INTERNALS__`
/// and `window.koderaDesktop`.
pub const fn build_ipc_init_script() -> &'static str {
    IPC_INIT_SCRIPT
}

/// HTTP payload served by the `kodera-asset://` custom protocol handler.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetHttpPayload {
    pub status: u16,
    pub content_type: &'static str,
    pub csp_header: String,
    pub body: Vec<u8>,
}

/// Resolves a `kodera-asset://localhost/<path>` request against an optional `apps/web/dist`
/// bundle directory (enforcing canonical path containment) or falls back to the CSP-clean
/// embedded Kodera Desktop bootstrap shell.
pub fn resolve_asset_response(
    asset_root: Option<&Path>,
    raw_request_path: &str,
    embedded_csp: &str,
) -> AssetHttpPayload {
    let Ok(normalized) = normalize_asset_path(raw_request_path) else {
        return AssetHttpPayload {
            status: 400,
            content_type: "text/plain; charset=utf-8",
            csp_header: embedded_csp.to_owned(),
            body: b"invalid_asset_path".to_vec(),
        };
    };

    if let Some(root) = asset_root {
        if let Ok(canonical_root) = fs::canonicalize(root) {
            let relative = normalized.trim_start_matches('/');
            let candidate = canonical_root.join(relative);
            if let Some(bytes) = read_contained_asset(&canonical_root, &candidate) {
                return AssetHttpPayload {
                    status: 200,
                    content_type: mime_type_for_path(&normalized),
                    csp_header: embedded_csp.to_owned(),
                    body: bytes,
                };
            }
            let last_segment = normalized.rsplit('/').next().unwrap_or("");
            let index_candidate = canonical_root.join("index.html");
            if !last_segment.contains('.') {
                if let Some(index_bytes) = read_contained_asset(&canonical_root, &index_candidate) {
                    return AssetHttpPayload {
                        status: 200,
                        content_type: "text/html; charset=utf-8",
                        csp_header: embedded_csp.to_owned(),
                        body: index_bytes,
                    };
                }
            } else if index_candidate.is_file() {
                return AssetHttpPayload {
                    status: 404,
                    content_type: "text/plain; charset=utf-8",
                    csp_header: embedded_csp.to_owned(),
                    body: b"not_found".to_vec(),
                };
            }
        }
    }

    match normalized.as_str() {
        "/index.html" => AssetHttpPayload {
            status: 200,
            content_type: "text/html; charset=utf-8",
            csp_header: embedded_csp.to_owned(),
            body: BOOTSTRAP_INDEX_HTML.as_bytes().to_vec(),
        },
        "/bootstrap.css" => AssetHttpPayload {
            status: 200,
            content_type: "text/css; charset=utf-8",
            csp_header: embedded_csp.to_owned(),
            body: BOOTSTRAP_CSS.as_bytes().to_vec(),
        },
        "/bootstrap.js" => AssetHttpPayload {
            status: 200,
            content_type: "text/javascript; charset=utf-8",
            csp_header: embedded_csp.to_owned(),
            body: BOOTSTRAP_JS.as_bytes().to_vec(),
        },
        _ => AssetHttpPayload {
            status: 404,
            content_type: "text/plain; charset=utf-8",
            csp_header: embedded_csp.to_owned(),
            body: b"not_found".to_vec(),
        },
    }
}

fn read_contained_asset(canonical_root: &Path, candidate: &Path) -> Option<Vec<u8>> {
    let canonical_file = fs::canonicalize(candidate).ok()?;
    if !canonical_file.starts_with(canonical_root) || !canonical_file.is_file() {
        return None;
    }
    let meta = fs::metadata(&canonical_file).ok()?;
    if meta.len() > MAX_STATIC_ASSET_BYTES {
        return None;
    }
    fs::read(&canonical_file).ok()
}

fn mime_type_for_path(path: &str) -> &'static str {
    if path.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if path.ends_with(".js") || path.ends_with(".mjs") {
        "text/javascript; charset=utf-8"
    } else if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".ico") {
        "image/x-icon"
    } else if path.ends_with(".woff2") {
        "font/woff2"
    } else if path.ends_with(".wasm") {
        "application/wasm"
    } else {
        "application/octet-stream"
    }
}

/// Native window side effect requested by an IPC command execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GuiWindowAction {
    ShowAndFocus,
    Hide,
    SetTitle(String),
    ApplyPlacement(RestoredWindowPlacement),
    Quit,
}

/// Closed refusal codes for incoming WebView `window.ipc.postMessage` requests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebViewIpcError {
    MessageTooLarge,
    UntrustedSenderOrigin,
    MalformedEnvelope,
    ListenerLimitReached,
}

impl fmt::Display for WebViewIpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let slug = match self {
            Self::MessageTooLarge => "message_too_large",
            Self::UntrustedSenderOrigin => "untrusted_sender_origin",
            Self::MalformedEnvelope => "malformed_envelope",
            Self::ListenerLimitReached => "listener_limit_reached",
        };
        f.write_str(slug)
    }
}

impl std::error::Error for WebViewIpcError {}

/// Evaluated result of one WebView IPC request: JavaScript scripts to run on the main frame plus
/// an optional native OS window side effect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebViewIpcOutcome {
    pub eval_scripts: Vec<String>,
    pub window_action: Option<GuiWindowAction>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RegisteredListener {
    event_id: u64,
    event_name: String,
    callback_id: u64,
}

/// Stateful WebView IPC router bridging `window.__TAURI_INTERNALS__` and `window.koderaDesktop`
/// to [`DesktopShellHost`] after strict sender-origin validation.
pub struct DesktopWebViewBridge {
    host: DesktopShellHost,
    policy: DeepLinkAdmissionPolicy,
    allow_dev_origin: bool,
    next_event_id: u64,
    listeners: Vec<RegisteredListener>,
    pending_deep_links: VecDeque<String>,
}

impl DesktopWebViewBridge {
    pub fn new(allow_dev_origin: bool, initial_deep_link: Option<AdmittedDeepLink>) -> Self {
        let mut pending_deep_links = VecDeque::new();
        if let Some(admitted) = initial_deep_link {
            pending_deep_links.push_back(admitted.canonical_uri().to_owned());
        }
        Self {
            host: DesktopShellHost::new(),
            policy: DeepLinkAdmissionPolicy::kodera_default(),
            allow_dev_origin,
            next_event_id: 1,
            listeners: Vec::new(),
            pending_deep_links,
        }
    }

    pub fn clear_session(&mut self) {
        self.host.clear_active_session();
    }

    /// Replaces the local `docker` CLI runner on the active host session (deterministic test seam).
    pub fn configure_community_runner(
        &mut self,
        organisation_id: &str,
        runner: std::sync::Arc<dyn crate::CommunityCommandRunner>,
    ) -> bool {
        self.host
            .configure_community_runner(organisation_id, runner)
    }

    /// Dispatches an admitted `kodera://` or `matrix:` deep link to active WebView listeners, or
    /// buffers it (bounded) until the web shell registers its `'kodera://deep-link'` listener.
    pub fn enqueue_deep_link(&mut self, admitted: AdmittedDeepLink) -> Vec<String> {
        let canonical = admitted.canonical_uri().to_owned();
        let scripts = self.dispatch_event_scripts("kodera://deep-link", &canonical);
        if scripts.is_empty() {
            if self.pending_deep_links.len() >= MAX_PENDING_DEEP_LINKS {
                self.pending_deep_links.pop_front();
            }
            self.pending_deep_links.push_back(canonical);
        }
        scripts
    }

    /// Validates the WebView frame URL and executes a framed IPC request (`<id>\t<cmd>\n<json>`).
    pub fn handle_ipc_request(
        &mut self,
        sender_url: &str,
        raw_message: &str,
    ) -> Result<WebViewIpcOutcome, WebViewIpcError> {
        if raw_message.len() > MAX_IPC_COMMAND_BYTES {
            return Err(WebViewIpcError::MessageTooLarge);
        }
        match validate_navigation_url(sender_url, &self.policy, self.allow_dev_origin) {
            Ok(
                NavigationDecision::AllowInternalAsset { .. }
                | NavigationDecision::AllowTrustedWebOrigin { .. },
            ) => {}
            _ => return Err(WebViewIpcError::UntrustedSenderOrigin),
        }

        let Some((header_line, json_body)) = raw_message.split_once('\n') else {
            return Err(WebViewIpcError::MalformedEnvelope);
        };
        let Some((req_id_str, cmd_raw)) = header_line.split_once('\t') else {
            return Err(WebViewIpcError::MalformedEnvelope);
        };
        let req_id: u64 = req_id_str
            .parse()
            .map_err(|_| WebViewIpcError::MalformedEnvelope)?;
        if req_id == 0 || req_id > 9_007_199_254_740_991 {
            return Err(WebViewIpcError::MalformedEnvelope);
        }
        if cmd_raw.is_empty()
            || cmd_raw.len() > 64
            || !cmd_raw
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b':' | b'|'))
        {
            return Err(WebViewIpcError::MalformedEnvelope);
        }

        let mut eval_scripts = Vec::new();
        let mut window_action = None;

        match cmd_raw {
            "get_app_metadata" => {
                let payload = format!(
                    r#"{{"identifier":"{}","productName":"{}","version":"{}","updateChannel":"stable","updateAvailable":false,"isNativeDesktop":true,"schemes":["kodera","matrix"]}}"#,
                    DESKTOP_APP_IDENTIFIER, DESKTOP_PRODUCT_NAME, DESKTOP_APP_VERSION,
                );
                eval_scripts.push(resolve_js_promise(req_id, true, &payload));
            }
            "check_app_updates" => {
                let payload = format!(
                    r#"{{"supported":true,"updateAvailable":false,"currentVersion":"{}","latestVersion":null,"channel":"stable"}}"#,
                    DESKTOP_APP_VERSION,
                );
                eval_scripts.push(resolve_js_promise(req_id, true, &payload));
            }
            "plugin:event|listen" => {
                let Some(event_name) = extract_json_string_field(json_body, "event") else {
                    eval_scripts.push(resolve_js_promise(
                        req_id,
                        false,
                        r#"{"error":"invalid_event_name"}"#,
                    ));
                    return Ok(WebViewIpcOutcome {
                        eval_scripts,
                        window_action,
                    });
                };
                let Some(callback_id) = extract_json_u64_field(json_body, "handler") else {
                    eval_scripts.push(resolve_js_promise(
                        req_id,
                        false,
                        r#"{"error":"invalid_event_handler"}"#,
                    ));
                    return Ok(WebViewIpcOutcome {
                        eval_scripts,
                        window_action,
                    });
                };
                if callback_id == 0 || event_name.is_empty() || event_name.len() > 64 {
                    eval_scripts.push(resolve_js_promise(
                        req_id,
                        false,
                        r#"{"error":"invalid_event_registration"}"#,
                    ));
                    return Ok(WebViewIpcOutcome {
                        eval_scripts,
                        window_action,
                    });
                }
                if self.listeners.len() >= MAX_REGISTERED_EVENT_LISTENERS {
                    return Err(WebViewIpcError::ListenerLimitReached);
                }
                let event_id = self.next_event_id;
                self.next_event_id = self.next_event_id.saturating_add(1);
                self.listeners.push(RegisteredListener {
                    event_id,
                    event_name: event_name.clone(),
                    callback_id,
                });
                eval_scripts.push(resolve_js_promise(req_id, true, &event_id.to_string()));
                if event_name == "kodera://deep-link" {
                    while let Some(queued_uri) = self.pending_deep_links.pop_front() {
                        eval_scripts.push(dispatch_js_event(callback_id, &queued_uri));
                    }
                }
            }
            "plugin:event|unlisten" => {
                if let Some(event_id) = extract_json_u64_field(json_body, "eventId") {
                    self.listeners.retain(|entry| entry.event_id != event_id);
                }
                eval_scripts.push(resolve_js_promise(req_id, true, "null"));
            }
            "plugin:window|show"
            | "plugin:window|set_focus"
            | "plugin:window|unminimize"
            | "show_window" => {
                window_action = Some(GuiWindowAction::ShowAndFocus);
                eval_scripts.push(resolve_js_promise(req_id, true, r#"{"ok":true}"#));
            }
            "plugin:window|hide" | "hide_window" => {
                window_action = Some(GuiWindowAction::Hide);
                eval_scripts.push(resolve_js_promise(req_id, true, r#"{"ok":true}"#));
            }
            "plugin:window|close" | "quit" => {
                self.host.clear_active_session();
                window_action = Some(GuiWindowAction::Quit);
                eval_scripts.push(resolve_js_promise(
                    req_id,
                    true,
                    r#"{"ok":true,"quit":true}"#,
                ));
            }
            "init_session" => {
                if let Some(org_id) = extract_json_string_field(json_body, "organisation_id") {
                    let init_line = format!(
                        r#"{{"host_op":"init_session","organisation_id":"{}"}}"#,
                        escape_js_json_str(&org_id)
                    );
                    let (reply, _) = self.host.handle_stdio_line(&init_line);
                    let ok = reply.starts_with(r#"{"ok":true"#);
                    eval_scripts.push(resolve_js_promise(req_id, ok, &reply));
                } else {
                    eval_scripts.push(resolve_js_promise(
                        req_id,
                        false,
                        r#"{"ok":false,"error":"invalid_organisation"}"#,
                    ));
                }
            }
            _ => {
                if !self.host.has_active_session() {
                    if let Some(org_id) = extract_json_string_field(json_body, "organisation_id") {
                        let _ = self.host.provision_session(&org_id);
                    }
                }
                let (reply, should_quit) = self.host.handle_stdio_line(json_body);
                let ok = reply.starts_with(r#"{"ok":true"#);
                if ok {
                    if should_quit {
                        window_action = Some(GuiWindowAction::Quit);
                    } else if cmd_raw == "set_unread_badge" || cmd_raw == "update_tray_state" {
                        let badge = extract_json_string_field(&reply, "badge_label")
                            .or_else(|| extract_json_string_field(&reply, "unread_badge"));
                        let title = match badge {
                            Some(label) if !label.is_empty() => {
                                format!("{DESKTOP_WINDOW_TITLE} ({label})")
                            }
                            _ => DESKTOP_WINDOW_TITLE.to_owned(),
                        };
                        window_action = Some(GuiWindowAction::SetTitle(title));
                    } else if cmd_raw == "trigger_tray_menu_action" {
                        if let Some(action_slug) = extract_json_string_field(&reply, "action") {
                            eval_scripts.extend(
                                self.dispatch_event_scripts("kodera://tray-action", &action_slug),
                            );
                            if action_slug == "open_kodera" {
                                window_action = Some(GuiWindowAction::ShowAndFocus);
                            }
                        }
                    } else if cmd_raw == "restore_window_bounds" {
                        window_action = Some(GuiWindowAction::ApplyPlacement(
                            self.host.window_placement().clone(),
                        ));
                    }
                }
                eval_scripts.push(resolve_js_promise(req_id, ok, &reply));
            }
        }

        Ok(WebViewIpcOutcome {
            eval_scripts,
            window_action,
        })
    }

    fn dispatch_event_scripts(&self, event_name: &str, str_payload: &str) -> Vec<String> {
        self.listeners
            .iter()
            .filter(|entry| entry.event_name == event_name)
            .map(|entry| dispatch_js_event(entry.callback_id, str_payload))
            .collect()
    }
}

fn resolve_js_promise(req_id: u64, ok: bool, raw_json_expr: &str) -> String {
    let ok_lit = if ok { "true" } else { "false" };
    format!("window.__KODERA_IPC_RESOLVE__({req_id}, {ok_lit}, {raw_json_expr});")
}

fn dispatch_js_event(callback_id: u64, str_payload: &str) -> String {
    format!(
        "window.__KODERA_IPC_DISPATCH_EVENT__({callback_id}, \"{}\");",
        escape_js_json_str(str_payload)
    )
}

fn escape_js_json_str(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

fn extract_json_string_field(raw_json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":");
    let idx = raw_json.find(&needle)?;
    let rest = raw_json[idx + needle.len()..].trim_start();
    let after_quote = rest.strip_prefix('"')?;
    let mut out = String::new();
    let mut chars = after_quote.chars();
    loop {
        match chars.next()? {
            '"' => return Some(out),
            '\\' => match chars.next()? {
                '"' => out.push('"'),
                '\\' => out.push('\\'),
                '/' => out.push('/'),
                'n' => out.push('\n'),
                'r' => out.push('\r'),
                't' => out.push('\t'),
                _ => return None,
            },
            c if c.is_control() => return None,
            c => out.push(c),
        }
    }
}

fn extract_json_u64_field(raw_json: &str, key: &str) -> Option<u64> {
    let needle = format!("\"{key}\":");
    let idx = raw_json.find(&needle)?;
    let rest = raw_json[idx + needle.len()..].trim_start();
    let end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    if end == 0 {
        return None;
    }
    rest[..end].parse().ok()
}

/// Startup configuration for [`launch_desktop_gui`].
#[derive(Debug, Clone, Default)]
pub struct DesktopGuiOptions {
    pub initial_deep_link: Option<AdmittedDeepLink>,
    pub override_url: Option<String>,
    pub asset_root: Option<PathBuf>,
    pub allow_dev_origin: bool,
}

impl DesktopGuiOptions {
    pub fn from_environment(initial_deep_link: Option<AdmittedDeepLink>) -> Self {
        let allow_dev_origin = std::env::var("KODERA_DESKTOP_DEV")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(cfg!(debug_assertions));
        let override_url = std::env::var("KODERA_DESKTOP_URL")
            .ok()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
        let asset_root = discover_frontend_dist_dir();
        Self {
            initial_deep_link,
            override_url,
            asset_root,
            allow_dev_origin,
        }
    }
}

fn discover_frontend_dist_dir() -> Option<PathBuf> {
    let explicit = std::env::var("KODERA_DESKTOP_DIST_DIR")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let appdir = std::env::var_os("APPDIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let current_exe = std::env::current_exe().ok();
    #[cfg(debug_assertions)]
    let debug_manifest_dist =
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist"));
    #[cfg(not(debug_assertions))]
    let debug_manifest_dist: Option<PathBuf> = None;

    discover_frontend_dist_from_context(
        explicit.as_deref(),
        appdir.as_deref(),
        current_exe.as_deref(),
        debug_manifest_dist.as_deref(),
    )
}

fn discover_frontend_dist_from_context(
    explicit_dist_dir: Option<&Path>,
    appdir: Option<&Path>,
    exe_path: Option<&Path>,
    debug_manifest_dist: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(explicit) = explicit_dist_dir {
        if explicit.join("index.html").is_file() {
            return Some(explicit.to_path_buf());
        }
    }
    if let Some(exe_dir) = exe_path.and_then(Path::parent) {
        for rel in [
            "../Resources/web",
            "../Resources/dist",
            "../share/kodera-desktop/web",
            "../share/kodera-desktop/dist",
            "web",
            "dist",
            "../../apps/web/dist",
        ] {
            let candidate = exe_dir.join(rel);
            if candidate.join("index.html").is_file() {
                return Some(candidate);
            }
        }
    }
    if let Some(app_root) = appdir {
        for rel in [
            "usr/share/kodera-desktop/web",
            "usr/share/kodera-desktop/dist",
        ] {
            let candidate = app_root.join(rel);
            if candidate.join("index.html").is_file() {
                return Some(candidate);
            }
        }
    }
    if let Some(manifest_dist) = debug_manifest_dist {
        if manifest_dist.join("index.html").is_file() {
            return Some(manifest_dist.to_path_buf());
        }
    }
    None
}

#[cfg(feature = "desktop-app")]
mod native_runtime {
    use super::*;
    use crate::{
        load_window_state, sanitize_and_clamp_window_state, save_window_state_atomic,
        verify_embedded_tauri_conf_csp, DesktopShellError, MonitorWorkArea, SavedWindowState,
        WindowBounds,
    };
    use std::borrow::Cow;
    use tao::{
        dpi::{LogicalPosition, LogicalSize},
        event::{Event, WindowEvent},
        event_loop::{ControlFlow, EventLoopBuilder},
        window::WindowBuilder,
    };
    use wry::{
        http::{header::CONTENT_TYPE, Response},
        NewWindowResponse, WebViewBuilder,
    };

    #[derive(Debug)]
    enum DesktopUserEvent {
        IpcMessage { sender_url: String, body: String },
        InterceptedDeepLink(AdmittedDeepLink),
    }

    fn default_window_state_path() -> Option<PathBuf> {
        #[cfg(target_os = "macos")]
        {
            let home = std::env::var_os("HOME")?;
            Some(
                PathBuf::from(home)
                    .join("Library")
                    .join("Application Support")
                    .join(DESKTOP_APP_IDENTIFIER)
                    .join("window-state.json"),
            )
        }
        #[cfg(target_os = "windows")]
        {
            let appdata = std::env::var_os("APPDATA")?;
            Some(
                PathBuf::from(appdata)
                    .join(DESKTOP_APP_IDENTIFIER)
                    .join("window-state.json"),
            )
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
                if !xdg.is_empty() {
                    return Some(
                        PathBuf::from(xdg)
                            .join(DESKTOP_APP_IDENTIFIER)
                            .join("window-state.json"),
                    );
                }
            }
            let home = std::env::var_os("HOME")?;
            Some(
                PathBuf::from(home)
                    .join(".config")
                    .join(DESKTOP_APP_IDENTIFIER)
                    .join("window-state.json"),
            )
        }
    }

    fn collect_monitors<T>(event_loop: &tao::event_loop::EventLoop<T>) -> Vec<MonitorWorkArea> {
        let primary_name = event_loop.primary_monitor().and_then(|m| m.name());
        let mut out = Vec::new();
        for (idx, handle) in event_loop.available_monitors().take(16).enumerate() {
            let scale = handle.scale_factor();
            let scale_milli = if scale.is_finite() && (0.5..=8.0).contains(&scale) {
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let v = (scale * 1000.0).round() as u32;
                v.clamp(500, 8000)
            } else {
                1000
            };
            let pos = handle.position().to_logical::<i32>(scale);
            let size = handle.size().to_logical::<u32>(scale);
            let is_primary = match (&primary_name, handle.name()) {
                (Some(p), Some(n)) => *p == n,
                _ => idx == 0,
            };
            let raw_id = handle.name().unwrap_or_else(|| format!("display-{idx}"));
            let ascii_id: String = raw_id
                .chars()
                .filter(|c| c.is_ascii() && !c.is_ascii_control())
                .take(48)
                .collect();
            let area = MonitorWorkArea {
                id: if ascii_id.is_empty() {
                    format!("display-{idx}")
                } else {
                    ascii_id
                },
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
                scale_factor_milli: scale_milli,
                is_primary,
            };
            if area.validate().is_ok() {
                out.push(area);
            }
        }
        if out.is_empty() {
            out.push(MonitorWorkArea::fallback_primary());
        }
        out
    }

    /// Launches the native OS desktop window, WebView custom protocol + IPC handler, and event loop.
    pub fn launch_desktop_gui(options: DesktopGuiOptions) -> Result<(), DesktopShellError> {
        let _ = DesktopShellHost::self_check()?;
        let embedded_csp = verify_embedded_tauri_conf_csp()
            .map_err(|_| DesktopShellError::SelfCheckFailed("csp_policy"))?;

        let policy = DeepLinkAdmissionPolicy::kodera_default();
        let startup_url = if let Some(ref custom_url) = options.override_url {
            match validate_navigation_url(custom_url, &policy, options.allow_dev_origin) {
                Ok(
                    NavigationDecision::AllowInternalAsset { .. }
                    | NavigationDecision::AllowTrustedWebOrigin { .. },
                ) => custom_url.clone(),
                _ => return Err(DesktopShellError::UntrustedStartupUrl),
            }
        } else {
            format!("{CUSTOM_ASSET_SCHEME}://localhost/index.html")
        };

        let event_loop = EventLoopBuilder::<DesktopUserEvent>::with_user_event().build();
        let monitors = collect_monitors(&event_loop);
        let state_path = default_window_state_path();
        let saved_on_disk = state_path
            .as_deref()
            .and_then(|p| load_window_state(p).ok().flatten());
        let placement = sanitize_and_clamp_window_state(saved_on_disk.as_ref(), &monitors)
            .unwrap_or_else(|_| {
                sanitize_and_clamp_window_state(None, &[MonitorWorkArea::fallback_primary()])
                    .expect("fallback primary monitor geometry is valid")
            });

        let window = WindowBuilder::new()
            .with_title(DESKTOP_WINDOW_TITLE)
            .with_inner_size(LogicalSize::new(
                f64::from(placement.bounds.width),
                f64::from(placement.bounds.height),
            ))
            .with_min_inner_size(LogicalSize::new(
                f64::from(GUI_MIN_WIDTH),
                f64::from(GUI_MIN_HEIGHT),
            ))
            .with_position(LogicalPosition::new(
                f64::from(placement.bounds.x),
                f64::from(placement.bounds.y),
            ))
            .with_maximized(placement.maximized)
            .with_resizable(true)
            .with_visible(true)
            .build(&event_loop)
            .map_err(|_| DesktopShellError::GuiWindowInitFailed)?;

        let ipc_proxy = event_loop.create_proxy();
        let nav_proxy = event_loop.create_proxy();
        let popup_proxy = event_loop.create_proxy();
        let nav_policy = policy.clone();
        let popup_policy = policy;
        let allow_dev = options.allow_dev_origin;
        let asset_root = options.asset_root.clone();
        let csp_for_protocol = embedded_csp;

        let builder = WebViewBuilder::new()
            .with_custom_protocol(
                CUSTOM_ASSET_SCHEME.to_owned(),
                move |_webview_id, request| {
                    let payload = resolve_asset_response(
                        asset_root.as_deref(),
                        request.uri().path(),
                        &csp_for_protocol,
                    );
                    Response::builder()
                        .status(payload.status)
                        .header(CONTENT_TYPE, payload.content_type)
                        .header("Content-Security-Policy", payload.csp_header)
                        .header("X-Content-Type-Options", "nosniff")
                        .header("X-Frame-Options", "DENY")
                        .header("Cache-Control", "no-store")
                        .body(Cow::Owned(payload.body))
                        .unwrap_or_else(|_| {
                            Response::builder()
                                .status(500)
                                .body(Cow::Borrowed(&b"internal_asset_error"[..]))
                                .expect("static fallback HTTP response is valid")
                        })
                },
            )
            .with_initialization_script_for_main_only(build_ipc_init_script(), true)
            .with_ipc_handler(move |request| {
                let body = request.body();
                if body.len() <= MAX_IPC_COMMAND_BYTES {
                    let _ = ipc_proxy.send_event(DesktopUserEvent::IpcMessage {
                        sender_url: request.uri().to_string(),
                        body: body.clone(),
                    });
                }
            })
            .with_navigation_handler(move |target_url| {
                match validate_navigation_url(&target_url, &nav_policy, allow_dev) {
                    Ok(
                        NavigationDecision::AllowInternalAsset { .. }
                        | NavigationDecision::AllowTrustedWebOrigin { .. },
                    ) => true,
                    Ok(NavigationDecision::InterceptDeepLink(admitted)) => {
                        let _ =
                            nav_proxy.send_event(DesktopUserEvent::InterceptedDeepLink(admitted));
                        false
                    }
                    Err(_) => false,
                }
            })
            .with_new_window_req_handler(move |target_url, _features| {
                if let Ok(NavigationDecision::InterceptDeepLink(admitted)) =
                    validate_navigation_url(&target_url, &popup_policy, allow_dev)
                {
                    let _ = popup_proxy.send_event(DesktopUserEvent::InterceptedDeepLink(admitted));
                }
                NewWindowResponse::Deny
            })
            .with_clipboard(true)
            .with_hotkeys_zoom(false)
            .with_url(startup_url);

        #[cfg(target_os = "windows")]
        let builder = {
            use wry::WebViewBuilderExtWindows;
            builder.with_https_scheme(true)
        };

        #[cfg(any(
            target_os = "windows",
            target_os = "macos",
            target_os = "ios",
            target_os = "android"
        ))]
        let webview = builder
            .build(&window)
            .map_err(|_| DesktopShellError::GuiWebViewInitFailed)?;

        #[cfg(not(any(
            target_os = "windows",
            target_os = "macos",
            target_os = "ios",
            target_os = "android"
        )))]
        let webview = {
            use tao::platform::unix::WindowExtUnix;
            use wry::WebViewBuilderExtUnix;
            let vbox = window
                .default_vbox()
                .ok_or(DesktopShellError::GuiWebViewInitFailed)?;
            builder
                .build_gtk(vbox)
                .map_err(|_| DesktopShellError::GuiWebViewInitFailed)?
        };

        let mut bridge =
            DesktopWebViewBridge::new(options.allow_dev_origin, options.initial_deep_link);
        let mut live_state = SavedWindowState {
            bounds: WindowBounds {
                x: placement.bounds.x,
                y: placement.bounds.y,
                width: placement.bounds.width,
                height: placement.bounds.height,
            },
            maximized: placement.maximized,
            fullscreen: placement.fullscreen,
            visible: true,
        };

        event_loop.run(move |event, _, control_flow| {
            *control_flow = ControlFlow::Wait;

            match event {
                Event::WindowEvent {
                    event: WindowEvent::Moved(pos),
                    ..
                } => {
                    let logical = pos.to_logical::<i32>(window.scale_factor());
                    live_state.bounds.x = logical.x;
                    live_state.bounds.y = logical.y;
                }
                Event::WindowEvent {
                    event: WindowEvent::Resized(size),
                    ..
                } => {
                    let logical = size.to_logical::<u32>(window.scale_factor());
                    if logical.width >= 320 && logical.height >= 240 {
                        live_state.bounds.width = logical.width;
                        live_state.bounds.height = logical.height;
                    }
                    live_state.maximized = window.is_maximized();
                }
                Event::WindowEvent {
                    event: WindowEvent::CloseRequested,
                    ..
                } => {
                    if let Some(ref path) = state_path {
                        let _ = save_window_state_atomic(path, &live_state);
                    }
                    bridge.clear_session();
                    *control_flow = ControlFlow::Exit;
                }
                Event::UserEvent(DesktopUserEvent::InterceptedDeepLink(admitted)) => {
                    window.set_visible(true);
                    window.set_minimized(false);
                    window.set_focus();
                    for js in bridge.enqueue_deep_link(admitted) {
                        let _ = webview.evaluate_script(&js);
                    }
                }
                Event::UserEvent(DesktopUserEvent::IpcMessage { sender_url, body }) => {
                    if let Ok(outcome) = bridge.handle_ipc_request(&sender_url, &body) {
                        for js in outcome.eval_scripts {
                            let _ = webview.evaluate_script(&js);
                        }
                        if let Some(action) = outcome.window_action {
                            match action {
                                GuiWindowAction::ShowAndFocus => {
                                    window.set_visible(true);
                                    window.set_minimized(false);
                                    window.set_focus();
                                    live_state.visible = true;
                                }
                                GuiWindowAction::Hide => {
                                    window.set_visible(false);
                                    live_state.visible = false;
                                }
                                GuiWindowAction::SetTitle(title) => {
                                    window.set_title(&title);
                                }
                                GuiWindowAction::ApplyPlacement(p) => {
                                    window.set_outer_position(LogicalPosition::new(
                                        f64::from(p.bounds.x),
                                        f64::from(p.bounds.y),
                                    ));
                                    window.set_inner_size(LogicalSize::new(
                                        f64::from(p.bounds.width),
                                        f64::from(p.bounds.height),
                                    ));
                                    live_state.bounds = p.bounds;
                                }
                                GuiWindowAction::Quit => {
                                    if let Some(ref path) = state_path {
                                        let _ = save_window_state_atomic(path, &live_state);
                                    }
                                    bridge.clear_session();
                                    *control_flow = ControlFlow::Exit;
                                }
                            }
                        }
                    }
                }
                Event::LoopDestroyed => {
                    bridge.clear_session();
                }
                _ => {}
            }
        });
    }
}

#[cfg(feature = "desktop-app")]
pub use native_runtime::launch_desktop_gui;

#[cfg(not(feature = "desktop-app"))]
pub fn launch_desktop_gui(_options: DesktopGuiOptions) -> Result<(), crate::DesktopShellError> {
    Err(crate::DesktopShellError::GuiRuntimeUnavailable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::verify_embedded_tauri_conf_csp;

    const ORG: &str = "019a5e62-6ca0-7303-8303-030303030303";

    #[test]
    fn navigation_guard_admits_internal_assets_and_approved_origins_and_intercepts_deep_links() {
        let policy = DeepLinkAdmissionPolicy::kodera_default();

        assert_eq!(
            validate_navigation_url("kodera-asset://localhost/", &policy, false).unwrap(),
            NavigationDecision::AllowInternalAsset {
                normalized_path: "/index.html".to_owned(),
            }
        );
        assert_eq!(
            validate_navigation_url(
                "https://kodera-asset.localhost/bootstrap.js",
                &policy,
                false
            )
            .unwrap(),
            NavigationDecision::AllowInternalAsset {
                normalized_path: "/bootstrap.js".to_owned(),
            }
        );
        assert_eq!(
            validate_navigation_url("https://app.kodera.io/channels/general", &policy, false)
                .unwrap(),
            NavigationDecision::AllowTrustedWebOrigin {
                origin: "https://app.kodera.io".to_owned(),
            }
        );
        assert_eq!(
            validate_navigation_url(
                "https://auth.kodera.io/realms/acme/protocol/openid-connect/auth",
                &policy,
                false
            )
            .unwrap(),
            NavigationDecision::AllowTrustedWebOrigin {
                origin: "https://auth.kodera.io".to_owned(),
            }
        );

        // Local Vite dev server requires explicit allow_dev_origin = true.
        assert_eq!(
            validate_navigation_url("http://localhost:5173/", &policy, false),
            Err(NavigationGuardError::UntrustedOrigin)
        );
        assert_eq!(
            validate_navigation_url("http://localhost:5173/", &policy, true).unwrap(),
            NavigationDecision::AllowTrustedWebOrigin {
                origin: "http://localhost:5173".to_owned(),
            }
        );

        // Valid kodera:// and matrix: deep links are intercepted rather than navigated directly.
        match validate_navigation_url("kodera://workspace/acme-ops/general", &policy, false)
            .unwrap()
        {
            NavigationDecision::InterceptDeepLink(link) => {
                assert_eq!(link.canonical_uri(), "kodera://workspace/acme-ops/general");
            }
            other => panic!("expected InterceptDeepLink, got {other:?}"),
        }
    }

    #[test]
    fn navigation_guard_fails_closed_on_malicious_schemes_traversal_and_external_hosts() {
        let policy = DeepLinkAdmissionPolicy::kodera_default();
        for dangerous in [
            "javascript:alert(1)",
            "JAVASCRIPT:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "file:///etc/passwd",
            "vbscript:msgbox(1)",
            "blob:https://app.kodera.io/uuid",
            "about:blank",
        ] {
            assert_eq!(
                validate_navigation_url(dangerous, &policy, true),
                Err(NavigationGuardError::DangerousScheme),
                "must block dangerous scheme {dangerous}"
            );
        }

        assert_eq!(
            validate_navigation_url("https://evil.example/phish", &policy, true),
            Err(NavigationGuardError::UntrustedOrigin)
        );
        assert_eq!(
            validate_navigation_url("https://app.kodera.io.evil.example/", &policy, true),
            Err(NavigationGuardError::UntrustedOrigin)
        );
        assert_eq!(
            validate_navigation_url("https://admin@app.kodera.io/", &policy, true),
            Err(NavigationGuardError::EmbeddedCredentials)
        );
        assert_eq!(
            validate_navigation_url("kodera-asset://localhost/../tauri.conf.json", &policy, true),
            Err(NavigationGuardError::PathTraversal)
        );
        assert_eq!(
            validate_navigation_url("kodera-asset://localhost/%2e%2e/secret", &policy, true),
            Err(NavigationGuardError::PathTraversal)
        );
        assert!(matches!(
            validate_navigation_url(
                "kodera://workspace/acme/general?redirect_uri=https://evil.example",
                &policy,
                false
            ),
            Err(NavigationGuardError::RejectedDeepLink(_))
        ));
    }

    #[test]
    fn custom_asset_protocol_attaches_verified_csp_and_blocks_traversal() {
        let csp = verify_embedded_tauri_conf_csp().unwrap();
        let index = resolve_asset_response(None, "/", &csp);
        assert_eq!(index.status, 200);
        assert_eq!(index.content_type, "text/html; charset=utf-8");
        assert_eq!(index.csp_header, csp);
        let html = core::str::from_utf8(&index.body).unwrap();
        assert!(html.contains("<title>Kodera</title>"));
        assert!(!html.contains("<style"));

        let traversal = resolve_asset_response(None, "/../../Cargo.toml", &csp);
        assert_eq!(traversal.status, 400);
    }

    struct ScopedTempDir(PathBuf);

    impl ScopedTempDir {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!(
                "kodera-desktop-gui-test-{tag}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for ScopedTempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn spa_route_fallback_serves_bundled_index_html_and_returns_404_for_missing_assets() {
        let csp = verify_embedded_tauri_conf_csp().unwrap();
        let scratch = ScopedTempDir::new("spa-fallback");
        let dist = scratch.path().join("web");
        fs::create_dir_all(dist.join("assets")).unwrap();
        let spa_html = b"<!doctype html><html><head><title>Kodera SPA</title></head><body><div id=\"root\"></div></body></html>";
        fs::write(dist.join("index.html"), spa_html).unwrap();
        fs::write(dist.join("assets/main.js"), b"console.log('kodera');").unwrap();

        let static_js = resolve_asset_response(Some(&dist), "/assets/main.js", &csp);
        assert_eq!(static_js.status, 200);
        assert_eq!(static_js.content_type, "text/javascript; charset=utf-8");
        assert_eq!(static_js.csp_header, csp);
        assert_eq!(static_js.body, b"console.log('kodera');");

        for spa_route in ["/login", "/onboarding", "/channels/general"] {
            let resp = resolve_asset_response(Some(&dist), spa_route, &csp);
            assert_eq!(resp.status, 200, "SPA route {spa_route} must return 200");
            assert_eq!(resp.content_type, "text/html; charset=utf-8");
            assert_eq!(resp.csp_header, csp);
            assert_eq!(resp.body, spa_html);
        }

        for missing_asset in ["/missing.js", "/assets/absent.css", "/bootstrap.js"] {
            let miss = resolve_asset_response(Some(&dist), missing_asset, &csp);
            assert_eq!(
                miss.status, 404,
                "missing static asset {missing_asset} must return 404"
            );
            assert_eq!(miss.csp_header, csp);
        }
    }

    #[test]
    fn bundle_asset_discovery_resolves_macos_linux_appimage_and_windows_layouts() {
        let scratch = ScopedTempDir::new("bundle-discovery");

        // 1. macOS `.app`: Contents/MacOS/kodera-desktop -> Contents/Resources/web/index.html
        let mac_exe = scratch
            .path()
            .join("Kodera.app/Contents/MacOS/kodera-desktop");
        let mac_web = scratch.path().join("Kodera.app/Contents/Resources/web");
        fs::create_dir_all(mac_exe.parent().unwrap()).unwrap();
        fs::create_dir_all(&mac_web).unwrap();
        fs::write(mac_web.join("index.html"), b"<!doctype html>").unwrap();
        let found_mac =
            discover_frontend_dist_from_context(None, None, Some(&mac_exe), None).unwrap();
        assert_eq!(
            fs::canonicalize(found_mac).unwrap(),
            fs::canonicalize(&mac_web).unwrap()
        );

        // 2. Linux `.deb`: /usr/bin/kodera-desktop -> /usr/share/kodera-desktop/web/index.html
        let deb_exe = scratch.path().join("deb-root/usr/bin/kodera-desktop");
        let deb_web = scratch.path().join("deb-root/usr/share/kodera-desktop/web");
        fs::create_dir_all(deb_exe.parent().unwrap()).unwrap();
        fs::create_dir_all(&deb_web).unwrap();
        fs::write(deb_web.join("index.html"), b"<!doctype html>").unwrap();
        let found_deb =
            discover_frontend_dist_from_context(None, None, Some(&deb_exe), None).unwrap();
        assert_eq!(
            fs::canonicalize(found_deb).unwrap(),
            fs::canonicalize(&deb_web).unwrap()
        );

        // 3. Linux `.AppImage` via `$APPDIR/usr/share/kodera-desktop/web/index.html`
        let appdir = scratch.path().join("AppDir");
        let appimage_web = appdir.join("usr/share/kodera-desktop/web");
        fs::create_dir_all(&appimage_web).unwrap();
        fs::write(appimage_web.join("index.html"), b"<!doctype html>").unwrap();
        let found_appimage =
            discover_frontend_dist_from_context(None, Some(&appdir), None, None).unwrap();
        assert_eq!(
            fs::canonicalize(found_appimage).unwrap(),
            fs::canonicalize(&appimage_web).unwrap()
        );

        // 4. Windows `.msi` / NSIS: Program Files/Kodera/kodera-desktop.exe -> Program Files/Kodera/web/index.html
        let win_exe = scratch.path().join("win-install/Kodera/kodera-desktop.exe");
        let win_web = scratch.path().join("win-install/Kodera/web");
        fs::create_dir_all(&win_web).unwrap();
        fs::write(win_web.join("index.html"), b"<!doctype html>").unwrap();
        let found_win =
            discover_frontend_dist_from_context(None, None, Some(&win_exe), None).unwrap();
        assert_eq!(
            fs::canonicalize(found_win).unwrap(),
            fs::canonicalize(&win_web).unwrap()
        );
    }

    #[test]
    fn webview_ipc_bridge_enforces_sender_origin_and_routes_commands_and_deep_links() {
        let policy = DeepLinkAdmissionPolicy::kodera_default();
        let startup_link = route_deep_link("kodera://workspace/acme/general", &policy).unwrap();
        let mut bridge = DesktopWebViewBridge::new(false, Some(startup_link));

        // Untrusted frame origin is rejected before parsing or executing commands.
        assert_eq!(
            bridge.handle_ipc_request(
                "https://evil.example/frame",
                "1\tget_app_metadata\n{\"command\":\"get_app_metadata\"}"
            ),
            Err(WebViewIpcError::UntrustedSenderOrigin)
        );

        // Registering `kodera://deep-link` flushes the buffered startup deep link.
        let listen_out = bridge
            .handle_ipc_request(
                "kodera-asset://localhost/index.html",
                "1\tplugin:event|listen\n{\"event\":\"kodera://deep-link\",\"handler\":7}",
            )
            .unwrap();
        assert_eq!(listen_out.eval_scripts.len(), 2);
        assert!(listen_out.eval_scripts[0].contains("__KODERA_IPC_RESOLVE__(1, true, 1)"));
        assert!(listen_out.eval_scripts[1]
            .contains("__KODERA_IPC_DISPATCH_EVENT__(7, \"kodera://workspace/acme/general\")"));

        // Setting unread badge auto-provisions the session and updates native window title.
        let badge_cmd = format!(
            "2\tset_unread_badge\n{{\"command\":\"set_unread_badge\",\"organisation_id\":\"{ORG}\",\"unread_count\":9}}"
        );
        let badge_out = bridge
            .handle_ipc_request("https://app.kodera.io/", &badge_cmd)
            .unwrap();
        assert_eq!(
            badge_out.window_action,
            Some(GuiWindowAction::SetTitle("Kodera (9)".to_owned()))
        );
        assert!(badge_out.eval_scripts[0].contains("__KODERA_IPC_RESOLVE__(2, true,"));

        // Quit command clears session and emits GuiWindowAction::Quit.
        let quit_out = bridge
            .handle_ipc_request(
                "kodera-asset://localhost/index.html",
                "3\tquit\n{\"command\":\"quit\"}",
            )
            .unwrap();
        assert_eq!(quit_out.window_action, Some(GuiWindowAction::Quit));
    }

    #[test]
    fn webview_ipc_bridge_routes_community_wizard_deploy_lifecycle_without_leaking_secrets() {
        use crate::{CommandExecOutput, CommunityCommandRunner, DockerUnavailableReason};
        use std::sync::{Arc, Mutex};
        use std::time::Duration;

        struct ScriptedRunner {
            outputs: Mutex<VecDeque<CommandExecOutput>>,
        }

        impl CommunityCommandRunner for ScriptedRunner {
            fn run_argv(
                &self,
                program: &str,
                _args: &[String],
                _working_dir: Option<&Path>,
                _timeout: Duration,
            ) -> Result<CommandExecOutput, DockerUnavailableReason> {
                assert_eq!(program, "docker");
                Ok(self
                    .outputs
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or(CommandExecOutput {
                        status_code: Some(0),
                        stdout: String::new(),
                        stderr: String::new(),
                        timed_out: false,
                    }))
            }

            fn poll_backoff(&self) -> Duration {
                Duration::ZERO
            }
        }

        let scratch = ScopedTempDir::new("wizard-webview-ipc");
        let stack_dir = scratch.path().join("community");
        fs::create_dir_all(&stack_dir).unwrap();
        fs::write(
            stack_dir.join("docker-compose.yml"),
            "services:\n  db:\n    image: postgres:17.6-alpine\n",
        )
        .unwrap();
        let stack_dir_str = stack_dir.to_str().unwrap();

        let healthy_ps = r#"[
            {"Service":"keycloak","State":"running","Health":"healthy","MemoryMiB":256},
            {"Service":"db","State":"running","Health":"healthy","MemoryMiB":192},
            {"Service":"synapse","State":"running","Health":"healthy","KoderaPolicy":"0.1.4","MemoryMiB":420},
            {"Service":"server","State":"running","Health":"healthy","MemoryMiB":220},
            {"Service":"web","State":"running","Health":"healthy","MemoryMiB":64},
            {"Service":"livekit","State":"running","Health":"healthy","MemoryMiB":128}
        ]"#;

        let runner = Arc::new(ScriptedRunner {
            outputs: Mutex::new(VecDeque::from([
                CommandExecOutput {
                    status_code: Some(0),
                    stdout: "Docker version 28.1.0, build 4d8c241\n".to_owned(),
                    stderr: String::new(),
                    timed_out: false,
                },
                CommandExecOutput {
                    status_code: Some(0),
                    stdout: "Docker Compose version v2.36.0\n".to_owned(),
                    stderr: String::new(),
                    timed_out: false,
                },
                CommandExecOutput {
                    status_code: Some(0),
                    stdout: String::new(),
                    stderr: String::new(),
                    timed_out: false,
                },
                CommandExecOutput {
                    status_code: Some(0),
                    stdout: String::new(),
                    stderr: String::new(),
                    timed_out: false,
                },
                CommandExecOutput {
                    status_code: Some(0),
                    stdout: healthy_ps.to_owned(),
                    stderr: String::new(),
                    timed_out: false,
                },
            ])),
        });

        let mut bridge = DesktopWebViewBridge::new(false, None);

        // Untrusted sender frame is refused before touching disk or session state.
        let untrusted_prepare = format!(
            "1\tself_host_prepare_community\n{{\"command\":\"self_host_prepare_community\",\"organisation_id\":\"{ORG}\",\"stack_dir\":\"{stack_dir_str}\",\"domain\":\"chat.example.org\",\"acme_email\":\"ops@example.org\",\"oidc_provider_origin\":\"https://auth.example.org\",\"tls_mode\":\"acme\",\"http_port\":80,\"https_port\":443}}"
        );
        assert_eq!(
            bridge.handle_ipc_request("https://evil.example/wizard", &untrusted_prepare),
            Err(WebViewIpcError::UntrustedSenderOrigin)
        );
        assert!(!stack_dir.join(".env").exists());

        // Initialize session and attach deterministic mock runner.
        let init_msg = format!("2\tinit_session\n{{\"organisation_id\":\"{ORG}\"}}");
        let init_out = bridge
            .handle_ipc_request("kodera-asset://localhost/index.html", &init_msg)
            .unwrap();
        assert!(init_out.eval_scripts[0].contains("__KODERA_IPC_RESOLVE__(2, true,"));
        assert!(bridge.configure_community_runner(ORG, runner));

        // 1. Preflight
        let preflight_msg = format!(
            "3\tself_host_preflight_community\n{{\"command\":\"self_host_preflight_community\",\"organisation_id\":\"{ORG}\",\"stack_dir\":\"{stack_dir_str}\",\"domain\":\"Chat.Example.org\",\"acme_email\":\"ops@example.org\",\"tls_mode\":\"acme\",\"http_port\":80,\"https_port\":443}}"
        );
        let preflight_out = bridge
            .handle_ipc_request("https://app.kodera.io/self-host", &preflight_msg)
            .unwrap();
        assert!(preflight_out.eval_scripts[0].contains("__KODERA_IPC_RESOLVE__(3, true,"));
        assert!(preflight_out.eval_scripts[0].contains(r#""type":"community_preflight""#));
        assert!(preflight_out.eval_scripts[0].contains(r#""normalized_domain":"chat.example.org""#));
        assert!(preflight_out.eval_scripts[0].contains(r#""matrix_base_domain":"example.org""#));

        // 2. Prepare (.env rendered with CSPRNG secrets; zero secret values returned over WebView IPC)
        let prepare_msg = format!(
            "4\tself_host_prepare_community\n{{\"command\":\"self_host_prepare_community\",\"organisation_id\":\"{ORG}\",\"stack_dir\":\"{stack_dir_str}\",\"domain\":\"Chat.Example.org\",\"acme_email\":\"ops@example.org\",\"oidc_provider_origin\":\"https://auth.example.org\",\"tls_mode\":\"acme\",\"http_port\":80,\"https_port\":443}}"
        );
        let prepare_out = bridge
            .handle_ipc_request("https://app.kodera.io/self-host", &prepare_msg)
            .unwrap();
        let prepare_js = &prepare_out.eval_scripts[0];
        assert!(prepare_js.contains("__KODERA_IPC_RESOLVE__(4, true,"));
        assert!(prepare_js.contains(r#""type":"community_prepare""#));
        assert!(prepare_js.contains(r#""env_file_written":true"#));
        assert!(prepare_js.contains(r#""compose_config_valid":true"#));

        let env_raw = fs::read_to_string(stack_dir.join(".env")).unwrap();
        for secret_prefix in [
            "POSTGRES_PASSWORD=",
            "DJANGO_SECRET_KEY=",
            "LIVEKIT_API_SECRET=",
            "KEYCLOAK_ADMIN_PASSWORD=",
        ] {
            let secret_val = env_raw
                .lines()
                .find_map(|line| line.strip_prefix(secret_prefix))
                .expect("expected generated secret key in .env");
            assert!(secret_val.len() >= 32);
            assert!(
                !prepare_js.contains(secret_val),
                "WebView IPC reply must never leak generated secret value for {secret_prefix}"
            );
        }

        // 3. Deploy & verify readiness
        let deploy_msg = format!(
            "5\tself_host_deploy_community\n{{\"command\":\"self_host_deploy_community\",\"organisation_id\":\"{ORG}\",\"stack_dir\":\"{stack_dir_str}\",\"timeout_ms\":5000}}"
        );
        let deploy_out = bridge
            .handle_ipc_request("https://app.kodera.io/self-host", &deploy_msg)
            .unwrap();
        let deploy_js = &deploy_out.eval_scripts[0];
        assert!(deploy_js.contains("__KODERA_IPC_RESOLVE__(5, true,"));
        assert!(deploy_js.contains(r#""type":"community_deploy""#));
        assert!(deploy_js.contains(r#""stack_healthy":true"#));
        assert!(deploy_js.contains(r#""state":"healthy""#));
    }
}
