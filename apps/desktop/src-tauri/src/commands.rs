//! Typed local backend operations. This is not registered Tauri IPC or an authentication layer.

use super::{
    AdmittedDeepLink, CloudProvider, CommunityDeployError, CommunityDeployReport,
    CommunityPreflightReport, CommunityPrepareReport, DeepLinkError, DeployValidationError,
    DispatchedNotification, DockBadgeSnapshot, KeychainCredentialStatus, KeychainError,
    KeychainSessionMetadata, KeychainStoreOutcome, MediaCaptureError, MediaCaptureStateSnapshot,
    NotificationError, OidcCallbackOutcome, OidcLoopbackError, OidcLoopbackSessionReady,
    PttStateSnapshot, RedactedApiToken, RestoredWindowPlacement, SelfHostDeploymentPlan,
    SelfHostHealthError, SelfHostHealthReport, TrayMenuActionOutcome, TrayPttError,
    TrayStateSnapshot, WindowStateError,
};
use kodera_rs::{
    ChannelAccessDecision, ChannelPermissionPolicy, ChannelPollSnapshot, CoreError, CoreThemeMode,
    DocsPadDocument, DocsPadUrl, Ed25519PublicKey, OrgRoleRank, ProximityHandle, SafetyStatus,
    ShareableThemePayload, SoundPackId, UserProfile,
};
use std::fmt;

mod dispatch;
mod parser;
mod seams;
#[cfg(test)]
mod tests;

pub use seams::*;

/// Bound raw UTF-8 requests before parsing or allocating decoded fields.
pub const MAX_IPC_COMMAND_BYTES: usize = 16_384;

/// Canonical desktop command names admitted by the dispatcher.
pub const REGISTERED_DESKTOP_COMMANDS: [&str; 42] = [
    "plan_self_host",
    "validate_docs_pad_url",
    "proximity_current_beacon",
    "proximity_member_statuses",
    "proximity_next_relay_batch",
    "clear_workspace_session",
    "set_sound_pack",
    "get_sound_pack",
    "create_channel_poll",
    "vote_channel_poll",
    "get_channel_poll",
    "close_channel_poll",
    "redact_iban",
    "validate_connector_post_url",
    "set_theme_mode",
    "import_shareable_theme",
    "export_shareable_theme",
    "update_user_profile",
    "evaluate_channel_iam",
    "save_docs_pad",
    "route_deep_link",
    "update_tray_state",
    "get_tray_state",
    "configure_ptt",
    "set_ptt_pressed",
    "get_ptt_state",
    "configure_media_capture",
    "get_media_capture_state",
    "validate_keychain_metadata",
    "inspect_self_host_health",
    "restore_window_bounds",
    "trigger_tray_menu_action",
    "set_unread_badge",
    "dispatch_notification",
    "store_keychain_credential",
    "load_keychain_credential",
    "delete_keychain_credential",
    "begin_oidc_pkce_loopback",
    "complete_oidc_pkce_callback",
    "self_host_preflight_community",
    "self_host_prepare_community",
    "self_host_deploy_community",
];

/// The proximity routes answer under two names, permanently. The channel was first called
/// `#urgence` and its routes `emergency_*`; a caller written then keeps working. Each legacy name
/// is resolved to its `proximity_*` route before the decoder runs, so both names share one schema,
/// one set of effects and one response. Removing a pair breaks deployed callers: the tests pin all
/// three and fail when one is dropped.
pub const LEGACY_ROUTE_ALIASES: [(&str, &str); 3] = [
    ("emergency_current_beacon", "proximity_current_beacon"),
    ("emergency_member_statuses", "proximity_member_statuses"),
    ("emergency_next_relay_batch", "proximity_next_relay_batch"),
];

