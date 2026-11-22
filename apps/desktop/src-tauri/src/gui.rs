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
    AdmittedDeepLink, MonitorWorkArea, RestoredWindowPlacement, DESKTOP_APP_IDENTIFIER,
    DESKTOP_APP_VERSION, DESKTOP_PRODUCT_NAME,
};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Native desktop window title when unread count is zero.
pub const DESKTOP_WINDOW_TITLE: &str = DESKTOP_PRODUCT_NAME;

/// Default logical desktop window width (`1280px`).
pub const GUI_DEFAULT_WIDTH: u32 = 1280;

/// Default logical desktop window height (`820px`).
pub const GUI_DEFAULT_HEIGHT: u32 = 820;

/// Minimum logical desktop window width (`960px`, aligned with `tauri.conf.json` and `window_state`).
pub const GUI_MIN_WIDTH: u32 = crate::window_state::MIN_WINDOW_WIDTH;

/// Minimum logical desktop window height (`640px`, aligned with `tauri.conf.json` and `window_state`).
pub const GUI_MIN_HEIGHT: u32 = crate::window_state::MIN_WINDOW_HEIGHT;

/// Computes the effective minimum logical inner window size for [`RestoredWindowPlacement`],
/// clamping [`GUI_MIN_WIDTH`] and [`GUI_MIN_HEIGHT`] to the selected monitor work area and
/// sanitized placement bounds so compact displays (such as `900x600`) are never inflated past
/// their work area by native window-manager minimum-size constraints.
#[must_use]
pub fn effective_gui_min_inner_size(
    placement: &RestoredWindowPlacement,
    monitors: &[MonitorWorkArea],
) -> (u32, u32) {
    let monitor_limits = monitors
        .iter()
        .find(|m| m.id == placement.target_monitor_id && m.validate().is_ok())
        .map(|m| (m.width, m.height));
    let (max_min_w, max_min_h) = match monitor_limits {
        Some((mw, mh)) => (
            mw.min(placement.bounds.width),
            mh.min(placement.bounds.height),
        ),
        None => (placement.bounds.width, placement.bounds.height),
    };
    (
        GUI_MIN_WIDTH.min(max_min_w).max(1),
        GUI_MIN_HEIGHT.min(max_min_h).max(1),
    )
}

/// Custom asset protocol scheme registered on the native OS WebView.
pub const CUSTOM_ASSET_SCHEME: &str = "kodera-asset";

/// Platform-exact internal bundled asset origin trusted for custom WebView IPC.
///
/// Windows `WebView2` serves custom protocol assets over `https://kodera-asset.localhost` via
/// `with_https_scheme(true)`; macOS `WKWebView` and Linux `WebKitGTK` serve custom protocol assets
/// over `kodera-asset://localhost`.
#[cfg(target_os = "windows")]
pub const INTERNAL_ASSET_ORIGIN: &str = "https://kodera-asset.localhost";

#[cfg(not(target_os = "windows"))]
pub const INTERNAL_ASSET_ORIGIN: &str = "kodera-asset://localhost";

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

const ADMITTED_WEBVIEW_IPC_COMMANDS: &[&str] = &[
    "begin_oidc_pkce_loopback",
    "check_app_updates",
    "complete_oidc_pkce_callback",
    "delete_keychain_credential",
    "dispatch_notification",
    "get_app_metadata",
    "hide_window",
    "init_session",
    "inspect_self_host_health",
    "load_keychain_credential",
    "plan_self_host",
    "plugin:event|listen",
    "plugin:event|unlisten",
    "plugin:window|close",
    "plugin:window|hide",
    "plugin:window|set_focus",
    "plugin:window|show",
    "plugin:window|unminimize",
    "quit",
    "restart_to_update",
    "restore_window_bounds",
    "route_deep_link",
    "select_community_stack_dir",
    "self_host_deploy_community",
    "self_host_preflight_community",
    "self_host_prepare_community",
    "set_unread_badge",
    "show_window",
    "store_keychain_credential",
    "trigger_tray_menu_action",
    "update_tray_state",
];

