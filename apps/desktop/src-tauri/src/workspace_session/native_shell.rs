//! Native desktop shell integrations (deep links, tray, window bounds, keychain, OIDC, PTT, self-host) on [`DesktopWorkspaceSession`].

use super::DesktopWorkspaceSession;
use crate::{
    deeplink, inspect_community_compose_ps, sanitize_and_clamp_window_state,
    self_host_deploy_community, self_host_preflight_community, self_host_prepare_community,
    AdmittedDeepLink, CommunityCommandRunner, CommunityDeployError, CommunityDeployReport,
    CommunityPreflightReport, CommunityPreflightSpec, CommunityPrepareReport, CommunityPrepareSpec,
    DeepLinkAdmissionPolicy, DesktopCommandError, DesktopNotificationRequest,
    DispatchedNotification, DockBadgeSnapshot, KeychainCredentialStatus, KeychainSecretKind,
    KeychainSessionMetadata, MonitorWorkArea, OidcCallbackOutcome, OidcIssuerAllowlist,
    OidcLoopbackError, OidcLoopbackSessionReady, OidcPkceSession, PttStateSnapshot,
    RestoredWindowPlacement, SavedWindowState, SelfHostHealthReport, TrayCallKind,
    TrayMenuActionOutcome, TrayMenuItemId, TrayMenuModel, TrayStateSnapshot,
};
use kodera_rs::CoreError;
use std::collections::BTreeMap;

