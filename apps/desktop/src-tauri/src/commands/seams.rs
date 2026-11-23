//! Rust-callable desktop command seams wrapping [`DesktopWorkspaceSession`].

use super::DesktopCommandError;
use crate::{
    AdmittedDeepLink, CommunityDeployReport, CommunityPreflightReport, CommunityPreflightSpec,
    CommunityPrepareReport, CommunityPrepareSpec, DesktopNotificationRequest,
    DesktopWorkspaceSession, DispatchedNotification, DockBadgeSnapshot, KeychainCredentialStatus,
    KeychainSecretKind, KeychainSessionMetadata, KeychainStoreOutcome, MediaCaptureStateSnapshot,
    OidcCallbackOutcome, OidcLoopbackSessionReady, PttStateSnapshot, RestoredWindowPlacement,
    ScreenShareSurface, SelfHostHealthReport, TrayCallKind, TrayMenuActionOutcome, TrayMenuItemId,
    TrayStateSnapshot,
};

/// Rust-callable Tauri command seams bound to the active [`DesktopWorkspaceSession`].
pub fn route_desktop_deep_link(
    session: &DesktopWorkspaceSession,
    organisation_id: &str,
    raw_uri: &str,
) -> Result<AdmittedDeepLink, DesktopCommandError> {
    session.route_deep_link(organisation_id, raw_uri)
}

pub fn update_desktop_tray_state(
    session: &mut DesktopWorkspaceSession,
    organisation_id: &str,
    unread_count: u32,
    active_call: Option<TrayCallKind>,
    muted: bool,
    self_host_degraded: bool,
) -> Result<TrayStateSnapshot, DesktopCommandError> {
    session.update_tray_state(
        organisation_id,
        unread_count,
        active_call,
        muted,
        self_host_degraded,
    )
}

pub fn get_desktop_tray_state(
    session: &DesktopWorkspaceSession,
    organisation_id: &str,
) -> Result<TrayStateSnapshot, DesktopCommandError> {
    session
        .tray_state(organisation_id)
        .map_err(DesktopCommandError::Core)
}

pub fn configure_desktop_ptt(
    session: &mut DesktopWorkspaceSession,
    organisation_id: &str,
    opt_in: bool,
    raw_chord: Option<&str>,
) -> Result<PttStateSnapshot, DesktopCommandError> {
    session.configure_ptt(organisation_id, opt_in, raw_chord)
}

pub fn set_desktop_ptt_pressed(
    session: &mut DesktopWorkspaceSession,
    organisation_id: &str,
    pressed: bool,
    now_ms: u64,
) -> Result<PttStateSnapshot, DesktopCommandError> {
    session.set_ptt_pressed(organisation_id, pressed, now_ms)
}

pub fn get_desktop_ptt_state(
    session: &DesktopWorkspaceSession,
    organisation_id: &str,
) -> Result<PttStateSnapshot, DesktopCommandError> {
    session
        .ptt_state(organisation_id)
        .map_err(DesktopCommandError::Core)
}

pub fn configure_desktop_media_capture(
    session: &mut DesktopWorkspaceSession,
    organisation_id: &str,
    preferred_surface: ScreenShareSurface,
    system_audio_loopback: bool,
    noise_suppression: bool,
    preferred_audio_input_id: Option<&str>,
    preferred_audio_output_id: Option<&str>,
) -> Result<MediaCaptureStateSnapshot, DesktopCommandError> {
    session.configure_media_capture(
        organisation_id,
        preferred_surface,
        system_audio_loopback,
        noise_suppression,
        preferred_audio_input_id,
        preferred_audio_output_id,
    )
}

pub fn get_desktop_media_capture_state(
    session: &DesktopWorkspaceSession,
    organisation_id: &str,
) -> Result<MediaCaptureStateSnapshot, DesktopCommandError> {
    session
        .media_capture_state(organisation_id)
        .map_err(DesktopCommandError::Core)
}

#[allow(clippy::too_many_arguments)]
pub fn validate_desktop_keychain_metadata(
    session: &DesktopWorkspaceSession,
    organisation_id: &str,
    secret_kind: KeychainSecretKind,
    matrix_user_id: &str,
    device_id: &str,
    issued_at_unix_secs: u64,
    expires_at_unix_secs: Option<u64>,
    raw_secret: Option<&str>,
) -> Result<KeychainSessionMetadata, DesktopCommandError> {
    session.validate_keychain_metadata(
        organisation_id,
        secret_kind,
        matrix_user_id,
        device_id,
        issued_at_unix_secs,
        expires_at_unix_secs,
        raw_secret,
    )
}

pub fn inspect_desktop_self_host_health(
    session: &mut DesktopWorkspaceSession,
    organisation_id: &str,
    compose_ps_json: &str,
) -> Result<SelfHostHealthReport, DesktopCommandError> {
    session.inspect_self_host_health(organisation_id, compose_ps_json)
}

