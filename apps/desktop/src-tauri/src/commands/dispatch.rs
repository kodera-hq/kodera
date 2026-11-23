//! Organisation-fenced execution of [`DesktopCommandRequest`] against [`DesktopWorkspaceSession`].

use super::{
    DesktopCommandError, DesktopCommandRequest, DesktopCommandResponse, ProximityMemberStatus,
    LEGACY_ROUTE_ALIASES,
};
use crate::{
    CommunityDeployError, CommunityPreflightSpec, CommunityPrepareSpec, CommunityTlsMode,
    DesktopNotificationRequest, DesktopWorkspaceSession, KeychainSecretKind, NotificationError,
    OidcLoopbackError, SelfHostDeploymentPlan, SelfHostDeploymentSpec, TrayCallKind,
    TrayMenuItemId, TrayPttError,
};
use kodera_rs::{encode_hex, KODERA_MONOGRAM_BG_HEX, MAX_PROXIMITY_QUEUE_CAPACITY};

fn public_plan_exposes_token(plan: &SelfHostDeploymentPlan, token: &str) -> bool {
    // Domain normalization can case-fold token-shaped input. Check the actual returned fields,
    // independently of how a formatter escapes them, and diagnostics as a defensive backstop.
    let token = token.to_ascii_lowercase();
    let exposes = |value: &str| value.to_ascii_lowercase().contains(&token);
    exposes(&plan.region)
        || plan.required_dns.iter().any(|record| exposes(&record.fqdn))
        || plan.https_origins.iter().any(|origin| exposes(origin))
        || plan
            .community_public_config
            .iter()
            .any(|(key, value)| exposes(key) || exposes(value))
        || exposes(&format!("{plan:?}"))
}

impl DesktopWorkspaceSession {
    /// Bounded command-only JSON admission. Parsing/schema errors carry no input text and have
    /// no side effects; this method neither registers JS IPC nor establishes caller identity.
    pub fn dispatch_command(&mut self, raw_json: &str) -> DesktopCommandResponse {
        self.dispatch_command_with_aliases(raw_json, &LEGACY_ROUTE_ALIASES)
    }

    pub(super) fn dispatch_command_with_aliases(
        &mut self,
        raw_json: &str,
        aliases: &[(&'static str, &'static str)],
    ) -> DesktopCommandResponse {
        match DesktopCommandRequest::from_json_with_aliases(raw_json, aliases) {
            Ok(request) => self.execute_command(request),
            Err(error) => DesktopCommandResponse::Error(error),
        }
    }