impl DesktopWorkspaceSession {
    /// Trusted session configuration adding tenant Matrix/workspace domains to the default
    /// deep-link allowlist. Invalid domain replacements leave the active policy unchanged.
    pub fn configure_deep_link_domains(
        &mut self,
        organisation_id: &str,
        extra_domains: &[&str],
    ) -> Result<(), DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let mut candidate = DeepLinkAdmissionPolicy::kodera_default();
        for domain in extra_domains {
            candidate
                .add_domain(domain)
                .map_err(DesktopCommandError::DeepLink)?;
        }
        self.deep_link_policy = candidate;
        Ok(())
    }

    pub fn route_deep_link(
        &self,
        organisation_id: &str,
        raw_uri: &str,
    ) -> Result<AdmittedDeepLink, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        deeplink::route_deep_link(raw_uri, &self.deep_link_policy)
            .map_err(DesktopCommandError::DeepLink)
    }

    pub fn update_tray_state(
        &mut self,
        organisation_id: &str,
        unread_count: u32,
        active_call: Option<TrayCallKind>,
        muted: bool,
        self_host_degraded: bool,
    ) -> Result<TrayStateSnapshot, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        self.tray
            .update_all(unread_count, active_call, muted, self_host_degraded)
            .map_err(DesktopCommandError::TrayPtt)?;
        self.notifications
            .set_unread_count(unread_count)
            .map_err(DesktopCommandError::Notification)?;
        if active_call.is_none() {
            self.ptt.force_release();
        }
        Ok(self.tray.snapshot(self.ptt.is_transmitting()))
    }

    pub fn tray_state(&self, organisation_id: &str) -> Result<TrayStateSnapshot, CoreError> {
        self.check_organisation(organisation_id)?;
        Ok(self.tray.snapshot(self.ptt.is_transmitting()))
    }

    pub fn tray_menu(&self, organisation_id: &str) -> Result<TrayMenuModel, CoreError> {
        self.check_organisation(organisation_id)?;
        Ok(self.tray.menu_model(self.ptt.is_transmitting()))
    }

    pub fn trigger_tray_menu_action(
        &mut self,
        organisation_id: &str,
        action: TrayMenuItemId,
    ) -> Result<TrayMenuActionOutcome, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let outcome = self
            .tray
            .handle_menu_action(action, self.ptt.is_transmitting());
        if matches!(action, TrayMenuItemId::OpenKodera) {
            self.window_placement.visible = true;
        }
        Ok(outcome)
    }

    pub fn configure_monitors(
        &mut self,
        organisation_id: &str,
        monitors: Vec<MonitorWorkArea>,
    ) -> Result<RestoredWindowPlacement, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let current_saved = SavedWindowState {
            bounds: self.window_placement.bounds,
            maximized: self.window_placement.maximized,
            fullscreen: self.window_placement.fullscreen,
            visible: self.window_placement.visible,
        };
        let placement = sanitize_and_clamp_window_state(Some(&current_saved), &monitors)
            .map_err(DesktopCommandError::WindowState)?;
        self.monitors = if monitors.is_empty() {
            vec![MonitorWorkArea::fallback_primary()]
        } else {
            monitors
        };
        self.window_placement = placement.clone();
        Ok(placement)
    }

    pub fn restore_window_bounds(
        &mut self,
        organisation_id: &str,
        saved_state_json: Option<&str>,
    ) -> Result<RestoredWindowPlacement, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let parsed = match saved_state_json {
            Some(raw) => {
                Some(SavedWindowState::from_json(raw).map_err(DesktopCommandError::WindowState)?)
            }
            None => None,
        };
        let placement = sanitize_and_clamp_window_state(parsed.as_ref(), &self.monitors)
            .map_err(DesktopCommandError::WindowState)?;
        self.window_placement = placement.clone();
        Ok(placement)
    }

    pub fn window_placement(
        &self,
        organisation_id: &str,
    ) -> Result<RestoredWindowPlacement, CoreError> {
        self.check_organisation(organisation_id)?;
        Ok(self.window_placement.clone())
    }

    pub fn set_unread_badge(
        &mut self,
        organisation_id: &str,
        unread_count: u32,
    ) -> Result<DockBadgeSnapshot, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let badge = self
            .notifications
            .set_unread_count(unread_count)
            .map_err(DesktopCommandError::Notification)?;
        self.tray
            .set_unread_count(unread_count)
            .map_err(DesktopCommandError::TrayPtt)?;
        Ok(badge)
    }

    pub fn dock_badge(&self, organisation_id: &str) -> Result<DockBadgeSnapshot, CoreError> {
        self.check_organisation(organisation_id)?;
        Ok(self.notifications.dock_badge().clone())
    }

    pub fn dispatch_notification(
        &mut self,
        organisation_id: &str,
        request: &DesktopNotificationRequest,
    ) -> Result<DispatchedNotification, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        self.notifications
            .dispatch(request, &self.deep_link_policy)
            .map_err(DesktopCommandError::Notification)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn store_keychain_credential(
        &mut self,
        organisation_id: &str,
        secret_kind: KeychainSecretKind,
        matrix_user_id: &str,
        device_id: &str,
        issued_at_unix_secs: u64,
        expires_at_unix_secs: Option<u64>,
        raw_secret: &str,
    ) -> Result<KeychainSessionMetadata, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        self.keychain_store
            .store_credential(
                secret_kind,
                organisation_id,
                matrix_user_id,
                device_id,
                issued_at_unix_secs,
                expires_at_unix_secs,
                raw_secret,
            )
            .map_err(DesktopCommandError::Keychain)
    }

    pub fn load_keychain_credential(
        &self,
        organisation_id: &str,
        secret_kind: KeychainSecretKind,
        matrix_user_id: &str,
    ) -> Result<KeychainCredentialStatus, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        self.keychain_store
            .load_credential_status(secret_kind, organisation_id, matrix_user_id)
            .map_err(DesktopCommandError::Keychain)
    }

    pub fn delete_keychain_credential(
        &mut self,
        organisation_id: &str,
        secret_kind: KeychainSecretKind,
        matrix_user_id: &str,
    ) -> Result<KeychainCredentialStatus, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        self.keychain_store
            .delete_credential(secret_kind, organisation_id, matrix_user_id)
            .map_err(DesktopCommandError::Keychain)
    }

    pub fn configure_oidc_issuers(
        &mut self,
        organisation_id: &str,
        extra_origins: &[&str],
    ) -> Result<(), DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let mut candidate = OidcIssuerAllowlist::kodera_default();
        for origin in extra_origins {
            candidate
                .add_issuer_origin(origin)
                .map_err(DesktopCommandError::OidcLoopback)?;
        }
        self.oidc_allowlist = candidate;
        Ok(())
    }

    pub fn begin_oidc_pkce_loopback(
        &mut self,
        organisation_id: &str,
        issuer_origin: &str,
        client_id: &str,
        raw_code_verifier: &str,
        expected_state: &str,
        loopback_port: u16,
    ) -> Result<OidcLoopbackSessionReady, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let (session, ready) = OidcPkceSession::start(
            &self.oidc_allowlist,
            issuer_origin,
            client_id,
            raw_code_verifier,
            expected_state,
            loopback_port,
        )
        .map_err(DesktopCommandError::OidcLoopback)?;
        if let Some(mut old) = self.pending_oidc.replace(session) {
            old.clear();
        }
        Ok(ready)
    }

    pub fn complete_oidc_pkce_callback(
        &mut self,
        organisation_id: &str,
        callback_uri: &str,
    ) -> Result<OidcCallbackOutcome, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let pending = self
            .pending_oidc
            .take()
            .ok_or(DesktopCommandError::OidcLoopback(
                OidcLoopbackError::NoPendingSession,
            ))?;
        pending
            .consume_callback_uri(callback_uri, &self.deep_link_policy)
            .map_err(DesktopCommandError::OidcLoopback)
    }

    pub fn configure_ptt(
        &mut self,
        organisation_id: &str,
        opt_in: bool,
        raw_chord: Option<&str>,
    ) -> Result<PttStateSnapshot, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        self.ptt
            .configure(opt_in, raw_chord)
            .map_err(DesktopCommandError::TrayPtt)
    }

    pub fn set_ptt_pressed(
        &mut self,
        organisation_id: &str,
        pressed: bool,
        now_ms: u64,
    ) -> Result<PttStateSnapshot, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let snapshot = if pressed {
            self.ptt.press(now_ms)
        } else {
            self.ptt.release()
        };
        snapshot.map_err(DesktopCommandError::TrayPtt)
    }

    pub fn ptt_state(&self, organisation_id: &str) -> Result<PttStateSnapshot, CoreError> {
        self.check_organisation(organisation_id)?;
        Ok(self.ptt.snapshot())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn validate_keychain_metadata(
        &self,
        organisation_id: &str,
        secret_kind: KeychainSecretKind,
        matrix_user_id: &str,
        device_id: &str,
        issued_at_unix_secs: u64,
        expires_at_unix_secs: Option<u64>,
        raw_secret: Option<&str>,
    ) -> Result<KeychainSessionMetadata, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let (metadata, _redacted_secret) = KeychainSessionMetadata::validate_with_secret(
            secret_kind,
            organisation_id,
            matrix_user_id,
            device_id,
            issued_at_unix_secs,
            expires_at_unix_secs,
            raw_secret,
        )
        .map_err(DesktopCommandError::Keychain)?;
        Ok(metadata)
    }

    pub fn inspect_self_host_health(
        &mut self,
        organisation_id: &str,
        raw_ps_json: &str,
    ) -> Result<SelfHostHealthReport, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        let report = inspect_community_compose_ps(raw_ps_json, &BTreeMap::new())
            .map_err(DesktopCommandError::SelfHostHealth)?;
        self.tray.set_self_host_degraded(!report.is_healthy());
        Ok(report)
    }

    /// Trusted adapter or test seam replacing the local `docker` CLI runner for this session.
    pub fn configure_community_runner(
        &mut self,
        organisation_id: &str,
        runner: std::sync::Arc<dyn CommunityCommandRunner>,
    ) -> Result<(), CoreError> {
        self.check_organisation(organisation_id)?;
        self.community_runner = runner;
        Ok(())
    }

    pub fn preflight_community_deploy(
        &self,
        organisation_id: &str,
        spec: &CommunityPreflightSpec<'_>,
    ) -> Result<CommunityPreflightReport, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        self_host_preflight_community(spec, self.community_runner.as_ref())
            .map_err(DesktopCommandError::CommunityDeploy)
    }

    pub fn prepare_community_deploy(
        &self,
        organisation_id: &str,
        spec: &CommunityPrepareSpec<'_>,
    ) -> Result<CommunityPrepareReport, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        self_host_prepare_community(spec, self.community_runner.as_ref())
            .map_err(DesktopCommandError::CommunityDeploy)
    }

    pub fn deploy_community_stack(
        &mut self,
        organisation_id: &str,
        stack_dir: &str,
        timeout_ms: Option<u64>,
    ) -> Result<CommunityDeployReport, DesktopCommandError> {
        self.check_organisation(organisation_id)
            .map_err(DesktopCommandError::Core)?;
        match self_host_deploy_community(stack_dir, timeout_ms, self.community_runner.as_ref()) {
            Ok(report) => {
                self.tray.set_self_host_degraded(!report.stack_healthy);
                Ok(report)
            }
            Err(err) => {
                if matches!(
                    err,
                    CommunityDeployError::ComposeLaunchFailed
                        | CommunityDeployError::ReadinessProbeFailed(_)
                        | CommunityDeployError::StackUnhealthy
                ) {
                    self.tray.set_self_host_degraded(true);
                }
                Err(DesktopCommandError::CommunityDeploy(err))
            }
        }
    }
}
