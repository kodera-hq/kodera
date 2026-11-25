//! Origin-fenced WebView IPC router, capability rotation, and command envelope dispatcher.

use super::desktop_core_api::{CoreAbort, CoreRequestGuard, CoreRequests, MAX_CORE_ENVELOPE};
use super::desktop_oidc::{NativeOidcServices, NativeOidcTask};
use super::picker::{NativeStackFolderPicker, OsNativeStackFolderPicker};
use super::{
    activate_js_document, dispatch_js_event, escape_js_json_str, resolve_js_promise,
    validate_navigation_url, NavigationDecision, ADMITTED_WEBVIEW_IPC_COMMANDS,
    APPROVED_DEV_ORIGINS, DESKTOP_WINDOW_TITLE, MAX_PENDING_DEEP_LINKS,
    MAX_REGISTERED_EVENT_LISTENERS, PRIVILEGED_INTERNAL_ONLY_COMMANDS,
};
use crate::{
    AdmittedDeepLink, DeepLinkAdmissionPolicy, DesktopShellHost, PttModifier, PttTriggerKey,
    RestoredWindowPlacement, MAX_IPC_COMMAND_BYTES,
};
use core::fmt;
use std::collections::{BTreeSet, VecDeque};
use std::path::{Component, Path, PathBuf};

// Both transports use the runtime's worker dispatcher; no network I/O runs on the UI thread.
pub(super) enum NativeIpcTask {
    Oidc(NativeOidcTask),
    Core {
        body: zeroize::Zeroizing<String>,
        guard: CoreRequestGuard,
        document_id: String,
        request_id: u64,
    },
}

// The ingress ceiling is only enlarged for the exact outer Core request command.
// Capability/origin and the matching JSON command are checked before deserializing its body.
// The authenticated text header is at most 256 bytes; never scan the upload body
// just to reject an overloaded ingress frame.
fn core_ingress_header(raw: &str) -> Option<&str> {
    let end = raw
        .as_bytes()
        .iter()
        .take(256)
        .position(|&byte| byte == b'\n')?;
    let header = &raw[..end];
    let (_, command) = header.split_once('\t')?;
    (command == "desktop_core_api_request").then_some(&raw[..=end])
}
pub(super) fn within_ipc_ingress_limit(raw: &str) -> bool {
    raw.len() <= MAX_IPC_COMMAND_BYTES
        || (raw.len() <= MAX_CORE_ENVELOPE && core_ingress_header(raw).is_some())
}

pub(super) fn busy_core_ingress_metadata(raw: &str) -> Option<String> {
    if raw.len() <= MAX_IPC_COMMAND_BYTES || raw.len() > MAX_CORE_ENVELOPE {
        return None;
    }
    Some(format!("{}{{}}", core_ingress_header(raw)?))
}

// Admission happens before a large renderer frame is cloned into the event queue.
#[derive(Clone, Default)]
pub(super) struct CoreIngress(std::sync::Arc<std::sync::atomic::AtomicUsize>);
#[derive(Debug)]
pub(super) struct CoreIngressPermit(std::sync::Arc<std::sync::atomic::AtomicUsize>);
impl CoreIngress {
    pub(super) fn admit(&self, raw: &str) -> Option<Option<CoreIngressPermit>> {
        if !within_ipc_ingress_limit(raw) {
            return None;
        }
        if raw.len() <= MAX_IPC_COMMAND_BYTES {
            return Some(None);
        }
        let mut count = self.0.load(std::sync::atomic::Ordering::SeqCst);
        loop {
            if count >= 8 {
                return None;
            }
            match self.0.compare_exchange_weak(
                count,
                count + 1,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            ) {
                Ok(_) => break,
                Err(current) => count = current,
            }
        }
        Some(Some(CoreIngressPermit(self.0.clone())))
    }
}
impl Drop for CoreIngressPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

impl NativeIpcTask {
    pub(super) fn spawn_with(
        self,
        spawn: impl FnOnce(Box<dyn FnOnce() + Send>) -> std::io::Result<()>,
        complete: impl FnOnce(WebViewIpcOutcome) + Send + 'static,
    ) -> WebViewIpcOutcome {
        let failure = self.failure_outcome("native_worker_unavailable");
        match spawn(Box::new(move || complete(self.run()))) {
            Ok(()) => WebViewIpcOutcome {
                eval_scripts: Vec::new(),
                window_action: None,
            },
            Err(_) => failure,
        }
    }

