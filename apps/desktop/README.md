# Kodera Desktop (`@kodera/desktop`)

Status: Implemented tao/wry host and Tauri-compatible IPC; native launch and installed-package qualification pending.

`@kodera/desktop` packages the Kodera workspace shell for macOS, Linux, and Windows using tao/wry, Tauri installer tooling, and the shared `kodera-rs` Rust crate. It provides a `#![forbid(unsafe_code)]` Rust host binary (`kodera-desktop`), least-privilege Tauri v2 capabilities (`src-tauri/capabilities/default.json`), a strict `WEB-ADR-0012` Content Security Policy with zero `'unsafe-eval'`, deterministic multi-OS bundle icons (`PNG`, `ICNS`, `ICO`), and a zero-dependency TypeScript IPC client (`@kodera/desktop`) with automatic browser no-op fallback when running outside Tauri.

## Architecture & Native Capabilities

### 1. Runnable Rust Host & Window Lifecycle (`apps/desktop/src-tauri/`)

- **Executable host (`src/main.rs`, `src/shell.rs`)**: `kodera-desktop` runs standalone health/contract diagnostics (`--version`, `--help`, `--print-runtime-metadata`, `--self-check`), single-shot deep-link admission (`--deep-link <uri>`), and a bounded line-delimited JSON IPC loop (`--ipc-stdio`) over `DesktopWorkspaceSession`.
- **Window state & multi-monitor bounds clamping (`src/window_state.rs`)**: Default `1280x820` geometry (`minWidth: 960`, `minHeight: 640`). Restored window coordinates are clamped onto intersecting monitor work areas with minimum visible titlebar margins, windows stranded on unplugged secondary monitors are re-centered onto the primary work area, oversized dimensions shrink cleanly onto compact displays, and state snapshots write atomically via temporary file rename.
- **System tray icon & menu (`src/tray_ptt.rs`)**: Configured in `tauri.conf.json` (`app.trayIcon.id = "kodera-tray"`, `icons/32x32.png`). `TrayController` drives a deterministic 4-item native tray menu (*Open Kodera*, *Toggle Mute / Unmute Microphone*, *Unread Messages: `<badge>`* disabled status row capped at `"99+"`, and *Quit Kodera*) plus indicator priority resolution (`ActiveCall` > `SelfHostDegraded` > `Muted` > `Unread` > `Idle`) and opt-in global Push-to-Talk (`PTT`) with typing-hijack guards.
- **Deep-link router & OIDC PKCE `S256` loopback handler (`src/deeplink.rs`, `src/oidc_loopback.rs`)**:
  - Validates `kodera://` (`kodera://workspace/...`, `kodera://invite/...`, `kodera://call/...`, `kodera://auth/callback?code=...&state=...`) and MSC2312 `matrix:` URIs up to 512 bytes against `DeepLinkAdmissionPolicy`. Control characters, fragments, backslashes, percent-encoded delimiters, path traversal (`..`), embedded credentials (`@`), dangerous/web schemes (`javascript:`, `data:`, `file:`, `http:`, `https:`), and unapproved origins fail closed; OIDC authorization codes are wrapped in `RedactedOidcCode`.
  - Implements RFC 8252 §7.3 loopback callback handling (`OidcLoopbackListener` bound strictly to `127.0.0.1:0` with `Host` header DNS-rebinding defense) and RFC 7636 `S256` PKCE challenge/verifier validation (`OidcPkceSession`, `OidcIssuerAllowlist`).
