//! Kodera Desktop (`apps/desktop/src-tauri`)
//!
//! Native Rust runtime backing the Tauri v2 desktop application:
//! 1. Links [`kodera_rs`] for unified device identity, MLS session envelopes, and `#proximity`
//!    offline BLE/Wi-Fi frame validation. The channel was first named `#urgence`; its frozen v1
//!    wire bytes and its legacy JSON route names are unchanged.
//! 2. Implements the **local-only 1-Click Self-Host Deployer** specification validator for
//!    European and global cloud providers (Scaleway, Hetzner, Hostinger, OVHcloud).
//!
//! Security invariant: provider API tokens supplied by an administrator during 1-click
//! self-host provisioning are held exclusively in ephemeral Desktop process memory to call
//! the provider API directly from the user's workstation. They are never serialized to logs
//! or transmitted to `kodera.io`.

#![forbid(unsafe_code)]

mod cloud_planner;
mod commands;
pub mod csp_policy;
pub mod deeplink;
pub mod gui;
pub mod keychain;
pub mod notifications;
pub mod oidc_loopback;
mod proximity_node;
pub mod self_host_deploy;
pub mod self_host_health;
pub mod shell;
pub mod tray_ptt;
pub mod updater;
pub mod window_state;
mod workspace_session;

pub use commands::{
    begin_desktop_oidc_pkce_loopback, complete_desktop_oidc_pkce_callback, configure_desktop_ptt,
    delete_desktop_keychain_credential, deploy_desktop_community_stack,
    dispatch_desktop_notification, get_desktop_ptt_state, get_desktop_tray_state,
    inspect_desktop_self_host_health, load_desktop_keychain_credential,
    preflight_desktop_community_stack, prepare_desktop_community_stack,
    restore_desktop_window_bounds, route_desktop_deep_link, set_desktop_ptt_pressed,
    set_desktop_unread_badge, store_desktop_keychain_credential, trigger_desktop_tray_menu_action,
    update_desktop_tray_state, validate_desktop_keychain_metadata, DesktopCommandError,
    DesktopCommandRequest, DesktopCommandResponse, ProximityMemberStatus, MAX_IPC_COMMAND_BYTES,
    REGISTERED_DESKTOP_COMMANDS,
};
pub use csp_policy::{
    verify_desktop_csp, verify_embedded_tauri_conf_csp, CspPolicyError, APPROVED_CONNECT_SOURCES,
};
pub use deeplink::{
    route_deep_link, AdmittedDeepLink, DeepLinkAdmissionPolicy, DeepLinkError, KoderaDeepLink,
    MatrixAction, MatrixDeepLink, MatrixTarget, RedactedOidcCode, DEFAULT_ADMITTED_DOMAINS,
    MAX_ADMITTED_DEEP_LINK_DOMAINS, MAX_DEEP_LINK_BYTES, MAX_MATRIX_VIA_SERVERS,
};
pub use gui::{
    build_ipc_init_script, launch_desktop_gui, resolve_asset_response, validate_navigation_url,
    AssetHttpPayload, DesktopGuiOptions, DesktopWebViewBridge, GuiWindowAction,
    NativeStackFolderPicker, NavigationDecision, NavigationGuardError, OsNativeStackFolderPicker,
    WebViewIpcError, WebViewIpcOutcome, APPROVED_AUTH_ORIGIN_PREFIX, APPROVED_DEV_ORIGINS,
    APPROVED_WEB_APP_ORIGINS, CUSTOM_ASSET_SCHEME, DESKTOP_WINDOW_TITLE, GUI_DEFAULT_HEIGHT,
    GUI_DEFAULT_WIDTH, GUI_MIN_HEIGHT, GUI_MIN_WIDTH,
};
pub use keychain::{
    build_keychain_slot, metadata_exposes_secret, validate_keychain_account_id,
    validate_keychain_service_id, KeychainCredentialStatus, KeychainCredentialStore, KeychainError,
    KeychainSecretKind, KeychainSessionMetadata, KeychainSlotDescriptor, OsKeychainCommandSpec,
    OsKeychainPlatform, RedactedSessionSecret, KEYCHAIN_SERVICE_NAMESPACE,
    MAX_KEYCHAIN_ACCOUNT_BYTES, MAX_KEYCHAIN_SECRET_BYTES, MAX_KEYCHAIN_SERVICE_BYTES,
    MAX_KEYCHAIN_SLOTS_PER_ORG, MIN_KEYCHAIN_SECRET_BYTES,
};
pub use notifications::{
    DesktopNotificationRequest, DispatchedNotification, DockBadgeSnapshot, NotificationCenter,
    NotificationError, MAX_NOTIFICATION_BODY_BYTES, MAX_NOTIFICATION_HISTORY,
    MAX_NOTIFICATION_TITLE_BYTES, REDACTED_NOTIFICATION_PREVIEW,
};
pub use oidc_loopback::{
    pkce_s256_challenge, OidcCallbackOutcome, OidcIssuerAllowlist, OidcLoopbackError,
    OidcLoopbackListener, OidcLoopbackSessionReady, OidcPkceSession, RedactedCodeVerifier,
    DEFAULT_LOOPBACK_TIMEOUT_MS, DEFAULT_OIDC_ISSUER_ORIGIN, MAX_LOOPBACK_HTTP_REQUEST_BYTES,
    MAX_LOOPBACK_TIMEOUT_MS, MAX_OIDC_CALLBACK_URI_BYTES,
};
pub use self_host_deploy::{
    admitted_service_environment_keys, self_host_deploy_community, self_host_preflight_community,
    self_host_prepare_community, validate_resolved_compose_config_json,
    validate_resolved_compose_config_json_with_source, CommandExecOutput, CommunityCommandRunner,
    CommunityCoreService, CommunityDeployError, CommunityDeployReport,
    CommunityDeployServiceStatus, CommunityPreflightReport, CommunityPreflightSpec,
    CommunityPrepareReport, CommunityPrepareSpec, CommunityTlsMode, StdProcessCommunityRunner,
    COMPOSE_CONFIG_TIMEOUT_MS, DEFAULT_DEPLOY_TIMEOUT_MS, FORBIDDEN_PRIVILEGED_COMPOSE_DIRECTIVES,
    HEX_SECRET_BYTES, LIVEKIT_KEY_RANDOM_BYTES, MAX_DEPLOY_TIMEOUT_MS, MAX_DOMAIN_BYTES,
    MAX_EMAIL_BYTES, MAX_OIDC_ORIGIN_BYTES, MAX_STACK_DIR_BYTES, MIN_DEPLOY_TIMEOUT_MS,
    PREFLIGHT_COMMAND_TIMEOUT_MS, READINESS_MAX_POLL_ATTEMPTS, SEAL_KEY_BYTES,
};
pub use self_host_health::{
    classify_docker_stderr, inspect_community_compose_ps, probe_local_community_stack,
    CommunityProbeHandle, CommunityServiceRole, DockerUnavailableReason, MemoryBudgetWarning,
    ProbeDisconnectedError, SelfHostHealthError, SelfHostHealthReport, ServiceHealthDiagnostic,
    ServiceReadiness, StackHealthState, COMMUNITY_MEMORY_BUDGET_MIB, DEFAULT_PROBE_TIMEOUT_MS,
    MAX_COMPOSE_CONTAINERS, MAX_COMPOSE_PS_JSON_BYTES, MAX_PROBE_TIMEOUT_MS,
};
pub use shell::{
    classify_launch_args, run_cli, DesktopLaunchMode, DesktopRuntimeMetadata,
    DesktopSelfCheckReport, DesktopShellError, DesktopShellHost, DESKTOP_APP_VERSION,
    DESKTOP_PRODUCT_NAME,
};
pub use tray_ptt::{
    PttController, PttKeyChord, PttModifier, PttStateSnapshot, PttTransmissionState, PttTriggerKey,
    TrayCallKind, TrayController, TrayIndicator, TrayMenuActionOutcome, TrayMenuEntry,
    TrayMenuItemId, TrayMenuModel, TrayPttError, TrayStateSnapshot, MAX_PTT_CHORD_BYTES,
    MAX_TRAY_BADGE_DIRECT, MAX_TRAY_UNREAD_COUNT,
};
pub use window_state::{
    load_window_state, parse_signed_i32, sanitize_and_clamp_window_state, save_window_state_atomic,
    MonitorWorkArea, RestoredWindowPlacement, SavedWindowState, WindowBounds, WindowStateError,
    DEFAULT_WINDOW_HEIGHT, DEFAULT_WINDOW_WIDTH, MAX_MONITORS, MAX_WINDOW_DIMENSION,
    MAX_WINDOW_STATE_JSON_BYTES, MIN_VISIBLE_TITLEBAR_PX, MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH,
    TITLEBAR_REACHABLE_HEIGHT_PX,
};

/// Canonical reverse-DNS bundle identifier for the Kodera Tauri v2 shell.
pub const DESKTOP_APP_IDENTIFIER: &str = "io.kodera.desktop";

pub use cloud_planner::{
    preflight_self_host_spec, CloudProvider, DeployValidationError, PublicDnsRequirement,
    PublicDnsTarget, RedactedApiToken, SelfHostDeploymentPlan, SelfHostDeploymentSpec,
};
pub use kodera_rs::{
    derive_extension_webhook_secret, ProximityOrganisationKeyGuard, ScopedWebhookVerifierRegistry,
};
pub use proximity_node::{
    emit_proximity_checkin, get_proximity_roster_status, ingest_ble_frame,
    verify_incoming_proximity_packet, verify_incoming_proximity_packet_now, DesktopProximityNode,
};
pub use workspace_session::DesktopWorkspaceSession;
