use super::*;

#[test]
fn webview_ipc_bridge_routes_community_wizard_deploy_lifecycle_without_leaking_secrets() {
    use crate::{CommandExecOutput, CommunityCommandRunner, DockerUnavailableReason};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    struct ScriptedRunner {
        outputs: Mutex<VecDeque<CommandExecOutput>>,
    }

    impl CommunityCommandRunner for ScriptedRunner {
        fn run_argv(
            &self,
            program: &str,
            _args: &[String],
            _working_dir: Option<&Path>,
            _timeout: Duration,
        ) -> Result<CommandExecOutput, DockerUnavailableReason> {
            assert_eq!(program, "docker");
            Ok(self
                .outputs
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(CommandExecOutput {
                    status_code: Some(0),
                    stdout: String::new(),
                    stderr: String::new(),
                    timed_out: false,
                }))
        }

        fn poll_backoff(&self) -> Duration {
            Duration::ZERO
        }
    }

    let scratch = ScopedTempDir::new("wizard-webview-ipc");
    let stack_dir = scratch.path().join("community");
    fs::create_dir_all(&stack_dir).unwrap();
    fs::write(
            stack_dir.join("docker-compose.yml"),
            "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n",
        )
        .unwrap();
    let stack_dir_str = stack_dir.to_str().unwrap();

    let healthy_ps = r#"[
            {"Service":"keycloak","State":"running","Health":"healthy","MemoryMiB":256},
            {"Service":"db","State":"running","Health":"healthy","MemoryMiB":192},
            {"Service":"synapse","State":"running","Health":"healthy","KoderaPolicy":"0.1.4","MemoryMiB":420},
            {"Service":"server","State":"running","Health":"healthy","MemoryMiB":220},
            {"Service":"web","State":"running","Health":"healthy","MemoryMiB":64},
            {"Service":"livekit","State":"running","Health":"healthy","MemoryMiB":128}
        ]"#;

    let resolved_compose_json = r#"{"name":"community","services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7"}}}"#;
    let runner = Arc::new(ScriptedRunner {
        outputs: Mutex::new(VecDeque::from([
            CommandExecOutput {
                status_code: Some(0),
                stdout: "Docker version 28.1.0, build 4d8c241\n".to_owned(),
                stderr: String::new(),
                timed_out: false,
            },
            CommandExecOutput {
                status_code: Some(0),
                stdout: "Docker Compose version v2.36.0\n".to_owned(),
                stderr: String::new(),
                timed_out: false,
            },
            CommandExecOutput {
                status_code: Some(0),
                stdout: resolved_compose_json.to_owned(),
                stderr: String::new(),
                timed_out: false,
            },
            CommandExecOutput {
                status_code: Some(0),
                stdout: resolved_compose_json.to_owned(),
                stderr: String::new(),
                timed_out: false,
            },
            CommandExecOutput {
                status_code: Some(0),
                stdout: String::new(),
                stderr: String::new(),
                timed_out: false,
            },
            CommandExecOutput {
                status_code: Some(0),
                stdout: healthy_ps.to_owned(),
                stderr: String::new(),
                timed_out: false,
            },
        ])),
    });

    struct FixedFolderPicker(PathBuf);
    impl NativeStackFolderPicker for FixedFolderPicker {
        fn pick_community_stack_dir(&self) -> Result<Option<PathBuf>, crate::CommunityDeployError> {
            Ok(Some(self.0.clone()))
        }
    }

    let mut bridge = DesktopWebViewBridge::new(false, None);
    bridge.set_stack_folder_picker(Arc::new(FixedFolderPicker(stack_dir.clone())));
    let internal_self_host = format!("{INTERNAL_ASSET_ORIGIN}/self-host");
    let doc_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let cap = bridge.document_capability.clone().unwrap();

    // Untrusted, remote web, and auth-realm sender frames are refused before touching disk or session state.
    let untrusted_prepare = format!(
            "{doc_id}:0:{cap}:1\tself_host_prepare_community\n{{\"command\":\"self_host_prepare_community\",\"organisation_id\":\"{ORG}\",\"stack_dir\":\"{stack_dir_str}\",\"domain\":\"chat.example.org\",\"acme_email\":\"ops@example.org\",\"oidc_provider_origin\":\"https://auth.example.org\",\"tls_mode\":\"acme\",\"http_port\":80,\"https_port\":443}}"
        );
    for refused_sender in [
        "https://evil.example/wizard",
        "https://app.kodera.io/self-host",
        "https://staging.kodera.io/self-host",
        "https://community.kodera.io/self-host",
        "https://auth.kodera.io/realms/kodera-staff/account",
        "http://kodera-asset.localhost/self-host",
    ] {
        assert_eq!(
            bridge.handle_ipc_request(refused_sender, &untrusted_prepare),
            Err(WebViewIpcError::UntrustedSenderOrigin)
        );
    }
    assert!(!stack_dir.join(".env").exists());

    // Initialize session and attach deterministic mock runner.
    let init_msg = format!("{doc_id}:0:{cap}:2\tinit_session\n{{\"organisation_id\":\"{ORG}\"}}");
    let init_out = bridge
        .handle_ipc_request(&internal_self_host, &init_msg)
        .unwrap();
    assert!(init_out.eval_scripts[0].contains("__KODERA_IPC_RESOLVE__(2, true,"));
    assert!(bridge.configure_community_runner(ORG, runner));

    // Before native folder-picker authorization, WebView IPC refuses `stack_dir` without touching disk.
    let unauth_out = bridge
        .handle_ipc_request(&internal_self_host, &untrusted_prepare)
        .unwrap();
    assert!(unauth_out.eval_scripts[0].contains("__KODERA_IPC_RESOLVE__(1, false,"));
    assert!(unauth_out.eval_scripts[0].contains("community_deploy:stack_dir_not_authorized"));
    assert!(!stack_dir.join(".env").exists());

    // Authorize `stack_dir` through the production `select_community_stack_dir` IPC command + native folder picker.
    let select_msg = format!(
            "{doc_id}:0:{cap}:20\tselect_community_stack_dir\n{{\"command\":\"select_community_stack_dir\",\"organisation_id\":\"{ORG}\"}}"
        );
    let select_out = bridge
        .handle_ipc_request(&internal_self_host, &select_msg)
        .unwrap();
    assert!(select_out.eval_scripts[0].contains("__KODERA_IPC_RESOLVE__(20, true,"));
    assert!(select_out.eval_scripts[0].contains(r#""selected":true"#));

    // 1. Preflight
    let preflight_msg = format!(
            "{doc_id}:0:{cap}:3\tself_host_preflight_community\n{{\"command\":\"self_host_preflight_community\",\"organisation_id\":\"{ORG}\",\"stack_dir\":\"{stack_dir_str}\",\"domain\":\"Chat.Example.org\",\"acme_email\":\"ops@example.org\",\"tls_mode\":\"acme\",\"http_port\":80,\"https_port\":443}}"
        );
    let preflight_out = bridge
        .handle_ipc_request(&internal_self_host, &preflight_msg)
        .unwrap();
    assert!(preflight_out.eval_scripts[0].contains("__KODERA_IPC_RESOLVE__(3, true,"));
    assert!(preflight_out.eval_scripts[0].contains(r#""type":"community_preflight""#));
    assert!(preflight_out.eval_scripts[0].contains(r#""normalized_domain":"chat.example.org""#));
    assert!(preflight_out.eval_scripts[0].contains(r#""matrix_base_domain":"example.org""#));

    // 2. Prepare (.env rendered with CSPRNG secrets; zero secret values returned over WebView IPC)
    let prepare_msg = format!(
            "{doc_id}:0:{cap}:4\tself_host_prepare_community\n{{\"command\":\"self_host_prepare_community\",\"organisation_id\":\"{ORG}\",\"stack_dir\":\"{stack_dir_str}\",\"domain\":\"Chat.Example.org\",\"acme_email\":\"ops@example.org\",\"oidc_provider_origin\":\"https://auth.example.org\",\"tls_mode\":\"acme\",\"http_port\":80,\"https_port\":443}}"
        );
    let prepare_out = bridge
        .handle_ipc_request(&internal_self_host, &prepare_msg)
        .unwrap();
    let prepare_js = &prepare_out.eval_scripts[0];
    assert!(prepare_js.contains("__KODERA_IPC_RESOLVE__(4, true,"));
    assert!(prepare_js.contains(r#""type":"community_prepare""#));
    assert!(prepare_js.contains(r#""env_file_written":true"#));
    assert!(prepare_js.contains(r#""compose_config_valid":true"#));

    let env_raw = fs::read_to_string(stack_dir.join(".env")).unwrap();
    for expected_key in [
        "POSTGRES_PASSWORD=",
        "DJANGO_SECRET_KEY=",
        "LIVEKIT_API_SECRET=",
        "KEYCLOAK_ADMIN_PASSWORD=",
    ] {
        let generated_val = env_raw
            .lines()
            .find_map(|line| line.strip_prefix(expected_key))
            .expect("expected generated entry in .env");
        assert!(generated_val.len() >= 32);
        assert!(
            !prepare_js.contains(generated_val),
            "WebView IPC reply must never include generated .env value"
        );
    }

    // 3. Deploy & verify readiness
    let deploy_msg = format!(
            "{doc_id}:0:{cap}:5\tself_host_deploy_community\n{{\"command\":\"self_host_deploy_community\",\"organisation_id\":\"{ORG}\",\"stack_dir\":\"{stack_dir_str}\",\"timeout_ms\":5000}}"
        );
    let deploy_out = bridge
        .handle_ipc_request(&internal_self_host, &deploy_msg)
        .unwrap();
    let deploy_js = &deploy_out.eval_scripts[0];
    assert!(deploy_js.contains("__KODERA_IPC_RESOLVE__(5, true,"));
    assert!(deploy_js.contains(r#""type":"community_deploy""#));
    assert!(deploy_js.contains(r#""stack_healthy":true"#));
    assert!(deploy_js.contains(r#""state":"healthy""#));
}

#[test]
fn departing_same_origin_document_envelope_after_navigation_cannot_invoke_community_deploy_or_resolve(
) {
    use crate::{CommandExecOutput, CommunityCommandRunner, DockerUnavailableReason};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::Duration;

    struct CountingRunner {
        invocations: AtomicUsize,
    }

    impl CommunityCommandRunner for CountingRunner {
        fn run_argv(
            &self,
            program: &str,
            _args: &[String],
            _working_dir: Option<&Path>,
            _timeout: Duration,
        ) -> Result<CommandExecOutput, DockerUnavailableReason> {
            assert_eq!(program, "docker");
            self.invocations.fetch_add(1, Ordering::SeqCst);
            Ok(CommandExecOutput {
                    status_code: Some(0),
                    stdout: r#"{"name":"community","services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7"}}}"#.to_owned(),
                    stderr: String::new(),
                    timed_out: false,
                })
        }

        fn poll_backoff(&self) -> Duration {
            Duration::ZERO
        }
    }

    let scratch = ScopedTempDir::new("departing-doc-community");
    let stack_dir = scratch.path().join("community");
    fs::create_dir_all(&stack_dir).unwrap();
    fs::write(
            stack_dir.join("docker-compose.yml"),
            "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n",
        )
        .unwrap();
    let stack_dir_str = stack_dir.to_str().unwrap();

    let mut bridge = DesktopWebViewBridge::new(false, None);
    let internal_self_host = format!("{INTERNAL_ASSET_ORIGIN}/self-host");
    bridge.begin_document(1);
    let old_doc = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let old_cap = bridge.document_capability.clone().unwrap();

    // Departing Document A initializes its session and folder grant on bundled internal asset origin.
    let init_old =
        format!("{old_doc}:1:{old_cap}:1\tinit_session\n{{\"organisation_id\":\"{ORG}\"}}");
    bridge
        .handle_ipc_request(&internal_self_host, &init_old)
        .unwrap();
    bridge.authorize_community_stack_dir(&stack_dir).unwrap();

    // Envelopes prepared by Document A before navigation (including a forged/sampled gen=2 case).
    let stale_prepare_gen1 = format!(
            "{old_doc}:1:{old_cap}:2\tself_host_prepare_community\n{{\"command\":\"self_host_prepare_community\",\"organisation_id\":\"{ORG}\",\"stack_dir\":\"{stack_dir_str}\",\"domain\":\"chat.example.org\",\"acme_email\":\"ops@example.org\",\"oidc_provider_origin\":\"https://auth.example.org\",\"tls_mode\":\"acme\",\"http_port\":80,\"https_port\":443}}"
        );
    let stale_prepare_gen2 = format!(
            "{old_doc}:2:{old_cap}:2\tself_host_prepare_community\n{{\"command\":\"self_host_prepare_community\",\"organisation_id\":\"{ORG}\",\"stack_dir\":\"{stack_dir_str}\",\"domain\":\"chat.example.org\",\"acme_email\":\"ops@example.org\",\"oidc_provider_origin\":\"https://auth.example.org\",\"tls_mode\":\"acme\",\"http_port\":80,\"https_port\":443}}"
        );
    let stale_deploy_gen2 = format!(
            "{old_doc}:2:{old_cap}:3\tself_host_deploy_community\n{{\"command\":\"self_host_deploy_community\",\"organisation_id\":\"{ORG}\",\"stack_dir\":\"{stack_dir_str}\",\"timeout_ms\":5000}}"
        );

    // Same-origin reload/navigation advances to generation 2, rotates the 256-bit capability,
    // and clears Document A's authorized_stack_dirs!
    bridge.begin_document(2);
    assert!(bridge.authorized_stack_dirs.is_empty());
    let new_doc = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let new_cap = bridge.document_capability.clone().unwrap();
    assert_ne!(new_cap, old_cap);

    // Late delivery from Document A BEFORE Document B binds `document_id` must be refused with zero side effects.
    for late_msg in [&stale_prepare_gen1, &stale_prepare_gen2, &stale_deploy_gen2] {
        assert_eq!(
            bridge.handle_ipc_request(&internal_self_host, late_msg),
            Err(WebViewIpcError::UntrustedSenderOrigin)
        );
    }
    assert!(bridge.document_id.is_none());
    assert!(!stack_dir.join(".env").exists());

    // Document B activates on the internal asset origin and provisions an active session + runner + grant.
    let hello_new = bridge
        .handle_ipc_request(
            &internal_self_host,
            &format!("{new_doc}:hello\t__document_generation\n{{}}"),
        )
        .unwrap();
    assert!(hello_new.eval_scripts[0].contains(&format!(
        "if (window.__KODERA_DOCUMENT_ID__ === \"{new_doc}\")"
    )));
    let init_new =
        format!("{new_doc}:2:{new_cap}:1\tinit_session\n{{\"organisation_id\":\"{ORG}\"}}");
    bridge
        .handle_ipc_request(&internal_self_host, &init_new)
        .unwrap();
    let counting_runner = Arc::new(CountingRunner {
        invocations: AtomicUsize::new(0),
    });
    assert!(bridge.configure_community_runner(ORG, counting_runner.clone()));
    bridge.authorize_community_stack_dir(&stack_dir).unwrap();

    // Late delivery from Document A AFTER Document B's session is live must STILL be refused without running docker or writing .env.
    for late_msg in [&stale_prepare_gen1, &stale_prepare_gen2, &stale_deploy_gen2] {
        assert_eq!(
            bridge.handle_ipc_request(&internal_self_host, late_msg),
            Err(WebViewIpcError::UntrustedSenderOrigin)
        );
    }
    assert_eq!(counting_runner.invocations.load(Ordering::SeqCst), 0);
    assert!(!stack_dir.join(".env").exists());

    // Document B's own `self_host_prepare_community` succeeds and scopes its reply strictly to `new_doc`.
    let valid_prepare = format!(
            "{new_doc}:2:{new_cap}:2\tself_host_prepare_community\n{{\"command\":\"self_host_prepare_community\",\"organisation_id\":\"{ORG}\",\"stack_dir\":\"{stack_dir_str}\",\"domain\":\"chat.example.org\",\"acme_email\":\"ops@example.org\",\"oidc_provider_origin\":\"https://auth.example.org\",\"tls_mode\":\"acme\",\"http_port\":80,\"https_port\":443}}"
        );
    let valid_out = bridge
        .handle_ipc_request(&internal_self_host, &valid_prepare)
        .unwrap();
    assert_eq!(counting_runner.invocations.load(Ordering::SeqCst), 1);
    assert!(stack_dir.join(".env").exists());
    assert!(valid_out.eval_scripts[0].starts_with(&format!(
        "if (window.__KODERA_DOCUMENT_ID__ === \"{new_doc}\") {{"
    )));
    assert!(!valid_out.eval_scripts[0].contains(old_doc));
}

#[test]
fn webview_ipc_enforces_command_acl_envelope_body_consistency_and_preserves_existing_dotenv() {
    verify_embedded_default_capability().unwrap();

    let scratch = ScopedTempDir::new("ipc-acl-and-envelope");
    let stack_dir = scratch.path().join("community");
    fs::create_dir_all(&stack_dir).unwrap();
    fs::write(
            stack_dir.join("docker-compose.yml"),
            "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n",
        )
        .unwrap();
    let sentinel_env = "POSTGRES_PASSWORD=non_kodera_existing_operator_secret\n";
    fs::write(stack_dir.join(".env"), sentinel_env).unwrap();
    let stack_dir_str = stack_dir.to_str().unwrap();

    let mut bridge = DesktopWebViewBridge::new(true, None);
    let internal_origin = format!("{INTERNAL_ASSET_ORIGIN}/index.html");
    let doc_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let cap = bridge.document_capability.clone().unwrap();

    // (a) Remote web origins (`staging.kodera.io`, `community.kodera.io`, `app.kodera.io`)
    // and local Vite dev origin are denied privileged host commands (remote origins are denied all commands).
    for remote_sender in [
        "https://staging.kodera.io/",
        "https://community.kodera.io/",
        "https://app.kodera.io/",
    ] {
        for cmd in [
            "self_host_prepare_community",
            "self_host_deploy_community",
            "store_keychain_credential",
            "delete_keychain_credential",
            "restart_to_update",
            "get_app_metadata",
        ] {
            let msg = format!("{doc_id}:0:{cap}:1\t{cmd}\n{{\"command\":\"{cmd}\"}}");
            assert_eq!(
                bridge.handle_ipc_request(remote_sender, &msg),
                Err(WebViewIpcError::UntrustedSenderOrigin),
                "remote sender {remote_sender} must be refused for {cmd}"
            );
        }
    }
    for dev_privileged in [
        "begin_oidc_pkce_loopback",
        "complete_oidc_pkce_callback",
        "self_host_prepare_community",
        "self_host_deploy_community",
        "store_keychain_credential",
        "load_keychain_credential",
        "delete_keychain_credential",
        "restart_to_update",
    ] {
        let msg =
            format!("{doc_id}:0:{cap}:1\t{dev_privileged}\n{{\"command\":\"{dev_privileged}\"}}");
        assert_eq!(
            bridge.handle_ipc_request("http://localhost:5173/", &msg),
            Err(WebViewIpcError::UntrustedSenderOrigin),
            "dev loopback must be refused privileged command {dev_privileged}"
        );
    }

    // (b) Header `cmd_raw` mismatch against `json_body.command` or `host_op` smuggling -> MalformedEnvelope.
    let mismatched = format!(
            "{doc_id}:0:{cap}:2\tset_unread_badge\n{{\"command\":\"self_host_prepare_community\",\"organisation_id\":\"{ORG}\",\"stack_dir\":\"{stack_dir_str}\"}}"
        );
    assert_eq!(
        bridge.handle_ipc_request(&internal_origin, &mismatched),
        Err(WebViewIpcError::MalformedEnvelope)
    );
    let smuggled_host_op = format!(
            "{doc_id}:0:{cap}:3\tset_unread_badge\n{{\"host_op\":\"init_session\",\"organisation_id\":\"{ORG}\"}}"
        );
    assert_eq!(
        bridge.handle_ipc_request(&internal_origin, &smuggled_host_op),
        Err(WebViewIpcError::MalformedEnvelope)
    );
    let missing_body_cmd = format!(
            "{doc_id}:0:{cap}:4\tset_unread_badge\n{{\"organisation_id\":\"{ORG}\",\"unread_count\":1}}"
        );
    assert_eq!(
        bridge.handle_ipc_request(&internal_origin, &missing_body_cmd),
        Err(WebViewIpcError::MalformedEnvelope)
    );

    // (c) Unauthorized `stack_dir` is refused, and once authorized, pre-existing `.env` is preserved intact.
    let prep_msg = format!(
            "{doc_id}:0:{cap}:5\tself_host_prepare_community\n{{\"command\":\"self_host_prepare_community\",\"organisation_id\":\"{ORG}\",\"stack_dir\":\"{stack_dir_str}\",\"domain\":\"chat.example.org\",\"acme_email\":\"ops@example.org\",\"oidc_provider_origin\":\"https://auth.example.org\",\"tls_mode\":\"acme\",\"http_port\":80,\"https_port\":443}}"
        );
    let unauth_out = bridge
        .handle_ipc_request(&internal_origin, &prep_msg)
        .unwrap();
    assert!(unauth_out.eval_scripts[0].contains("community_deploy:stack_dir_not_authorized"));
    assert_eq!(
        fs::read_to_string(stack_dir.join(".env")).unwrap(),
        sentinel_env
    );

    bridge.authorize_community_stack_dir(&stack_dir).unwrap();
    let existing_env_out = bridge
        .handle_ipc_request(&internal_origin, &prep_msg)
        .unwrap();
    assert!(existing_env_out.eval_scripts[0].contains("community_deploy:env_already_exists"));
    assert_eq!(
        fs::read_to_string(stack_dir.join(".env")).unwrap(),
        sentinel_env
    );
}

#[test]
fn select_community_stack_dir_enforces_native_picker_flow_and_ipc_envelope_skips_secret_copies() {
    use std::sync::{Arc, Mutex};

    struct QueuedFolderPicker {
        outcomes: Mutex<VecDeque<Result<Option<PathBuf>, crate::CommunityDeployError>>>,
    }

    impl NativeStackFolderPicker for QueuedFolderPicker {
        fn pick_community_stack_dir(&self) -> Result<Option<PathBuf>, crate::CommunityDeployError> {
            self.outcomes
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Ok(None))
        }
    }

    let scratch = ScopedTempDir::new("native-picker-and-envelope");
    let valid_stack = scratch.path().join("community-valid");
    fs::create_dir_all(&valid_stack).unwrap();
    fs::write(
            valid_stack.join("docker-compose.yml"),
            "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n",
        )
        .unwrap();
    let invalid_stack = scratch.path().join("community-missing-compose");
    fs::create_dir_all(&invalid_stack).unwrap();

    let picker = Arc::new(QueuedFolderPicker {
        outcomes: Mutex::new(VecDeque::from([
            Ok(None),
            Ok(Some(invalid_stack)),
            Ok(Some(valid_stack.clone())),
        ])),
    });

    let mut bridge = DesktopWebViewBridge::new(true, None);
    bridge.set_stack_folder_picker(picker);
    let internal_origin = format!("{INTERNAL_ASSET_ORIGIN}/self-host");
    let doc_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let cap = bridge.document_capability.clone().unwrap();

    // Remote and dev origins cannot invoke `select_community_stack_dir`.
    let select_req = format!(
            "{doc_id}:0:{cap}:1\tselect_community_stack_dir\n{{\"command\":\"select_community_stack_dir\",\"organisation_id\":\"{ORG}\"}}"
        );
    for untrusted in ["https://community.kodera.io/", "http://localhost:5173/"] {
        assert_eq!(
            bridge.handle_ipc_request(untrusted, &select_req),
            Err(WebViewIpcError::UntrustedSenderOrigin)
        );
    }

    // Caller-supplied `stack_dir` on `select_community_stack_dir` is rejected as MalformedEnvelope.
    let smuggled_path_req = format!(
            "{doc_id}:0:{cap}:2\tselect_community_stack_dir\n{{\"command\":\"select_community_stack_dir\",\"organisation_id\":\"{ORG}\",\"stack_dir\":\"/tmp\"}}"
        );
    assert_eq!(
        bridge.handle_ipc_request(&internal_origin, &smuggled_path_req),
        Err(WebViewIpcError::MalformedEnvelope)
    );

    // 1. User cancels native folder dialog -> selected:false, authorized_stack_dirs remains empty.
    let cancel_out = bridge
        .handle_ipc_request(&internal_origin, &select_req)
        .unwrap();
    assert!(cancel_out.eval_scripts[0].contains("__KODERA_IPC_RESOLVE__(1, true,"));
    assert!(cancel_out.eval_scripts[0].contains(r#""selected":false"#));
    assert!(bridge.authorized_stack_dirs.is_empty());

    // 2. User picks a folder without valid `docker-compose.yml` -> error returned, nothing authorized.
    let missing_compose_req = format!(
            "{doc_id}:0:{cap}:3\tselect_community_stack_dir\n{{\"command\":\"select_community_stack_dir\",\"organisation_id\":\"{ORG}\"}}"
        );
    let invalid_out = bridge
        .handle_ipc_request(&internal_origin, &missing_compose_req)
        .unwrap();
    assert!(invalid_out.eval_scripts[0].contains("__KODERA_IPC_RESOLVE__(3, false,"));
    assert!(invalid_out.eval_scripts[0].contains("community_deploy:compose_file_missing"));
    assert!(bridge.authorized_stack_dirs.is_empty());

    // 3. User picks a valid stack directory -> canonical path authorized and returned.
    let valid_req = format!(
            "{doc_id}:0:{cap}:4\tselect_community_stack_dir\n{{\"command\":\"select_community_stack_dir\",\"organisation_id\":\"{ORG}\"}}"
        );
    let valid_out = bridge
        .handle_ipc_request(&internal_origin, &valid_req)
        .unwrap();
    assert!(valid_out.eval_scripts[0].contains("__KODERA_IPC_RESOLVE__(4, true,"));
    assert!(valid_out.eval_scripts[0].contains(r#""selected":true"#));
    assert_eq!(bridge.authorized_stack_dirs.len(), 1);

    // 4. Verify `IpcEnvelopeHeader` skips `raw_token`/`raw_secret` via `IgnoredAny` without
    // materializing them on the header struct and still rejects `host_op: null` / `op: null`.
    let parsed_secret_env: IpcEnvelopeHeader = serde_json::from_str(
            r#"{"command":"plan_self_host","organisation_id":"0195f18e-52f5-7a1c-b411-94cf2ab35210","raw_token":"scw-secret-token-alpha-bravo-0001","raw_secret":"matrix-session-secret-0001"}"#,
        )
        .unwrap();
    assert_eq!(parsed_secret_env.command.as_deref(), Some("plan_self_host"));
    assert!(parsed_secret_env.host_op.is_none());
    assert!(parsed_secret_env.op.is_none());
    assert!(parsed_secret_env.stack_dir.is_none());

    let parsed_null_host_op: IpcEnvelopeHeader =
        serde_json::from_str(r#"{"command":"set_unread_badge","host_op":null}"#).unwrap();
    assert!(parsed_null_host_op.host_op.is_some());
    let null_host_op_msg = format!(
            "{doc_id}:0:{cap}:5\tset_unread_badge\n{{\"command\":\"set_unread_badge\",\"host_op\":null}}"
        );
    assert_eq!(
        bridge.handle_ipc_request(&internal_origin, &null_host_op_msg),
        Err(WebViewIpcError::MalformedEnvelope)
    );
}

#[test]
fn compact_900x600_display_clamps_effective_gui_min_inner_size() {
    let compact = MonitorWorkArea {
        id: "compact-900x600".to_owned(),
        x: 0,
        y: 0,
        width: 900,
        height: 600,
        scale_factor_milli: 2000,
        is_primary: true,
    };
    let compact_placement =
        crate::sanitize_and_clamp_window_state(None, std::slice::from_ref(&compact)).unwrap();
    assert_eq!(compact_placement.bounds.width, 900);
    assert_eq!(compact_placement.bounds.height, 600);
    assert_eq!(
        effective_gui_min_inner_size(&compact_placement, std::slice::from_ref(&compact)),
        (900, 600)
    );

    let standard = MonitorWorkArea::fallback_primary();
    let standard_placement =
        crate::sanitize_and_clamp_window_state(None, std::slice::from_ref(&standard)).unwrap();
    assert_eq!(standard_placement.bounds.width, GUI_DEFAULT_WIDTH);
    assert_eq!(standard_placement.bounds.height, GUI_DEFAULT_HEIGHT);
    assert_eq!(
        effective_gui_min_inner_size(&standard_placement, std::slice::from_ref(&standard)),
        (GUI_MIN_WIDTH, GUI_MIN_HEIGHT)
    );
}

#[cfg(feature = "desktop-app")]
#[test]
fn window_builder_clamps_min_inner_size_on_compact_900x600_display() {
    use tao::dpi::{LogicalSize, Size};

    let compact = MonitorWorkArea {
        id: "compact-900x600".to_owned(),
        x: 12,
        y: 28,
        width: 900,
        height: 600,
        scale_factor_milli: 2000,
        is_primary: true,
    };
    let compact_placement =
        crate::sanitize_and_clamp_window_state(None, std::slice::from_ref(&compact)).unwrap();
    let compact_builder = super::native_runtime::configure_gui_window_builder(
        &compact_placement,
        std::slice::from_ref(&compact),
    );
    assert_eq!(
        compact_builder.window.inner_size,
        Some(Size::Logical(LogicalSize::new(900.0, 600.0)))
    );
    assert_eq!(
        compact_builder
            .window
            .inner_size_constraints
            .min_size_logical::<u32>(2.0),
        LogicalSize::new(900, 600)
    );
    assert_eq!(
        compact_builder
            .window
            .inner_size_constraints
            .clamp(compact_builder.window.inner_size.unwrap(), 2.0)
            .to_logical::<u32>(2.0),
        LogicalSize::new(900, 600)
    );

    let standard = MonitorWorkArea::fallback_primary();
    let standard_placement =
        crate::sanitize_and_clamp_window_state(None, std::slice::from_ref(&standard)).unwrap();
    let standard_builder = super::native_runtime::configure_gui_window_builder(
        &standard_placement,
        std::slice::from_ref(&standard),
    );
    assert_eq!(
        standard_builder.window.inner_size,
        Some(Size::Logical(LogicalSize::new(1280.0, 820.0)))
    );
    assert_eq!(
        standard_builder
            .window
            .inner_size_constraints
            .min_size_logical::<u32>(1.0),
        LogicalSize::new(960, 640)
    );
}

#[test]
fn release_build_gates_env_overrides_and_excludes_staging_origin() {
    assert_eq!(
        crate::gui::APPROVED_WEB_APP_ORIGINS,
        crate::gui::approved_web_app_origins_for_build(cfg!(debug_assertions))
    );
    let release_origins = crate::gui::approved_web_app_origins_for_build(false);
    assert!(release_origins.contains(&"https://app.kodera.io"));
    assert!(release_origins.contains(&"https://community.kodera.io"));
    assert!(!release_origins.contains(&"https://staging.kodera.io"));

    let scratch = ScopedTempDir::new("release-dist-override");
    let custom_dist = scratch.path().join("custom-dist");
    fs::create_dir_all(&custom_dist).unwrap();
    fs::write(custom_dist.join("index.html"), "<!doctype html>").unwrap();
    assert_eq!(
        crate::gui::discover_frontend_dist_from_context(
            Some(&custom_dist),
            None,
            None,
            None,
            false,
        ),
        None
    );
    assert_eq!(
        crate::gui::discover_frontend_dist_from_context(Some(&custom_dist), None, None, None, true,),
        Some(custom_dist)
    );

    let release_opts = crate::gui::DesktopGuiOptions::from_values(
        None,
        Some("1"),
        Some("http://localhost:5173"),
        None,
        false,
    );
    assert!(!release_opts.allow_dev_origin);
    assert_eq!(release_opts.override_url, None);

    let debug_opts = crate::gui::DesktopGuiOptions::from_values(
        None,
        Some("1"),
        Some("http://localhost:5173"),
        None,
        true,
    );
    assert!(debug_opts.allow_dev_origin);
    assert_eq!(
        debug_opts.override_url.as_deref(),
        Some("http://localhost:5173")
    );
}
