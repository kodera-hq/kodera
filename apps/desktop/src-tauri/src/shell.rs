//! Runnable Kodera Desktop native host shell (`kodera-desktop`), CLI flags, self-check harness,
//! and bounded line-delimited JSON stdio IPC bridge.
//!
//! Security invariants:
//! - Every startup or `--self-check` invocation verifies the embedded `tauri.conf.json` CSP
//!   (`default-src 'self'`, zero `'unsafe-eval'`, path-scoped `https://`/`wss://` `connect-src`),
//!   multi-monitor window bounds clamping, system tray menu integrity, and deep-link injection
//!   defenses before admitting traffic.
//! - `--deep-link <uri>` validates untrusted OS protocol arguments through
//!   [`crate::deeplink::route_deep_link`] and never echoes rejected URIs in stdout/stderr.
//! - `--ipc-stdio` enforces [`crate::MAX_IPC_COMMAND_BYTES`] per line before JSON decoding and
//!   never serializes raw secrets (`RedactedSessionSecret`, `RedactedOidcCode`,
//!   `RedactedCodeVerifier`, `RedactedApiToken`) onto stdout.

use crate::{
    pkce_s256_challenge, route_deep_link, sanitize_and_clamp_window_state,
    verify_embedded_tauri_conf_csp, AdmittedDeepLink, DeepLinkAdmissionPolicy, DesktopCommandError,
    DesktopCommandResponse, DesktopWorkspaceSession, MonitorWorkArea, RestoredWindowPlacement,
    TrayController, TrayMenuItemId, TrayMenuModel, DESKTOP_APP_IDENTIFIER, MAX_IPC_COMMAND_BYTES,
    REGISTERED_DESKTOP_COMMANDS,
};
use core::fmt;
use std::collections::HashSet;
use std::io::{BufRead, Write};

/// Canonical product display name matching `tauri.conf.json`.
pub const DESKTOP_PRODUCT_NAME: &str = "Kodera";

/// Crate semantic version compiled into the native desktop binary.
pub const DESKTOP_APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Closed error codes for the runnable desktop shell host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopShellError {
    InvalidCliArguments,
    GuiLaunchRequired,
    GuiRuntimeUnavailable,
    GuiWindowInitFailed,
    GuiWebViewInitFailed,
    UntrustedStartupUrl,
    SelfCheckFailed(&'static str),
    DeepLinkRejected(String),
    IoFailure,
}

impl fmt::Display for DesktopShellError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidCliArguments => f.write_str("invalid_cli_arguments"),
            Self::GuiLaunchRequired => f.write_str("gui_launch_required"),
            Self::GuiRuntimeUnavailable => f.write_str("gui_runtime_unavailable"),
            Self::GuiWindowInitFailed => f.write_str("gui_window_init_failed"),
            Self::GuiWebViewInitFailed => f.write_str("gui_webview_init_failed"),
            Self::UntrustedStartupUrl => f.write_str("untrusted_startup_url"),
            Self::SelfCheckFailed(stage) => write!(f, "self_check_failed:{stage}"),
            Self::DeepLinkRejected(code) => write!(f, "deep_link_rejected:{code}"),
            Self::IoFailure => f.write_str("io_failure"),
        }
    }
}

impl std::error::Error for DesktopShellError {}

/// Startup execution mode resolved from OS process arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopLaunchMode {
    /// Launch the native OS desktop window and WebView event loop (`kodera-desktop` with no CLI flags,
    /// `--gui`, macOS LaunchServices `-psn_*`, or an OS protocol activation URI).
    Gui {
        initial_deep_link: Option<AdmittedDeepLink>,
    },
    /// Run a deterministic headless CLI / stdio RPC operation and exit.
    Cli(Vec<String>),
}