    pub(super) fn execute_command(
        &mut self,
        request: DesktopCommandRequest,
    ) -> DesktopCommandResponse {
        if let Err(error) = self.check_organisation(request.organisation_id()) {
            return DesktopCommandResponse::Error(DesktopCommandError::Core(error));
        }
        let result = match request {
            DesktopCommandRequest::CreateChannelPoll {
                organisation_id,
                channel_id,
                poll_id,
                question,
                options,
                allow_multiple,
            } => self
                .create_channel_poll(
                    &organisation_id,
                    &channel_id,
                    &poll_id,
                    &question,
                    &options,
                    allow_multiple,
                )
                .map(DesktopCommandResponse::ChannelPoll)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::VoteChannelPoll {
                organisation_id,
                channel_id,
                poll_id,
                voter_id,
                selections,
            } => self
                .vote_channel_poll(
                    &organisation_id,
                    &channel_id,
                    &poll_id,
                    &voter_id,
                    &selections,
                )
                .map(DesktopCommandResponse::ChannelPoll)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::GetChannelPoll {
                organisation_id,
                channel_id,
                poll_id,
            } => self
                .channel_poll(&organisation_id, &channel_id, &poll_id)
                .map(DesktopCommandResponse::ChannelPoll)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::CloseChannelPoll {
                organisation_id,
                channel_id,
                poll_id,
            } => self
                .close_channel_poll(&organisation_id, &channel_id, &poll_id)
                .map(DesktopCommandResponse::ChannelPoll)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::RedactIban {
                organisation_id,
                raw_iban,
            } => self
                .redact_connector_iban(&organisation_id, &raw_iban)
                .map(DesktopCommandResponse::RedactedIban)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::ValidateConnectorPostUrl {
                organisation_id,
                raw_url,
            } => self
                .validate_connector_post_url(&organisation_id, &raw_url)
                .map(DesktopCommandResponse::ConnectorPostUrl)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::PlanSelfHost {
                provider,
                region,
                fqdn,
                acme_email,
                token,
                ..
            } => (|| {
                let spec = SelfHostDeploymentSpec::from_validated_token(
                    provider,
                    &region,
                    &fqdn,
                    &acme_email,
                    token,
                )
                .map_err(DesktopCommandError::Deployment)?;
                let plan = SelfHostDeploymentPlan::from_spec(&spec)
                    .map_err(DesktopCommandError::Deployment)?;
                // Public fields are user-controlled too. Reject a token copied into any returned
                // metadata rather than returning a redacted, invalid deployment plan.
                if public_plan_exposes_token(&plan, spec.token.expose_for_provider_call()) {
                    return Err(DesktopCommandError::SecretInPublicPlan);
                }
                Ok(DesktopCommandResponse::SelfHostPlan(plan))
            })(),
            DesktopCommandRequest::ValidateDocsPadUrl {
                organisation_id,
                raw_url,
            } => self
                .validate_docs_pad_url(&organisation_id, &raw_url)
                .map(DesktopCommandResponse::DocsPadUrl)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::ProximityCurrentBeacon {
                organisation_id,
                now_unix_secs,
            } => self
                .current_beacon(&organisation_id, now_unix_secs)
                .map(|bytes| DesktopCommandResponse::ProximityBeacon {
                    hex: encode_hex(&bytes),
                    bytes,
                })
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::ProximityMemberStatuses { organisation_id } => self
                .member_statuses(&organisation_id)
                .and_then(|members| Ok((members, self.member_labels(&organisation_id)?)))
                .map(|(members, labels)| {
                    // Both lists come from the roster in public-key order.
                    DesktopCommandResponse::ProximityMemberStatuses(
                        members
                            .into_iter()
                            .zip(labels)
                            .map(|((sender_public_key, status, text, timestamp_ms), label)| {
                                debug_assert_eq!(label.sender_public_key, sender_public_key);
                                ProximityMemberStatus {
                                    sender_public_key,
                                    sender_handle: label.handle,
                                    sender_fingerprint: label.fingerprint,
                                    status,
                                    text,
                                    timestamp_ms,
                                }
                            })
                            .collect(),
                    )
                })
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::ProximityNextRelayBatch {
                organisation_id,
                max_frames,
            } => self
                .next_relay_batch(
                    &organisation_id,
                    max_frames.min(MAX_PROXIMITY_QUEUE_CAPACITY),
                )
                .map(DesktopCommandResponse::ProximityRelayBatch)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::ClearWorkspaceSession { .. } => {
                self.clear_session();
                Ok(DesktopCommandResponse::WorkspaceSessionCleared)
            }
            DesktopCommandRequest::SetSoundPack {
                organisation_id,
                sound_pack,
            } => self
                .set_sound_pack(&organisation_id, sound_pack)
                .map(|()| DesktopCommandResponse::SoundPack(sound_pack))
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::GetSoundPack { organisation_id } => self
                .sound_pack(&organisation_id)
                .map(DesktopCommandResponse::SoundPack)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::SetThemeMode {
                organisation_id,
                mode,
            } => self
                .set_theme_mode(&organisation_id, mode)
                .map(|mode| DesktopCommandResponse::ThemeMode {
                    mode,
                    monogram_bg_hex: KODERA_MONOGRAM_BG_HEX,
                })
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::ImportShareableTheme {
                organisation_id,
                share_code,
            } => self
                .import_shareable_theme(&organisation_id, &share_code)
                .map(DesktopCommandResponse::ShareableTheme)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::ExportShareableTheme { organisation_id } => self
                .export_shareable_theme(&organisation_id)
                .map(DesktopCommandResponse::ShareableThemeCode)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::UpdateUserProfile {
                organisation_id,
                profile,
            } => self
                .update_user_profile(&organisation_id, profile)
                .map(DesktopCommandResponse::UserProfile)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::EvaluateChannelIam {
                organisation_id,
                policy,
                rank,
            } => self
                .evaluate_channel_iam(&organisation_id, rank, &policy)
                .map(DesktopCommandResponse::ChannelAccess)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::SaveDocsPad {
                organisation_id,
                pad_id,
                channel_id,
                title,
                markdown_body,
                editor_handle,
            } => self
                .save_docs_pad(
                    &organisation_id,
                    &pad_id,
                    &channel_id,
                    &title,
                    &markdown_body,
                    &editor_handle,
                )
                .map(DesktopCommandResponse::DocsPad)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::RouteDeepLink {
                organisation_id,
                raw_uri,
            } => self
                .route_deep_link(&organisation_id, &raw_uri)
                .map(DesktopCommandResponse::DeepLink),
            DesktopCommandRequest::UpdateTrayState {
                organisation_id,
                unread_count,
                call_state,
                muted,
                self_host_degraded,
            } => (|| {
                let count = u32::try_from(unread_count).map_err(|_| {
                    DesktopCommandError::TrayPtt(TrayPttError::UnreadCountOutOfRange)
                })?;
                let active_call = TrayCallKind::parse_optional(&call_state)
                    .map_err(DesktopCommandError::TrayPtt)?;
                self.update_tray_state(
                    &organisation_id,
                    count,
                    active_call,
                    muted,
                    self_host_degraded,
                )
                .map(DesktopCommandResponse::TrayState)
            })(),
            DesktopCommandRequest::GetTrayState { organisation_id } => self
                .tray_state(&organisation_id)
                .map(DesktopCommandResponse::TrayState)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::ConfigurePtt {
                organisation_id,
                opt_in,
                raw_chord,
            } => self
                .configure_ptt(&organisation_id, opt_in, raw_chord.as_deref())
                .map(DesktopCommandResponse::PttState),
            DesktopCommandRequest::SetPttPressed {
                organisation_id,
                pressed,
                now_ms,
            } => self
                .set_ptt_pressed(&organisation_id, pressed, now_ms)
                .map(DesktopCommandResponse::PttState),
            DesktopCommandRequest::GetPttState { organisation_id } => self
                .ptt_state(&organisation_id)
                .map(DesktopCommandResponse::PttState)
                .map_err(DesktopCommandError::Core),
            DesktopCommandRequest::ValidateKeychainMetadata {
                organisation_id,
                secret_kind,
                matrix_user_id,
                device_id,
                issued_at_unix_secs,
                expires_at_unix_secs,
                raw_secret,
            } => (|| {
                let kind = KeychainSecretKind::parse(&secret_kind)
                    .map_err(DesktopCommandError::Keychain)?;
                self.validate_keychain_metadata(
                    &organisation_id,
                    kind,
                    &matrix_user_id,
                    &device_id,
                    issued_at_unix_secs,
                    expires_at_unix_secs,
                    raw_secret.as_deref(),
                )
                .map(DesktopCommandResponse::KeychainMetadata)
            })(),
            DesktopCommandRequest::InspectSelfHostHealth {
                organisation_id,
                compose_ps_json,
            } => self
                .inspect_self_host_health(&organisation_id, &compose_ps_json)
                .map(DesktopCommandResponse::SelfHostHealth),
            DesktopCommandRequest::RestoreWindowBounds {
                organisation_id,
                saved_state_json,
            } => self
                .restore_window_bounds(&organisation_id, saved_state_json.as_deref())
                .map(DesktopCommandResponse::WindowPlacement),
            DesktopCommandRequest::TriggerTrayMenuAction {
                organisation_id,
                action,
            } => (|| {
                let parsed_action =
                    TrayMenuItemId::parse(&action).map_err(DesktopCommandError::TrayPtt)?;
                self.trigger_tray_menu_action(&organisation_id, parsed_action)
                    .map(DesktopCommandResponse::TrayMenuAction)
            })(),
            DesktopCommandRequest::SetUnreadBadge {
                organisation_id,
                unread_count,
            } => (|| {
                let count = u32::try_from(unread_count).map_err(|_| {
                    DesktopCommandError::Notification(NotificationError::UnreadCountOutOfRange)
                })?;
                self.set_unread_badge(&organisation_id, count)
                    .map(DesktopCommandResponse::DockBadge)
            })(),
            DesktopCommandRequest::DispatchNotification {
                organisation_id,
                title,
                body,
                route_uri,
                redact_preview,
            } => self
                .dispatch_notification(
                    &organisation_id,
                    &DesktopNotificationRequest {
                        title,
                        body,
                        route_uri,
                        redact_preview,
                    },
                )
                .map(DesktopCommandResponse::Notification),
            DesktopCommandRequest::StoreKeychainCredential {
                organisation_id,
                secret_kind,
                matrix_user_id,
                device_id,
                issued_at_unix_secs,
                expires_at_unix_secs,
                raw_secret,
            } => (|| {
                let kind = KeychainSecretKind::parse(&secret_kind)
                    .map_err(DesktopCommandError::Keychain)?;
                self.store_keychain_credential(
                    &organisation_id,
                    kind,
                    &matrix_user_id,
                    &device_id,
                    issued_at_unix_secs,
                    expires_at_unix_secs,
                    &raw_secret,
                )
                .map(DesktopCommandResponse::KeychainMetadata)
            })(),
            DesktopCommandRequest::LoadKeychainCredential {
                organisation_id,
                secret_kind,
                matrix_user_id,
            } => (|| {
                let kind = KeychainSecretKind::parse(&secret_kind)
                    .map_err(DesktopCommandError::Keychain)?;
                self.load_keychain_credential(&organisation_id, kind, &matrix_user_id)
                    .map(DesktopCommandResponse::KeychainStatus)
            })(),
            DesktopCommandRequest::DeleteKeychainCredential {
                organisation_id,
                secret_kind,
                matrix_user_id,
            } => (|| {
                let kind = KeychainSecretKind::parse(&secret_kind)
                    .map_err(DesktopCommandError::Keychain)?;
                self.delete_keychain_credential(&organisation_id, kind, &matrix_user_id)
                    .map(DesktopCommandResponse::KeychainStatus)
            })(),
            DesktopCommandRequest::BeginOidcPkceLoopback {
                organisation_id,
                issuer_origin,
                client_id,
                code_verifier,
                state,
                loopback_port,
            } => (|| {
                let port = u16::try_from(loopback_port).map_err(|_| {
                    DesktopCommandError::OidcLoopback(OidcLoopbackError::InvalidLoopbackPort)
                })?;
                self.begin_oidc_pkce_loopback(
                    &organisation_id,
                    &issuer_origin,
                    &client_id,
                    &code_verifier,
                    &state,
                    port,
                )
                .map(DesktopCommandResponse::OidcLoopbackReady)
            })(),
            DesktopCommandRequest::CompleteOidcPkceCallback {
                organisation_id,
                callback_uri,
            } => self
                .complete_oidc_pkce_callback(&organisation_id, &callback_uri)
                .map(DesktopCommandResponse::OidcCallback),
            DesktopCommandRequest::SelfHostPreflightCommunity {
                organisation_id,
                stack_dir,
                domain,
                acme_email,
                tls_mode,
                http_port,
                https_port,
            } => (|| {
                let mode = CommunityTlsMode::parse(&tls_mode)
                    .map_err(DesktopCommandError::CommunityDeploy)?;
                let http = u16::try_from(http_port).map_err(|_| {
                    DesktopCommandError::CommunityDeploy(CommunityDeployError::InvalidPort)
                })?;
                let https = u16::try_from(https_port).map_err(|_| {
                    DesktopCommandError::CommunityDeploy(CommunityDeployError::InvalidPort)
                })?;
                let spec = CommunityPreflightSpec {
                    stack_dir: &stack_dir,
                    domain: &domain,
                    acme_email: &acme_email,
                    tls_mode: mode,
                    http_port: http,
                    https_port: https,
                };
                self.preflight_community_deploy(&organisation_id, &spec)
                    .map(DesktopCommandResponse::CommunityPreflight)
            })(),
            DesktopCommandRequest::SelfHostPrepareCommunity {
                organisation_id,
                stack_dir,
                domain,
                acme_email,
                oidc_provider_origin,
                tls_mode,
                http_port,
                https_port,
            } => (|| {
                let mode = CommunityTlsMode::parse(&tls_mode)
                    .map_err(DesktopCommandError::CommunityDeploy)?;
                let http = u16::try_from(http_port).map_err(|_| {
                    DesktopCommandError::CommunityDeploy(CommunityDeployError::InvalidPort)
                })?;
                let https = u16::try_from(https_port).map_err(|_| {
                    DesktopCommandError::CommunityDeploy(CommunityDeployError::InvalidPort)
                })?;
                let spec = CommunityPrepareSpec {
                    stack_dir: &stack_dir,
                    domain: &domain,
                    acme_email: &acme_email,
                    oidc_provider_origin: &oidc_provider_origin,
                    tls_mode: mode,
                    http_port: http,
                    https_port: https,
                };
                self.prepare_community_deploy(&organisation_id, &spec)
                    .map(DesktopCommandResponse::CommunityPrepare)
            })(),
            DesktopCommandRequest::SelfHostDeployCommunity {
                organisation_id,
                stack_dir,
                timeout_ms,
            } => self
                .deploy_community_stack(&organisation_id, &stack_dir, timeout_ms)
                .map(DesktopCommandResponse::CommunityDeploy),
        };
        result.unwrap_or_else(DesktopCommandResponse::Error)
    }
}
