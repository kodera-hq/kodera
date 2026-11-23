use super::*;

#[test]
fn deploy_launches_compose_and_polls_until_keycloak_server_web_and_livekit_are_healthy() {
    let fixture = TempStackFixture::new_with_compose();
    let prep_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_compose_json()]);
    let prep_spec = CommunityPrepareSpec {
        stack_dir: &fixture.path_str(),
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        oidc_provider_origin: "https://id.example.org",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    self_host_prepare_community(&prep_spec, &prep_runner).unwrap();

    let starting_ps = r#"[
            {"Service":"keycloak","State":"running","Health":"starting","MemoryMiB":220},
            {"Service":"db","State":"running","Health":"healthy","MemoryMiB":180},
            {"Service":"synapse","State":"running","Health":"healthy","KoderaPolicy":"0.1.4","MemoryMiB":400},
            {"Service":"server","State":"running","Health":"starting","MemoryMiB":200},
            {"Service":"web","State":"running","Health":"healthy","MemoryMiB":64},
            {"Service":"livekit","State":"running","Health":"healthy","MemoryMiB":120}
        ]"#;

    let deploy_runner = MockDockerRunner::with_responses([
        MockDockerRunner::ok_compose_json(),
        MockDockerRunner::ok_stdout(""),
        MockDockerRunner::ok_stdout(starting_ps),
        MockDockerRunner::ok_stdout(healthy_full_stack_ps_json()),
    ]);

    let report =
        self_host_deploy_community(&fixture.path_str(), Some(30_000), &deploy_runner).unwrap();
    assert!(report.stack_healthy);
    assert_eq!(report.poll_attempts, 2);
    assert!(report.health_report.is_healthy());
    assert_eq!(report.core_services.len(), 4);
    assert!(report
        .core_services
        .iter()
        .all(|s| s.readiness == ServiceReadiness::Ready));

    let calls = deploy_runner.recorded_calls();
    assert_eq!(calls.len(), 4);
    assert_eq!(
        &calls[0].1[5..],
        &[
            "config".to_owned(),
            "--format".to_owned(),
            "json".to_owned()
        ]
    );
    assert_eq!(
        &calls[1].1[5..],
        &["up".to_owned(), "-d".to_owned(), "--wait".to_owned()]
    );
    assert_eq!(
        &calls[2].1[5..],
        &["ps".to_owned(), "--format".to_owned(), "json".to_owned()]
    );
}

#[test]
fn deploy_supports_external_oidc_profile_and_fails_on_unhealthy_or_degraded_services() {
    let fixture = TempStackFixture::new_with_compose();
    let prep_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_compose_json()]);
    let prep_spec = CommunityPrepareSpec {
        stack_dir: &fixture.path_str(),
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        oidc_provider_origin: "https://id.example.org",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    self_host_prepare_community(&prep_spec, &prep_runner).unwrap();

    // External OIDC topology (no local keycloak container, valid https KODERA_OIDC_PROVIDER_ORIGIN).
    let external_oidc_ps = r#"[
            {"Service":"db","State":"running","Health":"healthy","MemoryMiB":180},
            {"Service":"synapse","State":"running","Health":"healthy","KoderaPolicy":"0.1.4","MemoryMiB":410},
            {"Service":"server","State":"running","Health":"healthy","MemoryMiB":210},
            {"Service":"web","State":"running","Health":"","MemoryMiB":64},
            {"Service":"livekit","State":"running","Health":"","MemoryMiB":128}
        ]"#;
    let ok_runner = MockDockerRunner::with_responses([
        MockDockerRunner::ok_compose_json(),
        MockDockerRunner::ok_stdout(""),
        MockDockerRunner::ok_stdout(external_oidc_ps),
    ]);
    let ok_report =
        self_host_deploy_community(&fixture.path_str(), Some(10_000), &ok_runner).unwrap();
    assert!(ok_report.stack_healthy);
    assert!(ok_report.core_services[0].external_oidc);

    // Unhealthy Keycloak container fails closed with StackUnhealthy.
    let unhealthy_keycloak_ps = r#"[
            {"Service":"keycloak","State":"running","Health":"unhealthy"},
            {"Service":"db","State":"running","Health":"healthy"},
            {"Service":"synapse","State":"running","Health":"healthy"},
            {"Service":"server","State":"running","Health":"healthy"},
            {"Service":"web","State":"running","Health":"healthy"},
            {"Service":"livekit","State":"running","Health":"healthy"}
        ]"#;
    let bad_kc_runner = MockDockerRunner::with_responses([
        MockDockerRunner::ok_compose_json(),
        MockDockerRunner::ok_stdout(""),
        MockDockerRunner::ok_stdout(unhealthy_keycloak_ps),
    ]);
    assert_eq!(
        self_host_deploy_community(&fixture.path_str(), Some(10_000), &bad_kc_runner),
        Err(CommunityDeployError::StackUnhealthy)
    );

    // Synapse missing KoderaPolicy in self_host_health fails closed with StackUnhealthy.
    let degraded_policy_ps = r#"[
            {"Service":"keycloak","State":"running","Health":"healthy"},
            {"Service":"db","State":"running","Health":"healthy"},
            {"Service":"synapse","State":"running","Health":"healthy","KoderaPolicy":false},
            {"Service":"server","State":"running","Health":"healthy"},
            {"Service":"web","State":"running","Health":"healthy"},
            {"Service":"livekit","State":"running","Health":"healthy"}
        ]"#;
    let bad_policy_runner = MockDockerRunner::with_responses([
        MockDockerRunner::ok_compose_json(),
        MockDockerRunner::ok_stdout(""),
        MockDockerRunner::ok_stdout(degraded_policy_ps),
    ]);
    assert_eq!(
        self_host_deploy_community(&fixture.path_str(), Some(10_000), &bad_policy_runner),
        Err(CommunityDeployError::StackUnhealthy)
    );
}

