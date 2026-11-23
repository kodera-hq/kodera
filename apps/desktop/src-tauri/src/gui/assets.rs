//! Bundled static frontend asset resolver and CSP-clean bootstrap shell responses.

use super::navigation::normalize_asset_path;
use super::{BOOTSTRAP_CSS, MAX_STATIC_ASSET_BYTES};
use std::fs;
use std::path::Path;

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
        zeroized process credential isolation, and multi-monitor window state protection.
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

    if normalized == "/__desktop-update.css" {
        return AssetHttpPayload {
            status: 200,
            content_type: "text/css; charset=utf-8",
            csp_header: embedded_csp.to_owned(),
            body: include_bytes!("../../assets/updater.css").to_vec(),
        };
    }

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
