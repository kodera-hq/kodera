use super::*;

#[test]
fn webview_ipc_bridge_enforces_sender_origin_and_routes_commands_and_deep_links() {
    let policy = DeepLinkAdmissionPolicy::kodera_default();
    let startup_link = route_deep_link("kodera://workspace/acme/general", &policy).unwrap();
    let mut bridge = DesktopWebViewBridge::new(false, Some(startup_link));
    bridge.document_capability = Some("c".repeat(64));
    let internal_index = format!("{INTERNAL_ASSET_ORIGIN}/index.html");

    // Untrusted and remote web frame origins are rejected before parsing or executing commands.
    for refused in [
        "https://evil.example/frame",
        "https://app.kodera.io/",
        "https://staging.kodera.io/",
        "https://community.kodera.io/",
    ] {
        assert_eq!(
                bridge.handle_ipc_request(
                    refused,
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc:1\tget_app_metadata\n{\"command\":\"get_app_metadata\"}"
                ),
                Err(WebViewIpcError::UntrustedSenderOrigin)
            );
    }

    // Registering `kodera://deep-link` flushes the buffered startup deep link.
    let listen_out = bridge
            .handle_ipc_request(
                &internal_index,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc:1\tplugin:event|listen\n{\"event\":\"kodera://deep-link\",\"handler\":7}",
            )
            .unwrap();
    assert_eq!(listen_out.eval_scripts.len(), 2);
    assert!(listen_out.eval_scripts[0].contains("__KODERA_IPC_RESOLVE__(1, true, 1)"));
    assert!(listen_out.eval_scripts[1]
        .contains("__KODERA_IPC_DISPATCH_EVENT__(7, \"kodera://workspace/acme/general\")"));

    // Setting unread badge auto-provisions the session and updates native window title.
    let badge_cmd = format!(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc:2\tset_unread_badge\n{{\"command\":\"set_unread_badge\",\"organisation_id\":\"{ORG}\",\"unread_count\":9}}"
        );
    let badge_out = bridge
        .handle_ipc_request(&internal_index, &badge_cmd)
        .unwrap();
    assert_eq!(
        badge_out.window_action,
        Some(GuiWindowAction::SetTitle("Kodera (9)".to_owned()))
    );
    assert!(badge_out.eval_scripts[0].contains("__KODERA_IPC_RESOLVE__(2, true,"));

    // Quit command clears session and emits GuiWindowAction::Quit.
    let quit_out = bridge
            .handle_ipc_request(
                &internal_index,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc:3\tquit\n{\"command\":\"quit\"}",
            )
            .unwrap();
    assert_eq!(quit_out.window_action, Some(GuiWindowAction::Quit));
}

#[test]
fn authentication_navigation_never_grants_native_command_authority() {
    let mut bridge = DesktopWebViewBridge::new(false, None);
    bridge.document_capability = Some("c".repeat(64));
    for url in [
        "https://auth.kodera.io/realms/example/account",
        "https://AUTH.KODERA.IO/realms/example/account",
    ] {
        assert!(
            validate_navigation_url(url, &DeepLinkAdmissionPolicy::kodera_default(), false).is_ok()
        );
        for command in [
            "quit",
            "init_session",
            "store_keychain_credential",
            "plugin:event|listen",
        ] {
            let message = format!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc:1\t{command}\n{{}}");
            assert_eq!(
                bridge.handle_ipc_request(url, &message),
                Err(WebViewIpcError::UntrustedSenderOrigin)
            );
        }
    }
}

#[test]
fn document_transition_discards_listeners_sessions_and_old_document_messages() {
    let mut bridge = DesktopWebViewBridge::new(false, None);
    bridge.document_capability = Some("c".repeat(64));
    let internal_index = format!("{INTERNAL_ASSET_ORIGIN}/index.html");
    let hello = bridge
        .handle_ipc_request(
            &internal_index,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:hello\t__document_generation\n{}",
        )
        .unwrap();
    assert!(hello.eval_scripts[0].contains("__KODERA_IPC_ACTIVATE__(0,"));
    assert!(bridge.document_id.is_none());
    let old = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc:1\tplugin:event|listen\n{\"event\":\"kodera://deep-link\",\"handler\":1}";
    bridge.handle_ipc_request(&internal_index, old).unwrap();
    bridge.host.provision_session(ORG).unwrap();
    bridge.begin_document(1);
    bridge.document_capability = Some("c".repeat(64));
    assert!(bridge.listeners.is_empty());
    assert!(!bridge.host.has_active_session());
    assert_eq!(
        bridge.handle_ipc_request(&internal_index, old),
        Err(WebViewIpcError::UntrustedSenderOrigin)
    );
    assert!(bridge.document_id.is_none());
    let new = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:1:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc:1\tplugin:event|listen\n{\"event\":\"kodera://deep-link\",\"handler\":1}";
    bridge.handle_ipc_request(&internal_index, new).unwrap();
    assert_eq!(
        bridge.handle_ipc_request(&internal_index, old),
        Err(WebViewIpcError::UntrustedSenderOrigin)
    );
    bridge.begin_document(1);
    assert_eq!(bridge.listeners.len(), 1);
    let late = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc:2\tquit\n{}";
    assert_eq!(
        bridge.handle_ipc_request(&internal_index, late),
        Err(WebViewIpcError::UntrustedSenderOrigin)
    );
    let link = route_deep_link(
        "kodera://workspace/acme/general",
        &DeepLinkAdmissionPolicy::kodera_default(),
    )
    .unwrap();
    let scripts = bridge.enqueue_deep_link(link);
    assert_eq!(scripts.len(), 1);
    assert!(scripts[0].contains("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
    assert!(!scripts[0].contains("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    let update = bridge
            .handle_ipc_request(
                &internal_index,
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:1:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc:2\tcheck_app_updates\n{}",
            )
            .unwrap();
    assert!(update.eval_scripts[0].contains("\"supported\":false"));
}

#[test]
fn document_capability_rotates_and_rejects_stale_and_future_generation_forgeries() {
    let mut bridge = DesktopWebViewBridge::new(false, None);
    let internal_index = format!("{INTERNAL_ASSET_ORIGIN}/index.html");
    bridge.begin_document(1);
    let old_capability = bridge.document_capability.clone().unwrap();
    let old_message =
        format!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:1:{old_capability}:1\tget_app_metadata\n{{}}");
    bridge
        .handle_ipc_request(&internal_index, &old_message)
        .unwrap();
    bridge.begin_document(2);
    assert!(bridge.document_id.is_none());
    let capability = bridge.document_capability.clone().unwrap();
    assert_ne!(capability, old_capability);
    let forged_current_generation =
        format!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:2:{old_capability}:2\tquit\n{{}}");
    assert_eq!(
        bridge.handle_ipc_request(&internal_index, &forged_current_generation),
        Err(WebViewIpcError::UntrustedSenderOrigin)
    );
    assert!(bridge.document_id.is_none());
    let forged_future_generation =
        format!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:3:{capability}:2\tquit\n{{}}");
    assert_eq!(
        bridge.handle_ipc_request(&internal_index, &forged_future_generation),
        Err(WebViewIpcError::UntrustedSenderOrigin)
    );
    assert!(bridge.document_id.is_none());
    let valid =
        format!("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:2:{capability}:1\tget_app_metadata\n{{}}");
    bridge.handle_ipc_request(&internal_index, &valid).unwrap();
    bridge.begin_document(3);
    // An unavailable OS capability has no predictable or empty fallback.
    bridge.document_capability = None;
    assert_eq!(
        bridge.handle_ipc_request(
            &internal_index,
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:hello\t__document_generation\n{}"
        ),
        Err(WebViewIpcError::UntrustedSenderOrigin)
    );
    let unavailable = format!("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:3:{capability}:2\tquit\n{{}}");
    assert_eq!(
        bridge.handle_ipc_request(&internal_index, &unavailable),
        Err(WebViewIpcError::UntrustedSenderOrigin)
    );
}

#[test]
fn update_response_exactly_reports_unsupported() {
    let mut bridge = DesktopWebViewBridge::new(false, None);
    let internal_index = format!("{INTERNAL_ASSET_ORIGIN}/index.html");
    let capability = bridge.document_capability.clone().unwrap();
    let message =
        format!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0:{capability}:1\tcheck_app_updates\n{{}}");
    let outcome = bridge
        .handle_ipc_request(&internal_index, &message)
        .unwrap();
    let payload = format!(
        r#"{{"supported":false,"updateAvailable":false,"currentVersion":"{}","latestVersion":null,"channel":"stable"}}"#,
        DESKTOP_APP_VERSION
    );
    assert_eq!(
        outcome.eval_scripts,
        vec![resolve_js_promise(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            1,
            true,
            &payload
        )]
    );
    assert!(IPC_INIT_SCRIPT.contains(&format!("version: '{DESKTOP_APP_VERSION}',")));
}

#[test]
fn webview_ipc_drives_ptt_media_capture_mute_toggle_and_focus_loss_release_safety() {
    let mut bridge = DesktopWebViewBridge::new(false, None);
    let internal_index = format!("{INTERNAL_ASSET_ORIGIN}/index.html");
    let doc_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let cap = bridge.document_capability.clone().unwrap();

    // Register listeners for `kodera://ptt-state` (cb 11) and `kodera://tray-action` (cb 12).
    bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:1\tplugin:event|listen\n{{\"event\":\"kodera://ptt-state\",\"handler\":11}}"
            ),
        )
        .unwrap();
    bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:2\tplugin:event|listen\n{{\"event\":\"kodera://tray-action\",\"handler\":12}}"
            ),
        )
        .unwrap();

    // Configure Push-to-Talk via WebView IPC -> resolves promise AND emits `kodera://ptt-state`.
    let cfg_ptt = bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:3\tconfigure_ptt\n{{\"command\":\"configure_ptt\",\"organisation_id\":\"{ORG}\",\"opt_in\":true,\"chord\":\"Ctrl+Shift+Space\"}}"
            ),
        )
        .unwrap();
    assert_eq!(cfg_ptt.eval_scripts.len(), 2);
    assert!(cfg_ptt.eval_scripts[0].contains("__KODERA_IPC_DISPATCH_EVENT__(11,"));
    assert!(cfg_ptt.eval_scripts[0].contains("Ctrl+Shift+Space"));
    assert!(cfg_ptt.eval_scripts[1].contains("__KODERA_IPC_RESOLVE__(3, true,"));

    // Physical key-chord press (`Ctrl+Shift` + `Space`) opens PTT and emits `kodera://ptt-state`.
    assert!(bridge
        .handle_modifiers_changed(std::collections::BTreeSet::from([
            crate::PttModifier::Ctrl,
            crate::PttModifier::Shift,
        ]))
        .is_empty());
    let press_scripts = bridge.handle_key_chord_event(crate::PttTriggerKey::Space, true, 4200);
    assert_eq!(press_scripts.len(), 1);
    assert!(press_scripts[0].contains("\\\"transmitting\\\":true"));
    assert!(press_scripts[0].contains("\\\"transmitting_since_ms\\\":4200"));

    // Focus loss (`WindowEvent::Focused(false)`) unconditionally releases PTT AND rejects delayed presses!
    let focus_loss_scripts = bridge.handle_window_focus_lost();
    assert!(!bridge.is_window_focused());
    assert_eq!(focus_loss_scripts.len(), 1);
    assert!(focus_loss_scripts[0].contains("\\\"transmitting\\\":false"));
    assert!(bridge.handle_window_focus_lost().is_empty());

    // Blur-then-delayed-press regression: WebView IPC `set_ptt_pressed(true)` (including JSON
    // whitespace `"pressed" :true` and unicode escape `"pre\u0073sed":true`) and physical key presses
    // are all refused while `!bridge.is_window_focused()`.
    for (req_num, body) in [
        (
            40,
            format!(
                r#"{{"command":"set_ptt_pressed","organisation_id":"{ORG}","pressed":true,"now_ms":4800}}"#
            ),
        ),
        (
            401,
            format!(
                r#"{{"command":"set_ptt_pressed","organisation_id":"{ORG}","pressed" :true,"now_ms":4801}}"#
            ),
        ),
        (
            402,
            format!(
                r#"{{"command":"set_ptt_pressed","organisation_id":"{ORG}","pre\u0073sed":true,"now_ms":4802}}"#
            ),
        ),
    ] {
        let delayed_ipc_press = bridge
            .handle_ipc_request(
                &internal_index,
                &format!("{doc_id}:0:{cap}:{req_num}\tset_ptt_pressed\n{body}"),
            )
            .unwrap();
        assert_eq!(delayed_ipc_press.eval_scripts.len(), 1);
        assert!(delayed_ipc_press.eval_scripts[0]
            .contains(&format!("__KODERA_IPC_RESOLVE__({req_num}, false,")));
        assert!(delayed_ipc_press.eval_scripts[0].contains("tray_ptt:window_not_focused"));
    }
    assert!(bridge
        .handle_key_chord_event(crate::PttTriggerKey::Space, true, 4900)
        .is_empty());

    // Restoring window focus (`WindowEvent::Focused(true)`) re-enables PTT presses.
    assert!(bridge.set_window_focused(true).is_empty());
    assert!(bridge.is_window_focused());

    // Modifier-release safety: pressing via IPC, then lifting `Shift` releases PTT immediately.
    let ipc_press = bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:4\tset_ptt_pressed\n{{\"command\":\"set_ptt_pressed\",\"organisation_id\":\"{ORG}\",\"pressed\":true,\"now_ms\":5100}}"
            ),
        )
        .unwrap();
    assert!(ipc_press.eval_scripts[0].contains("\\\"transmitting\\\":true"));
    let mod_lift = bridge
        .handle_modifiers_changed(std::collections::BTreeSet::from([crate::PttModifier::Ctrl]));
    assert_eq!(mod_lift.len(), 1);
    assert!(mod_lift[0].contains("\\\"transmitting\\\":false"));

    // `update_tray_state` ending a call (`call_state: "none"`) force-releases PTT AND emits `kodera://ptt-state`!
    bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:41\tset_ptt_pressed\n{{\"command\":\"set_ptt_pressed\",\"organisation_id\":\"{ORG}\",\"pressed\":true,\"now_ms\":5200}}"
            ),
        )
        .unwrap();
    let end_call = bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:42\tupdate_tray_state\n{{\"command\":\"update_tray_state\",\"organisation_id\":\"{ORG}\",\"unread_count\":0,\"call_state\":\"none\",\"muted\":false,\"self_host_degraded\":false}}"
            ),
        )
        .unwrap();
    assert!(end_call
        .eval_scripts
        .iter()
        .any(|s| s.contains("__KODERA_IPC_DISPATCH_EVENT__(11,")
            && s.contains("\\\"transmitting\\\":false")));

    // `hide_window` releases active PTT, emits `kodera://ptt-state`, and marks window unfocused!
    bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:43\tset_ptt_pressed\n{{\"command\":\"set_ptt_pressed\",\"organisation_id\":\"{ORG}\",\"pressed\":true,\"now_ms\":5300}}"
            ),
        )
        .unwrap();
    let hide_out = bridge
        .handle_ipc_request(
            &internal_index,
            &format!("{doc_id}:0:{cap}:44\thide_window\n{{}}"),
        )
        .unwrap();
    assert!(!bridge.is_window_focused());
    assert_eq!(hide_out.window_action, Some(GuiWindowAction::Hide));
    assert!(hide_out
        .eval_scripts
        .iter()
        .any(|s| s.contains("__KODERA_IPC_DISPATCH_EVENT__(11,")
            && s.contains("\\\"transmitting\\\":false")));
    bridge
        .handle_ipc_request(
            &internal_index,
            &format!("{doc_id}:0:{cap}:45\tshow_window\n{{}}"),
        )
        .unwrap();
    assert!(bridge.is_window_focused());

    // Native mute toggle emits `kodera://tray-action` (`toggle_mute`) and updates `get_tray_state`.
    let mute_scripts = bridge.handle_native_mute_toggle();
    assert_eq!(mute_scripts.len(), 1);
    assert!(mute_scripts[0].contains("__KODERA_IPC_DISPATCH_EVENT__(12, \"toggle_mute\")"));

    let tray_out = bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:5\tget_tray_state\n{{\"command\":\"get_tray_state\",\"organisation_id\":\"{ORG}\"}}"
            ),
        )
        .unwrap();
    assert!(tray_out.eval_scripts[0].contains("\"muted\":true"));

    // Configure and read back media capture preferences over WebView IPC.
    let media_cfg = bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:6\tconfigure_media_capture\n{{\"command\":\"configure_media_capture\",\"organisation_id\":\"{ORG}\",\"preferred_surface\":\"window\",\"system_audio_loopback\":true,\"noise_suppression\":true,\"preferred_audio_input_id\":\"mic-01\"}}"
            ),
        )
        .unwrap();
    assert!(media_cfg.eval_scripts[0].contains("\"type\":\"media_capture_state\""));
    assert!(media_cfg.eval_scripts[0].contains("\"preferred_surface\":\"window\""));

    let media_get = bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:7\tget_media_capture_state\n{{\"command\":\"get_media_capture_state\",\"organisation_id\":\"{ORG}\"}}"
            ),
        )
        .unwrap();
    assert!(media_get.eval_scripts[0].contains("\"preferred_audio_input_id\":\"mic-01\""));

    let ptt_get = bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:8\tget_ptt_state\n{{\"command\":\"get_ptt_state\",\"organisation_id\":\"{ORG}\"}}"
            ),
        )
        .unwrap();
    assert!(ptt_get.eval_scripts[0].contains("\"type\":\"ptt_state\""));
    assert!(ptt_get.eval_scripts[0].contains("\"transmitting\":false"));

    // SPA organisation switch & failed `init_session` isolation:
    // 0. Invalid/rejected requests (both schema AND domain-semantic errors!) carrying Org B's
    //    `organisation_id` MUST NOT switch or tear down Org A!
    let other_org = "019a5e62-6ca0-7303-8303-030303030399";
    bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:48\tconfigure_ptt\n{{\"command\":\"configure_ptt\",\"organisation_id\":\"{ORG}\",\"opt_in\":true,\"chord\":\"F13\"}}"
            ),
        )
        .unwrap();
    let rejected_org_b_unknown_field = bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:49\tget_ptt_state\n{{\"command\":\"get_ptt_state\",\"organisation_id\":\"{other_org}\",\"unexpected_extra\":1}}"
            ),
        )
        .unwrap();
    assert!(
        rejected_org_b_unknown_field.eval_scripts[0].contains("__KODERA_IPC_RESOLVE__(49, false,")
    );
    assert_eq!(bridge.host.active_organisation_id(), Some(ORG));

    let rejected_org_b_semantic = bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:490\tconfigure_media_capture\n{{\"command\":\"configure_media_capture\",\"organisation_id\":\"{other_org}\",\"preferred_surface\":\"invalid\",\"system_audio_loopback\":false,\"noise_suppression\":true}}"
            ),
        )
        .unwrap();
    assert!(rejected_org_b_semantic.eval_scripts[0].contains("__KODERA_IPC_RESOLVE__(490, false,"));
    assert!(rejected_org_b_semantic.eval_scripts[0]
        .contains("media_capture:invalid_screen_share_surface"));
    assert_eq!(bridge.host.active_organisation_id(), Some(ORG));

    let org_a_ptt_still_intact = bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:491\tget_ptt_state\n{{\"command\":\"get_ptt_state\",\"organisation_id\":\"{ORG}\"}}"
            ),
        )
        .unwrap();
    assert!(org_a_ptt_still_intact.eval_scripts[0].contains("\"F13\""));

    // 1. Activate PTT + unread badge in Org A, then switch to Org B -> clears modifiers & stack dirs,
    //    emits `kodera://ptt-state` (`transmitting: false`), and resets title!
    bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:50\tset_unread_badge\n{{\"command\":\"set_unread_badge\",\"organisation_id\":\"{ORG}\",\"unread_count\":7}}"
            ),
        )
        .unwrap();
    bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:51\tset_ptt_pressed\n{{\"command\":\"set_ptt_pressed\",\"organisation_id\":\"{ORG}\",\"pressed\":true,\"now_ms\":6000}}"
            ),
        )
        .unwrap();
    let switch_to_b = bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:52\tget_ptt_state\n{{\"command\":\"get_ptt_state\",\"organisation_id\":\"{other_org}\"}}"
            ),
        )
        .unwrap();
    assert_eq!(
        switch_to_b.window_action,
        Some(GuiWindowAction::SetTitle(DESKTOP_WINDOW_TITLE.to_owned()))
    );
    assert!(switch_to_b
        .eval_scripts
        .iter()
        .any(|s| s.contains("__KODERA_IPC_DISPATCH_EVENT__(11,")
            && s.contains("\\\"transmitting\\\":false")));
    assert_eq!(bridge.host.active_organisation_id(), Some(other_org));

    // 2. Cross-org `authorized_stack_dirs` isolation: Org A's folder grant MUST be cleared before
    //    `self_host_prepare_community` runs for another organisation (`ORG`), rejecting the call!
    let temp_stack_dir = crate::self_host_deploy::non_shared_test_scratch_root()
        .join(format!("kodera-ipc-cross-org-stack-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&temp_stack_dir);
    std::fs::create_dir_all(&temp_stack_dir).unwrap();
    std::fs::write(
        temp_stack_dir.join("docker-compose.yml"),
        "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2233efd22d166e1e5f7\n",
    )
    .unwrap();
    let canonical_stack = bridge
        .authorize_community_stack_dir(&temp_stack_dir)
        .unwrap();
    assert_eq!(bridge.authorized_stack_dirs.len(), 1);
    let canonical_escaped = super::escape_js_json_str(&canonical_stack.to_string_lossy());
    let cross_org_prepare = bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:525\tself_host_prepare_community\n{{\"command\":\"self_host_prepare_community\",\"organisation_id\":\"{ORG}\",\"stack_dir\":\"{canonical_escaped}\",\"domain\":\"chat.example.org\",\"acme_email\":\"ops@example.org\",\"oidc_provider_origin\":\"https://auth.example.org\",\"tls_mode\":\"acme\",\"http_port\":80,\"https_port\":443}}"
            ),
        )
        .unwrap();
    assert!(cross_org_prepare
        .eval_scripts
        .iter()
        .any(|s| s.contains("community_deploy:stack_dir_not_authorized")));
    assert!(bridge.authorized_stack_dirs.is_empty());
    assert!(!temp_stack_dir.join(".env").exists());
    let _ = std::fs::remove_dir_all(&temp_stack_dir);

    // 3. Failed `init_session` tears down active session BEFORE validation so previous org never remains active!
    let failed_init = bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:53\tinit_session\n{{\"organisation_id\":\"not-a-valid-uuid\"}}"
            ),
        )
        .unwrap();
    assert!(failed_init.eval_scripts[0].contains("__KODERA_IPC_RESOLVE__(53, false,"));
    assert!(!bridge.host.has_active_session());
    assert!(bridge.authorized_stack_dirs.is_empty());

    // 4. Late cleanup `set_ptt_pressed(false)` for an inactive/prior org is an idempotent no-op:
    //    it neither provisions a session when none is active nor wipes Org B's `Ctrl+Space` binding!
    let no_session_release = bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:54\tset_ptt_pressed\n{{\"command\":\"set_ptt_pressed\",\"organisation_id\":\"{ORG}\",\"pressed\":false,\"now_ms\":7000}}"
            ),
        )
        .unwrap();
    assert!(no_session_release.eval_scripts[0].contains("__KODERA_IPC_RESOLVE__(54, true,"));
    assert!(!bridge.host.has_active_session());

    bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:55\tconfigure_ptt\n{{\"command\":\"configure_ptt\",\"organisation_id\":\"{other_org}\",\"opt_in\":true,\"chord\":\"Ctrl+Space\"}}"
            ),
        )
        .unwrap();
    assert_eq!(bridge.host.active_organisation_id(), Some(other_org));

    let stale_org_a_release = bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:56\tset_ptt_pressed\n{{\"command\":\"set_ptt_pressed\",\"organisation_id\":\"{ORG}\",\"pressed\":false,\"now_ms\":7100}}"
            ),
        )
        .unwrap();
    assert!(stale_org_a_release.eval_scripts[0].contains("__KODERA_IPC_RESOLVE__(56, true,"));
    assert_eq!(bridge.host.active_organisation_id(), Some(other_org));

    let org_b_ptt = bridge
        .handle_ipc_request(
            &internal_index,
            &format!(
                "{doc_id}:0:{cap}:57\tget_ptt_state\n{{\"command\":\"get_ptt_state\",\"organisation_id\":\"{other_org}\"}}"
            ),
        )
        .unwrap();
    assert!(org_b_ptt.eval_scripts[0].contains("\"Ctrl+Space\""));
}

#[cfg(feature = "desktop-app")]
#[test]
fn tao_keycode_and_modifier_mapping_covers_ptt_chords_and_rejects_reserved_keys() {
    use tao::keyboard::{KeyCode, ModifiersState};

    let mods = super::native_runtime::modifiers_from_tao(
        ModifiersState::CONTROL | ModifiersState::SHIFT | ModifiersState::ALT,
    );
    assert!(mods.contains(&crate::PttModifier::Ctrl));
    assert!(mods.contains(&crate::PttModifier::Shift));
    assert!(mods.contains(&crate::PttModifier::Alt));
    assert!(!mods.contains(&crate::PttModifier::Super));

    assert_eq!(
        super::native_runtime::trigger_key_from_tao(KeyCode::Space),
        Some(crate::PttTriggerKey::Space)
    );
    assert_eq!(
        super::native_runtime::trigger_key_from_tao(KeyCode::F13),
        Some(crate::PttTriggerKey::Function(13))
    );
    assert_eq!(
        super::native_runtime::trigger_key_from_tao(KeyCode::KeyZ),
        Some(crate::PttTriggerKey::Letter('Z'))
    );
    assert_eq!(
        super::native_runtime::trigger_key_from_tao(KeyCode::Escape),
        None
    );
    assert_eq!(
        super::native_runtime::trigger_key_from_tao(KeyCode::Enter),
        None
    );
}

// Native authentication fixtures use loopback sockets and isolated in-memory keychains only.
mod native_auth {
    use super::*;
    use crate::{KeychainCredentialStore, KeychainSecretKind, OidcIssuerAllowlist};
    use serde_json::{json, Value};
    use std::collections::BTreeMap;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::sync::{Arc, Mutex};
    use zeroize::Zeroizing;

    type HttpHandler = dyn Fn(&str, &str) -> Result<NativeOidcHttpResponse, String> + Send + Sync;
    struct Http(Arc<HttpHandler>);
    impl NativeOidcHttpClient for Http {
        fn post_form(&self, url: &str, body: &str) -> Result<NativeOidcHttpResponse, String> {
            (self.0)(url, body)
        }
    }
    type BrowserHandler = dyn Fn(&str) -> Result<(), String> + Send + Sync;
    struct Browser(Arc<BrowserHandler>);
    impl NativeBrowserLauncher for Browser {
        fn open(&self, url: &str) -> Result<Arc<std::sync::atomic::AtomicBool>, String> {
            (self.0)(url)?;
            Ok(Arc::new(std::sync::atomic::AtomicBool::new(false)))
        }
    }
    fn decode(raw: &str) -> String {
        let mut bytes = Vec::new();
        let mut iter = raw.bytes();
        while let Some(b) = iter.next() {
            if b == b'%' {
                let hi = char::from(iter.next().unwrap()).to_digit(16).unwrap();
                let lo = char::from(iter.next().unwrap()).to_digit(16).unwrap();
                bytes.push((hi * 16 + lo) as u8);
            } else {
                bytes.push(b);
            }
        }
        String::from_utf8(bytes).unwrap()
    }
    fn query(raw: &str) -> BTreeMap<String, String> {
        raw.split('&')
            .map(|p| {
                let (k, v) = p.split_once('=').unwrap();
                (decode(k), decode(v))
            })
            .collect()
    }
    fn jwt(claims: Value) -> String {
        format!(
            "e30.{}.c2ln",
            super::super::super::desktop_oidc::base64url(claims.to_string().as_bytes())
        )
    }
    fn response(status: u16, body: Value) -> NativeOidcHttpResponse {
        NativeOidcHttpResponse {
            status,
            body: Zeroizing::new(body.to_string().into_bytes()),
        }
    }
    fn args(command: &str) -> Value {
        json!({"command":command,"issuer_origin":"https://auth.kodera.io","realm":"community","client_id":"kodera-desktop"})
    }
    fn envelope(command: &str, body: Value) -> String {
        format!(
            "{}:0:{}:1\t{command}\n{body}",
            "a".repeat(32),
            "c".repeat(64)
        )
    }
    fn invoke(bridge: &mut DesktopWebViewBridge, command: &str, body: Value) -> WebViewIpcOutcome {
        bridge
            .handle_ipc_request(
                &format!("{INTERNAL_ASSET_ORIGIN}/index.html"),
                &envelope(command, body),
            )
            .unwrap()
    }
    fn payload(out: &WebViewIpcOutcome, ok: bool) -> Value {
        let start = format!("__KODERA_IPC_RESOLVE__(1, {ok}, ");
        let raw = out.eval_scripts[0]
            .split_once(&start)
            .unwrap()
            .1
            .strip_suffix("); }")
            .unwrap();
        serde_json::from_str(raw).unwrap()
    }
    fn setup(
        http: Http,
        browser: Browser,
    ) -> (DesktopWebViewBridge, Arc<Mutex<KeychainCredentialStore>>) {
        let mut bridge = DesktopWebViewBridge::new(true, None);
        bridge.document_capability = Some("c".repeat(64));
        bridge.native_oidc.timeout_ms = 500;
        let keychain = Arc::new(Mutex::new(KeychainCredentialStore::new()));
        bridge.configure_native_oidc(
            Arc::new(http),
            Arc::new(browser),
            keychain.clone(),
            OidcIssuerAllowlist::kodera_default(),
        );
        (bridge, keychain)
    }
    fn stored(store: &Arc<Mutex<KeychainCredentialStore>>) -> Option<String> {
        let (org, user) = super::super::super::desktop_oidc::credential_slot("community");
        store
            .lock()
            .unwrap()
            .load_credential_secret(KeychainSecretKind::OidcRefresh, &org, &user)
            .unwrap()
            .map(|(_, s)| s.expose_for_keychain_write().to_owned())
    }
    fn seed(store: &Arc<Mutex<KeychainCredentialStore>>) {
        let (org, user) = super::super::super::desktop_oidc::credential_slot("community");
        kodera_rs::OrganisationId::parse(&org).unwrap();
        store
            .lock()
            .unwrap()
            .store_credential(
                KeychainSecretKind::OidcRefresh,
                &org,
                &user,
                "kodera-desktop",
                1,
                None,
                "refresh-before-native",
            )
            .unwrap();
    }
    fn unused_browser() -> Browser {
        Browser(Arc::new(|_| panic!("unexpected browser launch")))
    }
    fn unused_http() -> Http {
        Http(Arc::new(|_, _| panic!("unexpected token request")))
    }
    fn callback(uri: String, host: Option<String>) -> std::thread::JoinHandle<String> {
        std::thread::spawn(move || {
            let (authority, path) = uri
                .strip_prefix("http://")
                .unwrap()
                .split_once('/')
                .unwrap();
            let mut stream = TcpStream::connect(authority).unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            let request = format!(
                "GET /{path} HTTP/1.1\r\nHost: {}\r\n\r\n",
                host.as_deref().unwrap_or(authority)
            );
            // Deliberately fragment HTTP headers: TCP reads need not align with requests.
            for chunk in request.as_bytes().chunks(7) {
                stream.write_all(chunk).unwrap();
            }
            let mut reply = String::new();
            let _ = stream.read_to_string(&mut reply);
            reply
        })
    }

    #[test]
    fn exchange_pkce_validates_nonce_and_stores_only_native_refresh_credential() {
        for registration in [false, true] {
            let captured = Arc::new(Mutex::new(BTreeMap::<String, String>::new()));
            let browser_capture = captured.clone();
            let browser = Browser(Arc::new(move |url| {
                assert!(url.starts_with(if registration {
                    "https://auth.kodera.io/realms/community/protocol/openid-connect/registrations?"
                } else {
                    "https://auth.kodera.io/realms/community/protocol/openid-connect/auth?"
                }));
                let q = query(url.split_once('?').unwrap().1);
                assert_eq!(q["scope"], "openid profile email offline_access");
                assert_eq!(q["code_challenge_method"], "S256");
                assert_eq!(q["ui_locales"], "fr");
                assert_eq!(q["prompt"], "login");
                assert_eq!(q["kc_action"], "CONFIGURE_TOTP");
                assert_eq!(q["state"].len(), 43);
                assert_eq!(q["nonce"].len(), 43);
                callback(format!("{}?code=one-use-code&state={}&iss=https%3A%2F%2Fauth.kodera.io%2Frealms%2Fcommunity",q["redirect_uri"],q["state"]),None);
                *browser_capture.lock().unwrap() = q;
                Ok(())
            }));
            let http = Http(Arc::new(move |url, body| {
                assert_eq!(
                    url,
                    "https://auth.kodera.io/realms/community/protocol/openid-connect/token"
                );
                let form = query(body);
                let q = captured.lock().unwrap();
                assert_eq!(form["grant_type"], "authorization_code");
                assert_eq!(form["code"], "one-use-code");
                assert_eq!(form["redirect_uri"], q["redirect_uri"]);
                assert_eq!(form["code_verifier"].len(), 43);
                assert_eq!(
                    crate::pkce_s256_challenge(&form["code_verifier"]).unwrap(),
                    q["code_challenge"]
                );
                Ok(response(
                    200,
                    json!({"access_token":"short-access", "id_token":jwt(json!({"iss":"https://auth.kodera.io/realms/community","sub":"member","aud":"kodera-desktop","exp":4102444800u64,"nonce":q["nonce"],"amr":["pwd","otp"]})),"refresh_token":"native-refresh-only","expires_in":300}),
                ))
            }));
            let (mut bridge, store) = setup(http, browser);
            let mut input = args("desktop_oidc_exchange_loopback");
            input["registration"] = json!(registration);
            input["ui_locales"] = json!("fr");
            input["prompt"] = json!("login");
            input["kc_action"] = json!("CONFIGURE_TOTP");
            let out = invoke(&mut bridge, "desktop_oidc_exchange_loopback", input);
            assert_eq!(out.window_action, Some(GuiWindowAction::ShowAndFocus));
            assert_eq!(
                payload(&out, true),
                json!({"ok":true,"access_token":"short-access","expires_in":300,"realm":"community","issuer":"https://auth.kodera.io/realms/community","subject":"member","amr":["pwd","otp"]})
            );
            assert!(!out.eval_scripts[0].contains("native-refresh-only"));
            assert!(!out.eval_scripts[0].contains("refresh_token"));
            assert_eq!(stored(&store).as_deref(), Some("native-refresh-only"));
        }
    }

    #[test]
    fn exchange_requires_id_token_bound_to_client() {
        for (identity, accepted) in [
            (None, false),
            (Some(json!({})), false),
            (
                Some(json!({"aud":"other-client","azp":"other-client"})),
                false,
            ),
            (Some(json!({"aud":["other-client"]})), false),
            (Some(json!({"aud":["kodera-desktop", 42]})), false),
            (Some(json!({"azp":"kodera-desktop"})), false),
            (Some(json!({"aud":"account","azp":"kodera-desktop"})), false),
            (
                Some(json!({"aud":"kodera-desktop","azp":"other-client"})),
                false,
            ),
            (
                Some(json!({"aud":"kodera-desktop","azp":"kodera-desktop"})),
                true,
            ),
            (Some(json!({"aud":"kodera-desktop"})), true),
            (Some(json!({"aud":["kodera-desktop"]})), true),
            (Some(json!({"aud":"kodera-desktop","exp":null})), false),
            (Some(json!({"aud":"kodera-desktop","exp":0})), false),
            (Some(json!({"aud":"kodera-desktop","exp":"invalid"})), false),
            (
                Some(json!({"aud":["other-client","kodera-desktop"]})),
                false,
            ),
            (
                Some(json!({"aud":"other-client","azp":"kodera-desktop"})),
                false,
            ),
        ] {
            let nonce = Arc::new(Mutex::new(String::new()));
            let browser_nonce = nonce.clone();
            let browser = Browser(Arc::new(move |url| {
                let q = query(url.split_once('?').unwrap().1);
                *browser_nonce.lock().unwrap() = q["nonce"].clone();
                callback(format!("{}?code=single-use&state={}&iss=https%3A%2F%2Fauth.kodera.io%2Frealms%2Fcommunity", q["redirect_uri"], q["state"]), None);
                Ok(())
            }));
            let http = Http(Arc::new(move |_, _| {
                // Even a valid access-token identity cannot replace the interactive ID token.
                let mut body = json!({"access_token":jwt(json!({"iss":"https://auth.kodera.io/realms/community","sub":"member","aud":"kodera-desktop","exp":4102444800u64,"nonce":*nonce.lock().unwrap()})),"refresh_token":"new-native-refresh","expires_in":300});
                if let Some(mut claims) = identity.clone() {
                    if claims.get("exp").is_none() {
                        claims["exp"] = json!(4102444800u64);
                    }
                    claims["iss"] = json!("https://auth.kodera.io/realms/community");
                    claims["sub"] = json!("member");
                    claims["nonce"] = json!(*nonce.lock().unwrap());
                    body["id_token"] = json!(jwt(claims));
                }
                Ok(response(200, body))
            }));
            let (mut bridge, store) = setup(http, browser);
            seed(&store);
            let result = invoke(
                &mut bridge,
                "desktop_oidc_exchange_loopback",
                args("desktop_oidc_exchange_loopback"),
            );
            if accepted {
                assert_eq!(payload(&result, true)["subject"], "member");
                assert_eq!(stored(&store).as_deref(), Some("new-native-refresh"));
            } else {
                assert_eq!(payload(&result, false)["error"], "oidc_invalid_identity");
                assert_eq!(stored(&store).as_deref(), Some("refresh-before-native"));
            }
        }
    }

    #[test]
    fn background_refresh_does_not_cancel_interactive_exchange() {
        for refused in [false, true] {
            let (started_tx, started_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let release_rx = Mutex::new(release_rx);
            let nonce = Arc::new(Mutex::new(String::new()));
            let browser_nonce = nonce.clone();
            let browser = Browser(Arc::new(move |url| {
                let q = query(url.split_once('?').unwrap().1);
                *browser_nonce.lock().unwrap() = q["nonce"].clone();
                callback(format!("{}?code=single-use&state={}&iss=https%3A%2F%2Fauth.kodera.io%2Frealms%2Fcommunity", q["redirect_uri"], q["state"]), None);
                Ok(())
            }));
            let http = Http(Arc::new(move |_, body| {
                if query(body)["grant_type"] == "refresh_token" {
                    return Ok(if refused {
                        response(400, json!({"error":"invalid_grant"}))
                    } else {
                        response(
                            200,
                            json!({"access_token":jwt(json!({"iss":"https://auth.kodera.io/realms/community","sub":"member"})),"refresh_token":"background-refresh","expires_in":300}),
                        )
                    });
                }
                started_tx.send(()).unwrap();
                release_rx.lock().unwrap().recv().unwrap();
                Ok(response(
                    200,
                    json!({"access_token":"interactive-access","id_token":jwt(json!({"iss":"https://auth.kodera.io/realms/community","sub":"member","aud":"kodera-desktop","azp":"kodera-desktop","exp":4102444800u64,"nonce":*nonce.lock().unwrap()})),"refresh_token":"interactive-refresh","expires_in":300}),
                ))
            }));
            let (mut bridge, store) = setup(http, browser);
            seed(&store);
            let mut task = None;
            bridge
                .handle_ipc_request_with_native_dispatch(
                    &format!("{INTERNAL_ASSET_ORIGIN}/index.html"),
                    &envelope(
                        "desktop_oidc_exchange_loopback",
                        args("desktop_oidc_exchange_loopback"),
                    ),
                    |prepared| {
                        task = Some(prepared);
                        WebViewIpcOutcome {
                            eval_scripts: vec![],
                            window_action: None,
                        }
                    },
                )
                .unwrap();
            let revision = bridge
                .native_oidc
                .revision
                .load(std::sync::atomic::Ordering::SeqCst);
            let epoch = bridge
                .native_oidc
                .epoch
                .load(std::sync::atomic::Ordering::SeqCst);
            let worker = std::thread::spawn(move || task.unwrap().run());
            started_rx
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap();
            let result = invoke(
                &mut bridge,
                "desktop_oidc_refresh_session",
                args("desktop_oidc_refresh_session"),
            );
            if refused {
                assert_eq!(
                    payload(&result, false)["error"],
                    "oidc_refused:invalid_grant"
                );
            } else {
                assert_eq!(payload(&result, true)["subject"], "member");
            }
            assert_eq!(
                bridge
                    .native_oidc
                    .revision
                    .load(std::sync::atomic::Ordering::SeqCst),
                revision
            );
            assert_eq!(
                bridge
                    .native_oidc
                    .epoch
                    .load(std::sync::atomic::Ordering::SeqCst),
                epoch
            );
            release_tx.send(()).unwrap();
            assert_eq!(
                payload(&worker.join().unwrap(), true)["access_token"],
                "interactive-access"
            );
            assert_eq!(stored(&store).as_deref(), Some("interactive-refresh"));
        }
    }

    #[test]
    fn refresh_rotates_keychain_and_clear_removes_slot() {
        let http = Http(Arc::new(|_, body| {
            assert_eq!(
                query(body),
                BTreeMap::from([
                    ("client_id".into(), "kodera-desktop".into()),
                    ("grant_type".into(), "refresh_token".into()),
                    ("refresh_token".into(), "refresh-before-native".into())
                ])
            );
            Ok(response(
                200,
                json!({"access_token":jwt(json!({"iss":"https://auth.kodera.io/realms/community","sub":"member"})),"refresh_token":"refresh-after-native","expires_in":300}),
            ))
        }));
        let (mut bridge, store) = setup(http, unused_browser());
        seed(&store);
        let result = invoke(
            &mut bridge,
            "desktop_oidc_refresh_session",
            args("desktop_oidc_refresh_session"),
        );
        assert_eq!(payload(&result, true)["subject"], "member");
        assert!(!result.eval_scripts[0].contains("refresh-after-native"));
        assert_eq!(stored(&store).as_deref(), Some("refresh-after-native"));
        let result = invoke(
            &mut bridge,
            "desktop_oidc_clear_session",
            json!({"realm":"community"}),
        );
        assert_eq!(payload(&result, true), json!({"ok":true}));
        assert_eq!(stored(&store), None);
        let result = invoke(
            &mut bridge,
            "desktop_oidc_refresh_session",
            args("desktop_oidc_refresh_session"),
        );
        assert_eq!(
            payload(&result, false)["error"],
            "oidc_refused:no_refresh_credential"
        );
    }

    #[test]
    fn oauth_refusals_remove_stale_credentials_but_transient_failures_preserve_them() {
        for error in [
            "invalid_grant",
            "unauthorized_client",
            "invalid_client",
            "access_denied",
            "invalid_token",
            "invalid_scope",
            "invalid_request",
            "temporarily_unavailable",
        ] {
            let http = Http(Arc::new(move |_, _| {
                Ok(response(
                    400,
                    json!({"error":error,"error_description":"private-provider-detail"}),
                ))
            }));
            let (mut bridge, store) = setup(http, unused_browser());
            seed(&store);
            let result = invoke(
                &mut bridge,
                "desktop_oidc_refresh_session",
                args("desktop_oidc_refresh_session"),
            );
            let refused = error != "temporarily_unavailable";
            assert_eq!(
                payload(&result, false)["error"],
                if refused {
                    format!("oidc_refused:{error}")
                } else {
                    "oidc_transport".into()
                }
            );
            assert_eq!(stored(&store).is_none(), refused);
            assert!(!result.eval_scripts[0].contains("private-provider-detail"));
        }
    }

    #[test]
    fn refresh_identity_and_secret_bounds_fail_closed_without_rotation() {
        for claims in [
            json!({"iss":"https://evil.example/realms/community","sub":"member"}),
            json!({"iss":"https://auth.kodera.io/realms/community","sub":""}),
            json!({"iss":"https://auth.kodera.io/realms/community","sub":"\n"}),
            json!({"iss":"https://auth.kodera.io/realms/community","sub":"a".repeat(256)}),
        ] {
            let http = Http(Arc::new(move |_, _| {
                Ok(response(
                    200,
                    json!({"access_token":jwt(claims.clone()),"refresh_token":"must-not-store","expires_in":300}),
                ))
            }));
            let (mut bridge, store) = setup(http, unused_browser());
            seed(&store);
            let result = invoke(
                &mut bridge,
                "desktop_oidc_refresh_session",
                args("desktop_oidc_refresh_session"),
            );
            assert_eq!(payload(&result, false)["error"], "oidc_invalid_identity");
            assert_eq!(stored(&store).as_deref(), Some("refresh-before-native"));
        }
        let http = Http(Arc::new(|_, _| {
            Ok(response(
                200,
                json!({"access_token":jwt(json!({"iss":"https://auth.kodera.io/realms/community","sub":"member"})),"refresh_token":"r".repeat(crate::MAX_KEYCHAIN_SECRET_BYTES + 1),"expires_in":300}),
            ))
        }));
        let (mut bridge, store) = setup(http, unused_browser());
        seed(&store);
        let result = invoke(
            &mut bridge,
            "desktop_oidc_refresh_session",
            args("desktop_oidc_refresh_session"),
        );
        assert_eq!(payload(&result, false)["error"], "oidc_invalid_refresh");
        assert_eq!(stored(&store).as_deref(), Some("refresh-before-native"));
    }

    #[test]
    fn matrix_sso_loopback_validates_callback_and_returns_canonical_uri() {
        let reply = Arc::new(Mutex::new(None));
        let capture = reply.clone();
        let browser = Browser(Arc::new(move |url| {
            assert!(url
                .starts_with("https://community.kodera.io/_matrix/client/v3/login/sso/redirect?"));
            let back = query(url.split_once('?').unwrap().1)["redirectUrl"].clone();
            *capture.lock().unwrap() = Some(callback(
                format!("{back}&loginToken=one%2Buse%26token"),
                None,
            ));
            Ok(())
        }));
        let (mut bridge, _) = setup(unused_http(), browser);
        let out = invoke(
            &mut bridge,
            "desktop_matrix_sso_loopback",
            json!({"homeserver_origin":"https://community.kodera.io","state":"0123456789abcdef"}),
        );
        let result = payload(&out, true);
        let uri = result["callback_uri"].as_str().unwrap();
        assert!(uri.starts_with("http://127.0.0.1:"));
        assert!(
            uri.ends_with("/espace/callback?loginToken=one%2Buse%26token&state=0123456789abcdef")
        );
        let response = reply.lock().unwrap().take().unwrap().join().unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("Cache-Control: no-store"));
        assert!(response.contains("Content-Security-Policy: default-src 'none'"));
        assert!(!response.contains("one+use"));
    }

    #[test]
    fn matrix_rejects_host_state_duplicates_and_redirect_parameters() {
        for variant in ["host", "state", "redirect", "duplicate", "control", "path"] {
            let browser = Browser(Arc::new(move |url| {
                let mut back = query(url.split_once('?').unwrap().1)["redirectUrl"].clone();
                match variant {
                    "state" => back = back.replace("0123456789abcdef", "fedcba9876543210"),
                    "redirect" => back.push_str("&redirect_uri=https%3A%2F%2Fevil.example"),
                    "duplicate" => back.push_str("&state=0123456789abcdef"),
                    "path" => back = back.replace("/espace/callback", "/elsewhere"),
                    _ => {}
                }
                back.push_str(if variant == "control" {
                    "&loginToken=bad%0Atoken"
                } else {
                    "&loginToken=single-use"
                });
                callback(
                    back,
                    if variant == "host" {
                        Some("evil.example".into())
                    } else {
                        None
                    },
                );
                Ok(())
            }));
            let (mut bridge, _) = setup(unused_http(), browser);
            let result = invoke(
                &mut bridge,
                "desktop_matrix_sso_loopback",
                json!({"homeserver_origin":"https://team.kodera.io","state":"0123456789abcdef"}),
            );
            assert_eq!(payload(&result, false)["error"], "matrix_invalid_callback");
        }
    }

    #[test]
    fn native_commands_refuse_remote_and_development_origins_before_services_run() {
        let (mut bridge, _) = setup(unused_http(), unused_browser());
        for command in [
            "desktop_matrix_sso_loopback",
            "desktop_oidc_clear_session",
            "desktop_oidc_exchange_loopback",
            "desktop_oidc_refresh_session",
        ] {
            for origin in [
                "https://community.kodera.io/",
                "https://auth.kodera.io/realms/community/",
                "http://localhost:5173/",
                "http://127.0.0.1:5173/",
            ] {
                assert_eq!(
                    bridge.handle_ipc_request(origin, &envelope(command, json!({}))),
                    Err(WebViewIpcError::UntrustedSenderOrigin)
                );
            }
        }
        for (key, value) in [
            ("issuer_origin", "https://evil.example"),
            ("issuer_origin", "http://auth.kodera.io"),
            ("issuer_origin", "javascript:alert(1)"),
            ("issuer_origin", "file:///tmp/registration"),
            ("issuer_origin", "https://user@auth.kodera.io"),
            ("issuer_origin", "https://auth.kodera.io.evil.example"),
            ("issuer_origin", "https://auth.kodera.io/registration"),
            ("issuer_origin", "https://auth.kodera.io?redirect=evil"),
            ("issuer_origin", "not a URL"),
            ("realm", "../community"),
            ("realm", "Community"),
            ("client_id", "bad client"),
            ("prompt", "none"),
            ("kc_action", "other"),
            ("ui_locales", "en&redirect=evil"),
        ] {
            for registration in [false, true] {
                let mut input = args("desktop_oidc_exchange_loopback");
                input[key] = json!(value);
                input["registration"] = json!(registration);
                payload(
                    &invoke(&mut bridge, "desktop_oidc_exchange_loopback", input),
                    false,
                );
            }
        }
        for origin in [
            "http://kodera.io",
            "https://kodera.io.evil.example",
            "https://evil.example",
            "https://kodera.io/path",
            "https://user@kodera.io",
            "https://kodera.io:443",
        ] {
            payload(
                &invoke(
                    &mut bridge,
                    "desktop_matrix_sso_loopback",
                    json!({"homeserver_origin":origin,"state":"0123456789abcdef"}),
                ),
                false,
            );
        }
        for state in ["short", "contains spaces abcdef", "0123456789abcde&"] {
            payload(
                &invoke(
                    &mut bridge,
                    "desktop_matrix_sso_loopback",
                    json!({"homeserver_origin":"https://kodera.io","state":state}),
                ),
                false,
            );
        }
    }

    #[test]
    fn asynchronous_dispatch_happens_only_after_document_capability_validation() {
        let (mut bridge, _) = setup(unused_http(), unused_browser());
        let message = envelope(
            "desktop_oidc_refresh_session",
            args("desktop_oidc_refresh_session"),
        );
        let mut called = false;
        let result = bridge
            .handle_ipc_request_with_native_dispatch(
                &format!("{INTERNAL_ASSET_ORIGIN}/index.html"),
                &message,
                |task| {
                    called = true;
                    match &task {
                        super::super::super::ipc_bridge::NativeIpcTask::Oidc(oidc) => {
                            assert_eq!(oidc.document_id, "a".repeat(32))
                        }
                        _ => panic!("expected an OIDC task"),
                    }
                    WebViewIpcOutcome {
                        eval_scripts: Vec::new(),
                        window_action: None,
                    }
                },
            )
            .unwrap();
        assert!(called);
        assert!(result.eval_scripts.is_empty());
        bridge.begin_document(1);
        assert_eq!(
            bridge.handle_ipc_request_with_native_dispatch(
                &format!("{INTERNAL_ASSET_ORIGIN}/index.html"),
                &message,
                |_| panic!("stale document dispatched")
            ),
            Err(WebViewIpcError::UntrustedSenderOrigin)
        );
    }

    #[test]
    fn retired_and_in_flight_requests_cannot_recreate_cleared_credentials() {
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let http = Http(Arc::new(move |_, _| {
            started_tx.send(()).unwrap();
            release_rx.lock().unwrap().recv().unwrap();
            Ok(response(
                200,
                json!({"access_token":jwt(json!({"iss":"https://auth.kodera.io/realms/community","sub":"member"})), "refresh_token":"late-native-refresh", "expires_in":300}),
            ))
        }));
        let (mut bridge, store) = setup(http, unused_browser());
        seed(&store);
        let mut task = None;
        bridge
            .handle_ipc_request_with_native_dispatch(
                &format!("{INTERNAL_ASSET_ORIGIN}/index.html"),
                &envelope(
                    "desktop_oidc_refresh_session",
                    args("desktop_oidc_refresh_session"),
                ),
                |prepared| {
                    task = Some(prepared);
                    WebViewIpcOutcome {
                        eval_scripts: vec![],
                        window_action: None,
                    }
                },
            )
            .unwrap();
        let worker = std::thread::spawn(move || task.unwrap().run());
        started_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        let result = invoke(
            &mut bridge,
            "desktop_oidc_clear_session",
            json!({"realm":"community"}),
        );
        assert_eq!(payload(&result, true), json!({"ok":true}));
        release_tx.send(()).unwrap();
        assert_eq!(
            payload(&worker.join().unwrap(), false)["error"],
            "oidc_cancelled"
        );
        assert!(stored(&store).is_none());

        let (mut bridge, _) = setup(unused_http(), unused_browser());
        let mut late = None;
        bridge
            .handle_ipc_request_with_native_dispatch(
                &format!("{INTERNAL_ASSET_ORIGIN}/index.html"),
                &envelope(
                    "desktop_oidc_exchange_loopback",
                    args("desktop_oidc_exchange_loopback"),
                ),
                |prepared| {
                    late = Some(prepared);
                    WebViewIpcOutcome {
                        eval_scripts: vec![],
                        window_action: None,
                    }
                },
            )
            .unwrap();
        bridge.begin_document(1);
        assert_eq!(
            payload(&late.unwrap().run(), false)["error"],
            "oidc_cancelled"
        );
    }

    #[test]
    fn exchange_rejects_nonce_state_issuer_and_host_mixups() {
        for variant in ["nonce", "state", "issuer", "host"] {
            let browser = Browser(Arc::new(move |url| {
                let q = query(url.split_once('?').unwrap().1);
                let state = if variant == "state" {
                    "different-state-0000000000"
                } else {
                    &q["state"]
                };
                let issuer = if variant == "issuer" {
                    "https%3A%2F%2Fevil.example%2Frealms%2Fcommunity"
                } else {
                    "https%3A%2F%2Fauth.kodera.io%2Frealms%2Fcommunity"
                };
                callback(
                    format!(
                        "{}?code=single-use&state={state}&iss={issuer}",
                        q["redirect_uri"]
                    ),
                    (variant == "host").then(|| "evil.example".to_owned()),
                );
                Ok(())
            }));
            let http = Http(Arc::new(move |_, _| {
                assert_eq!(variant, "nonce", "invalid callback reached token endpoint");
                Ok(response(
                    200,
                    json!({"access_token":"short-access", "id_token":jwt(json!({"iss":"https://auth.kodera.io/realms/community","sub":"member","aud":"kodera-desktop","exp":4102444800u64,"nonce":"wrong-nonce"})),"refresh_token":"must-not-store-native", "expires_in":300}),
                ))
            }));
            let (mut bridge, store) = setup(http, browser);
            let result = invoke(
                &mut bridge,
                "desktop_oidc_exchange_loopback",
                args("desktop_oidc_exchange_loopback"),
            );
            assert_eq!(
                payload(&result, false)["error"],
                if variant == "nonce" {
                    "oidc_invalid_nonce"
                } else {
                    "oidc_loopback"
                }
            );
            assert!(stored(&store).is_none());
        }
    }

    #[test]
    fn native_issuer_allowlist_is_configurable_and_missing_rotation_preserves_refresh() {
        let http = Http(Arc::new(|url, _| {
            assert_eq!(
                url,
                "https://login.example.test/realms/community/protocol/openid-connect/token"
            );
            Ok(response(
                200,
                json!({"access_token":jwt(json!({"iss":"https://login.example.test/realms/community","sub":"member"})), "expires_in":300}),
            ))
        }));
        let (mut bridge, store) = setup(http, unused_browser());
        seed(&store);
        bridge
            .native_oidc
            .allowlist
            .add_issuer_origin("https://login.example.test")
            .unwrap();
        let mut input = args("desktop_oidc_refresh_session");
        input["issuer_origin"] = json!("https://login.example.test");
        let result = invoke(&mut bridge, "desktop_oidc_refresh_session", input);
        assert_eq!(
            payload(&result, true)["issuer"],
            "https://login.example.test/realms/community"
        );
        assert_eq!(stored(&store).as_deref(), Some("refresh-before-native"));
    }

    #[test]
    fn browser_refusal_and_loopback_timeout_return_closed_errors() {
        let (mut bridge, _) = setup(
            unused_http(),
            Browser(Arc::new(|_| Err("oidc_browser".into()))),
        );
        let result = invoke(
            &mut bridge,
            "desktop_oidc_exchange_loopback",
            args("desktop_oidc_exchange_loopback"),
        );
        assert_eq!(payload(&result, false)["error"], "oidc_browser");
        let (mut bridge, _) = setup(unused_http(), Browser(Arc::new(|_| Ok(()))));
        bridge.native_oidc.timeout_ms = 50;
        let result = invoke(
            &mut bridge,
            "desktop_oidc_exchange_loopback",
            args("desktop_oidc_exchange_loopback"),
        );
        assert_eq!(payload(&result, false)["error"], "oidc_loopback");
        let result = invoke(
            &mut bridge,
            "desktop_matrix_sso_loopback",
            json!({"homeserver_origin":"https://kodera.io","state":"0123456789abcdef"}),
        );
        assert_eq!(payload(&result, false)["error"], "matrix_loopback");
    }

    #[test]
    fn production_services_reject_non_https_urls_before_spawning() {
        for url in [
            "http://auth.kodera.io/",
            "https://auth.kodera.io/\n",
            "https://auth.kodera.io/'",
            "https://auth.kodera.io/\"",
            "https://auth.kodera.io/\\",
            "https://user@auth.kodera.io/",
            "https://auth.kodera.io/é",
        ] {
            assert!(StdBrowserLauncher.open(url).is_err());
            assert!(StdOidcHttpClient.post_form(url, "code=private").is_err());
        }
    }
}

mod native_core_api {
    use super::super::super::desktop_core_api::{
        encode_base64, execute_at_origin, parse_response, CoreRequest, MAX_BODY, MAX_REQUEST_BODY,
    };
    use super::*;
    use serde_json::{json, Value};
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn payload(url: &str) -> Value {
        json!({"command":"desktop_core_api_request", "requestId":"0123456789abcdef0123456789abcdef", "url":url, "method":"GET", "headers":{"Accept":"application/json"}})
    }
    fn valid(value: Value) -> bool {
        serde_json::from_value::<CoreRequest>(value)
            .is_ok_and(|r| r.validate("https://api.kodera.io").is_ok())
    }

    #[test]
    fn request_policy_refuses_untrusted_destinations_and_ambiguous_payloads() {
        assert!(valid(payload("https://api.kodera.io/api/v1/me")));
        for url in [
            "javascript:alert(1)",
            "file:///api/v1/me",
            "http://api.kodera.io/api/v1/me",
            "https://api.kodera.io.evil.test/api/v1/me",
            "https://evil.test/api/v1/me",
            "https://user@api.kodera.io/api/v1/me",
            "https://api.kodera.io:443/api/v1/me",
            "https://api.kodera.io/private",
            "https://api.kodera.io/api",
            "https://api.kodera.io/api/v2/me",
            "https://api.kodera.io/api/private",
            "https://api.kodera.io/api/v1",
            "https://api.kodera.io/api/v1?escape=/me",
            "https://api.kodera.io/api/../admin",
            "https://api.kodera.io/api/%2E%2e/admin",
            "https://api.kodera.io/api/%252e/admin",
            "https://api.kodera.io/api/%2fadmin",
            "https://api.kodera.io/api/\\admin",
            "https://api.kodera.io/api/v1/me#fragment",
            "https://api.kodera.io/api/./admin",
            "http://127.0.0.1:1234/api/v1/me",
            "https://api.kodera.io/api/v1/me\r\nInjected:yes",
        ] {
            assert!(!valid(payload(url)), "{url}");
        }
        for method in ["CONNECT", "TRACE", "get", "POST\r\nHost: evil"] {
            let mut p = payload("https://api.kodera.io/api/v1/me");
            p["method"] = json!(method);
            assert!(!valid(p));
        }
        for key in ["extra", "host_op", "redirect", "origin"] {
            let mut p = payload("https://api.kodera.io/api/v1/me");
            p[key] = json!(true);
            assert!(!valid(p));
        }
        for header in [
            "Origin",
            "Cookie",
            "Host",
            "Referer",
            "Proxy-Authorization",
            "X-Forwarded-For",
            "Content-Length",
        ] {
            let mut p = payload("https://api.kodera.io/api/v1/me");
            p["headers"] = json!({header:"value"});
            assert!(!valid(p));
        }
        for headers in [
            json!({"Accept":"ok\r\nCookie: injected"}),
            json!({"Accept":"a", "accept":"b"}),
            json!({"Authorization":"a".repeat(8193)}),
        ] {
            let mut p = payload("https://api.kodera.io/api/v1/me");
            p["headers"] = headers;
            assert!(!valid(p));
        }
        let mut p = payload("https://api.kodera.io/api/v1/workspaces/self-serve");
        p["method"] = json!("POST");
        p["body"] = json!("x".repeat(MAX_REQUEST_BODY + 1));
        assert!(!valid(p));
    }

    #[test]
    fn command_is_bundled_only_and_scheduled_through_native_worker() {
        let mut bridge = DesktopWebViewBridge::new(true, None);
        bridge.document_capability = Some("c".repeat(64));
        let raw = format!(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0:{}:1\tdesktop_core_api_request\n{}",
            "c".repeat(64),
            payload("https://api.kodera.io/api/v1/me")
        );
        for sender in [
            "https://evil.test/",
            "https://app.kodera.io/",
            "http://localhost:5173/",
            "http://127.0.0.1:5173/",
        ] {
            assert_eq!(
                bridge.handle_ipc_request(sender, &raw),
                Err(WebViewIpcError::UntrustedSenderOrigin)
            );
        }
        let mut scheduled = false;
        bridge
            .handle_ipc_request_with_native_dispatch(
                &format!("{INTERNAL_ASSET_ORIGIN}/"),
                &raw,
                |_| {
                    scheduled = true;
                    WebViewIpcOutcome {
                        eval_scripts: vec![],
                        window_action: None,
                    }
                },
            )
            .unwrap();
        assert!(scheduled);
    }

    fn frame(command: &str, body: &Value) -> String {
        format!(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0:{}:1\t{command}\n{body}",
            "c".repeat(64)
        )
    }

    #[test]
    fn large_envelopes_are_exclusive_to_authenticated_bounded_core_requests() {
        use super::super::super::desktop_core_api::MAX_CORE_ENVELOPE;
        let mut bridge = DesktopWebViewBridge::new(true, None);
        bridge.document_capability = Some("c".repeat(64));
        let mut body = payload("https://api.kodera.io/api/v1/documents");
        body["method"] = json!("PUT");
        body["bodyBase64"] = json!(encode_base64("🦀".repeat(262_144).as_bytes()));
        let raw = frame("desktop_core_api_request", &body);
        assert!(raw.len() > crate::MAX_IPC_COMMAND_BYTES);
        assert!(raw.len() < MAX_CORE_ENVELOPE);
        let origin = format!("{INTERNAL_ASSET_ORIGIN}/");
        let mut scheduled = false;
        bridge
            .handle_ipc_request_with_native_dispatch(&origin, &raw, |_| {
                scheduled = true;
                WebViewIpcOutcome {
                    eval_scripts: vec![],
                    window_action: None,
                }
            })
            .unwrap();
        assert!(scheduled);
        for command in [
            "get_app_metadata",
            "desktop_core_api_abort",
            "desktop_oidc_refresh_session",
        ] {
            assert_eq!(
                bridge.handle_ipc_request(&origin, &frame(command, &body)),
                Err(WebViewIpcError::MessageTooLarge)
            );
        }
        assert_eq!(
            bridge.handle_ipc_request(&origin, &raw.replacen(&"c".repeat(64), &"d".repeat(64), 1)),
            Err(WebViewIpcError::UntrustedSenderOrigin)
        );
        assert_eq!(
            bridge.handle_ipc_request("http://localhost:5173/", &raw),
            Err(WebViewIpcError::UntrustedSenderOrigin)
        );
        assert_eq!(
            bridge.handle_ipc_request(&origin, &(raw + &" ".repeat(MAX_CORE_ENVELOPE))),
            Err(WebViewIpcError::MessageTooLarge)
        );
        body["bodyBase64"] = json!(encode_base64(&vec![0; MAX_REQUEST_BODY + 1]));
        let refused = bridge
            .handle_ipc_request_with_native_dispatch(
                &origin,
                &frame("desktop_core_api_request", &body),
                |task| task.run(),
            )
            .unwrap();
        assert!(refused.eval_scripts[0].contains("core_api_refused"));
        body["bodyBase64"] = json!("");
        body["command"] = json!("get_app_metadata");
        assert_eq!(
            bridge.handle_ipc_request(&origin, &frame("desktop_core_api_request", &body)),
            Err(WebViewIpcError::MalformedEnvelope)
        );
    }

    #[test]
    fn large_frame_ingress_is_bounded_before_queue_cloning_and_releases_on_drop() {
        use super::super::super::ipc_bridge::CoreIngress;
        let ingress = CoreIngress::default();
        let mut body = payload("https://api.kodera.io/api/v1/documents");
        body["bodyBase64"] = json!("a".repeat(32768));
        let raw = frame("desktop_core_api_request", &body);
        let mut permits = Vec::new();
        for _ in 0..8 {
            permits.push(ingress.admit(&raw).unwrap().unwrap());
        }
        assert!(ingress.admit(&raw).is_none());
        assert!(ingress.admit(&frame("get_app_metadata", &body)).is_none());
        assert!(ingress.admit("small").unwrap().is_none());
        drop(permits.pop());
        assert!(ingress.admit(&raw).unwrap().is_some());
        drop(permits);
        assert!(ingress.admit(&raw).unwrap().is_some());
    }

    #[test]
    fn excess_large_ingress_rejects_only_authenticated_current_document_with_tiny_metadata() {
        use super::super::super::ipc_bridge::{busy_core_ingress_metadata, CoreIngress};
        let mut bridge = DesktopWebViewBridge::new(false, None);
        bridge.document_capability = Some("c".repeat(64));
        let origin = format!("{INTERNAL_ASSET_ORIGIN}/");
        let mut body = payload("https://api.kodera.io/api/v1/documents");
        body["bodyBase64"] = json!("a".repeat(1_398_104));
        let raw = frame("desktop_core_api_request", &body);
        let ingress = CoreIngress::default();
        let permits: Vec<_> = (0..8)
            .map(|_| ingress.admit(&raw).unwrap().unwrap())
            .collect();
        assert!(ingress.admit(&raw).is_none());
        let metadata = busy_core_ingress_metadata(&raw).unwrap();
        assert!(metadata.len() <= 258);
        assert!(!metadata.contains("bodyBase64"));
        let outcome = bridge.reject_busy_core_ingress(&origin, &metadata).unwrap();
        assert_eq!(outcome.eval_scripts.len(), 1);
        assert!(outcome.eval_scripts[0].contains("core_api_busy"));
        assert!(outcome.eval_scripts[0].contains("__KODERA_IPC_RESOLVE__(1, false,"));
        for invalid in [
            metadata.replacen(&"c".repeat(64), &"d".repeat(64), 1),
            metadata.replacen(":0:", ":1:", 1),
            metadata.replacen(":1\t", ":0\t", 1),
            metadata.replacen("desktop_core_api_request", "get_app_metadata", 1),
        ] {
            assert!(bridge.reject_busy_core_ingress(&origin, &invalid).is_err());
        }
        bridge.document_id = Some("b".repeat(32));
        assert!(bridge.reject_busy_core_ingress(&origin, &metadata).is_err());
        assert!(bridge
            .reject_busy_core_ingress("https://evil.example/", &metadata)
            .is_err());
        assert!(busy_core_ingress_metadata(&format!("{}\n{}", "x".repeat(257), raw)).is_none());
        assert!(busy_core_ingress_metadata(&frame("get_app_metadata", &body)).is_none());
        drop(permits);
        assert!(ingress.admit(&raw).unwrap().is_some());
    }

    #[test]
    fn body_decoding_occurs_only_on_the_reserved_worker() {
        let mut bridge = DesktopWebViewBridge::new(false, None);
        bridge.document_capability = Some("c".repeat(64));
        let mut body = payload("https://api.kodera.io/api/v1/documents");
        body["method"] = json!("POST");
        body["bodyBase64"] = json!("Zh=="); // Noncanonical bits, caught by worker decode.
        let mut scheduled = false;
        let result = bridge
            .handle_ipc_request_with_native_dispatch(
                &format!("{INTERNAL_ASSET_ORIGIN}/"),
                &frame("desktop_core_api_request", &body),
                |task| {
                    scheduled = true;
                    task.run()
                },
            )
            .unwrap();
        assert!(scheduled);
        assert!(result.eval_scripts[0].contains("core_api_refused"));
    }

    #[test]
    fn sign_out_retires_reserved_core_workers_and_fences_late_replies() {
        let mut bridge = DesktopWebViewBridge::new(false, None);
        bridge.document_capability = Some("c".repeat(64));
        let origin = format!("{INTERNAL_ASSET_ORIGIN}/");
        let mut reserved = None;
        bridge
            .handle_ipc_request_with_native_dispatch(
                &origin,
                &frame(
                    "desktop_core_api_request",
                    &payload("https://api.kodera.io/api/v1/me"),
                ),
                |task| {
                    reserved = Some(task);
                    WebViewIpcOutcome {
                        eval_scripts: vec![],
                        window_action: None,
                    }
                },
            )
            .unwrap();
        let epoch = bridge.core_requests.epoch();
        bridge
            .handle_ipc_request_with_native_dispatch(
                &origin,
                &frame(
                    "desktop_oidc_clear_session",
                    &json!({"command":"desktop_oidc_clear_session"}),
                ),
                |_| WebViewIpcOutcome {
                    eval_scripts: vec![],
                    window_action: None,
                },
            )
            .unwrap();
        assert_ne!(epoch, bridge.core_requests.epoch());
        assert!(reserved.unwrap().run().eval_scripts.is_empty());
    }

    #[test]
    fn concurrency_cap_is_native_and_reservations_release_on_worker_spawn_failure() {
        use super::super::super::desktop_core_api::MAX_IN_FLIGHT_CORE_REQUESTS;
        let mut bridge = DesktopWebViewBridge::new(false, None);
        bridge.document_capability = Some("c".repeat(64));
        let origin = format!("{INTERNAL_ASSET_ORIGIN}/");
        let mut tasks = Vec::new();
        for index in 0..MAX_IN_FLIGHT_CORE_REQUESTS {
            let mut body = payload("https://api.kodera.io/api/v1/me");
            body["requestId"] = json!(format!("{index:032x}"));
            bridge
                .handle_ipc_request_with_native_dispatch(
                    &origin,
                    &frame("desktop_core_api_request", &body),
                    |task| {
                        tasks.push(task);
                        WebViewIpcOutcome {
                            eval_scripts: vec![],
                            window_action: None,
                        }
                    },
                )
                .unwrap();
        }
        let request = frame(
            "desktop_core_api_request",
            &payload("https://api.kodera.io/api/v1/me"),
        );
        let busy = bridge
            .handle_ipc_request_with_native_dispatch(&origin, &request, |_| {
                panic!("ninth worker spawned")
            })
            .unwrap();
        assert!(busy.eval_scripts[0].contains("core_api_busy"));
        let failure = tasks.pop().unwrap().spawn_with(
            |_| Err(std::io::Error::other("synthetic thread quota")),
            |_| panic!("failed worker ran"),
        );
        assert!(failure.eval_scripts[0].contains("native_worker_unavailable"));
        let mut scheduled = false;
        bridge
            .handle_ipc_request_with_native_dispatch(&origin, &request, |_| {
                scheduled = true;
                WebViewIpcOutcome {
                    eval_scripts: vec![],
                    window_action: None,
                }
            })
            .unwrap();
        assert!(scheduled);
        bridge.begin_document(1);
        for task in tasks {
            let result = task.run();
            assert!(result.eval_scripts.is_empty());
        }
    }

    #[test]
    fn abort_command_is_strict_bundled_only_and_cancels_reserved_worker() {
        let mut bridge = DesktopWebViewBridge::new(true, None);
        bridge.document_capability = Some("c".repeat(64));
        let body = payload("https://api.kodera.io/api/v1/me");
        let origin = format!("{INTERNAL_ASSET_ORIGIN}/");
        let mut task = None;
        bridge
            .handle_ipc_request_with_native_dispatch(
                &origin,
                &frame("desktop_core_api_request", &body),
                |work| {
                    task = Some(work);
                    WebViewIpcOutcome {
                        eval_scripts: vec![],
                        window_action: None,
                    }
                },
            )
            .unwrap();
        let abort = json!({"command":"desktop_core_api_abort", "requestId":body["requestId"]});
        for sender in [
            "https://evil.test/",
            "http://localhost:5173/",
            "https://app.kodera.io/",
        ] {
            assert_eq!(
                bridge.handle_ipc_request(sender, &frame("desktop_core_api_abort", &abort)),
                Err(WebViewIpcError::UntrustedSenderOrigin)
            );
        }
        for invalid in [
            json!({"command":"desktop_core_api_abort", "requestId":body["requestId"], "extra":true}),
            json!({"command":"desktop_core_api_abort", "requestId":"invalid"}),
        ] {
            assert_eq!(
                bridge.handle_ipc_request(&origin, &frame("desktop_core_api_abort", &invalid)),
                Err(WebViewIpcError::MalformedEnvelope)
            );
        }
        bridge
            .handle_ipc_request(&origin, &frame("desktop_core_api_abort", &abort))
            .unwrap();
        assert!(task.unwrap().run().eval_scripts[0].contains("core_api_aborted"));
    }

    fn round_trip(method: &str, path: &str, body: Option<&str>, status: u16) -> (Value, String) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let n = socket.read(&mut buffer).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(end) = bytes.windows(4).position(|p| p == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length:")
                                .map(|n| n.trim().parse().unwrap())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: 11\r\nX-Request-Id: synthetic-id\r\nSet-Cookie: refused=yes\r\nLocation: http://127.0.0.1:1/private\r\nConnection: close\r\n\r\n{{\"ok\":true}}");
            socket.write_all(response.as_bytes()).unwrap();
            String::from_utf8(bytes).unwrap()
        });
        let mut request = payload(&format!("{origin}{path}"));
        request["method"] = json!(method);
        request["headers"] = json!({"Authorization":"Bearer synthetic", "Content-Type":"application/json", "Idempotency-Key":"synthetic-key"});
        if let Some(body) = body {
            request["body"] = json!(body);
        }
        let result = execute_at_origin(&request.to_string(), &origin);
        let wire = worker.join().unwrap();
        (
            json!({"result":result.as_ref().ok(), "refused":result.is_err()}),
            wire,
        )
    }

    #[test]
    fn get_me_and_post_workspace_round_trip_without_browser_cors_or_ambient_headers() {
        for (method, path, body, status) in [
            ("GET", "/api/v1/me", None, 200),
            (
                "POST",
                "/api/v1/workspaces/self-serve",
                Some("{\"name\":\"Test Studio\"}"),
                201,
            ),
            // A leading @ is data, never curl's file-upload syntax.
            (
                "POST",
                "/api/v1/workspaces/self-serve",
                Some("@/not-a-file\nsecond line"),
                400,
            ),
        ] {
            let (out, wire) = round_trip(method, path, body, status);
            assert_eq!(out["refused"], false);
            assert_eq!(out["result"]["status"], status);
            assert_eq!(
                out["result"]["body_base64"],
                encode_base64(b"{\"ok\":true}")
            );
            assert_eq!(out["result"]["headers"]["x-request-id"], "synthetic-id");
            assert!(out["result"]["headers"].get("set-cookie").is_none());
            assert!(wire.starts_with(&format!("{method} {path} HTTP/")));
            assert!(wire.contains("Authorization: Bearer synthetic"));
            assert!(!wire.to_ascii_lowercase().contains("\r\norigin:"));
            assert!(!wire.to_ascii_lowercase().contains("\r\ncookie:"));
            if let Some(body) = body {
                assert!(wire.ends_with(body));
            }
        }
        assert_eq!(
            round_trip("GET", "/api/v1/me", None, 302).0["refused"],
            true
        );
    }

    #[test]
    fn redirect_never_connects_to_its_location() {
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        let location = format!("http://{}/api/v1/me", destination.local_addr().unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            let mut request = [0; 4096];
            assert!(socket.read(&mut request).unwrap() > 0);
            socket.write_all(format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).unwrap();
        });
        assert!(execute_at_origin(
            &payload(&format!("{origin}/api/v1/me")).to_string(),
            &origin
        )
        .is_err());
        worker.join().unwrap();
        assert_eq!(
            destination.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn admits_only_the_documented_header_set_and_preserves_conditionals() {
        let mut p = payload("https://api.kodera.io/api/v1/me");
        p["headers"] = json!({
            "Authorization":"Bearer synthetic", "Content-Type":"application/json", "Accept":"application/json",
            "Accept-Language":"en", "If-Match":"synthetic-etag", "If-None-Match":"synthetic-other-etag",
            "Idempotency-Key":"synthetic-key", "X-Request-Id":"synthetic-id"
        });
        assert!(valid(p));
        let (head, _) = round_trip("HEAD", "/api/v1/me", None, 200);
        assert_eq!(head["refused"], false);
        assert_eq!(head["result"]["body_base64"], "");
    }

    #[test]
    fn response_bounds_and_redirects_are_fail_closed() {
        for status in [101, 301, 302, 307, 308, 600] {
            assert!(
                parse_response(format!("HTTP/1.1 {status} Test\r\n\r\n").as_bytes(), b"").is_err()
            );
        }
        assert!(parse_response(b"HTTP/1.1 304 Not Modified\r\nETag: abc\r\n\r\n", b"").is_ok());
        assert!(parse_response(
            b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\n\r\n",
            b"{}"
        )
        .is_ok());
        assert!(parse_response(b"HTTP/1.1 200 OK\r\n\r\n", &vec![b'a'; MAX_BODY + 1]).is_err());
        assert!(parse_response(
            format!("HTTP/1.1 200 OK\r\nX-Large: {}\r\n\r\n", "a".repeat(32768)).as_bytes(),
            b""
        )
        .is_err());
    }
}