- **Zeroized in-memory credential vault & OS keychain command-spec seam (`src/keychain.rs`)**: Derives canonical `(service, account)` coordinates (`io.kodera.desktop.<kind>` and `org:<organisation_uuid>:user:@<localpart>:<domain>`), validates `KeychainSessionMetadata`, stores redacted `RedactedSessionSecret` values in an organisation-isolated bounded process-memory vault (`KeychainCredentialStore`: `store_keychain_credential`, `load_keychain_credential`, `delete_keychain_credential`; reported truthfully as `nativeKeychain: false, ephemeralProcessVault: true` in `@kodera/desktop`) that overwrites secret bytes on overwrite/delete/switch/drop, and generates platform CLI command specs (`security` on macOS, `secret-tool` on Linux Secret Service, `cmdkey` on Windows Credential Locker) without shell interpolation. Persistent OS keychain storage across desktop process restarts is Planned.
- **Native desktop notifications & dock/taskbar unread badge (`src/notifications.rs`)**: `NotificationCenter` (`dispatch_notification`, `set_unread_badge`) validates titles/bodies (rejecting control characters and Unicode bidi spoofing overrides), validates optional `route_uri` targets through `route_deep_link`, supports `redact_preview` and Do-Not-Disturb suppression, caps history at 64 entries, and formats dock/taskbar unread badges (`None` for `0`, `"1"`–`"99"`, `"99+"`).
- **Strict CSP & least-privilege capabilities (`src/csp_policy.rs`, `tauri.conf.json`, `capabilities/default.json`)**:
  - Enforces `default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, zero `'unsafe-eval'`, and explicit path-scoped HTTPS/WSS `connect-src` origins (`https://api.kodera.io`, `https://staging-api.kodera.io`, `https://auth.kodera.io/realms/`, `https://matrix.kodera.io/_matrix/`, `https://*.kodera.io/_matrix/`, `wss://livekit.kodera.io`, `wss://collab.kodera.io`).
  - `capabilities/default.json` binds only the `main` window on local assets (`local: true`) to `core:default`, `core:window:allow-show`, `core:window:allow-hide`, `core:window:allow-set-focus`, `core:window:allow-unminimize`, and `deep-link:default` — zero shell, filesystem, or wildcard permissions.
  - `build.rs` verifies `tauri.conf.json`, `capabilities/default.json`, and the binary headers of the required bundle icons at compile time. `icons:check` additionally verifies every 16–1024 px raster and all ICNS/ICO frames against the official seven-path monogram and Cobalt 500 / Frost 100 design tokens.
- **Proximity mesh, self-host planner, automated `deploy/community` wizard & health inspector (`src/lib.rs`, `src/self_host_deploy.rs`, `src/self_host_health.rs`)**:
  - `DesktopProximityNode` coordinates signed 129-byte proximity check-ins (`kodera-rs`), replay suppression, and priority relay queues within one provisioned organisation session.
  - `#proximity` is an everyday presence channel with a voluntary, pseudonymous check-in. It is not an emergency service: it does not reach emergency services, and delivery is never guaranteed. It was first named `#urgence`. The 129-byte public frame and every other v1 wire byte are frozen under their historical values (magic `KE`, signed label `kodera-emergency-v1:`); only names in code, routes and copy changed.
  - `SelfHostDeploymentPlan` validates self-host domain/provider inputs with redacted tokens, and `inspect_community_compose_ps` / `probe_local_community_stack` monitor the `< 1.5 GiB` (`1536 MiB`) single-node Community Compose profile (`postgres`, `synapse`, `coturn` / `livekit`).
  - `self_host_deploy.rs` automates local Docker Engine `deploy/community` deployment without shell interpolation: `self_host_preflight_community` validates `docker --version`, `docker compose version`, directory permissions, regular `docker-compose.yml` presence, and domain/email/TLS/port inputs; `self_host_prepare_community` generates 16 distinct OS CSPRNG secrets (`getrandom::fill`), writes `.env` atomically with `0600` Unix permissions, and validates via `docker compose config --quiet`; `self_host_deploy_community` runs `docker compose up -d --wait` and polls `self_host_health` until Keycloak, Server, Web, LiveKit, PostgreSQL, and Synapse report healthy.

### 2. TypeScript IPC Bridge & Browser Fallback (`apps/desktop/src/`)

`@kodera/desktop` exports a typed ESM + `.d.ts` client consumed by `@kodera/web`:

```ts
import { createDesktopClient, isTauriDesktopRuntime } from "@kodera/desktop";

const desktop = createDesktopClient({ organisationId });
if (desktop.isNativeDesktop()) {
  await desktop.setUnreadCount(4);
  const metadata = await desktop.getAppMetadata();
}
```

- Detects `window.__TAURI_INTERNALS__.invoke` (`isTauriDesktopRuntime`) and falls back to deterministic no-ops outside Tauri without touching `localStorage` or `sessionStorage`, while still enforcing client-side scheme/origin/character validation.
- Exposes `getAppMetadata()`, `checkForAppUpdates()`, `restartToUpdate()`, `routeDeepLink(rawUri)`, `listenDeepLinks(listener)`, `setUnreadCount(unreadCount)`, `updateTrayState(state)`, `triggerTrayAction(action)`, `listenTrayActions(listener)`, `sendNotification(request)`, `storeSecureCredential(input)`, `loadSecureCredentialStatus(secretKind, matrixUserId)`, `deleteSecureCredential(secretKind, matrixUserId)`, `beginOidcPkceLoopback(input)`, `completeOidcPkceCallback(callbackUri)`, `restoreWindowBounds(savedStateJson)`, `preflightCommunityDeploy(input)`, `prepareCommunityDeploy(input)`, and `deployCommunityStack(input)`.

