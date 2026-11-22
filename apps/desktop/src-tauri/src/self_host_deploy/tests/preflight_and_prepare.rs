use super::*;

#[test]
fn preflight_validates_argv_docker_and_compose_versions_without_shell() {
    let fixture = TempStackFixture::new_with_compose();
    let runner = MockDockerRunner::with_responses([
        MockDockerRunner::ok_stdout("Docker version 28.1.0, build 4d8c241\n"),
        MockDockerRunner::ok_stdout("Docker Compose version v2.36.0\n"),
    ]);
    let spec = CommunityPreflightSpec {
        stack_dir: &fixture.path_str(),
        domain: "Chat.Example.org",
        acme_email: "ops@Example.org",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    let report = self_host_preflight_community(&spec, &runner).unwrap();
    assert_eq!(
        report.docker_version,
        "Docker version 28.1.0, build 4d8c241"
    );
    assert_eq!(report.compose_version, "Docker Compose version v2.36.0");
    assert!(report.compose_file_present);
    assert!(report.stack_dir_writable);
    assert_eq!(report.normalized_domain, "chat.example.org");
    assert_eq!(report.matrix_base_domain, "example.org");
    assert_eq!(report.tls_mode, CommunityTlsMode::Acme);

    let calls = runner.recorded_calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(
        calls[0],
        ("docker".to_owned(), vec!["--version".to_owned()])
    );
    assert_eq!(
        calls[1],
        (
            "docker".to_owned(),
            vec!["compose".to_owned(), "version".to_owned()]
        )
    );
}

#[test]
fn preflight_rejects_newlines_and_crlf_injection_in_every_field() {
    let fixture = TempStackFixture::new_with_compose();
    let runner = MockDockerRunner::with_responses([]);

    for poisoned_domain in [
        "chat.example.org\nEVIL=1",
        "chat.example.org\r\nEVIL=1",
        "\nchat.example.org",
    ] {
        let spec = CommunityPreflightSpec {
            stack_dir: &fixture.path_str(),
            domain: poisoned_domain,
            acme_email: "ops@example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_preflight_community(&spec, &runner),
            Err(CommunityDeployError::InvalidDomain)
        );
    }

    for poisoned_email in [
        "ops@example.org\nKODERA_AUTH_TRUST=bad",
        "ops\r@example.org",
    ] {
        let spec = CommunityPreflightSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: poisoned_email,
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_preflight_community(&spec, &runner),
            Err(CommunityDeployError::InvalidAcmeEmail)
        );
    }

    let bad_dir_spec = CommunityPreflightSpec {
        stack_dir: "/tmp/kodera\n/deploy",
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    assert_eq!(
        self_host_preflight_community(&bad_dir_spec, &runner),
        Err(CommunityDeployError::InvalidStackDir)
    );
    assert!(runner.recorded_calls().is_empty());
}

#[test]
fn preflight_rejects_path_traversal_relative_paths_and_shell_metacharacters() {
    let fixture = TempStackFixture::new_with_compose();
    let runner = MockDockerRunner::with_responses([]);
    let traversal = format!("{}/../{}", fixture.path_str(), "escape");

    for bad_dir in [
        traversal.as_str(),
        "deploy/community",
        "./deploy/community",
        "/tmp/kodera;id",
        "/tmp/kodera|whoami",
        "/tmp/kodera$(uname)",
        "/tmp/kodera`id`",
        "/tmp/kodera&true",
    ] {
        let spec = CommunityPreflightSpec {
            stack_dir: bad_dir,
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            tls_mode: CommunityTlsMode::Internal,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_preflight_community(&spec, &runner),
            Err(CommunityDeployError::InvalidStackDir),
            "expected InvalidStackDir for {bad_dir}"
        );
    }
    assert!(runner.recorded_calls().is_empty());
}

#[test]
fn preflight_rejects_invalid_domains_emails_ports_and_tls_modes() {
    let fixture = TempStackFixture::new_with_compose();
    let runner = MockDockerRunner::with_responses([]);

    assert_eq!(
        CommunityTlsMode::parse("self-signed"),
        Err(CommunityDeployError::InvalidTlsMode)
    );

    for bad_domain in [
        "",
        "localhost",
        "127.0.0.1",
        "-chat.example.org",
        "chat-.example.org",
        "chat..example.org",
        "chat.example.org;id",
        "chat example.org",
        "chat.example.123",
    ] {
        let spec = CommunityPreflightSpec {
            stack_dir: &fixture.path_str(),
            domain: bad_domain,
            acme_email: "ops@example.org",
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_preflight_community(&spec, &runner),
            Err(CommunityDeployError::InvalidDomain),
            "expected InvalidDomain for {bad_domain}"
        );
    }

    for bad_email in [
        "",
        "ops.example.org",
        "@example.org",
        "ops@@example.org",
        ".ops@example.org",
        "ops@localhost",
        "ops;id@example.org",
    ] {
        let spec = CommunityPreflightSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: bad_email,
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_preflight_community(&spec, &runner),
            Err(CommunityDeployError::InvalidAcmeEmail),
            "expected InvalidAcmeEmail for {bad_email}"
        );
    }

    for (http_port, https_port) in [(0, 443), (80, 0), (443, 443)] {
        let spec = CommunityPreflightSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            tls_mode: CommunityTlsMode::Off,
            http_port,
            https_port,
        };
        assert_eq!(
            self_host_preflight_community(&spec, &runner),
            Err(CommunityDeployError::InvalidPort)
        );
    }
}

