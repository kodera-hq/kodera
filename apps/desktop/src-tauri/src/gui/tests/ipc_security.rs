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