    pub(super) fn failure_outcome(&self, error: &str) -> WebViewIpcOutcome {
        let (document, request) = match self {
            Self::Oidc(task) => (&task.document_id, task.request_id),
            Self::Core {
                document_id,
                request_id,
                ..
            } => (document_id, *request_id),
        };
        WebViewIpcOutcome {
            eval_scripts: vec![resolve_js_promise(
                document,
                request,
                false,
                &serde_json::json!({"error":error}).to_string(),
            )],
            window_action: None,
        }
    }

    pub(super) fn run(self) -> WebViewIpcOutcome {
        match self {
            Self::Oidc(task) => task.run(),
            Self::Core {
                body,
                guard,
                document_id,
                request_id,
            } => {
                let result = super::desktop_core_api::execute(&body, &guard);
                if !guard.is_current() {
                    return WebViewIpcOutcome {
                        eval_scripts: vec![],
                        window_action: None,
                    };
                }
                let ok = result.is_ok();
                let payload =
                    result.unwrap_or_else(|error| serde_json::json!({"ok":false,"error":error}));
                WebViewIpcOutcome {
                    eval_scripts: vec![super::resolve_js_promise(
                        &document_id,
                        request_id,
                        ok,
                        &payload.to_string(),
                    )],
                    window_action: None,
                }
            }
        }
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
    #[serde(
        default,
        rename = "requestId",
        deserialize_with = "deserialize_non_null_string"
    )]
    pub(super) request_id: Option<String>,
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
    pub(super) core_requests: CoreRequests,
    pub(super) native_oidc: NativeOidcServices,
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
    pub(super) active_modifiers: BTreeSet<PttModifier>,
    pub(super) window_focused: bool,
}

impl DesktopWebViewBridge {
    pub fn new(allow_dev_origin: bool, initial_deep_link: Option<AdmittedDeepLink>) -> Self {
        let mut pending_deep_links = VecDeque::new();
        if let Some(admitted) = initial_deep_link {
            pending_deep_links.push_back(admitted.canonical_uri().to_owned());
        }
        Self {
            core_requests: CoreRequests::default(),
            native_oidc: NativeOidcServices::default(),
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
            active_modifiers: BTreeSet::new(),
            window_focused: true,
        }
    }

    /// Replaces native authentication services and the issuer policy for embedding or testing.
    pub fn configure_native_oidc(
        &mut self,
        http: std::sync::Arc<dyn super::NativeOidcHttpClient>,
        browser: std::sync::Arc<dyn super::NativeBrowserLauncher>,
        keychain: std::sync::Arc<std::sync::Mutex<crate::KeychainCredentialStore>>,
        allowlist: crate::OidcIssuerAllowlist,
    ) {
        self.native_oidc.http = http;
        self.native_oidc.browser = browser;
        self.native_oidc.keychain = keychain;
        self.native_oidc.allowlist = allowlist;
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
        self.native_oidc
            .epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.native_oidc
            .revision
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.core_requests.abort_all();
        self.host.clear_active_session();
        self.listeners.clear();
        self.authorized_stack_dirs.clear();
        self.active_modifiers.clear();
        self.document_id = None;
        self.document_generation = generation;
        self.document_capability = fresh_document_capability();
    }

    pub fn clear_session(&mut self) {
        self.native_oidc
            .epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.native_oidc
            .revision
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.core_requests.abort_all();
        self.host.clear_active_session();
        self.authorized_stack_dirs.clear();
        self.active_modifiers.clear();
    }

    /// Updates tracked OS window focus state; when `focused` is `false`, clears modifiers,
    /// force-releases any active Push-to-Talk gate, and emits `"kodera://ptt-state"`.
    pub fn set_window_focused(&mut self, focused: bool) -> Vec<String> {
        self.window_focused = focused;
        if focused {
            return Vec::new();
        }
        self.active_modifiers.clear();
        match self.host.force_release_ptt_on_focus_loss() {
            Some(ptt_json) => self.dispatch_event_scripts("kodera://ptt-state", &ptt_json),
            None => Vec::new(),
        }
    }

