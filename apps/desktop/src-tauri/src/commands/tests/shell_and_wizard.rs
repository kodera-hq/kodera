use super::*;

#[test]
fn w5_d1_commands_synchronize_tray_ptt_health_and_redact_keychain_secrets() {
    let mut state = session();
    // Default session starts with PTT disabled and tray idle.
    assert!(!get_desktop_ptt_state(&state, ORG).unwrap().opt_in_enabled);
    assert_eq!(
        get_desktop_tray_state(&state, ORG).unwrap().indicator,
        crate::TrayIndicator::Idle
    );
    assert_eq!(
        set_desktop_ptt_pressed(&mut state, ORG, true, 100),
        Err(DesktopCommandError::TrayPtt(TrayPttError::PttNotOptedIn))
    );

    // Configure PTT, join muted voice call, press PTT -> tray reflects active PTT, hang up -> PTT auto-releases.
    configure_desktop_ptt(&mut state, ORG, true, Some("Ctrl+Shift+Space")).unwrap();
    update_desktop_tray_state(&mut state, ORG, 2, Some(TrayCallKind::Voice), true, false).unwrap();
    set_desktop_ptt_pressed(&mut state, ORG, true, 500).unwrap();
    let live_tray = get_desktop_tray_state(&state, ORG).unwrap();
    assert!(live_tray.ptt_transmitting);
    assert_eq!(
        live_tray.indicator,
        crate::TrayIndicator::ActiveCall {
            kind: TrayCallKind::Voice,
            muted: false,
        }
    );

    // Ending the call automatically releases PTT transmission.
    let ended_tray = update_desktop_tray_state(&mut state, ORG, 2, None, false, false).unwrap();
    assert!(!ended_tray.ptt_transmitting);
    assert_eq!(
        get_desktop_ptt_state(&state, ORG).unwrap().transmission,
        crate::PttTransmissionState::Inactive
    );

    // Degraded local self-host inspection marks tray as SelfHostDegraded.
    let report = inspect_desktop_self_host_health(
            &mut state,
            ORG,
            r#"[{"Service":"postgres","State":"running","Health":"healthy"},{"Service":"synapse","State":"restarting","Health":""}]"#,
        )
        .unwrap();
    assert!(!report.is_healthy());
    assert_eq!(
        get_desktop_tray_state(&state, ORG).unwrap().indicator,
        crate::TrayIndicator::SelfHostDegraded
    );

    // Keychain metadata leak check via JSON command never echoes token.
    let leaked_json = json(
            "validate_keychain_metadata",
            &format!(
                r#","secret_kind":"matrix-session","matrix_user_id":"@member:community.kodera.io","device_id":"DEV_01","issued_at_unix_secs":1762520000,"raw_secret":"{TOKEN}""#
            ),
        )
        .replace("DEV_01", "fixture_token_never_reflect");
    let response = state.dispatch_command(&leaked_json.replace(
        &format!(r#""raw_secret":"{TOKEN}""#),
        r#""raw_secret":"fixture_token_never_reflect""#,
    ));
    assert_eq!(
        response,
        DesktopCommandResponse::Error(DesktopCommandError::Keychain(
            KeychainError::SecretLeakedInMetadata
        ))
    );
    assert!(!format!("{response:?}").contains("fixture_token_never_reflect"));

    // Deep-link wrapper enforces custom tenant domain configuration and resets on switch.
    assert_eq!(
        route_desktop_deep_link(&state, ORG, "matrix:r/team:chat.tenant.eu?action=join"),
        Err(DesktopCommandError::DeepLink(
            DeepLinkError::UntrustedOrigin
        ))
    );
    state
        .configure_deep_link_domains(ORG, &["chat.tenant.eu"])
        .unwrap();
    assert!(
        route_desktop_deep_link(&state, ORG, "matrix:r/team:chat.tenant.eu?action=join").is_ok()
    );
    state
        .switch_organisation(OTHER_ORG, [0x43; 32], HashSet::from([[1; 32]]), 4)
        .unwrap();
    assert_eq!(
        route_desktop_deep_link(
            &state,
            OTHER_ORG,
            "matrix:r/team:chat.tenant.eu?action=join"
        ),
        Err(DesktopCommandError::DeepLink(
            DeepLinkError::UntrustedOrigin
        ))
    );
    assert!(
        !get_desktop_ptt_state(&state, OTHER_ORG)
            .unwrap()
            .opt_in_enabled
    );
    assert_eq!(
        get_desktop_tray_state(&state, OTHER_ORG).unwrap().indicator,
        crate::TrayIndicator::Idle
    );

    // Media capture preferences validate inputs, apply per organisation, and reset on switch.
    let updated_media = configure_desktop_media_capture(
        &mut state,
        OTHER_ORG,
        crate::ScreenShareSurface::BrowserTab,
        true,
        false,
        Some("mic-external-xlr"),
        Some("dac-line-out"),
    )
    .unwrap();
    assert_eq!(
        updated_media.preferred_surface,
        crate::ScreenShareSurface::BrowserTab
    );
    assert!(updated_media.system_audio_loopback);
    assert!(!updated_media.noise_suppression);
    state
        .switch_organisation(ORG, [0x42; 32], HashSet::from([[1; 32]]), 4)
        .unwrap();
    let reset_media = get_desktop_media_capture_state(&state, ORG).unwrap();
    assert_eq!(
        reset_media.preferred_surface,
        crate::ScreenShareSurface::Monitor
    );
    assert!(!reset_media.system_audio_loopback);
    assert!(reset_media.noise_suppression);
    assert!(reset_media.preferred_audio_input_id.is_none());
    assert!(reset_media.preferred_audio_output_id.is_none());
}

#[test]
fn w8_desktop_shell_lifecycle_synchronizes_window_tray_notifications_keychain_and_oidc() {
    let mut state = session();
    // 1. Multi-monitor bounds clamping when an external monitor is unplugged.
    state
        .configure_monitors(
            ORG,
            vec![crate::MonitorWorkArea {
                id: "macbook-retina".to_owned(),
                x: 0,
                y: 25,
                width: 1512,
                height: 945,
                scale_factor_milli: 2000,
                is_primary: true,
            }],
        )
        .unwrap();
    let restored = restore_desktop_window_bounds(
            &mut state,
            ORG,
            Some(r#"{"x":-2560,"y":100,"width":1600,"height":1000,"maximized":false,"fullscreen":false,"visible":false}"#),
        )
        .unwrap();
    assert!(restored.clamped);
    assert_eq!(restored.target_monitor_id, "macbook-retina");
    assert_eq!(restored.bounds.width, 1512);
    assert_eq!(restored.bounds.height, 945);
    assert!(!restored.visible);

    // Selecting Open Kodera from the system tray menu reveals and focuses the main window.
    let open_outcome =
        trigger_desktop_tray_menu_action(&mut state, ORG, TrayMenuItemId::OpenKodera).unwrap();
    assert!(matches!(
        open_outcome,
        TrayMenuActionOutcome::ShowAndFocusMainWindow { .. }
    ));
    assert!(state.window_placement(ORG).unwrap().visible);

    // 2. Unread badge syncs both Dock/Taskbar badge and System Tray unread badge.
    let badge = set_desktop_unread_badge(&mut state, ORG, 108).unwrap();
    assert_eq!(badge.badge_label.as_deref(), Some("99+"));
    assert_eq!(
        get_desktop_tray_state(&state, ORG)
            .unwrap()
            .unread_badge
            .as_deref(),
        Some("99+")
    );

    // 3. Notification bridge rejects javascript: route injection and redacts confidential previews.
    assert!(dispatch_desktop_notification(
        &mut state,
        ORG,
        &DesktopNotificationRequest {
            title: "Spoof".to_owned(),
            body: "Body".to_owned(),
            route_uri: Some("javascript:alert(1)".to_owned()),
            redact_preview: false,
        },
    )
    .is_err());

    let confidential = dispatch_desktop_notification(
        &mut state,
        ORG,
        &DesktopNotificationRequest {
            title: "Direct message".to_owned(),
            body: "Room secret content".to_owned(),
            route_uri: Some("kodera://workspace/acme/general".to_owned()),
            redact_preview: true,
        },
    )
    .unwrap();
    assert_eq!(confidential.body, crate::REDACTED_NOTIFICATION_PREVIEW);

    // 4. Keychain store + OIDC PKCE single-use loopback consumption + full wipe on switch.
    store_desktop_keychain_credential(
        &mut state,
        ORG,
        KeychainSecretKind::MatrixSession,
        "@alice:kodera.io",
        "MAC_01",
        1_762_520_000,
        None,
        TOKEN,
    )
    .unwrap();
    assert!(
        load_desktop_keychain_credential(
            &state,
            ORG,
            KeychainSecretKind::MatrixSession,
            "@alice:kodera.io"
        )
        .unwrap()
        .present
    );

    assert_eq!(
        begin_desktop_oidc_pkce_loopback(
            &mut state,
            ORG,
            "https://auth.kodera.io",
            "kodera-desktop",
            "pkce_verifier_fixture_alpha_bravo_charlie_delta_99",
            "pkce_state_fixture_99999",
            52_100,
        ),
        Err(DesktopCommandError::OidcLoopback(
            OidcLoopbackError::InvalidIssuerOrigin
        ))
    );

    let ready = begin_desktop_oidc_pkce_loopback(
        &mut state,
        ORG,
        "https://auth.kodera.io/realms/kodera",
        "kodera-desktop",
        "pkce_verifier_fixture_alpha_bravo_charlie_delta_99",
        "pkce_state_fixture_99999",
        52_100,
    )
    .unwrap();
    assert_eq!(ready.redirect_uri, "http://127.0.0.1:52100/auth/callback");

    let completed = complete_desktop_oidc_pkce_callback(
            &mut state,
            ORG,
            "http://127.0.0.1:52100/auth/callback?code=auth_code_fixture_9999&state=pkce_state_fixture_99999&iss=https%3A%2F%2Fauth.kodera.io%2Frealms%2Fkodera",
        )
        .unwrap();
    assert_eq!(
        completed.authorization_code.expose_for_token_exchange(),
        "auth_code_fixture_9999"
    );
    // Replay fails closed because the PKCE session was consumed once.
    assert_eq!(
            complete_desktop_oidc_pkce_callback(
                &mut state,
                ORG,
                "http://127.0.0.1:52100/auth/callback?code=auth_code_fixture_9999&state=pkce_state_fixture_99999&iss=https%3A%2F%2Fauth.kodera.io%2Frealms%2Fkodera",
            ),
            Err(DesktopCommandError::OidcLoopback(
                OidcLoopbackError::NoPendingSession
            ))
        );

    state
        .switch_organisation(OTHER_ORG, [0x43; 32], HashSet::from([[1; 32]]), 4)
        .unwrap();
    assert!(
        !load_desktop_keychain_credential(
            &state,
            OTHER_ORG,
            KeychainSecretKind::MatrixSession,
            "@alice:kodera.io"
        )
        .unwrap()
        .present
    );
    assert_eq!(state.dock_badge(OTHER_ORG).unwrap().unread_count, 0);
}

#[test]
fn w9_wizard_community_deploy_commands_enforce_org_fencing_and_sync_tray_health() {
    struct UnhealthyDeployRunner;
    impl crate::CommunityCommandRunner for UnhealthyDeployRunner {
        fn run_argv(
            &self,
            _program: &str,
            args: &[String],
            _working_dir: Option<&std::path::Path>,
            _timeout: std::time::Duration,
        ) -> Result<crate::CommandExecOutput, crate::DockerUnavailableReason> {
            let stdout = if args.ends_with(&[
                "config".to_owned(),
                "--format".to_owned(),
                "json".to_owned(),
            ]) {
                r#"{"name":"community","services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7"}}}"#
            } else if args.ends_with(&["ps".to_owned(), "--format".to_owned(), "json".to_owned()]) {
                r#"[{"Service":"keycloak","State":"running","Health":"unhealthy"},{"Service":"db","State":"running","Health":"healthy"},{"Service":"synapse","State":"running","Health":"healthy"},{"Service":"server","State":"running","Health":"healthy"},{"Service":"web","State":"running","Health":"healthy"},{"Service":"livekit","State":"running","Health":"healthy"}]"#
            } else {
                ""
            };
            Ok(crate::CommandExecOutput {
                status_code: Some(0),
                stdout: stdout.to_owned(),
                stderr: String::new(),
                timed_out: false,
            })
        }
        fn poll_backoff(&self) -> std::time::Duration {
            std::time::Duration::ZERO
        }
    }

    let mut state = audit_workspace();
    let stack_dir_buf = fresh_audit_community_stack_dir("w9-wizard");
    let stack_dir = stack_dir_buf.to_str().unwrap();

    let preflight = preflight_desktop_community_stack(
        &state,
        ORG,
        &CommunityPreflightSpec {
            stack_dir,
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        },
    )
    .unwrap();
    assert_eq!(preflight.normalized_domain, "chat.example.org");

    let prepared = prepare_desktop_community_stack(
        &state,
        ORG,
        &CommunityPrepareSpec {
            stack_dir,
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            oidc_provider_origin: "https://id.example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        },
    )
    .unwrap();
    assert!(prepared.env_file_written);

    // Unhealthy deploy marks tray indicator SelfHostDegraded.
    state
        .configure_community_runner(ORG, std::sync::Arc::new(UnhealthyDeployRunner))
        .unwrap();
    assert_eq!(
        deploy_desktop_community_stack(&mut state, ORG, stack_dir, Some(5_000)),
        Err(DesktopCommandError::CommunityDeploy(
            CommunityDeployError::StackUnhealthy
        ))
    );
    assert_eq!(
        get_desktop_tray_state(&state, ORG).unwrap().indicator,
        crate::TrayIndicator::SelfHostDegraded
    );

    // Healthy deploy clears SelfHostDegraded back to Idle.
    state
        .configure_community_runner(ORG, std::sync::Arc::new(AuditMockCommunityRunner))
        .unwrap();
    let deployed = deploy_desktop_community_stack(&mut state, ORG, stack_dir, Some(5_000)).unwrap();
    assert!(deployed.stack_healthy);
    assert_eq!(
        get_desktop_tray_state(&state, ORG).unwrap().indicator,
        crate::TrayIndicator::Idle
    );
}