#[test]
fn preflight_rejects_missing_compose_file_and_docker_daemon_errors() {
    let fixture = TempStackFixture::new_with_compose();
    fs::remove_file(fixture.dir.join("docker-compose.yml")).unwrap();
    let runner = MockDockerRunner::with_responses([]);
    let spec = CommunityPreflightSpec {
        stack_dir: &fixture.path_str(),
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    assert_eq!(
        self_host_preflight_community(&spec, &runner),
        Err(CommunityDeployError::ComposeFileMissing)
    );

    // Restore compose file and verify Docker CLI missing / Compose plugin missing handling.
    fs::write(
            fixture.dir.join("docker-compose.yml"),
            "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n",
        )
        .unwrap();
    let cli_missing_runner =
        MockDockerRunner::with_responses([Err(DockerUnavailableReason::CliMissing)]);
    assert_eq!(
        self_host_preflight_community(&spec, &cli_missing_runner),
        Err(CommunityDeployError::DockerUnavailable(
            DockerUnavailableReason::CliMissing
        ))
    );

    let compose_missing_runner = MockDockerRunner::with_responses([
        MockDockerRunner::ok_stdout("Docker version 28.1.0\n"),
        MockDockerRunner::fail_stderr(1, "docker: 'compose' is not a docker command"),
    ]);
    assert_eq!(
        self_host_preflight_community(&spec, &compose_missing_runner),
        Err(CommunityDeployError::ComposePluginMissing)
    );
}

#[cfg(unix)]
#[test]
fn preflight_and_prepare_reject_symlinked_stack_dir_compose_and_dotenv() {
    use std::os::unix::fs::symlink;

    let real_fixture = TempStackFixture::new_with_compose();
    let link_parent = TempStackFixture::new_with_compose();
    let symlink_dir = link_parent.dir.join("linked-stack");
    symlink(&real_fixture.dir, &symlink_dir).unwrap();

    let runner = MockDockerRunner::with_responses([]);
    let spec = CommunityPreflightSpec {
        stack_dir: symlink_dir.to_str().unwrap(),
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    assert_eq!(
        self_host_preflight_community(&spec, &runner),
        Err(CommunityDeployError::SymlinkRejected)
    );

    // Symlinked docker-compose.yml inside a real directory is also refused.
    let compose_link_fixture = TempStackFixture::new_with_compose();
    let compose_file = compose_link_fixture.dir.join("docker-compose.yml");
    fs::remove_file(&compose_file).unwrap();
    symlink(real_fixture.dir.join("docker-compose.yml"), &compose_file).unwrap();
    let spec_compose_link = CommunityPreflightSpec {
        stack_dir: &compose_link_fixture.path_str(),
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    assert_eq!(
        self_host_preflight_community(&spec_compose_link, &runner),
        Err(CommunityDeployError::SymlinkRejected)
    );

    // Symlinked .env target during prepare is refused without overwriting target file.
    let outside_target = link_parent.dir.join("victim.txt");
    fs::write(&outside_target, "keep-safe").unwrap();
    symlink(&outside_target, real_fixture.dir.join(".env")).unwrap();
    let prep_spec = CommunityPrepareSpec {
        stack_dir: &real_fixture.path_str(),
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        oidc_provider_origin: "https://id.example.org",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    assert_eq!(
        self_host_prepare_community(&prep_spec, &runner),
        Err(CommunityDeployError::SymlinkRejected)
    );
    assert_eq!(fs::read_to_string(&outside_target).unwrap(), "keep-safe");
}

#[test]
fn prepare_generates_distinct_csprng_secrets_writes_0600_dotenv_and_runs_compose_config() {
    let fixture = TempStackFixture::new_with_compose();
    let runner = MockDockerRunner::with_responses([MockDockerRunner::ok_compose_json()]);
    let spec = CommunityPrepareSpec {
        stack_dir: &fixture.path_str(),
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        oidc_provider_origin: "https://id.example.org:443",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    let report = self_host_prepare_community(&spec, &runner).unwrap();
    assert!(report.env_file_written);
    assert!(report.compose_config_valid);
    assert_eq!(report.normalized_domain, "chat.example.org");
    assert_eq!(report.matrix_base_domain, "example.org");
    assert_eq!(
        report.oidc_issuer,
        "https://id.example.org/realms/community"
    );
    assert_eq!(report.generated_secret_keys.len(), 16);

    let env_path = fixture.dir.join(".env");
    assert!(env_path.is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(report.unix_file_mode, 0o600);
        let mode = fs::symlink_metadata(&env_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    let raw_env = fs::read_to_string(&env_path).unwrap();
    let parsed: BTreeMap<&str, &str> = raw_env
        .lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
        .map(|l| l.split_once('=').unwrap())
        .collect();

    assert_eq!(
        parsed.get("DJANGO_ALLOWED_HOSTS").copied(),
        Some("chat.example.org,127.0.0.1,server"),
        "DJANGO_ALLOWED_HOSTS must admit internal server host for tenant-agent polling"
    );

    // Verify 64-char hex CSPRNG secrets are distinct and have exact length 64.
    let hex_keys = [
        "POSTGRES_PASSWORD",
        "KODERA_API_DATABASE_PASSWORD",
        "KODERA_COLLAB_DATABASE_PASSWORD",
        "SYNAPSE_POSTGRES_PASSWORD",
        "DJANGO_SECRET_KEY",
        "KODERA_MEMBERSHIP_CURSOR_KEY",
        "ROOM_ACCESS_MATRIX_TOKEN",
        "LIVEKIT_API_SECRET",
        "KODERA_SYNAPSE_OIDC_CLIENT_SECRET",
        "KEYCLOAK_ADMIN_PASSWORD",
        "KEYCLOAK_DB_PASSWORD",
    ];
    let mut unique_secrets = BTreeSet::new();
    for key in hex_keys {
        let val = parsed.get(key).copied().expect(key);
        assert_eq!(val.len(), 64, "{key} must be 64 hex chars");
        assert!(
            val.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "{key} must be lowercase hex"
        );
        assert!(unique_secrets.insert(val), "{key} reused entropy");
        assert!(
            !format!("{report:?}").contains(val),
            "prepare report leaked secret {key}"
        );
    }

    // Verify canonical 44-char padded standard Base64 discovery HMAC key (32 bytes).
    let discovery_val = parsed
        .get("KODERA_DISCOVERY_HMAC_KEY")
        .copied()
        .expect("KODERA_DISCOVERY_HMAC_KEY");
    let decoded_discovery = decode_canonical_standard_base64_32(discovery_val)
        .expect("KODERA_DISCOVERY_HMAC_KEY must be canonical 44-char standard Base64");
    assert_eq!(encode_base64_padded_32(&decoded_discovery), discovery_val);
    assert!(
        unique_secrets.insert(discovery_val),
        "KODERA_DISCOVERY_HMAC_KEY reused entropy"
    );
    assert!(
        !format!("{report:?}").contains(discovery_val),
        "prepare report leaked KODERA_DISCOVERY_HMAC_KEY"
    );

    // Verify 44-char padded base64url seal keys.
    for seal_key in [
        "KODERA_CONTACT_SEAL_KEY",
        "KODERA_OUTBOX_SEAL_KEY",
        "KODERA_COLLAB_TICKET_KEY",
    ] {
        let val = parsed.get(seal_key).copied().expect(seal_key);
        assert_eq!(val.len(), 44, "{seal_key} must be 44 base64url chars");
        assert!(val.ends_with('='));
        assert!(unique_secrets.insert(val), "{seal_key} reused entropy");
        assert!(!format!("{report:?}").contains(val));
    }

    let lk_key = parsed.get("LIVEKIT_API_KEY").copied().unwrap();
    assert_eq!(lk_key.len(), 27);
    assert!(lk_key.starts_with("lk_"));
    assert!(!format!("{report:?}").contains(lk_key));

    // Verify `docker compose --env-file ... -f ... config --format json` argv invocation.
    let calls = runner.recorded_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "docker");
    assert_eq!(calls[0].1[0], "compose");
    assert_eq!(calls[0].1[1], "--env-file");
    assert_eq!(calls[0].1[3], "-f");
    assert_eq!(calls[0].1[5], "config");
    assert_eq!(calls[0].1[6], "--format");
    assert_eq!(calls[0].1[7], "json");
}

#[test]
fn prepare_rejects_oidc_injection_and_removes_dotenv_when_compose_config_fails() {
    let fixture = TempStackFixture::new_with_compose();
    let runner = MockDockerRunner::with_responses([]);

    for bad_oidc in [
        "http://id.example.org",
        "https://id.example.org/realms/community",
        "https://id.example.org?next=evil",
        "https://user@id.example.org",
        "https://id.example.org\nEVIL=1",
        "javascript:alert(1)",
    ] {
        let spec = CommunityPrepareSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            oidc_provider_origin: bad_oidc,
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_prepare_community(&spec, &runner),
            Err(CommunityDeployError::InvalidOidcOrigin),
            "expected InvalidOidcOrigin for {bad_oidc}"
        );
    }
    assert!(!fixture.dir.join(".env").exists());

    // When `docker compose config --quiet` fails, `.env` is removed cleanly.
    let failing_runner =
        MockDockerRunner::with_responses([MockDockerRunner::fail_stderr(1, "invalid yaml")]);
    let valid_spec = CommunityPrepareSpec {
        stack_dir: &fixture.path_str(),
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        oidc_provider_origin: "https://id.example.org",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    assert_eq!(
        self_host_prepare_community(&valid_spec, &failing_runner),
        Err(CommunityDeployError::ComposeConfigInvalid)
    );
    assert!(!fixture.dir.join(".env").exists());
}

#[test]
fn std_process_runner_refuses_non_docker_binaries_and_control_characters() {
    let runner = StdProcessCommunityRunner::new();
    assert_eq!(
        runner.run_argv(
            "sh",
            &["-c".to_owned(), "id".to_owned()],
            None,
            Duration::from_millis(100)
        ),
        Err(DockerUnavailableReason::PermissionDenied)
    );
    assert_eq!(
        runner.run_argv(
            "docker",
            &["compose\nmalicious".to_owned()],
            None,
            Duration::from_millis(100)
        ),
        Err(DockerUnavailableReason::PermissionDenied)
    );
}

#[test]
fn preflight_rejects_docker_daemon_permission_denied_stderr() {
    let fixture = TempStackFixture::new_with_compose();
    let runner = MockDockerRunner::with_responses([MockDockerRunner::fail_stderr(
        1,
        "permission denied while trying to connect to the Docker daemon socket",
    )]);
    let spec = CommunityPreflightSpec {
        stack_dir: &fixture.path_str(),
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    assert_eq!(
        self_host_preflight_community(&spec, &runner),
        Err(CommunityDeployError::DockerUnavailable(
            DockerUnavailableReason::PermissionDenied
        ))
    );
}

#[test]
fn preflight_rejects_docker_version_timeout() {
    let fixture = TempStackFixture::new_with_compose();
    let runner = MockDockerRunner::with_responses([Ok(CommandExecOutput {
        status_code: None,
        stdout: String::new(),
        stderr: String::new(),
        timed_out: true,
    })]);
    let spec = CommunityPreflightSpec {
        stack_dir: &fixture.path_str(),
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    assert_eq!(
        self_host_preflight_community(&spec, &runner),
        Err(CommunityDeployError::DockerUnavailable(
            DockerUnavailableReason::ProbeTimedOut
        ))
    );
}

#[test]
fn preflight_rejects_compose_version_timeout() {
    let fixture = TempStackFixture::new_with_compose();
    let runner = MockDockerRunner::with_responses([
        MockDockerRunner::ok_stdout("Docker version 28.1.0\n"),
        Ok(CommandExecOutput {
            status_code: None,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: true,
        }),
    ]);
    let spec = CommunityPreflightSpec {
        stack_dir: &fixture.path_str(),
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    assert_eq!(
        self_host_preflight_community(&spec, &runner),
        Err(CommunityDeployError::DockerUnavailable(
            DockerUnavailableReason::ProbeTimedOut
        ))
    );
}

#[test]
fn preflight_rejects_empty_or_oversized_docker_version_stdout() {
    let fixture = TempStackFixture::new_with_compose();
    let spec = CommunityPreflightSpec {
        stack_dir: &fixture.path_str(),
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    let empty_runner = MockDockerRunner::with_responses([MockDockerRunner::ok_stdout("   \n")]);
    assert_eq!(
        self_host_preflight_community(&spec, &empty_runner),
        Err(CommunityDeployError::DockerVersionUnsupported)
    );

    let huge_line = "x".repeat(200);
    let oversized_runner =
        MockDockerRunner::with_responses([MockDockerRunner::ok_stdout(&huge_line)]);
    assert_eq!(
        self_host_preflight_community(&spec, &oversized_runner),
        Err(CommunityDeployError::DockerVersionUnsupported)
    );
}

#[test]
fn preflight_rejects_empty_compose_yaml_file() {
    let fixture = TempStackFixture::new_with_compose();
    fs::write(fixture.dir.join("docker-compose.yml"), "").unwrap();
    let runner = MockDockerRunner::with_responses([]);
    let spec = CommunityPreflightSpec {
        stack_dir: &fixture.path_str(),
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        tls_mode: CommunityTlsMode::Internal,
        http_port: 80,
        https_port: 443,
    };
    assert_eq!(
        self_host_preflight_community(&spec, &runner),
        Err(CommunityDeployError::ComposeFileMissing)
    );
}

#[test]
fn preflight_rejects_oversized_stack_dir_path() {
    let runner = MockDockerRunner::with_responses([]);
    let long_dir = format!("/tmp/{}", "a".repeat(MAX_STACK_DIR_BYTES + 1));
    let spec = CommunityPreflightSpec {
        stack_dir: &long_dir,
        domain: "chat.example.org",
        acme_email: "ops@example.org",
        tls_mode: CommunityTlsMode::Acme,
        http_port: 80,
        https_port: 443,
    };
    assert_eq!(
        self_host_preflight_community(&spec, &runner),
        Err(CommunityDeployError::InvalidStackDir)
    );
}

#[test]
fn preflight_derives_two_label_and_subdomain_matrix_base_domains() {
    assert_eq!(derive_matrix_base_domain("example.org"), "example.org");
    assert_eq!(derive_matrix_base_domain("chat.example.org"), "example.org");
    assert_eq!(
        derive_matrix_base_domain("chat.eu.example.org"),
        "eu.example.org"
    );
}

#[test]
fn tls_mode_round_trips_acme_internal_and_off() {
    for (raw, expected) in [
        ("acme", CommunityTlsMode::Acme),
        ("internal", CommunityTlsMode::Internal),
        ("off", CommunityTlsMode::Off),
    ] {
        let parsed = CommunityTlsMode::parse(raw).unwrap();
        assert_eq!(parsed, expected);
        assert_eq!(parsed.as_str(), raw);
    }
    assert_eq!(
        CommunityTlsMode::parse("ACME"),
        Err(CommunityDeployError::InvalidTlsMode)
    );
}

#[test]
fn prepare_cleans_up_dotenv_when_docker_unavailable_during_config_check() {
    let fixture = TempStackFixture::new_with_compose();
    let runner = MockDockerRunner::with_responses([Err(DockerUnavailableReason::DaemonOffline)]);
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
        Err(CommunityDeployError::DockerUnavailable(
            DockerUnavailableReason::DaemonOffline
        ))
    );
    assert!(!fixture.dir.join(".env").exists());
}

#[test]
fn prepare_accepts_custom_https_port_and_strips_default_443_on_oidc_origin() {
    let fixture = TempStackFixture::new_with_compose();
    let runner = MockDockerRunner::with_responses([MockDockerRunner::ok_compose_json()]);
    let spec = CommunityPrepareSpec {
        stack_dir: &fixture.path_str(),
        domain: "chat.example.org",
        acme_email: "ops+admin@example.org",
        oidc_provider_origin: "https://id.example.org:8443",
        tls_mode: CommunityTlsMode::Internal,
        http_port: 8080,
        https_port: 8443,
    };
    let report = self_host_prepare_community(&spec, &runner).unwrap();
    assert_eq!(
        report.oidc_issuer,
        "https://id.example.org:8443/realms/community"
    );
    assert_eq!(report.http_port, 8080);
    assert_eq!(report.https_port, 8443);
    assert_eq!(report.tls_mode, CommunityTlsMode::Internal);
}

#[test]
fn prepare_rejects_oidc_origin_with_port_zero_or_overflow() {
    let fixture = TempStackFixture::new_with_compose();
    let runner = MockDockerRunner::with_responses([]);
    for bad_origin in [
        "https://id.example.org:0",
        "https://id.example.org:65536",
        "https://id.example.org:abc",
        "https://id.example.org:",
    ] {
        let spec = CommunityPrepareSpec {
            stack_dir: &fixture.path_str(),
            domain: "chat.example.org",
            acme_email: "ops@example.org",
            oidc_provider_origin: bad_origin,
            tls_mode: CommunityTlsMode::Acme,
            http_port: 80,
            https_port: 443,
        };
        assert_eq!(
            self_host_prepare_community(&spec, &runner),
            Err(CommunityDeployError::InvalidOidcOrigin)
        );
    }
}

fn decode_canonical_standard_base64_32(raw: &str) -> Option<[u8; 32]> {
    if raw.len() != 44 || !raw.ends_with('=') {
        return None;
    }
    let sextet = |b: u8| -> Option<u8> {
        match b {
            b'A'..=b'Z' => Some(b - b'A'),
            b'a'..=b'z' => Some(b - b'a' + 26),
            b'0'..=b'9' => Some(b - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let bytes = raw.as_bytes();
    let mut out = [0u8; 32];
    let mut in_idx = 0usize;
    let mut out_idx = 0usize;
    while in_idx < 40 {
        let s0 = sextet(bytes[in_idx])?;
        let s1 = sextet(bytes[in_idx + 1])?;
        let s2 = sextet(bytes[in_idx + 2])?;
        let s3 = sextet(bytes[in_idx + 3])?;
        out[out_idx] = (s0 << 2) | (s1 >> 4);
        out[out_idx + 1] = (s1 << 4) | (s2 >> 2);
        out[out_idx + 2] = (s2 << 6) | s3;
        in_idx += 4;
        out_idx += 3;
    }
    let s0 = sextet(bytes[40])?;
    let s1 = sextet(bytes[41])?;
    let s2 = sextet(bytes[42])?;
    if (s2 & 0x03) != 0 {
        return None;
    }
    out[30] = (s0 << 2) | (s1 >> 4);
    out[31] = (s1 << 4) | (s2 >> 2);
    if encode_base64_padded_32(&out) == raw {
        Some(out)
    } else {
        None
    }
}

#[test]
fn encode_base64_and_base64url_padded_32_match_rfc4648_vectors() {
    let zero_key = [0u8; 32];
    let encoded_zeros = encode_base64url_padded_32(&zero_key);
    assert_eq!(encoded_zeros.len(), 44);
    assert_eq!(
        encoded_zeros,
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    );
    assert_eq!(
        encode_base64_padded_32(&zero_key),
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    );
    assert_eq!(
        decode_canonical_standard_base64_32(&encode_base64_padded_32(&zero_key)),
        Some(zero_key)
    );

    let ff_key = [0xffu8; 32];
    let encoded_ff = encode_base64url_padded_32(&ff_key);
    assert_eq!(encoded_ff.len(), 44);
    assert_eq!(encoded_ff, "__________________________________________8=");

    let std_ff = encode_base64_padded_32(&ff_key);
    assert_eq!(std_ff.len(), 44);
    assert_eq!(std_ff, "//////////////////////////////////////////8=");
    assert_eq!(decode_canonical_standard_base64_32(&std_ff), Some(ff_key));

    let fb_key = [0xfbu8; 32];
    let std_fb = encode_base64_padded_32(&fb_key);
    assert_eq!(std_fb, "+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/s=");
    assert_eq!(decode_canonical_standard_base64_32(&std_fb), Some(fb_key));

    // Non-standard or non-canonical encodings must be rejected, matching server configured_key().
    assert_eq!(decode_canonical_standard_base64_32(&encoded_ff), None);
    assert_eq!(decode_canonical_standard_base64_32(&"ab".repeat(32)), None);
    assert_eq!(
        decode_canonical_standard_base64_32(&format!("{}B=", "A".repeat(42))),
        None
    );
    assert_eq!(
        decode_canonical_standard_base64_32("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
        None
    );
}