## Bounded JSON Command Seam (40 Routes + 3 Permanent Aliases)

`DesktopWorkspaceSession::dispatch_command(&str)` accepts flat JSON objects up to 16,384 UTF-8 bytes with `command` (or `op` on the 6 workspace preference routes) and active canonical non-nil `organisation_id`. Unknown fields, duplicate keys (including Unicode-escaped duplicates), nested objects, trailing bytes, and wrong-organisation calls fail closed without side effects.

| `command` | Required / optional fields |
| --- | --- |
| `plan_self_host` | `provider` (`scaleway`, `hetzner`, `hostinger`, `ovhcloud`), `region`, `fqdn`, `acme_email`, `raw_token` |
| `validate_docs_pad_url` | `raw_url` (trusted Docs host must be provisioned) |
| `proximity_current_beacon` (alias `emergency_current_beacon`) | `now_unix_secs` |
| `proximity_member_statuses` (alias `emergency_member_statuses`) | None |
| `proximity_next_relay_batch` (alias `emergency_next_relay_batch`) | `max_frames` (`<= 128`) |
| `set_sound_pack` / `get_sound_pack` | `sound_pack` (`givre`, `cristal`, `atelier`, `8bit`, `404`, `silent`) / None |
| `clear_workspace_session` | None |
| `create_channel_poll` | `channel_id`, `poll_id`, `question`, `options` (2–10 strings), `allow_multiple` |
| `vote_channel_poll` | `channel_id`, `poll_id`, `voter_id`, `selections` (0–10 indices) |
| `get_channel_poll` / `close_channel_poll` | `channel_id`, `poll_id` |
| `redact_iban` | `raw_iban` (`<= 128` bytes, canonical structure) |
| `validate_connector_post_url` | `raw_url` (canonical HTTPS public FQDN URL) |
| `set_theme_mode` | `mode` (`light`, `dark`, `black`; also admitted via `op`) |
| `import_shareable_theme` / `export_shareable_theme` | `code` (`kodera-theme:v1:...`) / None (also admitted via `op`) |
| `update_user_profile` | `user_id`, `display_name`, `handle`, `role_title`, `presence`, `rank`; optional `status_emoji`, `status_text` |
| `evaluate_channel_iam` | `channel_id`, `rank` |
| `save_docs_pad` | `pad_id`, `channel_id`, `title`, `markdown_body`, `actor` |
| `route_deep_link` | `raw_uri` (`kodera://` or `matrix:`) |
| `update_tray_state` / `get_tray_state` | `unread_count`, `call_state`, `muted`, `self_host_degraded` / None |
| `trigger_tray_menu_action` | `action` (`open_kodera`, `toggle_mute`, `unread_indicator`, `quit`) |
| `set_unread_badge` | `unread_count` (`<= 99999`) |
| `configure_ptt` / `set_ptt_pressed` / `get_ptt_state` | `opt_in`, optional `chord` / `pressed`, `now_ms` / None |
| `validate_keychain_metadata` | `secret_kind`, `matrix_user_id`, `device_id`, `issued_at_unix_secs`; optional `expires_at_unix_secs`, `raw_secret` |
| `store_keychain_credential` | `secret_kind`, `matrix_user_id`, `device_id`, `issued_at_unix_secs`, `raw_secret`; optional `expires_at_unix_secs` |
| `load_keychain_credential` / `delete_keychain_credential` | `secret_kind`, `matrix_user_id` |
| `dispatch_notification` | `title`, `body`, `redact_preview`; optional `route_uri` |
| `restore_window_bounds` | optional `saved_state_json` |
| `begin_oidc_pkce_loopback` | `issuer_origin`, `client_id`, `code_verifier`, `state`, `loopback_port` |
| `complete_oidc_pkce_callback` | `callback_uri` |
| `inspect_self_host_health` | `compose_ps_json` |
| `self_host_preflight_community` | `stack_dir`, `domain`, `acme_email`, `tls_mode` (`acme`, `internal`, `off`), `http_port`, `https_port` |
| `self_host_prepare_community` | `stack_dir`, `domain`, `acme_email`, `oidc_provider_origin`, `tls_mode`, `http_port`, `https_port` |
| `self_host_deploy_community` | `stack_dir`; optional `timeout_ms` (`1000`–`300000`) |