pub fn restore_desktop_window_bounds(
    session: &mut DesktopWorkspaceSession,
    organisation_id: &str,
    saved_state_json: Option<&str>,
) -> Result<RestoredWindowPlacement, DesktopCommandError> {
    session.restore_window_bounds(organisation_id, saved_state_json)
}

pub fn trigger_desktop_tray_menu_action(
    session: &mut DesktopWorkspaceSession,
    organisation_id: &str,
    action: TrayMenuItemId,
) -> Result<TrayMenuActionOutcome, DesktopCommandError> {
    session.trigger_tray_menu_action(organisation_id, action)
}

pub fn set_desktop_unread_badge(
    session: &mut DesktopWorkspaceSession,
    organisation_id: &str,
    unread_count: u32,
) -> Result<DockBadgeSnapshot, DesktopCommandError> {
    session.set_unread_badge(organisation_id, unread_count)
}

pub fn dispatch_desktop_notification(
    session: &mut DesktopWorkspaceSession,
    organisation_id: &str,
    request: &DesktopNotificationRequest,
) -> Result<DispatchedNotification, DesktopCommandError> {
    session.dispatch_notification(organisation_id, request)
}

#[allow(clippy::too_many_arguments)]
pub fn store_desktop_keychain_credential(
    session: &mut DesktopWorkspaceSession,
    organisation_id: &str,
    secret_kind: KeychainSecretKind,
    matrix_user_id: &str,
    device_id: &str,
    issued_at_unix_secs: u64,
    expires_at_unix_secs: Option<u64>,
    raw_secret: &str,
) -> Result<KeychainStoreOutcome, DesktopCommandError> {
    session.store_keychain_credential(
        organisation_id,
        secret_kind,
        matrix_user_id,
        device_id,
        issued_at_unix_secs,
        expires_at_unix_secs,
        raw_secret,
    )
}

pub fn clear_desktop_organisation_keychain(
    session: &mut DesktopWorkspaceSession,
    organisation_id: &str,
) -> Result<usize, DesktopCommandError> {
    session.clear_organisation_keychain(organisation_id)
}

pub fn load_desktop_keychain_credential(
    session: &DesktopWorkspaceSession,
    organisation_id: &str,
    secret_kind: KeychainSecretKind,
    matrix_user_id: &str,
) -> Result<KeychainCredentialStatus, DesktopCommandError> {
    session.load_keychain_credential(organisation_id, secret_kind, matrix_user_id)
}

pub fn delete_desktop_keychain_credential(
    session: &mut DesktopWorkspaceSession,
    organisation_id: &str,
    secret_kind: KeychainSecretKind,
    matrix_user_id: &str,
) -> Result<KeychainCredentialStatus, DesktopCommandError> {
    session.delete_keychain_credential(organisation_id, secret_kind, matrix_user_id)
}

pub fn begin_desktop_oidc_pkce_loopback(
    session: &mut DesktopWorkspaceSession,
    organisation_id: &str,
    issuer_origin: &str,
    client_id: &str,
    raw_code_verifier: &str,
    expected_state: &str,
    loopback_port: u16,
) -> Result<OidcLoopbackSessionReady, DesktopCommandError> {
    session.begin_oidc_pkce_loopback(
        organisation_id,
        issuer_origin,
        client_id,
        raw_code_verifier,
        expected_state,
        loopback_port,
    )
}

pub fn complete_desktop_oidc_pkce_callback(
    session: &mut DesktopWorkspaceSession,
    organisation_id: &str,
    callback_uri: &str,
) -> Result<OidcCallbackOutcome, DesktopCommandError> {
    session.complete_oidc_pkce_callback(organisation_id, callback_uri)
}

pub fn preflight_desktop_community_stack(
    session: &DesktopWorkspaceSession,
    organisation_id: &str,
    spec: &CommunityPreflightSpec<'_>,
) -> Result<CommunityPreflightReport, DesktopCommandError> {
    session.preflight_community_deploy(organisation_id, spec)
}

pub fn prepare_desktop_community_stack(
    session: &DesktopWorkspaceSession,
    organisation_id: &str,
    spec: &CommunityPrepareSpec<'_>,
) -> Result<CommunityPrepareReport, DesktopCommandError> {
    session.prepare_community_deploy(organisation_id, spec)
}

pub fn deploy_desktop_community_stack(
    session: &mut DesktopWorkspaceSession,
    organisation_id: &str,
    stack_dir: &str,
    timeout_ms: Option<u64>,
) -> Result<CommunityDeployReport, DesktopCommandError> {
    session.deploy_community_stack(organisation_id, stack_dir, timeout_ms)
}