/// Classifies raw `argv[1..]` process arguments into native GUI launch vs headless CLI execution.
pub fn classify_launch_args<I, S>(args: I) -> Result<DesktopLaunchMode, DesktopShellError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let filtered: Vec<String> = args
        .into_iter()
        .map(|s| s.as_ref().to_owned())
        .filter(|arg| !arg.starts_with("-psn_"))
        .collect();

    match filtered.as_slice() {
        [] => Ok(DesktopLaunchMode::Gui {
            initial_deep_link: None,
        }),
        [flag] if flag == "--gui" => Ok(DesktopLaunchMode::Gui {
            initial_deep_link: None,
        }),
        [flag, raw_uri] if flag == "--gui" => {
            let policy = DeepLinkAdmissionPolicy::kodera_default();
            let admitted = route_deep_link(raw_uri, &policy)
                .map_err(|err| DesktopShellError::DeepLinkRejected(err.to_string()))?;
            Ok(DesktopLaunchMode::Gui {
                initial_deep_link: Some(admitted),
            })
        }
        [raw_uri] if raw_uri.starts_with("kodera:") || raw_uri.starts_with("matrix:") => {
            let policy = DeepLinkAdmissionPolicy::kodera_default();
            let admitted = route_deep_link(raw_uri, &policy)
                .map_err(|err| DesktopShellError::DeepLinkRejected(err.to_string()))?;
            Ok(DesktopLaunchMode::Gui {
                initial_deep_link: Some(admitted),
            })
        }
        _ => Ok(DesktopLaunchMode::Cli(filtered)),
    }
}

/// Immutable build, platform, and capability metadata exposed to the web shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopRuntimeMetadata {
    pub identifier: &'static str,
    pub product_name: &'static str,
    pub version: &'static str,
    pub update_channel: &'static str,
    pub os: &'static str,
    pub arch: &'static str,
    pub registered_command_count: usize,
    pub schemes: [&'static str; 2],
    pub tray_menu_items: [&'static str; 4],
}

impl DesktopRuntimeMetadata {
    pub const fn current() -> Self {
        Self {
            identifier: DESKTOP_APP_IDENTIFIER,
            product_name: DESKTOP_PRODUCT_NAME,
            version: DESKTOP_APP_VERSION,
            update_channel: "stable",
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            registered_command_count: REGISTERED_DESKTOP_COMMANDS.len(),
            schemes: ["kodera", "matrix"],
            tray_menu_items: [
                TrayMenuItemId::OpenKodera.as_str(),
                TrayMenuItemId::ToggleMute.as_str(),
                TrayMenuItemId::UnreadIndicator.as_str(),
                TrayMenuItemId::Quit.as_str(),
            ],
        }
    }

    pub fn to_json(&self) -> String {
        format!(
            r#"{{"identifier":"{}","product_name":"{}","version":"{}","update_channel":"{}","os":"{}","arch":"{}","registered_command_count":{},"schemes":["{}","{}"],"tray_menu_items":["{}","{}","{}","{}"]}}"#,
            self.identifier,
            self.product_name,
            self.version,
            self.update_channel,
            self.os,
            self.arch,
            self.registered_command_count,
            self.schemes[0],
            self.schemes[1],
            self.tray_menu_items[0],
            self.tray_menu_items[1],
            self.tray_menu_items[2],
            self.tray_menu_items[3],
        )
    }
}

/// Result of running the startup security and lifecycle self-check suite.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopSelfCheckReport {
    pub csp_verified: bool,
    pub window_placement: RestoredWindowPlacement,
    pub tray_menu_count: usize,
    pub deep_link_guard_verified: bool,
    pub pkce_s256_verified: bool,
}

impl DesktopSelfCheckReport {
    pub fn to_json(&self) -> String {
        format!(
            r#"{{"ok":true,"csp_verified":{},"window":{{"x":{},"y":{},"width":{},"height":{},"monitor":"{}"}},"tray_menu_count":{},"deep_link_guard_verified":{},"pkce_s256_verified":{}}}"#,
            self.csp_verified,
            self.window_placement.bounds.x,
            self.window_placement.bounds.y,
            self.window_placement.bounds.width,
            self.window_placement.bounds.height,
            json_escape(&self.window_placement.target_monitor_id),
            self.tray_menu_count,
            self.deep_link_guard_verified,
            self.pkce_s256_verified,
        )
    }
}

