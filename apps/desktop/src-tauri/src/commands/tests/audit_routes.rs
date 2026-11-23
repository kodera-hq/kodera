use super::*;

/// The complete current JSON surface, including routes added after the original shell.
fn audit_command_cases() -> Vec<(&'static str, String)> {
    let theme = kodera_rs::encode_shareable_theme(&kodera_rs::curated_desktop_themes()[1]).unwrap();
    vec![
        (
            "plan_self_host",
            json(
                "plan_self_host",
                &format!(
                    r#","provider":"scaleway","region":"fr-par-1","fqdn":"chat.example.org","acme_email":"ops@example.org","raw_token":"{TOKEN}""#
                ),
            ),
        ),
        (
            "validate_docs_pad_url",
            json(
                "validate_docs_pad_url",
                r#","raw_url":"https://docs.example.org/docs/one""#,
            ),
        ),
        (
            "proximity_current_beacon",
            json("proximity_current_beacon", r#","now_unix_secs":1"#),
        ),
        (
            "proximity_member_statuses",
            json("proximity_member_statuses", ""),
        ),
        (
            "proximity_next_relay_batch",
            json("proximity_next_relay_batch", r#","max_frames":128"#),
        ),
        (
            "clear_workspace_session",
            json("clear_workspace_session", ""),
        ),
        (
            "set_sound_pack",
            json("set_sound_pack", r#","sound_pack":"silent""#),
        ),
        ("get_sound_pack", json("get_sound_pack", "")),
        (
            "create_channel_poll",
            json(
                "create_channel_poll",
                r#","channel_id":"text","poll_id":"new-poll","question":"New?","options":["Yes","No"],"allow_multiple":false"#,
            ),
        ),
        (
            "vote_channel_poll",
            poll_request(
                "vote_channel_poll",
                &format!(r#","voter_id":"{ORG}","selections":[1]"#),
            ),
        ),
        ("get_channel_poll", poll_request("get_channel_poll", "")),
        ("close_channel_poll", poll_request("close_channel_poll", "")),
        (
            "redact_iban",
            json(
                "redact_iban",
                r#","raw_iban":"FR7612345678901234567890189""#,
            ),
        ),
        (
            "validate_connector_post_url",
            json(
                "validate_connector_post_url",
                r#","raw_url":"https://social.example.org:443/@member/42""#,
            ),
        ),
        (
            "set_theme_mode",
            json("set_theme_mode", r#","mode":"light""#),
        ),
        (
            "import_shareable_theme",
            json("import_shareable_theme", &format!(r#","code":"{theme}""#)),
        ),
        ("export_shareable_theme", json("export_shareable_theme", "")),
        ("update_user_profile", profile_json()),
        (
            "evaluate_channel_iam",
            json(
                "evaluate_channel_iam",
                r#","channel_id":"text","rank":"moderator""#,
            ),
        ),
        ("save_docs_pad", save_json("pad", "text", "updated")),
        (
            "route_deep_link",
            json(
                "route_deep_link",
                r#","raw_uri":"matrix:r/partner-ops:community.kodera.io?action=join""#,
            ),
        ),
        (
            "update_tray_state",
            json(
                "update_tray_state",
                r#","unread_count":3,"call_state":"voice","muted":true,"self_host_degraded":false"#,
            ),
        ),
        ("get_tray_state", json("get_tray_state", "")),
        (
            "configure_ptt",
            json(
                "configure_ptt",
                r#","opt_in":true,"chord":"Alt+Shift+Space""#,
            ),
        ),
        (
            "set_ptt_pressed",
            json("set_ptt_pressed", r#","pressed":true,"now_ms":2500"#),
        ),
        ("get_ptt_state", json("get_ptt_state", "")),
        (
            "validate_keychain_metadata",
            json(
                "validate_keychain_metadata",
                &format!(
                    r#","secret_kind":"matrix-session","matrix_user_id":"@member:community.kodera.io","device_id":"DEV_01","issued_at_unix_secs":1762520000,"expires_at_unix_secs":1762523600,"raw_secret":"{TOKEN}""#
                ),
            ),
        ),
        (
            "inspect_self_host_health",
            json(
                "inspect_self_host_health",
                r#","compose_ps_json":"[{\"Service\":\"postgres\",\"State\":\"running\",\"Health\":\"healthy\",\"MemoryMiB\":256},{\"Service\":\"synapse\",\"State\":\"running\",\"Health\":\"healthy\",\"KoderaPolicy\":\"0.1.4\",\"MemoryMiB\":640},{\"Service\":\"coturn\",\"State\":\"running\",\"Health\":\"\",\"MemoryMiB\":96}]""#,
            ),
        ),
        (
            "restore_window_bounds",
            json(
                "restore_window_bounds",
                r#","saved_state_json":"{\"x\":-3200,\"y\":120,\"width\":1400,\"height\":900,\"maximized\":false,\"fullscreen\":false,\"visible\":true}""#,
            ),
        ),
        (
            "trigger_tray_menu_action",
            json("trigger_tray_menu_action", r#","action":"toggle_mute""#),
        ),
        (
            "set_unread_badge",
            json("set_unread_badge", r#","unread_count":12"#),
        ),
        (
            "dispatch_notification",
            json(
                "dispatch_notification",
                r#","title":"Ops channel","body":"Deployment verified","route_uri":"kodera://workspace/acme-ops/ops","redact_preview":false"#,
            ),
        ),
        (
            "store_keychain_credential",
            json(
                "store_keychain_credential",
                &format!(
                    r#","secret_kind":"matrix-session","matrix_user_id":"@member:community.kodera.io","device_id":"DEV_01","issued_at_unix_secs":1762520000,"expires_at_unix_secs":1762523600,"raw_secret":"{TOKEN}""#
                ),
            ),
        ),
        (
            "load_keychain_credential",
            json(
                "load_keychain_credential",
                r#","secret_kind":"oidc-refresh","matrix_user_id":"@member:community.kodera.io""#,
            ),
        ),
        (
            "delete_keychain_credential",
            json(
                "delete_keychain_credential",
                r#","secret_kind":"oidc-refresh","matrix_user_id":"@member:community.kodera.io""#,
            ),
        ),
        (
            "begin_oidc_pkce_loopback",
            json(
                "begin_oidc_pkce_loopback",
                r#","issuer_origin":"https://auth.kodera.io/realms/kodera","client_id":"kodera-desktop","code_verifier":"pkce_verifier_fixture_echo_foxtrot_golf_hotel_002","state":"audit_pkce_state_fixture_02","loopback_port":51920"#,
            ),
        ),
        (
            "complete_oidc_pkce_callback",
            json(
                "complete_oidc_pkce_callback",
                r#","callback_uri":"http://127.0.0.1:49152/auth/callback?code=oidc_code_fixture_0001&state=audit_pkce_state_fixture_01&iss=https%3A%2F%2Fauth.kodera.io%2Frealms%2Fkodera""#,
            ),
        ),
        (
            "self_host_preflight_community",
            json(
                "self_host_preflight_community",
                &format!(
                    r#","stack_dir":"{}","domain":"chat.example.org","acme_email":"ops@example.org","tls_mode":"acme","http_port":80,"https_port":443"#,
                    audit_community_stack_dir()
                ),
            ),
        ),
        (
            "self_host_prepare_community",
            json(
                "self_host_prepare_community",
                &format!(
                    r#","stack_dir":"{}","domain":"chat.example.org","acme_email":"ops@example.org","oidc_provider_origin":"https://id.example.org","tls_mode":"acme","http_port":80,"https_port":443"#,
                    fresh_audit_community_stack_dir("prepare-case")
                        .to_str()
                        .unwrap()
                ),
            ),
        ),
        (
            "self_host_deploy_community",
            json(
                "self_host_deploy_community",
                &format!(
                    r#","stack_dir":"{}","timeout_ms":15000"#,
                    audit_community_stack_dir()
                ),
            ),
        ),
    ]
}

#[test]
fn complete_twenty_route_json_flow_reaches_each_typed_result() {
    let cases = audit_command_cases();
    assert_eq!(cases.len(), REGISTERED_DESKTOP_COMMANDS.len());
    assert_eq!(
        cases.iter().map(|(name, _)| *name).collect::<Vec<_>>(),
        REGISTERED_DESKTOP_COMMANDS
    );
    assert_eq!(
        cases
            .iter()
            .map(|(name, _)| *name)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        REGISTERED_DESKTOP_COMMANDS.len()
    );
    for (name, request) in cases {
        let mut state = audit_workspace();
        let response = state.dispatch_command(&request);
        assert!(!format!("{response:?}").contains(TOKEN));
        match (name, response) {
            ("plan_self_host", DesktopCommandResponse::SelfHostPlan(plan)) => {
                assert!(!plan.required_dns.is_empty());
            }
            ("validate_docs_pad_url", DesktopCommandResponse::DocsPadUrl(url)) => {
                assert_eq!(url.as_str(), "https://docs.example.org/docs/one");
            }
            (
                "proximity_current_beacon",
                DesktopCommandResponse::ProximityBeacon { bytes, hex },
            ) => {
                assert_eq!(bytes, state.current_beacon(ORG, 1).unwrap());
                assert_eq!(hex, encode_hex(&bytes));
            }
            (
                "proximity_member_statuses",
                DesktopCommandResponse::ProximityMemberStatuses(members),
            ) => assert_eq!(members.len(), 1),
            ("proximity_next_relay_batch", DesktopCommandResponse::ProximityRelayBatch(frames)) => {
                assert_eq!(frames.len(), 1);
                assert!(state.next_relay_batch(ORG, 1).unwrap().is_empty());
            }
            ("clear_workspace_session", DesktopCommandResponse::WorkspaceSessionCleared) => {
                assert!(state.organisation_id().is_none());
                assert!(state.user_profile.is_none() && state.docs_pads.is_empty());
            }
            ("set_sound_pack", DesktopCommandResponse::SoundPack(SoundPackId::Silent))
            | ("get_sound_pack", DesktopCommandResponse::SoundPack(SoundPackId::Givre)) => {}
            ("create_channel_poll", DesktopCommandResponse::ChannelPoll(poll)) => {
                assert_eq!(poll.question, "New?");
                assert_eq!(poll.options.len(), 2);
                assert_eq!(poll.total_votes, 0);
            }
            ("vote_channel_poll", DesktopCommandResponse::ChannelPoll(poll)) => {
                assert_eq!(poll.total_votes, 1);
                assert_eq!(poll.options[1].vote_count, 1);
            }
            ("get_channel_poll", DesktopCommandResponse::ChannelPoll(poll)) => {
                assert_eq!(poll.total_votes, 0);
                assert!(!poll.is_closed);
            }
            ("close_channel_poll", DesktopCommandResponse::ChannelPoll(poll)) => {
                assert!(poll.is_closed);
            }
            ("redact_iban", DesktopCommandResponse::RedactedIban(masked)) => {
                assert_eq!(masked, "FR76 **** **** **** **** ***0 189");
            }
            ("validate_connector_post_url", DesktopCommandResponse::ConnectorPostUrl(url)) => {
                assert_eq!(url, "https://social.example.org/@member/42");
            }
            (
                "set_theme_mode",
                DesktopCommandResponse::ThemeMode {
                    mode: CoreThemeMode::Light,
                    monogram_bg_hex: "#000000",
                },
            ) => {}
            ("import_shareable_theme", DesktopCommandResponse::ShareableTheme(theme)) => {
                assert_eq!(theme.id, "preset-cobalt-polaire");
            }
            ("export_shareable_theme", DesktopCommandResponse::ShareableThemeCode(code)) => {
                assert_eq!(
                    kodera_rs::decode_shareable_theme(&code).unwrap().id,
                    "preset-real-black-oled"
                );
            }
            ("update_user_profile", DesktopCommandResponse::UserProfile(profile)) => {
                assert_eq!(profile.handle, "member");
            }
            ("evaluate_channel_iam", DesktopCommandResponse::ChannelAccess(decision)) => {
                assert!(decision.can_read && decision.can_write && decision.can_manage);
                assert!(decision.can_create_poll && !decision.can_manage_connectors);
            }
            ("save_docs_pad", DesktopCommandResponse::DocsPad(document)) => {
                assert_eq!(document.markdown_body, "updated");
                assert_eq!(document.revision, 2);
                assert!(document
                    .export_markdown_with_frontmatter()
                    .ends_with("updated"));
            }
            ("route_deep_link", DesktopCommandResponse::DeepLink(admitted)) => {
                assert_eq!(
                    admitted.canonical_uri(),
                    "matrix:r/partner-ops:community.kodera.io?action=join"
                );
            }
            ("update_tray_state", DesktopCommandResponse::TrayState(tray)) => {
                assert_eq!(tray.unread_count, 3);
                assert_eq!(tray.active_call, Some(TrayCallKind::Voice));
                assert!(tray.muted);
            }
            ("get_tray_state", DesktopCommandResponse::TrayState(tray)) => {
                assert_eq!(tray.unread_count, 0);
                assert_eq!(tray.active_call, None);
            }
            ("configure_ptt", DesktopCommandResponse::PttState(ptt)) => {
                assert!(ptt.opt_in_enabled);
                assert_eq!(ptt.binding.as_deref(), Some("Alt+Shift+Space"));
            }
            ("set_ptt_pressed", DesktopCommandResponse::PttState(ptt)) => {
                assert_eq!(
                    ptt.transmission,
                    crate::PttTransmissionState::Transmitting { since_ms: 2500 }
                );
            }
            ("get_ptt_state", DesktopCommandResponse::PttState(ptt)) => {
                assert!(ptt.opt_in_enabled);
                assert_eq!(ptt.binding.as_deref(), Some("Ctrl+Shift+Space"));
            }
            ("validate_keychain_metadata", DesktopCommandResponse::KeychainMetadata(metadata)) => {
                assert_eq!(
                    metadata.slot.service_name,
                    "io.kodera.desktop.matrix-session"
                );
                assert_eq!(
                    metadata.slot.account_name,
                    format!("org:{ORG}:user:@member:community.kodera.io")
                );
            }
            ("inspect_self_host_health", DesktopCommandResponse::SelfHostHealth(report)) => {
                assert!(report.is_healthy());
                assert_eq!(report.observed_memory_mib, 992);
            }
            ("restore_window_bounds", DesktopCommandResponse::WindowPlacement(placement)) => {
                assert!(placement.clamped);
                assert_eq!(placement.bounds.width, 1400);
                assert_eq!(placement.bounds.height, 900);
                assert!(placement.bounds.x >= 0);
            }
            (
                "trigger_tray_menu_action",
                DesktopCommandResponse::TrayMenuAction(TrayMenuActionOutcome::MuteToggled {
                    muted,
                    ..
                }),
            ) => {
                assert!(muted);
            }
            ("set_unread_badge", DesktopCommandResponse::DockBadge(badge)) => {
                assert_eq!(badge.unread_count, 12);
                assert_eq!(badge.badge_label.as_deref(), Some("12"));
                assert_eq!(state.tray_state(ORG).unwrap().unread_count, 12);
            }
            ("dispatch_notification", DesktopCommandResponse::Notification(note)) => {
                assert_eq!(note.title, "Ops channel");
                assert_eq!(
                    note.canonical_route_uri.as_deref(),
                    Some("kodera://workspace/acme-ops/ops")
                );
            }
            ("store_keychain_credential", DesktopCommandResponse::KeychainMetadata(metadata)) => {
                assert_eq!(
                    metadata.slot.service_name,
                    "io.kodera.desktop.matrix-session"
                );
            }
            ("load_keychain_credential", DesktopCommandResponse::KeychainStatus(status)) => {
                assert!(status.present);
                assert!(status.metadata.is_some());
            }
            ("delete_keychain_credential", DesktopCommandResponse::KeychainStatus(status)) => {
                assert!(status.present);
                assert!(status.metadata.is_none());
            }
            ("begin_oidc_pkce_loopback", DesktopCommandResponse::OidcLoopbackReady(ready)) => {
                assert_eq!(ready.code_challenge_method, "S256");
                assert_eq!(ready.redirect_uri, "http://127.0.0.1:51920/auth/callback");
            }
            ("complete_oidc_pkce_callback", DesktopCommandResponse::OidcCallback(outcome)) => {
                assert_eq!(outcome.issuer_origin, "https://auth.kodera.io");
                assert_eq!(
                    outcome.authorization_code.expose_for_token_exchange(),
                    "oidc_code_fixture_0001"
                );
            }
            (
                "self_host_preflight_community",
                DesktopCommandResponse::CommunityPreflight(report),
            ) => {
                assert!(report.compose_file_present && report.stack_dir_writable);
                assert_eq!(report.normalized_domain, "chat.example.org");
                assert_eq!(report.matrix_base_domain, "example.org");
            }
            ("self_host_prepare_community", DesktopCommandResponse::CommunityPrepare(report)) => {
                assert!(report.env_file_written && report.compose_config_valid);
                assert_eq!(report.generated_secret_keys.len(), 16);
                assert_eq!(
                    report.oidc_issuer,
                    "https://id.example.org/realms/community"
                );
            }
            ("self_host_deploy_community", DesktopCommandResponse::CommunityDeploy(report)) => {
                assert!(report.stack_healthy);
                assert_eq!(report.core_services.len(), 4);
                assert!(report.health_report.is_healthy());
            }
            (route, unexpected) => {
                panic!("{route} produced unexpected response: {unexpected:?}")
            }
        }
    }
}

#[test]
fn every_json_route_refuses_foreign_duplicate_unknown_and_wrong_typed_scope_without_effects() {
    let snapshot = |state: &DesktopWorkspaceSession| {
        (
            state.sound_pack(ORG).unwrap(),
            state.export_shareable_theme(ORG).unwrap(),
            state.user_profile(ORG).unwrap(),
            state.docs_pad(ORG, "pad").unwrap(),
            state.channel_poll(ORG, "text", "poll").unwrap(),
            state.member_statuses(ORG).unwrap(),
            state.allowed_docs_host.clone(),
            state.tray_state(ORG).unwrap(),
            state.ptt_state(ORG).unwrap(),
            state.deep_link_policy.clone(),
            (
                state.window_placement(ORG).unwrap(),
                state.dock_badge(ORG).unwrap(),
                state.keychain_store.metadata_snapshot(),
                state.pending_oidc.is_some(),
            ),
        )
    };
    for (name, request) in audit_command_cases()
        .into_iter()
        .chain(legacy_route_cases())
    {
        let stem = request.strip_suffix('}').unwrap();
        let attempts = [
            (
                request.replacen(ORG, OTHER_ORG, 1),
                DesktopCommandError::Core(CoreError::OrganisationMismatch),
            ),
            (
                format!(r#"{stem},"organisation_\u0069d":"{ORG}"}}"#),
                DesktopCommandError::InvalidRequest,
            ),
            (
                format!(r#"{stem},"audit_unknown":true}}"#),
                DesktopCommandError::InvalidRequest,
            ),
            (
                request.replacen(
                    &format!(r#""organisation_id":"{ORG}""#),
                    r#""organisation_id":true"#,
                    1,
                ),
                DesktopCommandError::InvalidRequest,
            ),
        ];
        for (input, error) in attempts {
            let mut state = audit_workspace();
            let before = snapshot(&state);
            assert_eq!(
                state.dispatch_command(&input),
                DesktopCommandResponse::Error(error),
                "route {name} must refuse the adversarial envelope"
            );
            assert_eq!(snapshot(&state), before, "route {name} changed payload");
            assert_eq!(
                state.next_relay_batch(ORG, 128).unwrap().len(),
                1,
                "route {name} drained the proximity queue"
            );
        }
    }
}

#[test]
fn every_json_route_fails_closed_after_workspace_teardown() {
    for (name, request) in audit_command_cases()
        .into_iter()
        .chain(legacy_route_cases())
    {
        let mut state = audit_workspace();
        state.clear_session();
        assert_eq!(
            state.dispatch_command(&request),
            DesktopCommandResponse::Error(DesktopCommandError::Core(
                CoreError::TransportUnavailable
            )),
            "ended workspace route {name} must remain unavailable"
        );
        assert!(state.organisation_id().is_none());
        assert!(state.user_profile.is_none() && state.docs_pads.is_empty());
    }
}

/// The three legacy names, spelled here on purpose: this list does not read the table it pins.
const PINNED_LEGACY_ROUTES: [(&str, &str); 3] = [
    ("emergency_current_beacon", "proximity_current_beacon"),
    ("emergency_member_statuses", "proximity_member_statuses"),
    ("emergency_next_relay_batch", "proximity_next_relay_batch"),
];

/// Each proximity request of the audit, re-addressed to its legacy route name.
fn legacy_route_cases() -> Vec<(&'static str, String)> {
    let canonical = audit_command_cases();
    PINNED_LEGACY_ROUTES
        .iter()
        .map(|(legacy, proximity)| {
            let (_, request) = canonical
                .iter()
                .find(|(name, _)| name == proximity)
                .expect("every proximity route is in the audit");
            let renamed = request.replacen(
                &format!(r#""command":"{proximity}""#),
                &format!(r#""command":"{legacy}""#),
                1,
            );
            assert_ne!(&renamed, request);
            (*legacy, renamed)
        })
        .collect()
}

/// Everything a proximity route can change or reveal, for comparing two sessions.
fn proximity_outcome(
    state: &mut DesktopWorkspaceSession,
    request: &str,
    aliases: &[(&'static str, &'static str)],
) -> (DesktopCommandResponse, usize, usize) {
    let response = state.dispatch_command_with_aliases(request, aliases);
    let members = state
        .member_statuses(ORG)
        .map_or(0, |members| members.len());
    let queued = state
        .next_relay_batch(ORG, 128)
        .map_or(0, |frames| frames.len());
    (response, members, queued)
}

/// The dual-name contract: with `aliases` in force, each legacy route answers exactly like its
/// proximity route, on success and on every refusal, and leaves the same state behind.
fn legacy_routes_answer_like_proximity_routes(
    aliases: &[(&'static str, &'static str)],
) -> Result<(), String> {
    let canonical = audit_command_cases();
    for ((legacy, legacy_request), (_, proximity)) in
        legacy_route_cases().into_iter().zip(PINNED_LEGACY_ROUTES)
    {
        let (_, proximity_request) = canonical
            .iter()
            .find(|(name, _)| *name == proximity)
            .expect("every proximity route is in the audit");
        let variants = |request: &str| {
            let stem = request.strip_suffix('}').unwrap();
            vec![
                request.to_owned(),
                request.replacen(ORG, OTHER_ORG, 1),
                format!(r#"{stem},"audit_unknown":true}}"#),
                format!(r#"{stem},"max_frames":"128"}}"#),
            ]
        };
        for (index, (old, new)) in variants(&legacy_request)
            .into_iter()
            .zip(variants(proximity_request))
            .enumerate()
        {
            let answered_old = proximity_outcome(&mut audit_workspace(), &old, aliases);
            let answered_new = proximity_outcome(&mut audit_workspace(), &new, aliases);
            if answered_old != answered_new {
                return Err(format!(
                    "{legacy} differs from {proximity} on variant {index}"
                ));
            }
            let succeeded = !matches!(answered_new.0, DesktopCommandResponse::Error(_));
            if succeeded != (index == 0) {
                return Err(format!("{proximity} variant {index} had the wrong verdict"));
            }
        }
        for ended in [&legacy_request, proximity_request] {
            let mut state = audit_workspace();
            state.clear_session();
            if state.dispatch_command_with_aliases(ended, aliases)
                != DesktopCommandResponse::Error(DesktopCommandError::Core(
                    CoreError::TransportUnavailable,
                ))
            {
                return Err(format!("{legacy} or {proximity} answered after teardown"));
            }
        }
    }
    Ok(())
}

#[test]
fn legacy_emergency_routes_are_permanent_aliases_of_the_proximity_routes() {
    assert_eq!(LEGACY_ROUTE_ALIASES, PINNED_LEGACY_ROUTES);
    assert_eq!(
        legacy_routes_answer_like_proximity_routes(&LEGACY_ROUTE_ALIASES),
        Ok(())
    );
    // Through the public entry point too: each name reaches its typed proximity result.
    for (name, request) in legacy_route_cases() {
        let mut state = audit_workspace();
        match (name, state.dispatch_command(&request)) {
            (
                "emergency_current_beacon",
                DesktopCommandResponse::ProximityBeacon { bytes, hex },
            ) => {
                assert_eq!(bytes, state.current_beacon(ORG, 1).unwrap());
                assert_eq!(hex, encode_hex(&bytes));
            }
            (
                "emergency_member_statuses",
                DesktopCommandResponse::ProximityMemberStatuses(members),
            ) => {
                assert_eq!(members.len(), 1);
                // Bound to this organisation's beacon salt, and unique here: no fingerprint.
                assert_eq!(
                    members[0].sender_handle,
                    ProximityHandle::generated(&[0x42; 32], &members[0].sender_public_key)
                );
                assert_ne!(
                    members[0].sender_handle,
                    ProximityHandle::generated(&[0x43; 32], &members[0].sender_public_key)
                );
                assert_eq!(members[0].sender_fingerprint, None);
            }
            ("emergency_next_relay_batch", DesktopCommandResponse::ProximityRelayBatch(frames)) => {
                assert_eq!(frames.len(), 1);
                assert!(state.next_relay_batch(ORG, 1).unwrap().is_empty());
            }
            (route, unexpected) => {
                panic!("{route} produced unexpected response: {unexpected:?}")
            }
        }
    }
    // An alias is a route name only: it is not admitted through the `op` discriminator, and
    // no other spelling of the old name is invented.
    for request in [
        format!(r#"{{"op":"emergency_member_statuses","organisation_id":"{ORG}"}}"#),
        json("Emergency_member_statuses", ""),
        json("emergency_member_status", ""),
        json("urgence_member_statuses", ""),
    ] {
        assert_eq!(
            audit_workspace().dispatch_command(&request),
            DesktopCommandResponse::Error(DesktopCommandError::InvalidRequest)
        );
    }
}

/// Member statuses carry a pseudonym, never a name: one per sender, bound to this organisation.
#[test]
fn member_statuses_label_each_sender_with_an_organisation_bound_pseudonym() {
    let mut state = session();
    populate(&mut state, 1, 1);
    populate(&mut state, 2, 2);
    let DesktopCommandResponse::ProximityMemberStatuses(members) =
        state.dispatch_command(&json("proximity_member_statuses", ""))
    else {
        panic!("expected member statuses")
    };
    assert_eq!(members.len(), 2);
    let labels = state.member_labels(ORG).unwrap();
    for (member, label) in members.iter().zip(&labels) {
        assert_eq!(member.sender_public_key, label.sender_public_key);
        assert_eq!(member.sender_handle, label.handle);
        assert_eq!(
            member.sender_handle,
            ProximityHandle::generated(&[0x42; 32], &member.sender_public_key)
        );
        assert_eq!(member.sender_fingerprint, None);
        assert_eq!(label.display(), member.sender_handle.as_str());
        assert!(kodera_rs::validate_proximity_handle(member.sender_handle.as_str()).is_ok());
    }
    assert_ne!(members[0].sender_handle, members[1].sender_handle);
    // A label is display only: a wrong organisation still gets nothing, whatever it shows.
    assert_eq!(
        state.member_labels(OTHER_ORG),
        Err(CoreError::OrganisationMismatch)
    );
    state.clear_session();
    assert_eq!(
        state.member_labels(ORG),
        Err(CoreError::TransportUnavailable)
    );
}

/// A member whose handle equals that of a provisioned member who has not checked in yet is
/// already shown with its key fingerprint: it cannot pass for the absent member, and its label
/// does not change when that member appears.
#[test]
fn a_handle_shared_with_an_absent_provisioned_member_already_carries_its_fingerprint() {
    let mut state = session();
    state
        .provision_dedicated_handle(ORG, [1; 32], "north-wing-3")
        .unwrap();
    state
        .provision_dedicated_handle(ORG, [2; 32], "north-wing-3")
        .unwrap();
    populate(&mut state, 1, 1); // only the first of the two checks in
    let statuses = |state: &mut DesktopWorkspaceSession| {
        let DesktopCommandResponse::ProximityMemberStatuses(members) =
            state.dispatch_command(&json("proximity_member_statuses", ""))
        else {
            panic!("expected member statuses")
        };
        members
    };
    let alone = statuses(&mut state);
    assert_eq!(alone.len(), 1);
    assert_eq!(alone[0].sender_handle.as_str(), "north-wing-3");
    let fingerprint = alone[0]
        .sender_fingerprint
        .clone()
        .expect("the handle is shared with a provisioned member that has not checked in");
    // Keyed with this organisation's beacon salt: the same key elsewhere shows another one.
    assert!(
        kodera_rs::proximity_roster_fingerprint(&[0x42; 32], &[1; 32]).starts_with(&fingerprint)
    );
    assert!(
        !kodera_rs::proximity_roster_fingerprint(&[0x43; 32], &[1; 32]).starts_with(&fingerprint)
    );
    assert_eq!(
        state.member_labels(ORG).unwrap()[0].display(),
        format!("north-wing-3 [{fingerprint}]")
    );

    populate(&mut state, 2, 2); // the other member appears: the first label is unchanged
    let both = statuses(&mut state);
    assert_eq!(both.len(), 2);
    assert_eq!(both[0], alone[0]);
    assert_ne!(both[0].sender_fingerprint, both[1].sender_fingerprint);
    assert!(both[1].sender_fingerprint.is_some());

    // Provisioning a pseudonym is display metadata for roster keys only.
    assert_eq!(
        state.provision_dedicated_handle(ORG, [9; 32], "north-wing-3"),
        Err(CoreError::UnauthorizedSender)
    );
    assert_eq!(
        state.provision_dedicated_handle(ORG, [1; 32], "North Wing"),
        Err(CoreError::InvalidProximityHandle)
    );
    assert_eq!(
        state.provision_dedicated_handle(OTHER_ORG, [1; 32], "north-wing-3"),
        Err(CoreError::OrganisationMismatch)
    );
    state.clear_session();
    assert_eq!(
        state.provision_dedicated_handle(ORG, [1; 32], "north-wing-3"),
        Err(CoreError::TransportUnavailable)
    );
}

/// Refusal mutation: drop one alias at a time. The legacy name must then be refused and the
/// dual-name check above must fail, while the proximity name keeps answering.
#[test]
fn dropping_any_legacy_alias_is_refused_by_the_dual_name_check() {
    for (dropped, (legacy, proximity)) in PINNED_LEGACY_ROUTES.into_iter().enumerate() {
        let mutated: Vec<(&'static str, &'static str)> = LEGACY_ROUTE_ALIASES
            .into_iter()
            .enumerate()
            .filter(|(index, _)| *index != dropped)
            .map(|(_, pair)| pair)
            .collect();
        assert_eq!(mutated.len(), 2);
        let failure = legacy_routes_answer_like_proximity_routes(&mutated)
            .expect_err("a dropped alias must fail the dual-name check");
        assert!(failure.starts_with(legacy), "{failure}");

        let (_, legacy_request) = legacy_route_cases().swap_remove(dropped);
        assert_eq!(
            audit_workspace().dispatch_command_with_aliases(&legacy_request, &mutated),
            DesktopCommandResponse::Error(DesktopCommandError::InvalidRequest),
            "{legacy} without its alias"
        );
        let proximity_request =
            legacy_request.replacen(&format!(r#""{legacy}""#), &format!(r#""{proximity}""#), 1);
        assert!(!matches!(
            audit_workspace().dispatch_command_with_aliases(&proximity_request, &mutated),
            DesktopCommandResponse::Error(_)
        ));
    }
    // An alias pointing at another route is caught as well.
    let crossed = [
        ("emergency_current_beacon", "proximity_member_statuses"),
        LEGACY_ROUTE_ALIASES[1],
        LEGACY_ROUTE_ALIASES[2],
    ];
    assert!(legacy_routes_answer_like_proximity_routes(&crossed).is_err());
}