    pub const fn is_window_focused(&self) -> bool {
        self.window_focused
    }

    /// Releases any active Push-to-Talk microphone gate on OS window focus loss and emits
    /// `"kodera://ptt-state"` to registered WebView listeners so an open PTT mic can never stick.
    pub fn handle_window_focus_lost(&mut self) -> Vec<String> {
        self.set_window_focused(false)
    }

    /// Updates tracked keyboard modifiers and releases PTT if a required chord modifier was lifted.
    pub fn handle_modifiers_changed(&mut self, modifiers: BTreeSet<PttModifier>) -> Vec<String> {
        self.active_modifiers = modifiers;
        match self
            .host
            .handle_ptt_modifiers_changed(&self.active_modifiers)
        {
            Some(ptt_json) => self.dispatch_event_scripts("kodera://ptt-state", &ptt_json),
            None => Vec::new(),
        }
    }

    /// Evaluates a physical trigger-key press or release against the configured Push-to-Talk chord.
    /// Rejects new `pressed == true` transitions while `!self.window_focused`.
    pub fn handle_key_chord_event(
        &mut self,
        trigger: PttTriggerKey,
        pressed: bool,
        now_ms: u64,
    ) -> Vec<String> {
        if pressed && !self.window_focused {
            return Vec::new();
        }
        match self
            .host
            .handle_ptt_key_event(&self.active_modifiers, trigger, pressed, now_ms)
        {
            Some(ptt_json) => self.dispatch_event_scripts("kodera://ptt-state", &ptt_json),
            None => Vec::new(),
        }
    }

    /// Toggles native tray microphone mute and emits `"kodera://tray-action"` (`"toggle_mute"`).
    pub fn handle_native_mute_toggle(&mut self) -> Vec<String> {
        if self.host.toggle_tray_mute().is_some() {
            self.dispatch_event_scripts("kodera://tray-action", "toggle_mute")
        } else {
            Vec::new()
        }
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
        self.handle_ipc_request_with_native_dispatch(sender_url, raw_message, NativeIpcTask::run)
    }

    pub(super) fn handle_ipc_request_with_native_dispatch(
        &mut self,
        sender_url: &str,
        raw_message: &str,
        dispatch: impl FnOnce(NativeIpcTask) -> WebViewIpcOutcome,
    ) -> Result<WebViewIpcOutcome, WebViewIpcError> {
        self.handle_ipc_request_inner(sender_url, raw_message, false, dispatch)
    }

    pub(super) fn reject_busy_core_ingress(
        &mut self,
        sender_url: &str,
        metadata: &str,
    ) -> Result<WebViewIpcOutcome, WebViewIpcError> {
        if metadata.len() > 258 {
            return Err(WebViewIpcError::MessageTooLarge);
        }
        self.handle_ipc_request_inner(sender_url, metadata, true, |_| unreachable!())
    }