#[cfg(unix)]
#[test]
fn deploy_refuses_missing_or_world_readable_dotenv_before_invoking_docker() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = TempStackFixture::new_with_compose();
    let runner = MockDockerRunner::with_responses([]);
    assert_eq!(
        self_host_deploy_community(&fixture.path_str(), Some(5_000), &runner),
        Err(CommunityDeployError::EnvFileMissing)
    );

    let env_path = fixture.dir.join(".env");
    fs::write(
        &env_path,
        "KODERA_OIDC_PROVIDER_ORIGIN=https://id.example.org\n",
    )
    .unwrap();
    fs::set_permissions(&env_path, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        self_host_deploy_community(&fixture.path_str(), Some(5_000), &runner),
        Err(CommunityDeployError::EnvPermissionsInsecure)
    );
    assert!(runner.recorded_calls().is_empty());
}

#[test]
fn deploy_returns_compose_launch_failed_on_nonzero_exit_or_timeout() {
    let fixture = TempStackFixture::new_with_compose();
    let prep_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_compose_json()]);
    let prep_spec = CommunityPrepareSpec {
        stack_dir: &fixture.path_str(),
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        oidc_provider_origin: "https://id.example.org",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    self_host_prepare_community(&prep_spec, &prep_runner).unwrap();

    let exit_fail_runner = MockDockerRunner::with_responses([
        MockDockerRunner::ok_compose_json(),
        MockDockerRunner::fail_stderr(1, "port allocated"),
    ]);
    assert_eq!(
        self_host_deploy_community(&fixture.path_str(), Some(5_000), &exit_fail_runner),
        Err(CommunityDeployError::ComposeLaunchFailed)
    );

    let timeout_runner = MockDockerRunner::with_responses([
        MockDockerRunner::ok_compose_json(),
        Ok(CommandExecOutput {
            status_code: None,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: true,
        }),
    ]);
    assert_eq!(
        self_host_deploy_community(&fixture.path_str(), Some(5_000), &timeout_runner),
        Err(CommunityDeployError::ComposeLaunchFailed)
    );
}

#[test]
fn deploy_returns_probe_timed_out_when_compose_ps_times_out() {
    let fixture = TempStackFixture::new_with_compose();
    let prep_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_compose_json()]);
    let prep_spec = CommunityPrepareSpec {
        stack_dir: &fixture.path_str(),
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        oidc_provider_origin: "https://id.example.org",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    self_host_prepare_community(&prep_spec, &prep_runner).unwrap();

    let runner = MockDockerRunner::with_responses([
        MockDockerRunner::ok_compose_json(),
        MockDockerRunner::ok_stdout(""),
        Ok(CommandExecOutput {
            status_code: None,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: true,
        }),
    ]);
    assert_eq!(
        self_host_deploy_community(&fixture.path_str(), Some(5_000), &runner),
        Err(CommunityDeployError::DockerUnavailable(
            DockerUnavailableReason::ProbeTimedOut
        ))
    );
}

