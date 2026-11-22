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