/// Every variant is bound to the active organisation, including clear and local planning.
/// Debug and Display intentionally redact the entire request, because a caller can copy a token
/// into a public-looking field. No request value belongs in a diagnostic.
pub enum DesktopCommandRequest {
    CreateChannelPoll {
        organisation_id: String,
        channel_id: String,
        poll_id: String,
        question: String,
        options: Vec<String>,
        allow_multiple: bool,
    },
    VoteChannelPoll {
        organisation_id: String,
        channel_id: String,
        poll_id: String,
        voter_id: String,
        selections: Vec<usize>,
    },
    GetChannelPoll {
        organisation_id: String,
        channel_id: String,
        poll_id: String,
    },
    CloseChannelPoll {
        organisation_id: String,
        channel_id: String,
        poll_id: String,
    },
    RedactIban {
        organisation_id: String,
        raw_iban: String,
    },
    ValidateConnectorPostUrl {
        organisation_id: String,
        raw_url: String,
    },
    PlanSelfHost {
        organisation_id: String,
        provider: CloudProvider,
        region: String,
        fqdn: String,
        acme_email: String,
        token: RedactedApiToken,
    },
    ValidateDocsPadUrl {
        organisation_id: String,
        raw_url: String,
    },
    ProximityCurrentBeacon {
        organisation_id: String,
        now_unix_secs: u64,
    },
    ProximityMemberStatuses {
        organisation_id: String,
    },
    ProximityNextRelayBatch {
        organisation_id: String,
        max_frames: usize,
    },
    ClearWorkspaceSession {
        organisation_id: String,
    },
    SetSoundPack {
        organisation_id: String,
        sound_pack: SoundPackId,
    },
    GetSoundPack {
        organisation_id: String,
    },
    SetThemeMode {
        organisation_id: String,
        mode: CoreThemeMode,
    },
    ImportShareableTheme {
        organisation_id: String,
        share_code: String,
    },
    ExportShareableTheme {
        organisation_id: String,
    },
    UpdateUserProfile {
        organisation_id: String,
        profile: UserProfile,
    },
    EvaluateChannelIam {
        organisation_id: String,
        policy: ChannelPermissionPolicy,
        rank: OrgRoleRank,
    },
    SaveDocsPad {
        organisation_id: String,
        pad_id: String,
        channel_id: String,
        title: String,
        markdown_body: String,
        editor_handle: String,
    },
    RouteDeepLink {
        organisation_id: String,
        raw_uri: String,
    },
    UpdateTrayState {
        organisation_id: String,
        unread_count: u64,
        call_state: String,
        muted: bool,
        self_host_degraded: bool,
    },
    GetTrayState {
        organisation_id: String,
    },
    ConfigurePtt {
        organisation_id: String,
        opt_in: bool,
        raw_chord: Option<String>,
    },
    SetPttPressed {
        organisation_id: String,
        pressed: bool,
        now_ms: u64,
    },
    GetPttState {
        organisation_id: String,
    },
    ConfigureMediaCapture {
        organisation_id: String,
        preferred_surface: String,
        system_audio_loopback: bool,
        noise_suppression: bool,
        preferred_audio_input_id: Option<String>,
        preferred_audio_output_id: Option<String>,
    },
    GetMediaCaptureState {
        organisation_id: String,
    },
    ValidateKeychainMetadata {
        organisation_id: String,
        secret_kind: String,
        matrix_user_id: String,
        device_id: String,
        issued_at_unix_secs: u64,
        expires_at_unix_secs: Option<u64>,
        raw_secret: Option<String>,
    },
    InspectSelfHostHealth {
        organisation_id: String,
        compose_ps_json: String,
    },
    RestoreWindowBounds {
        organisation_id: String,
        saved_state_json: Option<String>,
    },
    TriggerTrayMenuAction {
        organisation_id: String,
        action: String,
    },
    SetUnreadBadge {
        organisation_id: String,
        unread_count: u64,
    },
    DispatchNotification {
        organisation_id: String,
        title: String,
        body: String,
        route_uri: Option<String>,
        redact_preview: bool,
    },
    StoreKeychainCredential {
        organisation_id: String,
        secret_kind: String,
        matrix_user_id: String,
        device_id: String,
        issued_at_unix_secs: u64,
        expires_at_unix_secs: Option<u64>,
        raw_secret: String,
    },
    LoadKeychainCredential {
        organisation_id: String,
        secret_kind: String,
        matrix_user_id: String,
    },
    DeleteKeychainCredential {
        organisation_id: String,
        secret_kind: String,
        matrix_user_id: String,
    },
    BeginOidcPkceLoopback {
        organisation_id: String,
        issuer_origin: String,
        client_id: String,
        code_verifier: String,
        state: String,
        loopback_port: u64,
    },
    CompleteOidcPkceCallback {
        organisation_id: String,
        callback_uri: String,
    },
    SelfHostPreflightCommunity {
        organisation_id: String,
        stack_dir: String,
        domain: String,
        acme_email: String,
        tls_mode: String,
        http_port: u64,
        https_port: u64,
    },
    SelfHostPrepareCommunity {
        organisation_id: String,
        stack_dir: String,
        domain: String,
        acme_email: String,
        oidc_provider_origin: String,
        tls_mode: String,
        http_port: u64,
        https_port: u64,
    },
    SelfHostDeployCommunity {
        organisation_id: String,
        stack_dir: String,
        timeout_ms: Option<u64>,
    },
}