#[test]
fn deploy_returns_readiness_probe_failed_on_malformed_compose_ps_json() {
    let fixture = TempStackFixture::new_with_compose();
    let prep_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_compose_json()]);
    let prep_spec = CommunityPrepareSpec {
        stack_dir: &fixture.path_str(),
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        oidc_provider_origin: "https://id.example.org",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    self_host_prepare_community(&prep_spec, &prep_runner).unwrap();

    let runner = MockDockerRunner::with_responses([
        MockDockerRunner::ok_compose_json(),
        MockDockerRunner::ok_stdout(""),
        MockDockerRunner::ok_stdout("{broken_json"),
    ]);
    assert_eq!(
        self_host_deploy_community(&fixture.path_str(), Some(5_000), &runner),
        Err(CommunityDeployError::ReadinessProbeFailed(
            SelfHostHealthError::InvalidJson
        ))
    );
}

#[test]
fn deploy_exhausts_retry_polls_when_service_stays_restarting() {
    let fixture = TempStackFixture::new_with_compose();
    let prep_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_compose_json()]);
    let prep_spec = CommunityPrepareSpec {
        stack_dir: &fixture.path_str(),
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        oidc_provider_origin: "https://id.example.org",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    self_host_prepare_community(&prep_spec, &prep_runner).unwrap();

    let restarting_ps = r#"[
            {"Service":"keycloak","State":"restarting","Health":""},
            {"Service":"db","State":"running","Health":"healthy"},
            {"Service":"synapse","State":"running","Health":"healthy"},
            {"Service":"server","State":"running","Health":"healthy"},
            {"Service":"web","State":"running","Health":"healthy"},
            {"Service":"livekit","State":"running","Health":"healthy"}
        ]"#;
    let mut seq = vec![
        MockDockerRunner::ok_compose_json(),
        MockDockerRunner::ok_stdout(""),
    ];
    for _ in 0..READINESS_MAX_POLL_ATTEMPTS {
        seq.push(MockDockerRunner::ok_stdout(restarting_ps));
    }
    let runner = MockDockerRunner::with_responses(seq);
    assert_eq!(
        self_host_deploy_community(&fixture.path_str(), Some(30_000), &runner),
        Err(CommunityDeployError::StackUnhealthy)
    );
    // 1 `compose config --format json` + 1 `compose up` + READINESS_MAX_POLL_ATTEMPTS `compose ps` invocations.
    assert_eq!(
        runner.recorded_calls().len(),
        2 + usize::from(READINESS_MAX_POLL_ATTEMPTS)
    );
}

#[test]
fn deploy_supports_ndjson_compose_ps_output() {
    let fixture = TempStackFixture::new_with_compose();
    let prep_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_compose_json()]);
    let prep_spec = CommunityPrepareSpec {
        stack_dir: &fixture.path_str(),
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        oidc_provider_origin: "https://id.example.org",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    self_host_prepare_community(&prep_spec, &prep_runner).unwrap();

    let ndjson = concat!(
        r#"{"Service":"keycloak","State":"running","Health":"healthy","Publishers":[{"TargetPort":8080}]}"#,
        "\n",
        r#"{"Service":"db","State":"running","Health":"healthy"}"#,
        "\n",
        r#"{"Service":"synapse","State":"running","Health":"healthy","KoderaPolicy":"0.1.4"}"#,
        "\n",
        r#"{"Service":"server","State":"running","Health":"healthy"}"#,
        "\n",
        r#"{"Service":"web","State":"running","Health":"healthy"}"#,
        "\n",
        r#"{"Service":"livekit","State":"running","Health":"healthy"}"#,
        "\n",
    );
    let runner = MockDockerRunner::with_responses([
        MockDockerRunner::ok_compose_json(),
        MockDockerRunner::ok_stdout(""),
        MockDockerRunner::ok_stdout(ndjson),
    ]);
    let report = self_host_deploy_community(&fixture.path_str(), Some(10_000), &runner).unwrap();
    assert!(report.stack_healthy);
    assert_eq!(report.poll_attempts, 1);
}

#[test]
fn error_display_slugs_are_secret_free_and_deterministic() {
    assert_eq!(
        CommunityDeployError::InvalidStackDir.to_string(),
        "invalid_stack_dir"
    );
    assert_eq!(
        CommunityDeployError::SymlinkRejected.to_string(),
        "symlink_rejected"
    );
    assert_eq!(
        CommunityDeployError::EnvPermissionsInsecure.to_string(),
        "env_permissions_insecure"
    );
    assert_eq!(
        CommunityDeployError::DockerUnavailable(DockerUnavailableReason::CliMissing).to_string(),
        "docker_unavailable:cli_missing"
    );
    assert_eq!(
        CommunityDeployError::StackUnhealthy.to_string(),
        "stack_unhealthy"
    );
    assert_eq!(
        CommunityDeployError::EnvAlreadyExists.to_string(),
        "env_already_exists"
    );
    assert_eq!(
        CommunityDeployError::StackDirNotAuthorized.to_string(),
        "stack_dir_not_authorized"
    );
}