const PRIVILEGED_INTERNAL_ONLY_COMMANDS: &[&str] = &[
    "begin_oidc_pkce_loopback",
    "complete_oidc_pkce_callback",
    "delete_keychain_credential",
    "load_keychain_credential",
    "plan_self_host",
    "restart_to_update",
    "select_community_stack_dir",
    "self_host_deploy_community",
    "self_host_preflight_community",
    "self_host_prepare_community",
    "store_keychain_credential",
];

const APPROVED_CAPABILITY_PERMISSIONS: [&str; 6] = [
    "core:default",
    "core:window:allow-hide",
    "core:window:allow-set-focus",
    "core:window:allow-show",
    "core:window:allow-unminimize",
    "deep-link:default",
];

/// Verifies at startup that `capabilities/default.json` remains local-only, main-window-scoped,
/// and restricted to the exact approved Tauri capability set.
pub fn verify_embedded_default_capability() -> Result<(), &'static str> {
    let raw = include_str!("../capabilities/default.json");
    let parsed: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(raw).map_err(|_| "capability_invalid_json")?;
    if parsed.get("identifier").and_then(serde_json::Value::as_str) != Some("default") {
        return Err("capability_identifier_mismatch");
    }
    if parsed.get("local").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err("capability_not_local_only");
    }
    if parsed.contains_key("remote") {
        return Err("capability_remote_forbidden");
    }
    let Some(windows) = parsed.get("windows").and_then(serde_json::Value::as_array) else {
        return Err("capability_windows_invalid");
    };
    if windows.len() != 1 || windows[0].as_str() != Some("main") {
        return Err("capability_windows_scope_mismatch");
    }
    let Some(perms) = parsed
        .get("permissions")
        .and_then(serde_json::Value::as_array)
    else {
        return Err("capability_permissions_invalid");
    };
    let mut perm_set = BTreeSet::new();
    for item in perms {
        let Some(name) = item.as_str() else {
            return Err("capability_permissions_invalid");
        };
        if !perm_set.insert(name) {
            return Err("capability_permissions_duplicate");
        }
    }
    let expected: BTreeSet<&str> = APPROVED_CAPABILITY_PERMISSIONS.iter().copied().collect();
    if perm_set != expected {
        return Err("capability_permissions_mismatch");
    }
    Ok(())
}

mod assets;
mod ipc_bridge;
#[cfg(feature = "desktop-app")]
mod native_runtime;
mod navigation;
mod picker;
#[cfg(test)]
mod tests;

pub use assets::{resolve_asset_response, AssetHttpPayload};
pub use ipc_bridge::{DesktopWebViewBridge, GuiWindowAction, WebViewIpcError, WebViewIpcOutcome};
#[cfg(feature = "desktop-app")]
pub use native_runtime::launch_desktop_gui;
pub use navigation::{
    validate_navigation_url, validate_navigation_url_for_os, NavigationDecision,
    NavigationGuardError,
};
pub use picker::{NativeStackFolderPicker, OsNativeStackFolderPicker};

#[cfg(not(feature = "desktop-app"))]
pub fn launch_desktop_gui(_options: DesktopGuiOptions) -> Result<(), crate::DesktopShellError> {
    Err(crate::DesktopShellError::GuiRuntimeUnavailable)
}

const BOOTSTRAP_CSS: &str = include_str!("../assets/bootstrap.css");