impl DesktopCommandRequest {
    pub fn organisation_id(&self) -> &str {
        match self {
            Self::CreateChannelPoll {
                organisation_id, ..
            }
            | Self::VoteChannelPoll {
                organisation_id, ..
            }
            | Self::GetChannelPoll {
                organisation_id, ..
            }
            | Self::CloseChannelPoll {
                organisation_id, ..
            }
            | Self::RedactIban {
                organisation_id, ..
            }
            | Self::ValidateConnectorPostUrl {
                organisation_id, ..
            }
            | Self::PlanSelfHost {
                organisation_id, ..
            }
            | Self::ValidateDocsPadUrl {
                organisation_id, ..
            }
            | Self::ProximityCurrentBeacon {
                organisation_id, ..
            }
            | Self::ProximityMemberStatuses { organisation_id }
            | Self::ProximityNextRelayBatch {
                organisation_id, ..
            }
            | Self::ClearWorkspaceSession { organisation_id }
            | Self::SetSoundPack {
                organisation_id, ..
            }
            | Self::GetSoundPack { organisation_id }
            | Self::SetThemeMode {
                organisation_id, ..
            }
            | Self::ImportShareableTheme {
                organisation_id, ..
            }
            | Self::ExportShareableTheme { organisation_id }
            | Self::UpdateUserProfile {
                organisation_id, ..
            }
            | Self::EvaluateChannelIam {
                organisation_id, ..
            }
            | Self::SaveDocsPad {
                organisation_id, ..
            }
            | Self::RouteDeepLink {
                organisation_id, ..
            }
            | Self::UpdateTrayState {
                organisation_id, ..
            }
            | Self::GetTrayState { organisation_id }
            | Self::ConfigurePtt {
                organisation_id, ..
            }
            | Self::SetPttPressed {
                organisation_id, ..
            }
            | Self::GetPttState { organisation_id }
            | Self::ConfigureMediaCapture {
                organisation_id, ..
            }
            | Self::GetMediaCaptureState { organisation_id }
            | Self::ValidateKeychainMetadata {
                organisation_id, ..
            }
            | Self::InspectSelfHostHealth {
                organisation_id, ..
            }
            | Self::RestoreWindowBounds {
                organisation_id, ..
            }
            | Self::TriggerTrayMenuAction {
                organisation_id, ..
            }
            | Self::SetUnreadBadge {
                organisation_id, ..
            }
            | Self::DispatchNotification {
                organisation_id, ..
            }
            | Self::StoreKeychainCredential {
                organisation_id, ..
            }
            | Self::LoadKeychainCredential {
                organisation_id, ..
            }
            | Self::DeleteKeychainCredential {
                organisation_id, ..
            }
            | Self::BeginOidcPkceLoopback {
                organisation_id, ..
            }
            | Self::CompleteOidcPkceCallback {
                organisation_id, ..
            }
            | Self::SelfHostPreflightCommunity {
                organisation_id, ..
            }
            | Self::SelfHostPrepareCommunity {
                organisation_id, ..
            }
            | Self::SelfHostDeployCommunity {
                organisation_id, ..
            } => organisation_id,
        }
    }
}

