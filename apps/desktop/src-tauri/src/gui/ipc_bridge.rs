//! Origin-fenced WebView IPC router, capability rotation, and command envelope dispatcher.

use super::picker::{NativeStackFolderPicker, OsNativeStackFolderPicker};
use super::{
    activate_js_document, dispatch_js_event, escape_js_json_str, resolve_js_promise,
    validate_navigation_url, NavigationDecision, ADMITTED_WEBVIEW_IPC_COMMANDS,
    APPROVED_DEV_ORIGINS, DESKTOP_WINDOW_TITLE, MAX_PENDING_DEEP_LINKS,
    MAX_REGISTERED_EVENT_LISTENERS, PRIVILEGED_INTERNAL_ONLY_COMMANDS,
};
use crate::{
    AdmittedDeepLink, DeepLinkAdmissionPolicy, DesktopShellHost, RestoredWindowPlacement,
    MAX_IPC_COMMAND_BYTES,
};
use core::fmt;
use std::collections::{BTreeSet, VecDeque};
use std::path::{Component, Path, PathBuf};

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
pub(super) struct RegisteredListener {
    event_id: u64,
    event_name: String,
    callback_id: u64,
}

pub(super) struct ForbiddenEnvelopeKey;

impl<'de> serde::Deserialize<'de> for ForbiddenEnvelopeKey {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let _ = serde::de::IgnoredAny::deserialize(deserializer)?;
        Ok(Self)
    }
}

const fn is_sorted_str_slice(slice: &[&str]) -> bool {
    let mut i = 1;
    while i < slice.len() {
        let left = slice[i - 1].as_bytes();
        let right = slice[i].as_bytes();
        let min_len = if left.len() < right.len() {
            left.len()
        } else {
            right.len()
        };
        let mut j = 0;
        let mut decided = false;
        while j < min_len {
            if left[j] < right[j] {
                decided = true;
                break;
            }
            if left[j] > right[j] {
                return false;
            }
            j += 1;
        }
        if !decided && left.len() >= right.len() {
            return false;
        }
        i += 1;
    }
    true
}

fn deserialize_present_key<'de, D>(
    deserializer: D,
) -> Result<Option<ForbiddenEnvelopeKey>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    <ForbiddenEnvelopeKey as serde::Deserialize>::deserialize(deserializer).map(Some)
}

fn deserialize_non_null_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    <String as serde::Deserialize>::deserialize(deserializer).map(Some)
}

/// Minimal IPC JSON envelope header that skips secret fields (`raw_token`, `raw_secret`,
/// `code_verifier`) via `serde::de::IgnoredAny` without allocating unzeroized `String` copies.
#[derive(Default, serde::Deserialize)]
pub(super) struct IpcEnvelopeHeader {
    #[serde(default, deserialize_with = "deserialize_non_null_string")]
    pub(super) command: Option<String>,
    #[serde(default, deserialize_with = "deserialize_present_key")]
    pub(super) host_op: Option<ForbiddenEnvelopeKey>,
    #[serde(default, deserialize_with = "deserialize_present_key")]
    pub(super) op: Option<ForbiddenEnvelopeKey>,
    #[serde(default, deserialize_with = "deserialize_non_null_string")]
    pub(super) stack_dir: Option<String>,
}