const IPC_INIT_SCRIPT: &str = r#"(function () {
  if (typeof window === 'undefined' || window.__KODERA_IPC_READY__ === true) {
    return;
  }
  const pending = new Map();
  const callbacks = new Map();
  const documentId = Array.from(crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  Object.defineProperty(window, '__KODERA_DOCUMENT_ID__', { value: documentId });
  let nativeGeneration = null;
  let nativeCapability = null;
  let nextReqId = 1;
  let nextCbId = 1;

  function postEnvelope(reqId, cmd, payloadObj) {
    if (!window.ipc || typeof window.ipc.postMessage !== 'function') {
      return false;
    }
    if (nativeGeneration === null) return true;
    const line = documentId + ':' + nativeGeneration + ':' + nativeCapability + ':' + String(reqId) + '\t' + String(cmd) + '\n' + JSON.stringify(payloadObj);
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
      if (pending.size >= 64) { reject(new Error('ipc_pending_limit')); return; }
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
      pending.set(reqId, { resolve: resolve, reject: reject, cmd: cmd, payload: payload });
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
    if (callbacks.size >= 64) throw new Error('ipc_callback_limit');
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
    void regPromise.catch(() => callbacks.delete(handlerId));
    return function () {
      return regPromise.then(function (eventId) {
        callbacks.delete(handlerId);
        return invoke('plugin:event|unlisten', { event: eventName, eventId: eventId });
      });
    };
  }

  Object.defineProperty(window, '__KODERA_IPC_ACTIVATE__', {
    value: function (generation, capability) {
      if (nativeGeneration !== null || !Number.isSafeInteger(generation) || generation < 0 ||
          typeof capability !== 'string' || !/^[a-f0-9]{64}$/.test(capability)) return;
      nativeGeneration = String(generation);
      nativeCapability = capability;
      for (const [reqId, entry] of pending) {
        if (!postEnvelope(reqId, entry.cmd, entry.payload)) {
          pending.delete(reqId);
          entry.reject(new Error('ipc_transport_unavailable'));
        }
      }
    }
  });

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
      if (!ok && entry.cmd === 'plugin:event|listen') callbacks.delete(entry.payload.handler);
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

  // A non-privileged handshake avoids waiting for page-finished: application modules may
  // themselves await an IPC promise before the document load event can finish.
  if (window.ipc && typeof window.ipc.postMessage === 'function') {
    window.ipc.postMessage(documentId + ':hello\t__document_generation\n{}');
  }

  const tauriInternals = Object.freeze({
    invoke: invoke,
    transformCallback: transformCallback
  });

  const koderaDesktop = Object.freeze({
    identifier: 'io.kodera.desktop',
    productName: 'Kodera',
    version: '0.1.1',
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

/// Returns the JavaScript main-frame initialization bridge exposing `window.__TAURI_INTERNALS__`
/// and `window.koderaDesktop`.
pub const fn build_ipc_init_script() -> &'static str {
    IPC_INIT_SCRIPT
}

fn builtin_meta_payload(
    cmd_raw: &str,
    ready_update: Option<&crate::updater::ReadyUpdate>,
) -> Option<String> {
    match cmd_raw {
        "get_app_metadata" => Some(format!(
            r#"{{"identifier":"{}","productName":"{}","version":"{}","updateChannel":"stable","updateAvailable":false,"isNativeDesktop":true,"schemes":["kodera","matrix"]}}"#,
            DESKTOP_APP_IDENTIFIER, DESKTOP_PRODUCT_NAME, DESKTOP_APP_VERSION,
        )),
        "check_app_updates" => Some(if let Some(update) = ready_update {
            serde_json::json!({"supported": true, "updateAvailable": true, "updateReady": true, "verified": true, "currentVersion": DESKTOP_APP_VERSION, "latestVersion": update.version, "channel": "stable"}).to_string()
        } else {
            format!(
                r#"{{"supported":false,"updateAvailable":false,"currentVersion":"{}","latestVersion":null,"channel":"stable"}}"#,
                DESKTOP_APP_VERSION,
            )
        }),
        _ => None,
    }
}

fn activate_js_document(document_id: &str, generation: u64, capability: &str) -> String {
    format!("if (window.__KODERA_DOCUMENT_ID__ === \"{document_id}\") {{ window.__KODERA_IPC_ACTIVATE__({generation}, \"{capability}\"); }}")
}

fn resolve_js_promise(document_id: &str, req_id: u64, ok: bool, raw_json_expr: &str) -> String {
    let ok_lit = if ok { "true" } else { "false" };
    format!("if (window.__KODERA_DOCUMENT_ID__ === \"{document_id}\") {{ window.__KODERA_IPC_RESOLVE__({req_id}, {ok_lit}, {raw_json_expr}); }}")
}

fn dispatch_js_event(document_id: &str, callback_id: u64, str_payload: &str) -> String {
    format!(
        "if (window.__KODERA_DOCUMENT_ID__ === \"{document_id}\") {{ window.__KODERA_IPC_DISPATCH_EVENT__({callback_id}, \"{}\"); }}",
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
            "../lib/Kodera/web",
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
            "usr/lib/Kodera/web",
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