impl fmt::Debug for DesktopCommandRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DesktopCommandRequest([REDACTED])")
    }
}

impl fmt::Display for DesktopCommandRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProximityMemberStatus {
    pub sender_public_key: Ed25519PublicKey,
    /// The pseudonym to show for this sender: derived from the sender key under the organisation's
    /// beacon salt, never a name. A display label only, never an identity or an authorisation input.
    pub sender_handle: ProximityHandle,
    /// A fingerprint prefix of the signing key, present when another member of this roster shows
    /// the same handle: the two are then told apart as `handle [fingerprint]`.
    pub sender_fingerprint: Option<String>,
    pub status: SafetyStatus,
    pub text: String,
    pub timestamp_ms: u64,
}

/// Closed errors carry no parser text, input fragments, tokens or deployment spec values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopCommandError {
    RequestTooLarge,
    InvalidRequest,
    Core(CoreError),
    Deployment(DeployValidationError),
    SecretInPublicPlan,
    DeepLink(DeepLinkError),
    TrayPtt(TrayPttError),
    MediaCapture(MediaCaptureError),
    Keychain(KeychainError),
    SelfHostHealth(SelfHostHealthError),
    WindowState(WindowStateError),
    Notification(NotificationError),
    OidcLoopback(OidcLoopbackError),
    CommunityDeploy(CommunityDeployError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopCommandResponse {
    ChannelPoll(ChannelPollSnapshot),
    RedactedIban(String),
    ConnectorPostUrl(String),
    SelfHostPlan(SelfHostDeploymentPlan),
    DocsPadUrl(DocsPadUrl),
    ProximityBeacon {
        bytes: [u8; 8],
        hex: String,
    },
    ProximityMemberStatuses(Vec<ProximityMemberStatus>),
    ProximityRelayBatch(Vec<Vec<u8>>),
    SoundPack(SoundPackId),
    ThemeMode {
        mode: CoreThemeMode,
        monogram_bg_hex: &'static str,
    },
    ShareableTheme(ShareableThemePayload),
    ShareableThemeCode(String),
    UserProfile(UserProfile),
    ChannelAccess(ChannelAccessDecision),
    DocsPad(DocsPadDocument),
    DeepLink(AdmittedDeepLink),
    TrayState(TrayStateSnapshot),
    TrayMenuAction(TrayMenuActionOutcome),
    PttState(PttStateSnapshot),
    MediaCaptureState(MediaCaptureStateSnapshot),
    KeychainMetadata(KeychainSessionMetadata),
    KeychainStored(KeychainStoreOutcome),
    KeychainStatus(KeychainCredentialStatus),
    SelfHostHealth(SelfHostHealthReport),
    WindowPlacement(RestoredWindowPlacement),
    DockBadge(DockBadgeSnapshot),
    Notification(DispatchedNotification),
    OidcLoopbackReady(OidcLoopbackSessionReady),
    OidcCallback(OidcCallbackOutcome),
    CommunityPreflight(CommunityPreflightReport),
    CommunityPrepare(CommunityPrepareReport),
    CommunityDeploy(CommunityDeployReport),
    WorkspaceSessionCleared,
    Error(DesktopCommandError),
}

impl fmt::Display for DesktopCommandResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}