/// Stateful WebView IPC router bridging `window.__TAURI_INTERNALS__` and `window.koderaDesktop`
/// to [`DesktopShellHost`] after strict sender-origin validation.
pub struct DesktopWebViewBridge {
    pub(super) host: DesktopShellHost,
    pub(super) policy: DeepLinkAdmissionPolicy,
    pub(super) allow_dev_origin: bool,
    pub(super) next_event_id: u64,
    pub(super) listeners: Vec<RegisteredListener>,
    pub(super) pending_deep_links: VecDeque<String>,
    pub(super) document_id: Option<String>,
    pub(super) document_generation: u64,
    pub(super) document_capability: Option<String>,
    pub(super) ready_update: Option<crate::updater::ReadyUpdate>,
    pub(super) authorized_stack_dirs: BTreeSet<PathBuf>,
    pub(super) stack_folder_picker: std::sync::Arc<dyn NativeStackFolderPicker>,
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
            document_id: None,
            document_generation: 0,
            document_capability: fresh_document_capability(),
            ready_update: None,
            authorized_stack_dirs: BTreeSet::new(),
            stack_folder_picker: std::sync::Arc::new(OsNativeStackFolderPicker),
        }
    }

    /// Replaces the native OS folder chooser on this bridge instance (deterministic test seam).
    pub fn set_stack_folder_picker(&mut self, picker: std::sync::Arc<dyn NativeStackFolderPicker>) {
        self.stack_folder_picker = picker;
    }

    /// Discard all authority and callbacks owned by a departed top-level document.
    pub fn begin_document(&mut self, generation: u64) {
        if self.document_generation == generation {
            return;
        }
        if self.document_id.is_some() || self.document_generation != 0 {
            self.pending_deep_links.clear();
        }
        self.host.clear_active_session();
        self.listeners.clear();
        self.authorized_stack_dirs.clear();
        self.document_id = None;
        self.document_generation = generation;
        self.document_capability = fresh_document_capability();
    }

    pub fn clear_session(&mut self) {
        self.host.clear_active_session();
        self.authorized_stack_dirs.clear();
    }

    /// Records an explicit native OS folder-picker authorization for a canonical Community stack
    /// directory on the current document generation. WebView JavaScript cannot call this over IPC.
    pub fn authorize_community_stack_dir(
        &mut self,
        stack_dir: &Path,
    ) -> Result<PathBuf, crate::CommunityDeployError> {
        let raw = stack_dir
            .to_str()
            .ok_or(crate::CommunityDeployError::InvalidStackDir)?;
        let canonical = crate::self_host_deploy::canonicalize_authorized_stack_dir(raw)?;
        self.authorized_stack_dirs.insert(canonical.clone());
        Ok(canonical)
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
        // Custom WebView IPC commands are denied to all remote web origins (`capabilities/default.json`
        // specifies `local: true` with zero remote origins). Only bundled internal assets (and local
        // Vite loopback strictly when `allow_dev_origin` is active, excluding privileged host ops)
        // may address the IPC router.
        let is_internal_asset_origin =
            match validate_navigation_url(sender_url, &self.policy, self.allow_dev_origin) {
                Ok(NavigationDecision::AllowInternalAsset { .. }) => true,
                Ok(NavigationDecision::AllowTrustedWebOrigin { origin })
                    if self.allow_dev_origin && APPROVED_DEV_ORIGINS.contains(&origin.as_str()) =>
                {
                    false
                }
                _ => return Err(WebViewIpcError::UntrustedSenderOrigin),
            };

        let Some((header_line, json_body)) = raw_message.split_once('\n') else {
            return Err(WebViewIpcError::MalformedEnvelope);
        };
        let Some((req_id_str, cmd_raw)) = header_line.split_once('\t') else {
            return Err(WebViewIpcError::MalformedEnvelope);
        };
        let Some((document_id, req_id_str)) = req_id_str.split_once(':') else {
            return Err(WebViewIpcError::MalformedEnvelope);
        };
        if document_id.len() != 32
            || !document_id
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(WebViewIpcError::MalformedEnvelope);
        }
        if req_id_str == "hello" && cmd_raw == "__document_generation" {
            if json_body.trim() != "{}" {
                return Err(WebViewIpcError::MalformedEnvelope);
            }
            return Ok(WebViewIpcOutcome {
                eval_scripts: vec![activate_js_document(
                    document_id,
                    self.document_generation,
                    self.document_capability
                        .as_deref()
                        .ok_or(WebViewIpcError::UntrustedSenderOrigin)?,
                )],
                window_action: None,
            });
        }
        if self
            .document_id
            .as_deref()
            .is_some_and(|current| current != document_id)
        {
            return Err(WebViewIpcError::UntrustedSenderOrigin);
        }
        let Some((generation, req_id_str)) = req_id_str.split_once(':') else {
            return Err(WebViewIpcError::MalformedEnvelope);
        };
        if generation.parse::<u64>().ok() != Some(self.document_generation) {
            return Err(WebViewIpcError::UntrustedSenderOrigin);
        }
        let Some((capability, req_id_str)) = req_id_str.split_once(':') else {
            return Err(WebViewIpcError::MalformedEnvelope);
        };
        if !self
            .document_capability
            .as_deref()
            .is_some_and(|expected| same_document_capability(expected, capability))
        {
            return Err(WebViewIpcError::UntrustedSenderOrigin);
        }
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
            || ADMITTED_WEBVIEW_IPC_COMMANDS
                .binary_search(&cmd_raw)
                .is_err()
        {
            return Err(WebViewIpcError::MalformedEnvelope);
        }
        if PRIVILEGED_INTERNAL_ONLY_COMMANDS
            .binary_search(&cmd_raw)
            .is_ok()
            && !is_internal_asset_origin
        {
            return Err(WebViewIpcError::UntrustedSenderOrigin);
        }

        const {
            assert!(
                is_sorted_str_slice(ADMITTED_WEBVIEW_IPC_COMMANDS),
                "ADMITTED_WEBVIEW_IPC_COMMANDS must be sorted"
            );
            assert!(
                is_sorted_str_slice(PRIVILEGED_INTERNAL_ONLY_COMMANDS),
                "PRIVILEGED_INTERNAL_ONLY_COMMANDS must be sorted"
            );
        }

        let envelope: IpcEnvelopeHeader =
            serde_json::from_str(json_body).map_err(|_| WebViewIpcError::MalformedEnvelope)?;
        if envelope.host_op.is_some() || envelope.op.is_some() {
            return Err(WebViewIpcError::MalformedEnvelope);
        }
        let has_matching_body_command = match envelope.command.as_deref() {
            Some(body_cmd) if body_cmd == cmd_raw => true,
            Some(_) => return Err(WebViewIpcError::MalformedEnvelope),
            None => false,
        };

        self.document_id = Some(document_id.to_owned());
        let mut eval_scripts = Vec::new();
        let mut window_action = None;

        match cmd_raw {
            "get_app_metadata" | "check_app_updates" => {
                let payload = super::builtin_meta_payload(cmd_raw, self.ready_update.as_ref())
                    .expect("matched metadata or update command");
                eval_scripts.push(resolve_js_promise(document_id, req_id, true, &payload));
            }
            "restart_to_update" => {
                let result = self
                    .ready_update
                    .take()
                    .ok_or("update_not_ready")
                    .and_then(crate::updater::ReadyUpdate::restart);
                if result.is_ok() {
                    window_action = Some(GuiWindowAction::Quit);
                    eval_scripts.push(resolve_js_promise(
                        document_id,
                        req_id,
                        true,
                        r#"{"restarting":true}"#,
                    ));
                } else {
                    eval_scripts.push(resolve_js_promise(
                        document_id,
                        req_id,
                        false,
                        r#"{"error":"update_not_ready"}"#,
                    ));
                }
            }
            "plugin:event|listen" => {
                let Some(event_name) = extract_json_string_field(json_body, "event") else {
                    eval_scripts.push(resolve_js_promise(
                        document_id,
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
                        document_id,
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
                        document_id,
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
                eval_scripts.push(resolve_js_promise(
                    document_id,
                    req_id,
                    true,
                    &event_id.to_string(),
                ));
                if event_name == "kodera://deep-link" {
                    while let Some(queued_uri) = self.pending_deep_links.pop_front() {
                        eval_scripts.push(dispatch_js_event(document_id, callback_id, &queued_uri));
                    }
                }
            }
            "plugin:event|unlisten" => {
                if let Some(event_id) = extract_json_u64_field(json_body, "eventId") {
                    self.listeners.retain(|entry| entry.event_id != event_id);
                }
                eval_scripts.push(resolve_js_promise(document_id, req_id, true, "null"));
            }
            "plugin:window|show"
            | "plugin:window|set_focus"
            | "plugin:window|unminimize"
            | "show_window" => {
                window_action = Some(GuiWindowAction::ShowAndFocus);
                eval_scripts.push(resolve_js_promise(
                    document_id,
                    req_id,
                    true,
                    r#"{"ok":true}"#,
                ));
            }
            "plugin:window|hide" | "hide_window" => {
                window_action = Some(GuiWindowAction::Hide);
                eval_scripts.push(resolve_js_promise(
                    document_id,
                    req_id,
                    true,
                    r#"{"ok":true}"#,
                ));
            }
            "plugin:window|close" | "quit" => {
                self.host.clear_active_session();
                window_action = Some(GuiWindowAction::Quit);
                eval_scripts.push(resolve_js_promise(
                    document_id,
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
                    eval_scripts.push(resolve_js_promise(document_id, req_id, ok, &reply));
                } else {
                    eval_scripts.push(resolve_js_promise(
                        document_id,
                        req_id,
                        false,
                        r#"{"ok":false,"error":"invalid_organisation"}"#,
                    ));
                }
            }
            "select_community_stack_dir" => {
                if !has_matching_body_command || envelope.stack_dir.is_some() {
                    return Err(WebViewIpcError::MalformedEnvelope);
                }
                let Some(org_id) = extract_json_string_field(json_body, "organisation_id") else {
                    eval_scripts.push(resolve_js_promise(
                        document_id,
                        req_id,
                        false,
                        r#"{"ok":false,"error":"invalid_organisation"}"#,
                    ));
                    return Ok(WebViewIpcOutcome {
                        eval_scripts,
                        window_action,
                    });
                };
                if !self.host.has_active_session() && self.host.provision_session(&org_id).is_err()
                {
                    eval_scripts.push(resolve_js_promise(
                        document_id,
                        req_id,
                        false,
                        r#"{"ok":false,"error":"invalid_organisation"}"#,
                    ));
                    return Ok(WebViewIpcOutcome {
                        eval_scripts,
                        window_action,
                    });
                }
                if self.host.active_organisation_id() != Some(org_id.as_str()) {
                    eval_scripts.push(resolve_js_promise(
                        document_id,
                        req_id,
                        false,
                        r#"{"ok":false,"error":"organisation_mismatch"}"#,
                    ));
                    return Ok(WebViewIpcOutcome {
                        eval_scripts,
                        window_action,
                    });
                }
                match self.stack_folder_picker.pick_community_stack_dir() {
                    Ok(Some(chosen_dir)) => match self.authorize_community_stack_dir(&chosen_dir) {
                        Ok(canonical) => {
                            let canonical_str = canonical.to_string_lossy();
                            let payload = format!(
                                r#"{{"ok":true,"type":"community_stack_dir_selected","selected":true,"stack_dir":"{}"}}"#,
                                escape_js_json_str(&canonical_str)
                            );
                            eval_scripts.push(resolve_js_promise(
                                document_id,
                                req_id,
                                true,
                                &payload,
                            ));
                        }
                        Err(err) => {
                            let escaped_err =
                                escape_js_json_str(&format!("community_deploy:{err}"));
                            let payload = format!(r#"{{"ok":false,"error":"{escaped_err}"}}"#);
                            eval_scripts.push(resolve_js_promise(
                                document_id,
                                req_id,
                                false,
                                &payload,
                            ));
                        }
                    },
                    Ok(None) => {
                        eval_scripts.push(resolve_js_promise(
                            document_id,
                            req_id,
                            true,
                            r#"{"ok":true,"type":"community_stack_dir_selected","selected":false,"stack_dir":null}"#,
                        ));
                    }
                    Err(err) => {
                        let escaped_err = escape_js_json_str(&format!("community_deploy:{err}"));
                        let payload = format!(r#"{{"ok":false,"error":"{escaped_err}"}}"#);
                        eval_scripts.push(resolve_js_promise(document_id, req_id, false, &payload));
                    }
                }
            }
            _ => {
                if !has_matching_body_command {
                    return Err(WebViewIpcError::MalformedEnvelope);
                }
                if matches!(
                    cmd_raw,
                    "self_host_preflight_community"
                        | "self_host_prepare_community"
                        | "self_host_deploy_community"
                ) {
                    let Some(raw_stack_dir) = envelope.stack_dir.as_deref() else {
                        eval_scripts.push(resolve_js_promise(
                            document_id,
                            req_id,
                            false,
                            r#"{"ok":false,"error":"missing_field"}"#,
                        ));
                        return Ok(WebViewIpcOutcome {
                            eval_scripts,
                            window_action,
                        });
                    };
                    let candidate_path = Path::new(raw_stack_dir);
                    if !raw_stack_dir.is_empty()
                        && raw_stack_dir.len() <= crate::MAX_STACK_DIR_BYTES
                        && candidate_path.is_absolute()
                        && !candidate_path
                            .components()
                            .any(|comp| matches!(comp, Component::ParentDir))
                    {
                        let authorized = !self.authorized_stack_dirs.is_empty()
                            && crate::self_host_deploy::canonicalize_authorized_stack_dir(
                                raw_stack_dir,
                            )
                            .is_ok_and(|canonical| self.authorized_stack_dirs.contains(&canonical));
                        if !authorized {
                            eval_scripts.push(resolve_js_promise(
                                document_id,
                                req_id,
                                false,
                                r#"{"ok":false,"error":"community_deploy:stack_dir_not_authorized"}"#,
                            ));
                            return Ok(WebViewIpcOutcome {
                                eval_scripts,
                                window_action,
                            });
                        }
                    }
                }
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
                eval_scripts.push(resolve_js_promise(document_id, req_id, ok, &reply));
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
            .map(|entry| {
                dispatch_js_event(
                    self.document_id.as_deref().unwrap_or(""),
                    entry.callback_id,
                    str_payload,
                )
            })
            .collect()
    }
}

fn fresh_document_capability() -> Option<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn same_document_capability(expected: &str, supplied: &str) -> bool {
    if expected.len() != 64 || supplied.len() != 64 {
        return false;
    }
    expected
        .bytes()
        .zip(supplied.bytes())
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
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