/// Stateful native shell host coordinating window placement, system tray, and workspace session.
pub struct DesktopShellHost {
    metadata: DesktopRuntimeMetadata,
    window_placement: RestoredWindowPlacement,
    tray_menu: TrayMenuModel,
    session: Option<DesktopWorkspaceSession>,
}

impl Default for DesktopShellHost {
    fn default() -> Self {
        Self::new()
    }
}

impl DesktopShellHost {
    pub fn new() -> Self {
        let monitors = [MonitorWorkArea::fallback_primary()];
        let window_placement = sanitize_and_clamp_window_state(None, &monitors)
            .expect("fallback primary monitor geometry is valid");
        let tray = TrayController::new();
        let tray_menu = tray.menu_model(false);
        Self {
            metadata: DesktopRuntimeMetadata::current(),
            window_placement,
            tray_menu,
            session: None,
        }
    }

    pub const fn metadata(&self) -> &DesktopRuntimeMetadata {
        &self.metadata
    }

    pub fn window_placement(&self) -> &RestoredWindowPlacement {
        &self.window_placement
    }

    pub fn tray_menu(&self) -> &TrayMenuModel {
        &self.tray_menu
    }

    pub const fn has_active_session(&self) -> bool {
        self.session.is_some()
    }

    pub fn clear_active_session(&mut self) {
        if let Some(session) = &mut self.session {
            session.clear_session();
        }
        self.session = None;
    }

    /// Runs deterministic startup self-checks across CSP, window bounds, tray menu, deep-link
    /// scheme filtering, and OIDC PKCE `S256`.
    pub fn self_check() -> Result<DesktopSelfCheckReport, DesktopShellError> {
        verify_embedded_tauri_conf_csp()
            .map_err(|_| DesktopShellError::SelfCheckFailed("csp_policy"))?;

        let monitors = [MonitorWorkArea::fallback_primary()];
        let placement = sanitize_and_clamp_window_state(None, &monitors)
            .map_err(|_| DesktopShellError::SelfCheckFailed("window_bounds"))?;

        let tray = TrayController::new();
        let menu = tray.menu_model(false);
        if menu.entries.len() != 4 {
            return Err(DesktopShellError::SelfCheckFailed("tray_menu"));
        }

        let policy = DeepLinkAdmissionPolicy::kodera_default();
        if route_deep_link("kodera://workspace/kodera/general", &policy).is_err() {
            return Err(DesktopShellError::SelfCheckFailed("deep_link_admit"));
        }
        if route_deep_link("javascript:alert(1)", &policy).is_ok() {
            return Err(DesktopShellError::SelfCheckFailed("deep_link_reject"));
        }

        let challenge = pkce_s256_challenge("pkce_self_check_verifier_alpha_bravo_charlie_0001")
            .map_err(|_| DesktopShellError::SelfCheckFailed("oidc_pkce"))?;
        if challenge.is_empty() {
            return Err(DesktopShellError::SelfCheckFailed("oidc_pkce_empty"));
        }

        Ok(DesktopSelfCheckReport {
            csp_verified: true,
            window_placement: placement,
            tray_menu_count: menu.entries.len(),
            deep_link_guard_verified: true,
            pkce_s256_verified: true,
        })
    }