    fn handle_ipc_request_inner(
        &mut self,
        sender_url: &str,
        raw_message: &str,
        core_ingress_busy: bool,
        dispatch: impl FnOnce(NativeIpcTask) -> WebViewIpcOutcome,
    ) -> Result<WebViewIpcOutcome, WebViewIpcError> {
        if !within_ipc_ingress_limit(raw_message) {
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

        if core_ingress_busy {
            if cmd_raw != "desktop_core_api_request" || json_body != "{}" {
                return Err(WebViewIpcError::MalformedEnvelope);
            }
            return Ok(WebViewIpcOutcome {
                eval_scripts: vec![resolve_js_promise(
                    document_id,
                    req_id,
                    false,
                    r#"{"error":"core_api_busy"}"#,
                )],
                window_action: None,
            });
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
            "desktop_core_api_request" => {
                let admission = (|| {
                    let id = envelope
                        .request_id
                        .as_deref()
                        .filter(|id| super::desktop_core_api::valid_request_id(id))
                        .ok_or_else(|| "core_api_refused".to_owned())?;
                    if !has_matching_body_command {
                        return Err("core_api_refused".into());
                    }
                    self.core_requests
                        .reserve(document_id, self.document_generation, id)
                })();
                let guard = match admission {
                    Ok(guard) => guard,
                    Err(error) => {
                        return Ok(WebViewIpcOutcome {
                            eval_scripts: vec![resolve_js_promise(
                                document_id,
                                req_id,
                                false,
                                &serde_json::json!({"error":error}).to_string(),
                            )],
                            window_action: None,
                        })
                    }
                };
                return Ok(dispatch(NativeIpcTask::Core {
                    body: zeroize::Zeroizing::new(json_body.to_owned()),
                    guard,
                    document_id: document_id.to_owned(),
                    request_id: req_id,
                }));
            }
            "desktop_core_api_abort" => {
                let abort: CoreAbort = serde_json::from_str(json_body)
                    .map_err(|_| WebViewIpcError::MalformedEnvelope)?;
                if !abort.validate() {
                    return Err(WebViewIpcError::MalformedEnvelope);
                }
                self.core_requests
                    .abort(document_id, self.document_generation, &abort.request_id);
                eval_scripts.push(resolve_js_promise(document_id, req_id, true, "{}"));
            }
            "desktop_oidc_exchange_loopback"
            | "desktop_oidc_refresh_session"
            | "desktop_oidc_clear_session"
            | "desktop_matrix_sso_loopback" => {
                if cmd_raw == "desktop_oidc_clear_session" {
                    self.core_requests.abort_all();
                }
                if matches!(
                    cmd_raw,
                    "desktop_oidc_exchange_loopback" | "desktop_oidc_clear_session"
                ) {
                    self.native_oidc
                        .epoch
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    self.native_oidc
                        .revision
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
                return Ok(dispatch(NativeIpcTask::Oidc(NativeOidcTask {
                    services: self.native_oidc.clone(),
                    policy: self.policy.clone(),
                    command: cmd_raw.to_owned(),
                    body: json_body.to_owned(),
                    document_id: document_id.to_owned(),
                    request_id: req_id,
                    epoch: self
                        .native_oidc
                        .epoch
                        .load(std::sync::atomic::Ordering::SeqCst),
                })));
            }
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
                let parsed_listen = serde_json::from_str::<EventListenArgs>(json_body).ok();
                let Some(event_name) = parsed_listen.as_ref().and_then(|p| p.event.clone()) else {
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
                let Some(callback_id) = parsed_listen.and_then(|p| p.handler) else {
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
                if let Ok(parsed_unlisten) = serde_json::from_str::<EventUnlistenArgs>(json_body) {
                    if let Some(event_id) = parsed_unlisten.event_id {
                        self.listeners.retain(|entry| entry.event_id != event_id);
                    }
                }
                eval_scripts.push(resolve_js_promise(document_id, req_id, true, "null"));
            }
            "plugin:window|show"
            | "plugin:window|set_focus"
            | "plugin:window|unminimize"
            | "show_window" => {
                self.window_focused = true;
                window_action = Some(GuiWindowAction::ShowAndFocus);
                eval_scripts.push(resolve_js_promise(
                    document_id,
                    req_id,
                    true,
                    r#"{"ok":true}"#,
                ));
            }
            "plugin:window|hide" | "hide_window" => {
                let release_scripts = self.handle_window_focus_lost();
                window_action = Some(GuiWindowAction::Hide);
                eval_scripts.push(resolve_js_promise(
                    document_id,
                    req_id,
                    true,
                    r#"{"ok":true}"#,
                ));
                eval_scripts.extend(release_scripts);
            }
            "plugin:window|close" | "quit" => {
                self.clear_session();
                window_action = Some(GuiWindowAction::Quit);
                eval_scripts.push(resolve_js_promise(
                    document_id,
                    req_id,
                    true,
                    r#"{"ok":true,"quit":true}"#,
                ));
            }
            "init_session" => {
                let was_ptt_transmitting = self.host.is_ptt_transmitting();
                self.authorized_stack_dirs.clear();
                self.active_modifiers.clear();
                self.core_requests.abort_all();
                self.host.clear_active_session();
                window_action = Some(GuiWindowAction::SetTitle(DESKTOP_WINDOW_TITLE.to_owned()));
                if let Ok(parsed_init) = serde_json::from_str::<InitSessionArgs>(json_body) {
                    let init_line = format!(
                        r#"{{"host_op":"init_session","organisation_id":"{}"}}"#,
                        escape_js_json_str(&parsed_init.organisation_id)
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
                if was_ptt_transmitting {
                    eval_scripts.extend(
                        self.dispatch_event_scripts("kodera://ptt-state", RESET_PTT_STATE_JSON),
                    );
                }
            }
            "select_community_stack_dir" => {
                if !has_matching_body_command || envelope.stack_dir.is_some() {
                    return Err(WebViewIpcError::MalformedEnvelope);
                }
                let org_id =
                    match crate::DesktopCommandRequest::parse_select_stack_dir_org_id(json_body) {
                        Ok(id) => id,
                        Err(err) => {
                            let err_json = crate::shell::serialize_command_error_json(&err);
                            eval_scripts.push(resolve_js_promise(
                                document_id,
                                req_id,
                                false,
                                &err_json,
                            ));
                            return Ok(WebViewIpcOutcome {
                                eval_scripts,
                                window_action,
                            });
                        }
                    };
                let mut switch_events = Vec::new();
                if self
                    .ensure_webview_session_for_org(&org_id, &mut switch_events, &mut window_action)
                    .is_err()
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
                eval_scripts.extend(switch_events);
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
                // (a) Parse & validate both JSON schema AND domain semantics FIRST (refusing
                //     unknown/duplicate fields, type mismatches, unicode-escaped key tricks, and
                //     invalid semantic parameters before any organisation switch occurs!).
                let parsed_request = match crate::DesktopCommandRequest::from_json(json_body) {
                    Ok(req) => req,
                    Err(err) => {
                        let err_json = crate::shell::serialize_command_error_json(&err);
                        eval_scripts.push(resolve_js_promise(
                            document_id,
                            req_id,
                            false,
                            &err_json,
                        ));
                        return Ok(WebViewIpcOutcome {
                            eval_scripts,
                            window_action,
                        });
                    }
                };
                let is_cross_org =
                    self.host.active_organisation_id() != Some(parsed_request.organisation_id());
                if let Err(err) =
                    parsed_request.prevalidate_webview_semantics(&self.policy, is_cross_org)
                {
                    let err_json = crate::shell::serialize_command_error_json(&err);
                    eval_scripts.push(resolve_js_promise(document_id, req_id, false, &err_json));
                    return Ok(WebViewIpcOutcome {
                        eval_scripts,
                        window_action,
                    });
                }
                if is_cross_org
                    && matches!(
                        parsed_request,
                        crate::DesktopCommandRequest::SetPttPressed { pressed: false, .. }
                    )
                {
                    // Late/cleanup PTT release for an already-inactive or switched-away organisation
                    // succeeds as an idempotent no-op without provisioning or wiping the active org!
                    eval_scripts.push(resolve_js_promise(
                        document_id,
                        req_id,
                        true,
                        RESET_PTT_STATE_JSON,
                    ));
                    return Ok(WebViewIpcOutcome {
                        eval_scripts,
                        window_action,
                    });
                }

                // (b) Switch/provision the session for `parsed_request.organisation_id()` SECOND
                //     (clearing `self.authorized_stack_dirs` and `self.active_modifiers` on org change
                //     BEFORE any authorization or focus check runs!).
                let mut switch_events = Vec::new();
                if self
                    .ensure_webview_session_for_org(
                        parsed_request.organisation_id(),
                        &mut switch_events,
                        &mut window_action,
                    )
                    .is_err()
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

                // (c) Enforce `!self.window_focused` (`SetPttPressed { pressed: true }`) and
                //     `self.authorized_stack_dirs` on the switched session THIRD!
                if !self.window_focused
                    && matches!(
                        parsed_request,
                        crate::DesktopCommandRequest::SetPttPressed { pressed: true, .. }
                    )
                {
                    eval_scripts.extend(switch_events);
                    eval_scripts.push(resolve_js_promise(
                        document_id,
                        req_id,
                        false,
                        r#"{"ok":false,"error":"tray_ptt:window_not_focused"}"#,
                    ));
                    return Ok(WebViewIpcOutcome {
                        eval_scripts,
                        window_action,
                    });
                }
                if let crate::DesktopCommandRequest::SelfHostPreflightCommunity {
                    stack_dir: ref raw_stack_dir,
                    ..
                }
                | crate::DesktopCommandRequest::SelfHostPrepareCommunity {
                    stack_dir: ref raw_stack_dir,
                    ..
                }
                | crate::DesktopCommandRequest::SelfHostDeployCommunity {
                    stack_dir: ref raw_stack_dir,
                    ..
                } = parsed_request
                {
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
                            eval_scripts.extend(switch_events);
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

                // (d) Execute the validated typed request on the active session.
                let was_ptt_transmitting = self.host.is_ptt_transmitting();
                let (reply, should_quit) = self.host.execute_active_webview_command(parsed_request);
                eval_scripts.extend(switch_events);
                let ok = reply.starts_with(r#"{"ok":true"#);
                if ok {
                    let reply_meta =
                        serde_json::from_str::<ReplyMetadata>(&reply).unwrap_or_default();
                    if should_quit {
                        window_action = Some(GuiWindowAction::Quit);
                    } else if cmd_raw == "set_unread_badge" || cmd_raw == "update_tray_state" {
                        let badge = reply_meta.badge_label.or(reply_meta.unread_badge);
                        let title = match badge {
                            Some(label) if !label.is_empty() => {
                                format!("{DESKTOP_WINDOW_TITLE} ({label})")
                            }
                            _ => DESKTOP_WINDOW_TITLE.to_owned(),
                        };
                        window_action = Some(GuiWindowAction::SetTitle(title));
                        if cmd_raw == "update_tray_state"
                            && was_ptt_transmitting
                            && !self.host.is_ptt_transmitting()
                        {
                            if let Some(ptt_json) = self.host.current_ptt_state_json() {
                                eval_scripts.extend(
                                    self.dispatch_event_scripts("kodera://ptt-state", &ptt_json),
                                );
                            }
                        }
                    } else if cmd_raw == "trigger_tray_menu_action" {
                        if let Some(action_slug) = reply_meta.action {
                            eval_scripts.extend(
                                self.dispatch_event_scripts("kodera://tray-action", &action_slug),
                            );
                            if action_slug == "open_kodera" {
                                self.window_focused = true;
                                window_action = Some(GuiWindowAction::ShowAndFocus);
                            }
                        }
                    } else if cmd_raw == "configure_ptt" || cmd_raw == "set_ptt_pressed" {
                        eval_scripts
                            .extend(self.dispatch_event_scripts("kodera://ptt-state", &reply));
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

    fn ensure_webview_session_for_org(
        &mut self,
        org_id: &str,
        switch_events: &mut Vec<String>,
        window_action: &mut Option<GuiWindowAction>,
    ) -> Result<(), ()> {
        if self.host.active_organisation_id() == Some(org_id) {
            return Ok(());
        }
        let Ok(parsed_org) = kodera_rs::OrganisationId::parse(org_id) else {
            return Err(());
        };
        let had_prior_session = self.host.has_active_session();
        let was_ptt_transmitting = self.host.is_ptt_transmitting();
        if had_prior_session {
            self.authorized_stack_dirs.clear();
            self.active_modifiers.clear();
            *window_action = Some(GuiWindowAction::SetTitle(DESKTOP_WINDOW_TITLE.to_owned()));
        }
        self.host
            .provision_session(parsed_org.as_str())
            .map_err(|_| ())?;
        if had_prior_session && was_ptt_transmitting {
            switch_events
                .extend(self.dispatch_event_scripts("kodera://ptt-state", RESET_PTT_STATE_JSON));
        }
        Ok(())
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

const RESET_PTT_STATE_JSON: &str = r#"{"ok":true,"type":"ptt_state","opt_in_enabled":false,"binding":null,"transmitting":false,"transmitting_since_ms":null}"#;

#[derive(serde::Deserialize)]
struct EventListenArgs {
    event: Option<String>,
    handler: Option<u64>,
    #[serde(default)]
    #[allow(dead_code)]
    target: Option<serde::de::IgnoredAny>,
}

#[derive(serde::Deserialize)]
struct EventUnlistenArgs {
    #[serde(rename = "eventId")]
    event_id: Option<u64>,
    #[serde(default)]
    #[allow(dead_code)]
    event: Option<serde::de::IgnoredAny>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct InitSessionArgs {
    #[serde(default)]
    #[allow(dead_code)]
    command: Option<String>,
    organisation_id: String,
}

#[derive(Default, serde::Deserialize)]
struct ReplyMetadata {
    badge_label: Option<String>,
    unread_badge: Option<String>,
    action: Option<String>,
}