## Local Development, Code Signing & Multi-OS Packaging

### Document and resource boundaries

Authentication navigation into the admitted identity origin grants no native command authority. Each new document creates a random identity for promise/callback delivery. Each navigation also rotates a native 256-bit OS-random capability, delivered only through identity-guarded activation; both capability and generation are required on commands. OS entropy failure denies activation and commands. The native page-load generation and capability reject queued work from departed documents, clears listeners and volatile host state, and binds replies/events to the originating document. Route changes within an existing document do not reset it.

The fallback stylesheet is generated from `@kodera/design-tokens` by `scripts/generate-bootstrap-css.mjs --write`; preflight rejects drift and literal styles. macOS builds with a pinned update key and feed check and stage signed updates in a background worker. The desktop-owned update pill appears only after verification and staging; unconfigured builds and other operating systems report unsupported. Native OS keychain execution, tray behavior and installed-package acceptance remain separate qualification work; command models and status-only credential loads do not prove vault persistence or secret extraction.

### Native GUI Window vs Headless CLI Execution

- **GUI Launch (default installer entrypoint)**: Invoking `kodera-desktop` with no arguments (or `--gui`, macOS LaunchServices `-psn_*`, or a bare `kodera://` / `matrix:` protocol URI) opens the native OS WebView window titled `"Kodera"` (`1280x820`, min `960x640`), serving bundled `apps/web/dist` assets or the CSP-verified bootstrap shell over `kodera-asset://localhost/index.html` with `window.__TAURI_INTERNALS__` + `window.koderaDesktop` IPC bridged to `DesktopShellHost` and fail-closed navigation validation (`validate_navigation_url`).
- **Headless CLI / RPC flags**: `--health` / `--self-check`, `--stdio-rpc` / `--ipc-stdio`, `--open-url <uri>` / `--deep-link <uri>`, `--print-runtime-metadata`, `--version` / `-V`, `--help` / `-h`.
- **Linux system packages** (Ubuntu / Debian): `pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`.

### Scripts (`apps/desktop/package.json`)

```bash
# Run native desktop host in development mode (launches Tauri CLI when installed, or native host)
npm --workspace @kodera/desktop run dev

# Build native host binary (`kodera-desktop`) and verify icons + Tauri security contracts
npm --workspace @kodera/desktop run build

# Run TypeScript strict typecheck + security mutation self-tests
npm --workspace @kodera/desktop run typecheck

# Run TypeScript/Node IPC bridge, browser fallback, packaging plan, and native binary stdio tests
npm --workspace @kodera/desktop run test

# Multi-OS installer packaging
npm --workspace @kodera/desktop run package:macos
npm --workspace @kodera/desktop run package:linux
npm --workspace @kodera/desktop run package:windows
```

### Multi-OS Installer Outputs

| Target script | Bundle formats | Expected bundle artifacts |
| --- | --- | --- |
| `package:macos` | `app`, `dmg` | `bundle/macos/Kodera.app`, `bundle/dmg/Kodera_<version>_aarch64.dmg`, `bundle/dmg/Kodera_<version>_x64.dmg` |
| `package:linux` | `appimage`, `deb` | `bundle/appimage/Kodera_<version>_amd64.AppImage`, `bundle/deb/Kodera_<version>_amd64.deb` |
| `package:windows` | `msi`, `nsis` | `bundle/msi/Kodera_<version>_x64_en-US.msi`, `bundle/nsis/Kodera_<version>_x64-setup.exe` |

Installer packaging requires the platform bundler and refuses with exit 69 when it is unavailable. `build` builds the host separately; `package --dry-run` only describes the plan. The frontend build is checked for complete local entry assets, symlinks and size bounds before bundling. `bundle.resources` copies the full frontend tree to `web/`: `Contents/Resources/web` on macOS, `usr/lib/Kodera/web` on Linux (including inside AppDir), and the installation's `web/` on Windows. Synthetic staging tests verify this mapping; no installed artifact is qualified by those tests.

### Code Signing & Notarization Environment Variables

Template placeholders live in [`apps/desktop/.env.example`](./.env.example). Never commit a `.env` file or signing material to git:

- **macOS (`app`, `dmg`)**: `APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific notarytool credential), `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`.
- **Windows (`msi`, `nsis`)**: `WINDOWS_CERTIFICATE_THUMBPRINT`, `WINDOWS_TIMESTAMP_URL`.
- **Linux & Release Update Signatures (`appimage`, `deb`)**: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

### Automated Multi-OS Release Workflow (`.github/workflows/release-binaries.yml`)

- Builds and stages `@kodera/web` + `@kodera/desktop` installers across `macos-15` (universal `.dmg` + `.app.tar.gz`), `ubuntu-latest` (genuine ELF Type-2 `AI\x02` + SquashFS `.AppImage` + `.deb`), and `windows-latest` (WiX `.msi` + NSIS `-setup.exe` with bundled `web/` assets).
- Verifies reproducible unsigned Android candidate APKs (`scripts/ci/package-android-release.py` + `scripts/ci/check-native-packaging.py`), then runs `zipalign` and `apksigner sign` (v1/v2/v3) + `apksigner verify` to produce an installable `kodera-android.apk` (failing closed on release tags if `ANDROID_SIGNING_KEYSTORE_B64` is absent).
- Merges npm workspace, `Cargo.lock` + `cargo metadata`, and resolved Android Maven `.jar`/`.aar` SHA-256 digests and POM SPDX licenses into `sbom-cyclonedx.json` (`scripts/ci/assemble-release-sbom.py`) alongside `SHA256SUMS.txt`.

## Verification

```bash
npm --workspace @kodera/desktop run typecheck
npm --workspace @kodera/desktop run test
cargo fmt --all -- --check
cargo check --locked --workspace --all-targets --all-features
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-targets --all-features
```

## License

Licensed under the Apache License, Version 2.0 ([`LICENSE`](./LICENSE)).

## Installation and signed updates

Status: macOS signed-update execution implemented; public signing, notarization and installed-package qualification remain operator gates. Windows and Linux self-update are deferred.

The macOS disk image contains `Kodera.app`, an `Applications` shortcut and installation instructions. Drag the app onto Applications, launch the copied app, then eject the image. A build artifact alone does not establish Gatekeeper acceptance: the fallback packager does not sign or notarize. A refused app needs an officially signed and notarized replacement; the instructions never ask members to disable platform protection.

For a macOS release that supports updates, set these **public build settings** before compiling:

- `KODERA_DESKTOP_UPDATE_FEED`: a direct HTTPS manifest URL, without redirects, credentials, query or fragment.
- `KODERA_DESKTOP_UPDATE_PUBLIC_KEY`: the 32-byte Ed25519 verification key as 64 lowercase hexadecimal characters. The signing key stays outside the application and repository.

The feed serves this exact JSON schema, with a detached Ed25519 signature over the exact response bytes at `<feed>.sig` (128 lowercase hexadecimal characters):

```json
{"version":"0.1.1","platform":"macos-universal","url":"https://downloads.example.org/kodera-desktop-macos-universal.app.tar.gz","sha256":"<64 lowercase hexadecimal characters>","expires_at":<Unix seconds>}
```

`expires_at` must be in the future and within 30 days. Versions have three numeric components and must advance the running version. The archive must be the genuine signed and notarized universal macOS app bundle with root `Kodera.app/`; archive links, traversal and special entries are refused. Publish the archive and signature before the manifest. HTTPS alone or a SHA-256 checksum without the detached signature never authorizes installation.

The native worker verifies the signature before parsing, bounds the download, checks the archive digest, extracts into private staging beside the installed app, and requires both `codesign --verify --deep --strict` and `spctl --assess` to succeed. It needs write access to the installation directory and never requests privilege escalation. Only then does **Update Ready · Restart to Update** appear (French follows the document language). The keyboard-accessible pill uses generated design tokens in an isolated shadow tree and is absent in ordinary web browsers.

Restart rechecks signature, freshness, digest and platform acceptance. A fixed native-owned helper waits for this process to exit, replaces the app by same-volume rename, restores the previous app if replacement or relaunch fails, and removes staging. WebView payloads cannot choose a key, feed, path or command. The existing `quit` action preserves window state during handoff. A failed recheck closes the stale affordance without interrupting the workspace.

Tests cover throwaway-key signature rejection, tampering, wrong keys, expiry, downgrade, malformed platform/URL, hidden unverified UI, bilingual ready/restart behavior and container resolutions. These tests do not constitute public release signing or a real Gatekeeper-approved installed update; that end-to-end acceptance belongs on the hosted macOS release runner with operator-managed signing.