    /// Provisions an active organisation workspace session inside the host shell.
    pub fn provision_session(&mut self, organisation_id: &str) -> Result<(), DesktopCommandError> {
        let salt = kodera_rs::sha256(format!("kodera-desktop-host:{organisation_id}").as_bytes());
        let session = DesktopWorkspaceSession::new(organisation_id, salt, HashSet::new(), 64)
            .map_err(DesktopCommandError::Core)?;
        self.window_placement = session
            .window_placement(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        self.tray_menu = session
            .tray_menu(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        self.session = Some(session);
        Ok(())
    }

    /// Processes a single JSON line from `--ipc-stdio`. Returns `(json_reply, should_quit)`.
    pub fn handle_stdio_line(&mut self, raw_line: &str) -> (String, bool) {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            return (r#"{"ok":false,"error":"empty_request"}"#.to_owned(), false);
        }
        if trimmed.len() > MAX_IPC_COMMAND_BYTES {
            return (
                r#"{"ok":false,"error":"request_too_large"}"#.to_owned(),
                false,
            );
        }
        if trimmed == r#"{"host_op":"get_runtime_metadata"}"# {
            return (
                format!(r#"{{"ok":true,"metadata":{}}}"#, self.metadata.to_json()),
                false,
            );
        }
        if trimmed == r#"{"host_op":"self_check"}"# {
            return match Self::self_check() {
                Ok(report) => (report.to_json(), false),
                Err(err) => (
                    format!(
                        r#"{{"ok":false,"error":"{}"}}"#,
                        json_escape(&err.to_string())
                    ),
                    false,
                ),
            };
        }
        if trimmed == r#"{"host_op":"quit"}"# {
            if let Some(session) = &mut self.session {
                session.clear_session();
            }
            self.session = None;
            return (r#"{"ok":true,"quit":true}"#.to_owned(), true);
        }
        if let Some(org_id) = parse_init_session_op(trimmed) {
            return match self.provision_session(&org_id) {
                Ok(()) => (
                    format!(
                        r#"{{"ok":true,"organisation_id":"{}"}}"#,
                        json_escape(&org_id)
                    ),
                    false,
                ),
                Err(err) => (
                    format!(r#"{{"ok":false,"error":"{}"}}"#, command_error_slug(&err)),
                    false,
                ),
            };
        }

        let Some(session) = &mut self.session else {
            return (
                r#"{"ok":false,"error":"session_not_initialized"}"#.to_owned(),
                false,
            );
        };
        let response = session.dispatch_command(trimmed);
        if let Some(org) = session.organisation_id().map(str::to_owned) {
            if let Ok(win) = session.window_placement(&org) {
                self.window_placement = win;
            }
            if let Ok(menu) = session.tray_menu(&org) {
                self.tray_menu = menu;
            }
        }
        serialize_command_response(response)
    }

    /// Runs the bounded line-delimited JSON IPC loop over `reader` and `writer`.
    pub fn serve_stdio<R: BufRead, W: Write>(
        &mut self,
        mut reader: R,
        mut writer: W,
    ) -> Result<(), DesktopShellError> {
        let mut line = String::new();
        loop {
            line.clear();
            let read_bytes = reader
                .read_line(&mut line)
                .map_err(|_| DesktopShellError::IoFailure)?;
            if read_bytes == 0 {
                break;
            }
            let (reply, should_quit) = self.handle_stdio_line(&line);
            writeln!(writer, "{reply}").map_err(|_| DesktopShellError::IoFailure)?;
            writer.flush().map_err(|_| DesktopShellError::IoFailure)?;
            if should_quit {
                break;
            }
        }
        Ok(())
    }
}

fn parse_init_session_op(trimmed: &str) -> Option<String> {
    let prefix = r#"{"host_op":"init_session","organisation_id":""#;
    let rest = trimmed.strip_prefix(prefix)?;
    let org_id = rest.strip_suffix(r#""}"#)?;
    if org_id.is_empty() || org_id.len() > 64 || org_id.contains('"') || org_id.contains('\\') {
        return None;
    }
    Some(org_id.to_owned())
}

fn serialize_command_response(response: DesktopCommandResponse) -> (String, bool) {
    match response {
        DesktopCommandResponse::WindowPlacement(p) => (
            format!(
                r#"{{"ok":true,"type":"window_placement","x":{},"y":{},"width":{},"height":{},"maximized":{},"fullscreen":{},"visible":{},"target_monitor_id":"{}","clamped":{}}}"#,
                p.bounds.x,
                p.bounds.y,
                p.bounds.width,
                p.bounds.height,
                p.maximized,
                p.fullscreen,
                p.visible,
                json_escape(&p.target_monitor_id),
                p.clamped,
            ),
            false,
        ),
        DesktopCommandResponse::TrayState(t) => (
            format!(
                r#"{{"ok":true,"type":"tray_state","unread_count":{},"unread_badge":{},"muted":{},"ptt_transmitting":{},"self_host_degraded":{},"tooltip":"{}"}}"#,
                t.unread_count,
                optional_json_str(t.unread_badge.as_deref()),
                t.muted,
                t.ptt_transmitting,
                t.self_host_degraded,
                json_escape(&t.tooltip),
            ),
            false,
        ),
        DesktopCommandResponse::TrayMenuAction(outcome) => match outcome {
            crate::TrayMenuActionOutcome::ShowAndFocusMainWindow { tray } => (
                format!(
                    r#"{{"ok":true,"type":"tray_menu_action","action":"open_kodera","window_visible":true,"muted":{},"unread_count":{}}}"#,
                    tray.muted, tray.unread_count
                ),
                false,
            ),
            crate::TrayMenuActionOutcome::MuteToggled { muted, tray } => (
                format!(
                    r#"{{"ok":true,"type":"tray_menu_action","action":"toggle_mute","muted":{},"tooltip":"{}"}}"#,
                    muted,
                    json_escape(&tray.tooltip)
                ),
                false,
            ),
            crate::TrayMenuActionOutcome::UnreadIndicatorStatus {
                unread_count,
                unread_badge,
                ..
            } => (
                format!(
                    r#"{{"ok":true,"type":"tray_menu_action","action":"unread_indicator","unread_count":{},"unread_badge":{}}}"#,
                    unread_count,
                    optional_json_str(unread_badge.as_deref())
                ),
                false,
            ),
            crate::TrayMenuActionOutcome::QuitRequested => (
                r#"{"ok":true,"type":"tray_menu_action","action":"quit","quit":true}"#.to_owned(),
                true,
            ),
        },
        DesktopCommandResponse::DockBadge(b) => (
            format!(
                r#"{{"ok":true,"type":"dock_badge","unread_count":{},"badge_label":{},"visible":{}}}"#,
                b.unread_count,
                optional_json_str(b.badge_label.as_deref()),
                b.visible,
            ),
            false,
        ),
        DesktopCommandResponse::Notification(n) => (
            format!(
                r#"{{"ok":true,"type":"notification","notification_id":{},"title":"{}","body":"{}","canonical_route_uri":{},"redacted":{},"suppressed_by_dnd":{}}}"#,
                n.notification_id,
                json_escape(&n.title),
                json_escape(&n.body),
                optional_json_str(n.canonical_route_uri.as_deref()),
                n.redacted,
                n.suppressed_by_dnd,
            ),
            false,
        ),
        DesktopCommandResponse::DeepLink(link) => (serialize_admitted_deep_link(&link), false),
        DesktopCommandResponse::KeychainMetadata(m) => (
            format!(
                r#"{{"ok":true,"type":"keychain_metadata","service_name":"{}","account_name":"{}","device_id":"{}","issued_at_unix_secs":{}}}"#,
                json_escape(&m.slot.service_name),
                json_escape(&m.slot.account_name),
                json_escape(&m.device_id),
                m.issued_at_unix_secs,
            ),
            false,
        ),
        DesktopCommandResponse::KeychainStatus(s) => (
            format!(
                r#"{{"ok":true,"type":"keychain_status","service_name":"{}","account_name":"{}","present":{}}}"#,
                json_escape(&s.slot.service_name),
                json_escape(&s.slot.account_name),
                s.present,
            ),
            false,
        ),
        DesktopCommandResponse::OidcLoopbackReady(r) => (
            format!(
                r#"{{"ok":true,"type":"oidc_loopback_ready","issuer_origin":"{}","client_id":"{}","redirect_uri":"{}","loopback_port":{},"code_challenge":"{}","code_challenge_method":"{}"}}"#,
                json_escape(&r.issuer_origin),
                json_escape(&r.client_id),
                json_escape(&r.redirect_uri),
                r.loopback_port,
                json_escape(&r.code_challenge),
                r.code_challenge_method,
            ),
            false,
        ),
        DesktopCommandResponse::OidcCallback(c) => (
            format!(
                r#"{{"ok":true,"type":"oidc_callback_verified","issuer_origin":"{}","client_id":"{}","redirect_uri":"{}"}}"#,
                json_escape(&c.issuer_origin),
                json_escape(&c.client_id),
                json_escape(&c.redirect_uri),
            ),
            false,
        ),
        DesktopCommandResponse::WorkspaceSessionCleared => (
            r#"{"ok":true,"type":"workspace_session_cleared"}"#.to_owned(),
            false,
        ),
        DesktopCommandResponse::Error(err) => (
            format!(r#"{{"ok":false,"error":"{}"}}"#, command_error_slug(&err)),
            false,
        ),
        _ => (
            r#"{"ok":true,"type":"command_completed"}"#.to_owned(),
            false,
        ),
    }
}

fn serialize_admitted_deep_link(link: &AdmittedDeepLink) -> String {
    let scheme = match link {
        AdmittedDeepLink::Matrix(_) => "matrix",
        AdmittedDeepLink::Kodera(_) => "kodera",
    };
    format!(
        r#"{{"ok":true,"type":"deep_link","scheme":"{}","canonical_uri":"{}"}}"#,
        scheme,
        json_escape(link.canonical_uri()),
    )
}

fn command_error_slug(err: &DesktopCommandError) -> String {
    match err {
        DesktopCommandError::RequestTooLarge => "request_too_large".to_owned(),
        DesktopCommandError::InvalidRequest => "invalid_request".to_owned(),
        DesktopCommandError::Core(c) => format!("core:{c:?}").to_ascii_lowercase(),
        DesktopCommandError::Deployment(d) => format!("deployment:{d:?}").to_ascii_lowercase(),
        DesktopCommandError::SecretInPublicPlan => "secret_in_public_plan".to_owned(),
        DesktopCommandError::DeepLink(d) => format!("deep_link:{d}"),
        DesktopCommandError::TrayPtt(t) => format!("tray_ptt:{t}"),
        DesktopCommandError::Keychain(k) => format!("keychain:{k}"),
        DesktopCommandError::SelfHostHealth(h) => format!("self_host_health:{h}"),
        DesktopCommandError::WindowState(w) => format!("window_state:{w}"),
        DesktopCommandError::Notification(n) => format!("notification:{n}"),
        DesktopCommandError::OidcLoopback(o) => format!("oidc_loopback:{o}"),
    }
}

fn optional_json_str(val: Option<&str>) -> String {
    match val {
        Some(s) => format!(r#""{}""#, json_escape(s)),
        None => "null".to_owned(),
    }
}

fn json_escape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// Executes the headless `kodera-desktop` CLI contract and returns a process exit code.
///
/// Invoking `kodera-desktop` without CLI arguments launches the native desktop GUI window via
/// [`crate::gui::launch_desktop_gui`]; passing empty or `--gui` arguments into `run_cli` returns
/// [`DesktopShellError::GuiLaunchRequired`].
pub fn run_cli<I, S, R, W, E>(
    args: I,
    stdin: R,
    mut stdout: W,
    mut stderr: E,
) -> Result<i32, DesktopShellError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
    R: BufRead,
    W: Write,
    E: Write,
{
    let collected: Vec<String> = args.into_iter().map(|s| s.as_ref().to_owned()).collect();
    match collected.as_slice() {
        [] => Err(DesktopShellError::GuiLaunchRequired),
        [flag] if flag == "--gui" => Err(DesktopShellError::GuiLaunchRequired),
        [flag] if flag == "--version" || flag == "-V" => {
            writeln!(stdout, "{DESKTOP_PRODUCT_NAME} {DESKTOP_APP_VERSION}")
                .map_err(|_| DesktopShellError::IoFailure)?;
            Ok(0)
        }
        [flag] if flag == "--help" || flag == "-h" => {
            writeln!(
                stdout,
                "Usage: kodera-desktop [--gui | --version | --print-runtime-metadata | --self-check | --health | --deep-link <uri> | --open-url <uri> | --ipc-stdio | --stdio-rpc]"
            )
            .map_err(|_| DesktopShellError::IoFailure)?;
            Ok(0)
        }
        [flag] if flag == "--print-runtime-metadata" => {
            writeln!(stdout, "{}", DesktopRuntimeMetadata::current().to_json())
                .map_err(|_| DesktopShellError::IoFailure)?;
            Ok(0)
        }
        [flag] if flag == "--self-check" || flag == "--health" => {
            let report = DesktopShellHost::self_check()?;
            writeln!(stdout, "{}", report.to_json()).map_err(|_| DesktopShellError::IoFailure)?;
            Ok(0)
        }
        [flag, raw_uri] if flag == "--deep-link" || flag == "--open-url" => {
            let _ = DesktopShellHost::self_check()?;
            let policy = DeepLinkAdmissionPolicy::kodera_default();
            match route_deep_link(raw_uri, &policy) {
                Ok(admitted) => {
                    writeln!(stdout, "{}", serialize_admitted_deep_link(&admitted))
                        .map_err(|_| DesktopShellError::IoFailure)?;
                    Ok(0)
                }
                Err(err) => {
                    writeln!(stderr, r#"{{"ok":false,"error":"deep_link:{err}"}}"#)
                        .map_err(|_| DesktopShellError::IoFailure)?;
                    Ok(2)
                }
            }
        }
        [flag] if flag == "--ipc-stdio" || flag == "--stdio-rpc" => {
            let _ = DesktopShellHost::self_check()?;
            let mut host = DesktopShellHost::new();
            host.serve_stdio(stdin, stdout)?;
            Ok(0)
        }
        _ => {
            writeln!(stderr, r#"{{"ok":false,"error":"invalid_cli_arguments"}}"#)
                .map_err(|_| DesktopShellError::IoFailure)?;
            Ok(64)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const ORG: &str = "019a5e62-6ca0-7303-8303-030303030303";

    #[test]
    fn cli_supports_version_metadata_self_check_and_deep_link_filtering() {
        let mut out = Vec::new();
        let mut err = Vec::new();
        assert_eq!(
            run_cli(["--version"], Cursor::new(""), &mut out, &mut err).unwrap(),
            0
        );
        assert!(String::from_utf8(out.clone())
            .unwrap()
            .starts_with("Kodera "));

        out.clear();
        assert_eq!(
            run_cli(["--self-check"], Cursor::new(""), &mut out, &mut err).unwrap(),
            0
        );
        let check_json = String::from_utf8(out.clone()).unwrap();
        assert!(check_json.contains(r#""ok":true"#));
        assert!(check_json.contains(r#""csp_verified":true"#));

        out.clear();
        assert_eq!(
            run_cli(
                ["--deep-link", "kodera://workspace/acme-ops/general"],
                Cursor::new(""),
                &mut out,
                &mut err,
            )
            .unwrap(),
            0
        );
        assert!(String::from_utf8(out.clone())
            .unwrap()
            .contains("kodera://workspace/acme-ops/general"));

        // Malicious javascript: URI exits with code 2 and never echoes payload.
        out.clear();
        err.clear();
        assert_eq!(
            run_cli(
                ["--deep-link", "javascript:alert('xss_marker')"],
                Cursor::new(""),
                &mut out,
                &mut err,
            )
            .unwrap(),
            2
        );
        let err_str = String::from_utf8(err).unwrap();
        assert!(err_str.contains("unsupported_scheme"));
        assert!(!err_str.contains("xss_marker"));
    }

    #[test]
    fn stdio_ipc_bridge_drives_session_tray_badge_notifications_and_quit() {
        let input = [
            format!(r#"{{"host_op":"init_session","organisation_id":"{ORG}"}}"#),
            format!(
                r#"{{"command":"set_unread_badge","organisation_id":"{ORG}","unread_count":42}}"#
            ),
            format!(
                r#"{{"command":"trigger_tray_menu_action","organisation_id":"{ORG}","action":"toggle_mute"}}"#
            ),
            format!(
                r#"{{"command":"dispatch_notification","organisation_id":"{ORG}","title":"Ops","body":"All clear","redact_preview":false}}"#
            ),
            r#"{"host_op":"quit"}"#.to_owned(),
        ]
        .join("\n")
            + "\n";

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run_cli(
            ["--ipc-stdio"],
            Cursor::new(input.as_bytes()),
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        let lines: Vec<&str> = core::str::from_utf8(&out).unwrap().lines().collect();
        assert_eq!(lines.len(), 5);
        assert!(lines[0].contains(r#""ok":true"#));
        assert!(lines[1].contains(r#""badge_label":"42""#));
        assert!(lines[2].contains(r#""action":"toggle_mute","muted":true"#));
        assert!(lines[3].contains(r#""type":"notification""#));
        assert!(lines[4].contains(r#""quit":true"#));
    }

    #[test]
    fn empty_args_and_macos_psn_route_to_gui_launch_never_silent_cli_exit() {
        assert_eq!(
            classify_launch_args([] as [&str; 0]).unwrap(),
            DesktopLaunchMode::Gui {
                initial_deep_link: None
            }
        );
        assert_eq!(
            classify_launch_args(["--gui"]).unwrap(),
            DesktopLaunchMode::Gui {
                initial_deep_link: None
            }
        );
        assert_eq!(
            classify_launch_args(["-psn_0_49152"]).unwrap(),
            DesktopLaunchMode::Gui {
                initial_deep_link: None
            }
        );
        match classify_launch_args(["kodera://workspace/acme-ops/general"]).unwrap() {
            DesktopLaunchMode::Gui {
                initial_deep_link: Some(link),
            } => assert_eq!(link.canonical_uri(), "kodera://workspace/acme-ops/general"),
            other => panic!("expected GUI mode with initial deep link, got {other:?}"),
        }
        assert!(matches!(
            classify_launch_args([
                "kodera://workspace/acme-ops/general?redirect_uri=https://evil.example"
            ]),
            Err(DesktopShellError::DeepLinkRejected(_))
        ));

        let mut out = Vec::new();
        let mut err = Vec::new();
        assert_eq!(
            run_cli([] as [&str; 0], Cursor::new(""), &mut out, &mut err),
            Err(DesktopShellError::GuiLaunchRequired)
        );
    }

    #[test]
    fn cli_supports_health_open_url_and_stdio_rpc_aliases() {
        let mut out = Vec::new();
        let mut err = Vec::new();
        assert_eq!(
            run_cli(["--health"], Cursor::new(""), &mut out, &mut err).unwrap(),
            0
        );
        assert!(String::from_utf8(out.clone())
            .unwrap()
            .contains(r#""csp_verified":true"#));

        out.clear();
        assert_eq!(
            run_cli(
                ["--open-url", "matrix:r/ops:kodera.io?action=join"],
                Cursor::new(""),
                &mut out,
                &mut err
            )
            .unwrap(),
            0
        );
        assert!(String::from_utf8(out.clone())
            .unwrap()
            .contains("matrix:r/ops:kodera.io"));

        out.clear();
        assert_eq!(
            run_cli(
                ["--stdio-rpc"],
                Cursor::new(b"{\"host_op\":\"quit\"}\n" as &[u8]),
                &mut out,
                &mut err
            )
            .unwrap(),
            0
        );
        assert!(String::from_utf8(out).unwrap().contains(r#""quit":true"#));
    }
}