#[test]
fn prepare_never_overwrites_or_deletes_preexisting_dotenv_under_any_outcome() {
    let fixture = TempStackFixture::new_with_compose();
    let env_path = fixture.dir.join(".env");
    let sentinel = "POSTGRES_PASSWORD=live_production_database_secret_do_not_clobber\n";
    fs::write(&env_path, sentinel).unwrap();

    for response in [
        MockDockerRunner::ok_stdout(""),
        MockDockerRunner::fail_stderr(1, "compose invalid"),
        Err(DockerUnavailableReason::DaemonOffline),
    ] {
        let runner = MockDockerRunner::with_responses([response]);
        let spec = CommunityPrepareSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            oidc_provider_origin: "https://id.example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_prepare_community(&spec, &runner),
            Err(CommunityDeployError::EnvAlreadyExists)
        );
        assert!(runner.recorded_calls().is_empty());
        assert_eq!(fs::read_to_string(&env_path).unwrap(), sentinel);
    }
}

#[test]
fn prepare_validates_against_temp_candidate_and_preserves_concurrently_created_dotenv() {
    struct RacingRunner {
        env_path: PathBuf,
        sentinel: &'static str,
        succeed: bool,
    }

    impl CommunityCommandRunner for RacingRunner {
        fn run_argv(
            &self,
            _program: &str,
            args: &[String],
            _working_dir: Option<&Path>,
            _timeout: Duration,
        ) -> Result<CommandExecOutput, DockerUnavailableReason> {
            // Verify `--env-file` points to the isolated candidate file, not `.env`.
            assert_eq!(args[1], "--env-file");
            assert!(args[2].contains(".env.kodera-tmp-"));
            assert!(Path::new(&args[2]).is_file());
            assert!(!self.env_path.exists());
            // Simulate another operator writing `.env` while `docker compose config` runs.
            fs::write(&self.env_path, self.sentinel).unwrap();
            if self.succeed {
                MockDockerRunner::ok_compose_json()
            } else {
                MockDockerRunner::fail_stderr(1, "compose config failed")
            }
        }

        fn poll_backoff(&self) -> Duration {
            Duration::ZERO
        }
    }

    // Case 1: Compose config fails after concurrent `.env` creation -> candidate deleted, `.env` intact.
    let fail_fixture = TempStackFixture::new_with_compose();
    let fail_env = fail_fixture.dir.join(".env");
    let fail_runner = RacingRunner {
        env_path: fail_env.clone(),
        sentinel: "CONCURRENT_OPERATOR_SECRET=keep_on_config_failure\n",
        succeed: false,
    };
    let fail_spec = CommunityPrepareSpec {
        stack_dir: &fail_fixture.path_str(),
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        oidc_provider_origin: "https://id.example.org",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    assert_eq!(
        self_host_prepare_community(&fail_spec, &fail_runner),
        Err(CommunityDeployError::ComposeConfigInvalid)
    );
    assert_eq!(
        fs::read_to_string(&fail_env).unwrap(),
        "CONCURRENT_OPERATOR_SECRET=keep_on_config_failure\n"
    );
    assert_eq!(
        fs::read_dir(&fail_fixture.dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(".env.kodera-tmp-"))
            .count(),
        0
    );

    // Case 2: Compose config succeeds after concurrent `.env` creation -> hard_link refuses overwrite!
    let ok_fixture = TempStackFixture::new_with_compose();
    let ok_env = ok_fixture.dir.join(".env");
    let ok_runner = RacingRunner {
        env_path: ok_env.clone(),
        sentinel: "CONCURRENT_OPERATOR_SECRET=keep_on_atomic_publish\n",
        succeed: true,
    };
    let ok_spec = CommunityPrepareSpec {
        stack_dir: &ok_fixture.path_str(),
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        oidc_provider_origin: "https://id.example.org",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    assert_eq!(
        self_host_prepare_community(&ok_spec, &ok_runner),
        Err(CommunityDeployError::EnvAlreadyExists)
    );
    assert_eq!(
        fs::read_to_string(&ok_env).unwrap(),
        "CONCURRENT_OPERATOR_SECRET=keep_on_atomic_publish\n"
    );
    assert_eq!(
        fs::read_dir(&ok_fixture.dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(".env.kodera-tmp-"))
            .count(),
        0
    );
}
