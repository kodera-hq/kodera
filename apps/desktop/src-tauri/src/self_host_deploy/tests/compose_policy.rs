use super::*;

#[test]
fn compose_policy_accepts_canonical_community_manifests_and_rejects_host_escape_directives() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.join("../../..");
    let community_compose = repo_root.join("deploy/community/docker-compose.yml");
    let create_kodera_compose = repo_root.join("packages/create-kodera/assets/docker-compose.yml");
    assert_eq!(validate_compose_file_policy(&community_compose), Ok(()));
    assert_eq!(validate_compose_file_policy(&create_kodera_compose), Ok(()));

    // Verify forward compatibility with `api_ingress` static IPv4 & IPAM bridge configuration.
    let ipam_fixture = TempStackFixture::new_with_compose();
    fs::write(
            ipam_fixture.dir.join("docker-compose.yml"),
            "services:\n  caddy:\n    image: caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0\n    networks:\n      api_ingress:\n        ipv4_address: ${KODERA_CADDY_API_ADDRESS:-172.30.240.2}\nnetworks:\n  default:\n  edge:\n    driver: bridge\n  api_ingress:\n    driver: bridge\n    ipam:\n      config:\n        - subnet: ${KODERA_API_INGRESS_SUBNET:-172.30.240.0/28}\n",
        )
        .unwrap();
    assert_eq!(
        validate_compose_file_policy(&ipam_fixture.dir.join("docker-compose.yml")),
        Ok(())
    );

    let hostile_payloads = [
            "services:\n  attacker:\n    image: alpine:3.20\n",
            "services:\n    attacker:\n        image: alpine:3.20\n        privileged: true\n        volumes:\n            - /:/host:rw\n",
            "services:\n    db:\n        image: postgres:17.6-alpine\n        privileged: true\n",
            "services:\n    db:\n        image: postgres:17.6-alpine\n        volumes:\n            - /:/host:rw\n",
            "x-escape: &escape\n  privileged: true\nservices:\n  db:\n    image: postgres:17.6-alpine\n    <<: *escape\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    volumes:\n      - postgres_data:/var/lib/postgresql/data\nvolumes:\n  postgres_data:\n    driver_opts:\n      type: none\n      o: bind\n      device: /\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    volumes:\n      - postgres_data:/var/lib/postgresql/data\nvolumes:\n  postgres_data:\n    external: true\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    privileged: true\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    network_mode: host\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    pid: host\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    cap_add: [\"SYS_ADMIN\"]\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    cap_add:\n      - SYS_ADMIN\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    security_opt: [\"apparmor:unconfined\"]\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    security_opt:\n      - apparmor:unconfined\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    volumes:\n      - /:/host:rw\n",
            "services:\n  db:\n    image: postgres:17.6-alpine\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n",
            "services:\n  caddy:\n    image: caddy:2.11.9-alpine\n    volumes:\n      - ./Caddyfile:/etc/caddy/Caddyfile:rw\n",
            "services:\n  caddy:\n    image: caddy:2.11.9-alpine\n    volumes:\n      - ./evil.sh:/entrypoint.sh:ro\n",
            "services:\n  caddy:\n    image: caddy:2.11.9-alpine\n    volumes:\n      - type: bind\n        source: /etc\n        target: /host-etc\n",
        ];

    for hostile in hostile_payloads {
        let fixture = TempStackFixture::new_with_compose();
        fs::write(fixture.dir.join("docker-compose.yml"), hostile).unwrap();
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
            Err(CommunityDeployError::ComposeConfigInvalid),
            "expected ComposeConfigInvalid for payload:\n{hostile}"
        );
        assert!(runner.recorded_calls().is_empty());
    }

    // Verify resolved `docker compose config --format json` validator directly against canonical & hostile ASTs.
    let canonical_fixture = TempStackFixture::new_with_compose();
    let canonical_dir = fs::canonicalize(&canonical_fixture.dir).unwrap();
    let caddyfile_str = canonical_dir.join("Caddyfile").to_str().unwrap().to_owned();
    let valid_resolved_json = serde_json::json!({
            "name": "community",
            "services": {
                "caddy": {
                    "image": "caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0",
                    "volumes": [
                        {
                            "type": "bind",
                            "source": caddyfile_str,
                            "target": "/etc/caddy/Caddyfile",
                            "read_only": true
                        },
                        {
                            "type": "volume",
                            "source": "caddy_data",
                            "target": "/data"
                        }
                    ]
                },
                "media-socket-init": {
                    "image": "ghcr.io/kodera/server:0.1.1@sha256:1111111111111111111111111111111111111111111111111111111111111111",
                    "cap_add": ["CHOWN", "FOWNER", "DAC_OVERRIDE"],
                    "security_opt": ["no-new-privileges:true"]
                }
            },
            "volumes": {
                "caddy_data": { "driver": "local" }
            }
        })
        .to_string();
    assert_eq!(
        validate_resolved_compose_config_json(&valid_resolved_json, &canonical_dir),
        Ok(())
    );

    let hostile_resolved_jsons = [
            "",
            "{not_json",
            r#"{"services":{}}"#,
            r#"{"services":{"attacker":{"image":"alpine:3.20","privileged":true,"volumes":[{"type":"bind","source":"/","target":"/host"}]}}}"#,
            r#"{"services":{"db":{"image":"postgres:17.6-alpine","privileged":true}}}"#,
            r#"{"services":{"db":{"image":"postgres:17.6-alpine","network_mode":"host"}}}"#,
            r#"{"services":{"db":{"image":"postgres:17.6-alpine","cap_add":["SYS_ADMIN"]}}}"#,
            r#"{"services":{"db":{"image":"postgres:17.6-alpine","volumes":[{"type":"bind","source":"/","target":"/host","read_only":true}]}}}"#,
            &serde_json::json!({
                "services": {
                    "caddy": {
                        "image": "caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0",
                        "volumes": [{
                            "type": "bind",
                            "source": canonical_dir.join("Caddyfile").to_str().unwrap(),
                            "target": "/etc/caddy/Caddyfile",
                            "read_only": false
                        }]
                    }
                }
            })
            .to_string(),
            r#"{"services":{"db":{"image":"postgres:17.6-alpine","volumes":[{"type":"volume","source":"postgres_data","target":"/var/lib/postgresql/data"}]}},"volumes":{"postgres_data":{"driver":"local","driver_opts":{"type":"none","o":"bind","device":"/"}}}}"#,
            r#"{"services":{"db":{"image":"postgres:17.6-alpine","volumes":[{"type":"volume","source":"postgres_data","target":"/var/lib/postgresql/data"}]}},"volumes":{"postgres_data":{"external":true}}}"#,
        ];
    for bad_json in hostile_resolved_jsons {
        assert_eq!(
            validate_resolved_compose_config_json(bad_json, &canonical_dir),
            Err(CommunityDeployError::ComposeConfigInvalid),
            "expected ComposeConfigInvalid for resolved JSON: {bad_json}"
        );
    }

    // Sensitive system and credential roots are rejected before compose inspection.
    let ssh_like = TempStackFixture::new_with_compose();
    let dot_ssh = ssh_like.dir.join(".ssh");
    fs::create_dir_all(&dot_ssh).unwrap();
    fs::write(
        dot_ssh.join("docker-compose.yml"),
        "services:\n  db:\n    image: postgres:17.6-alpine\n",
    )
    .unwrap();
    assert_eq!(
        canonicalize_authorized_stack_dir(dot_ssh.to_str().unwrap()),
        Err(CommunityDeployError::InvalidStackDir)
    );
    assert_eq!(
        canonicalize_authorized_stack_dir("/"),
        Err(CommunityDeployError::InvalidStackDir)
    );
}

#[test]
fn compose_build_policy_accepts_canonical_builds_and_rejects_external_context_and_inline_dockerfile(
) {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let canonical_repo_root = fs::canonicalize(manifest_dir.join("../../..")).unwrap();
    let canonical_community_dir = canonical_repo_root.join("deploy").join("community");
    let server_ctx = canonical_repo_root.join("apps").join("server");
    let yjs_ctx = server_ctx.join("yjs_collab");
    let policy_dir = canonical_repo_root.join("packages").join("synapse-policy");

    let valid_build_resolved_json = serde_json::json!({
            "name": "community",
            "services": {
                "migrate": {
                    "build": {
                        "context": server_ctx.to_str().unwrap(),
                        "dockerfile": "Dockerfile.migrator"
                    }
                },
                "server": {
                    "build": {
                        "context": server_ctx.to_str().unwrap(),
                        "dockerfile": "Dockerfile"
                    }
                },
                "yjs-collab": {
                    "build": {
                        "context": yjs_ctx.to_str().unwrap(),
                        "dockerfile": "Dockerfile"
                    }
                },
                "web": {
                    "build": {
                        "context": canonical_repo_root.to_str().unwrap(),
                        "dockerfile": "apps/web/Dockerfile",
                        "args": {
                            "VITE_CORE_API_URL": "https://chat.example.org/api/v1",
                            "VITE_OIDC_CLIENT_ID": "console"
                        }
                    }
                },
                "synapse": {
                    "image": "matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62",
                    "volumes": [{
                        "type": "bind",
                        "source": policy_dir.to_str().unwrap(),
                        "target": "/opt/kodera-policy",
                        "read_only": true
                    }]
                },
                "media-socket-init": {
                    "build": {
                        "context": server_ctx.to_str().unwrap(),
                        "dockerfile": "Dockerfile"
                    },
                    "cap_drop": ["ALL"],
                    "cap_add": ["CHOWN", "FOWNER", "DAC_OVERRIDE"],
                    "security_opt": ["no-new-privileges:true"]
                }
            }
        })
        .to_string();

    // 1. Positive: monorepo `deploy/community` resolves `<stack_dir>/../..` automatically.
    assert_eq!(
        validate_resolved_compose_config_json(&valid_build_resolved_json, &canonical_community_dir),
        Ok(())
    );

    // 2. Positive: external `create-kodera` workspace with explicit `KODERA_SOURCE_DIR` in `.env`.
    let external_ws = TempStackFixture::new_with_compose();
    let canonical_ext_dir = fs::canonicalize(&external_ws.dir).unwrap();
    assert_eq!(
        validate_resolved_compose_config_json_with_source(
            &valid_build_resolved_json,
            &canonical_ext_dir,
            Some(&canonical_repo_root),
        ),
        Ok(())
    );

    fs::write(
            external_ws.dir.join("docker-compose.yml"),
            "services:\n  server:\n    build:\n      context: ${KODERA_SOURCE_DIR:?Set Community source root}/apps/server\n      dockerfile: Dockerfile\n",
        )
        .unwrap();
    let ext_env_path = external_ws.dir.join(".env");
    fs::write(
        &ext_env_path,
        format!(
            "KODERA_OIDC_PROVIDER_ORIGIN=https://id.example.org\nKODERA_SOURCE_DIR='{}'\n",
            canonical_repo_root.display()
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&ext_env_path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let deploy_runner = MockDockerRunner::with_responses([
        MockDockerRunner::ok_stdout(&valid_build_resolved_json),
        MockDockerRunner::ok_stdout(""),
        MockDockerRunner::ok_stdout(healthy_full_stack_ps_json()),
    ]);
    let deploy_report =
        self_host_deploy_community(&external_ws.path_str(), Some(10_000), &deploy_runner).unwrap();
    assert!(deploy_report.stack_healthy);

    // 3. Refusal: YAML build-policy escape vectors (including exact R2 PoC).
    let hostile_build_yaml_payloads = [
            "services:\n  db:\n    build:\n      context: ${HOME}\n      dockerfile_inline: |\n        FROM alpine:3.20\n        COPY .ssh /captured-ssh\n",
            "services:\n  db:\n    build:\n      context: ../../apps/server\n      dockerfile: Dockerfile\n",
            "services:\n  server:\n    build: ../../apps/server\n",
            "services:\n  server:\n    build:\n      context: ${HOME}\n      dockerfile: Dockerfile\n",
            "services:\n  server:\n    build:\n      context: ../../apps/server\n      dockerfile_inline: |\n        FROM alpine:3.20\n        COPY .ssh /captured-ssh\n",
            "services:\n  server:\n    build:\n      context: ../../apps/server\n      dockerfile: Dockerfile\n      additional_contexts:\n        host_ssh: /root/.ssh\n",
            "services:\n  server:\n    build:\n      context: ../../apps/server\n      dockerfile: Dockerfile\n      ssh:\n        - default\n",
            "services:\n  server:\n    build:\n      context: ../../apps/server\n      dockerfile: Dockerfile\n      network: host\n",
            "services:\n  server:\n    build:\n      context: ../../apps/server\n      dockerfile: Dockerfile\n      privileged: true\n",
            "services:\n  server:\n    build:\n      context: ../../apps/server\n      dockerfile: Dockerfile.migrator\n",
            "services:\n  server:\n    build:\n      context: ../../apps/server\n",
            "services:\n  server:\n    build:\n      context: ${KODERA_SOURCE_DIR:-/tmp/attacker}/apps/server\n      dockerfile: Dockerfile\n",
            "services:\n  server:\n    build:\n      context: ../../apps/server\n      dockerfile: Dockerfile\n      args:\n        VITE_CORE_API_URL: https://chat.example.org/api/v1\n",
            "services:\n  web:\n    build:\n      context: ../..\n      dockerfile: apps/web/Dockerfile\n      args:\n        HTTP_PROXY: http://127.0.0.1:8080\n",
            "services:\n  server:\n    image: alpine:3.20\n    env_file:\n      - /etc/passwd\n",
        ];

    for bad_yaml in hostile_build_yaml_payloads {
        let fixture = TempStackFixture::new_with_compose();
        fs::write(fixture.dir.join("docker-compose.yml"), bad_yaml).unwrap();
        assert_eq!(
            validate_compose_file_policy(&fixture.dir.join("docker-compose.yml")),
            Err(CommunityDeployError::ComposeConfigInvalid),
            "expected ComposeConfigInvalid for build YAML:\n{bad_yaml}"
        );
    }

    // 4. Refusal: Resolved JSON build/bind escape vectors.
    let fake_policy_parent = TempStackFixture::new_with_compose();
    let fake_policy_dir = fake_policy_parent.dir.join("packages/synapse-policy");
    fs::create_dir_all(&fake_policy_dir).unwrap();

    let hostile_build_jsons = [
            serde_json::json!({
                "services": {
                    "db": {
                        "build": {
                            "context": canonical_ext_dir.to_str().unwrap(),
                            "dockerfile_inline": "FROM alpine:3.20\nCOPY .ssh /captured-ssh\n"
                        }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "services": {
                    "server": {
                        "build": {
                            "context": server_ctx.to_str().unwrap(),
                            "dockerfile": "Dockerfile",
                            "dockerfile_inline": "FROM alpine:3.20\n"
                        }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "services": {
                    "server": {
                        "build": {
                            "context": server_ctx.to_str().unwrap(),
                            "dockerfile": "Dockerfile",
                            "additional_contexts": { "ssh": "/tmp" }
                        }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "services": {
                    "server": {
                        "build": {
                            "context": server_ctx.to_str().unwrap(),
                            "dockerfile": "Dockerfile",
                            "ssh": ["default"]
                        }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "services": {
                    "server": {
                        "build": {
                            "context": canonical_repo_root.to_str().unwrap(),
                            "dockerfile": "Dockerfile"
                        }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "services": {
                    "server": {
                        "build": {
                            "context": server_ctx.to_str().unwrap(),
                            "dockerfile": "Dockerfile.migrator"
                        }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "services": {
                    "web": {
                        "build": {
                            "context": canonical_repo_root.to_str().unwrap(),
                            "dockerfile": "apps/web/Dockerfile",
                            "args": {
                                "BUILDKIT_SYNTAX": "attacker/frontend:latest"
                            }
                        }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "services": {
                    "synapse": {
                        "image": "matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62",
                        "volumes": [{
                            "type": "bind",
                            "source": fake_policy_dir.to_str().unwrap(),
                            "target": "/opt/kodera-policy",
                            "read_only": true
                        }]
                    }
                }
            })
            .to_string(),
        ];

    for bad_json in hostile_build_jsons {
        assert_eq!(
            validate_resolved_compose_config_json_with_source(
                &bad_json,
                &canonical_ext_dir,
                Some(&canonical_repo_root),
            ),
            Err(CommunityDeployError::ComposeConfigInvalid),
            "expected ComposeConfigInvalid for resolved build JSON: {bad_json}"
        );
    }

    // 5. Refusal: `.env` pointing `KODERA_SOURCE_DIR` to non-Kodera dir or `KODERA_MEDIA_SECRETS_SOURCE` to host path.
    for bad_dotenv in [
        format!("KODERA_SOURCE_DIR='{}'\n", canonical_ext_dir.display()),
        "KODERA_MEDIA_SECRETS_SOURCE=/etc\n".to_owned(),
        "COMPOSE_FILE=/etc/passwd\n".to_owned(),
    ] {
        let bad_ws = TempStackFixture::new_with_compose();
        let bad_env = bad_ws.dir.join(".env");
        fs::write(&bad_env, &bad_dotenv).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&bad_env, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let runner = MockDockerRunner::with_responses([]);
        assert_eq!(
            self_host_deploy_community(&bad_ws.path_str(), Some(5_000), &runner),
            Err(CommunityDeployError::ComposeConfigInvalid),
            "expected ComposeConfigInvalid for dotenv: {bad_dotenv}"
        );
        assert!(runner.recorded_calls().is_empty());
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let sym_parent = TempStackFixture::new_with_compose();
        let sym_source_link = sym_parent.dir.join("linked-source");
        symlink(&canonical_repo_root, &sym_source_link).unwrap();

        let sym_ws = TempStackFixture::new_with_compose();
        let sym_env = sym_ws.dir.join(".env");
        fs::write(
            &sym_env,
            format!("KODERA_SOURCE_DIR='{}'\n", sym_source_link.display()),
        )
        .unwrap();
        fs::set_permissions(&sym_env, fs::Permissions::from_mode(0o600)).unwrap();

        let runner = MockDockerRunner::with_responses([]);
        assert_eq!(
            self_host_deploy_community(&sym_ws.path_str(), Some(5_000), &runner),
            Err(CommunityDeployError::SymlinkRejected)
        );
        assert!(runner.recorded_calls().is_empty());
    }
}

#[test]
fn compose_image_digest_ports_entrypoint_and_sensitive_root_policies_enforce_strict_invariants() {
    // 1. Forbidden host-escape service directives and capabilities are never admitted.
    for forbidden_directive in FORBIDDEN_PRIVILEGED_COMPOSE_DIRECTIVES {
        assert!(
            ADMITTED_COMPOSE_SERVICE_DIRECTIVES
                .binary_search(forbidden_directive)
                .is_err(),
            "directive {forbidden_directive} must never be admitted"
        );
    }
    for forbidden_cap in [
        "SYS_ADMIN",
        "NET_ADMIN",
        "SYS_PTRACE",
        "SYS_MODULE",
        "DAC_READ_SEARCH",
        "SETUID",
        "SETGID",
        "NET_RAW",
        "ALL",
    ] {
        assert!(
            !is_admitted_cap_add_token(forbidden_cap),
            "capability {forbidden_cap} must never be admitted"
        );
    }

    for zero_env_svc in [
        "agent-state-init",
        "keycloak",
        "keycloak-db",
        "media-socket-init",
        "media-storage-worker",
        "proximity-broker",
        "proximity-socket-init",
        "valkey",
    ] {
        assert!(
            admitted_service_environment_keys(zero_env_svc).is_empty(),
            "service {zero_env_svc} has no canonical environment block and must admit zero keys"
        );
    }
    assert_eq!(
        admitted_service_environment_keys("web"),
        ["KODERA_ATTACHMENT_BASE"]
    );

    // 2. World-writable temp roots, macOS `/private/*` & `/var/folders`, UNC roots, and credential segments are sensitive.
    for sensitive in [
        "/tmp",
        "/tmp/kodera-stack",
        "/private/tmp/kodera-stack",
        "/var/tmp/kodera-stack",
        "/private/var/tmp/kodera-stack",
        "/var/folders/ab/cd/T/kodera-stack",
        "/private/var/folders/ab/cd/T/kodera-stack",
        "/dev/shm/kodera-stack",
        "/etc",
        "/private/etc",
        "/private/var/root",
        "/Users/alice",
        "/home/alice",
        "//fileserver/share/kodera",
        "\\\\fileserver\\share\\kodera",
        "\\\\?\\UNC\\fileserver\\share\\kodera",
        "/srv/kodera/.ssh/stack",
        "/srv/kodera/.aws/stack",
        "/srv/kodera/.gnupg/stack",
        "/srv/kodera/.kube/stack",
        "/srv/kodera/.docker/stack",
        "/srv/kodera/Keychains/stack",
    ] {
        assert!(
            is_sensitive_stack_root(Path::new(sensitive)),
            "expected sensitive root rejection for {sensitive}"
        );
    }
    for unc in ["//fileserver/share/kodera", "\\\\fileserver\\share\\kodera"] {
        assert_eq!(
            canonicalize_authorized_stack_dir(unc),
            Err(CommunityDeployError::InvalidStackDir)
        );
    }

    // 3. Candidate `.env` cleanup on `publish_candidate_dotenv_no_replace` failure leaves zero leftover files.
    let race_fixture = TempStackFixture::new_with_compose();
    let existing_env = race_fixture.dir.join(".env");
    fs::write(&existing_env, "POSTGRES_PASSWORD=keep_existing_secret\n").unwrap();
    let candidate_env =
        create_dotenv_candidate_0600(&race_fixture.dir, b"POSTGRES_PASSWORD=discard\n").unwrap();
    assert!(candidate_env.exists());
    assert_eq!(
        publish_candidate_dotenv_no_replace(&candidate_env, &existing_env),
        Err(CommunityDeployError::EnvAlreadyExists)
    );
    assert!(!candidate_env.exists());

    // 4. Positive & negative `image` digest, `entrypoint`, `command`, `user`, `environment`, and `ports` enforcement in YAML & resolved JSON.
    let fixture = TempStackFixture::new_with_compose();
    let canonical_dir = fs::canonicalize(&fixture.dir).unwrap();

    let valid_ports_and_synapse_json = serde_json::json!({
            "name": "community",
            "services": {
                "caddy": {
                    "image": "caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0",
                    "command": ["caddy", "reverse-proxy", "--domain", "kodera.example.org"],
                    "ports": [
                        { "mode": "ingress", "target": 80, "published": "80", "protocol": "tcp" },
                        { "mode": "ingress", "target": 443, "published": "443", "protocol": "tcp" },
                        { "mode": "ingress", "target": 443, "published": "443", "protocol": "udp" },
                        { "host_ip": "127.0.0.1", "target": 80, "published": "8080", "protocol": "tcp" }
                    ]
                },
                "livekit": {
                    "image": "livekit/livekit-server:v1.13.11@sha256:25cd902de7cacbd5f1f779f6a6ac1eae20ba8f56b0935934ce6b0ab80d1e3d20",
                    "command": ["--config", "/etc/livekit.yaml"],
                    "ports": [
                        { "mode": "ingress", "target": 7881, "published": "7881", "protocol": "tcp" },
                        { "mode": "ingress", "target": 50000, "published": "50000-50200", "protocol": "udp" }
                    ]
                },
                "valkey": {
                    "image": "valkey/valkey:8.1-alpine@sha256:1b426a5a4d7d4fcad15e9d40f0bd8bc2e5c1f09061f5cc8b2a5f6653d5bd5949",
                    "command": ["valkey-server", "--save", "60", "1", "--loglevel", "warning"]
                },
                "media-socket-init": {
                    "image": "ghcr.io/kodera/server:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a",
                    "user": "0:0",
                    "command": [
                        "python",
                        "-c",
                        "import os; from pathlib import Path; Path('/run/kodera-media/media.sock').unlink(missing_ok=True); [(os.chmod(p, 0o700), os.chown(p, 10001, 10001)) for p in ('/run/kodera-media', '/run/kodera-media-secrets')]"
                    ]
                },
                "server": {
                    "image": "ghcr.io/kodera/server:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a",
                    "environment": {
                        "KODERA_EDITION": "community",
                        "KODERA_BILLING_ENABLED": "false",
                        "KODERA_MEDIA_ROOM_VERIFIER_URL": "http://room-access:8096/internal/room-member"
                    }
                },
                "synapse": {
                    "image": "matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62",
                    "environment": {
                        "PYTHONPATH": "/tmp/kodera-policy",
                        "SYNAPSE_REPORT_STATS": "no"
                    },
                    "entrypoint": [
                        "/bin/sh",
                        "-c",
                        CANONICAL_SYNAPSE_ENTRYPOINT_SCRIPT
                    ]
                }
            }
        })
        .to_string();
    assert_eq!(
        validate_resolved_compose_config_json(&valid_ports_and_synapse_json, &canonical_dir),
        Ok(())
    );

    let comment_bypass_synapse_yaml = format!(
            "services:\n  synapse:\n    image: matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62\n    entrypoint:\n      - /bin/sh\n      - -c\n      - |\n        id\n        {}\n",
            CANONICAL_SYNAPSE_ENTRYPOINT_SCRIPT.replace('\n', "\n        ")
        );
    let bad_yaml_cases = [
            // Unpinned tag (missing `@sha256:...`).
            "services:\n  db:\n    image: postgres:17.12-alpine\n",
            // Wrong image repository for `db`.
            "services:\n  db:\n    image: alpine:3.20@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n",
            // Non-synapse entrypoint override.
            "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n    entrypoint:\n      - /bin/sh\n",
            // Comment-bypass `synapse` entrypoint (substring match would falsely pass).
            "services:\n  synapse:\n    image: matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62\n    entrypoint:\n      - /bin/sh\n      - -c\n      - |\n        exec /bin/true\n        # /opt/community/configure_synapse.py /data/homeserver.yaml\n        # exec /start.py\n",
            comment_bypass_synapse_yaml.as_str(),
            // `command` override on `db` (service without canonical `command`) or tampered `valkey` `command`.
            "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n    command:\n      - sh\n      - -c\n      - id\n",
            "services:\n  valkey:\n    image: valkey/valkey:8.1-alpine@sha256:1b426a5a4d7d4fcad15e9d40f0bd8bc2e5c1f09061f5cc8b2a5f6653d5bd5949\n    command: valkey-server --loadmodule /tmp/evil.so\n",
            // `user` root escalation on `db`.
            "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n    user: \"0:0\"\n",
            // Code-execution `environment` injection (`LD_PRELOAD`, `NODE_OPTIONS`, `PYTHONPATH`, CPython `PYTHONWARNINGS` + `BROWSER`, zero-env service).
            "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n    environment:\n      LD_PRELOAD: /tmp/evil.so\n",
            "services:\n  synapse:\n    image: matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62\n    environment:\n      PYTHONPATH: /tmp/evil\n",
            "services:\n  synapse:\n    image: matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62\n    environment:\n      PYTHONWARNINGS: \"ignore::antigravity.Example\"\n      BROWSER: '/bin/sh -c \"printf R5_ENV_BYPASS >&2\" %s'\n",
            "services:\n  valkey:\n    image: valkey/valkey:8.1-alpine@sha256:1b426a5a4d7d4fcad15e9d40f0bd8bc2e5c1f09061f5cc8b2a5f6653d5bd5949\n    environment:\n      POSTGRES_USER: kodera\n",
            "services:\n  server:\n    image: ghcr.io/kodera/server:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a\n    environment:\n      KODERA_BILLING_ENABLED: \"true\"\n",
            "services:\n  web:\n    image: ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a\n    environment:\n      NODE_OPTIONS: \"--require /tmp/evil.js\"\n",
            "services:\n  web:\n    image: ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a\n    environment:\n      KODERA_ATTACHMENT_BASE: \"http://insecure.example.org/bucket/\"\n",
            "services:\n  web:\n    image: ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a\n    environment:\n      KODERA_ATTACHMENT_BASE: \"https://media.example.org//\"\n",
            "services:\n  web:\n    image: ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a\n    environment:\n      KODERA_ATTACHMENT_BASE: \"https://media.example.org/bucket//\"\n",
            "services:\n  web:\n    image: ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a\n    environment:\n      KODERA_ATTACHMENT_BASE: \"https://media.example.org/%2e/\"\n",
            "services:\n  web:\n    image: ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a\n    entrypoint:\n      - \"/bin/sh\"\n      - \"-ec\"\n      - \"id; exec node /app/static.mjs\"\n      - \"sh\"\n",
            // Publishing Postgres 5432, SSH 22, or mixed single-port range `3478-7882:7881/tcp` on host.
            "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n    ports:\n      - \"5432:5432\"\n",
            "services:\n  caddy:\n    image: caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0\n    ports:\n      - \"22:80\"\n",
            "services:\n  livekit:\n    image: livekit/livekit-server:v1.13.11@sha256:25cd902de7cacbd5f1f779f6a6ac1eae20ba8f56b0935934ce6b0ab80d1e3d20\n    ports:\n      - \"3478-7882:7881/tcp\"\n",
            "services:\n  caddy:\n    image: caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0\n    ports:\n      - \"127.0.0.1:8080-8090:80\"\n",
            // Plain scalar ending in `|` must NOT swallow a subsequent unapproved directive.
            "services:\n  db:\n    image: postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7\n    command: echo foo|\n      privileged: true\n",
        ];
    for bad_yaml in bad_yaml_cases {
        let f = TempStackFixture::new_with_compose();
        fs::write(f.dir.join("docker-compose.yml"), bad_yaml).unwrap();
        assert_eq!(
            validate_compose_file_policy(&f.dir.join("docker-compose.yml")),
            Err(CommunityDeployError::ComposeConfigInvalid),
            "expected ComposeConfigInvalid for YAML:\n{bad_yaml}"
        );
    }

    let prefixed_synapse_json = serde_json::json!({
            "services": {
                "synapse": {
                    "image": "matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62",
                    "entrypoint": [
                        "/bin/sh",
                        "-c",
                        format!("id\n{CANONICAL_SYNAPSE_ENTRYPOINT_SCRIPT}")
                    ]
                }
            }
        })
        .to_string();
    let bad_synapse_pythonpath_json = serde_json::json!({
            "services": {
                "synapse": {
                    "image": "matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62",
                    "environment": { "PYTHONPATH": "/tmp/evil" },
                    "entrypoint": ["/bin/sh", "-c", CANONICAL_SYNAPSE_ENTRYPOINT_SCRIPT]
                }
            }
        })
        .to_string();
    let bad_synapse_pythonwarnings_browser_json = serde_json::json!({
            "services": {
                "synapse": {
                    "image": "matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62",
                    "environment": {
                        "PYTHONWARNINGS": "ignore::antigravity.Example",
                        "BROWSER": "/bin/sh -c \"printf R5_ENV_BYPASS >&2\" %s"
                    },
                    "entrypoint": ["/bin/sh", "-c", CANONICAL_SYNAPSE_ENTRYPOINT_SCRIPT]
                }
            }
        })
        .to_string();
    let bad_json_cases = [
        // Missing `@sha256:...` digest.
        r#"{"services":{"db":{"image":"postgres:17.12-alpine"}}}"#,
        // Wrong repository for `db`.
        r#"{"services":{"db":{"image":"attacker/evil:1.0@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7"}}}"#,
        // Service omitting both `image` and `build`.
        r#"{"services":{"db":{"restart":"unless-stopped"}}}"#,
        // `entrypoint` on non-`synapse` service.
        r#"{"services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7","entrypoint":["/bin/sh","-c","id"]}}}"#,
        // Tampered `synapse` entrypoint omitting policy configurator or using comment/prefix bypass.
        r#"{"services":{"synapse":{"image":"matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62","entrypoint":["/bin/sh","-c","exec /bin/sh"]}}}"#,
        r#"{"services":{"synapse":{"image":"matrixdotorg/synapse:v1.165.0@sha256:673b4223c81a7634fd07d832b939a58f97081cfdaae7cdd2d1664cdcf7611b62","entrypoint":["/bin/sh","-c","exec /bin/true\n# /opt/community/configure_synapse.py /data/homeserver.yaml\n# exec /start.py\n"]}}}"#,
        prefixed_synapse_json.as_str(),
        // `command` override on `db` or tampered `command` on `valkey`.
        r#"{"services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7","command":["/bin/sh","-c","id"]}}}"#,
        r#"{"services":{"valkey":{"image":"valkey/valkey:8.1-alpine@sha256:1b426a5a4d7d4fcad15e9d40f0bd8bc2e5c1f09061f5cc8b2a5f6653d5bd5949","command":["valkey-server","--loadmodule","/tmp/evil.so"]}}}"#,
        // `user` escalation on non-init service (`db`).
        r#"{"services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7","user":"0:0"}}}"#,
        // Dangerous `environment` keys (`LD_PRELOAD`, `NODE_OPTIONS`, `BASH_ENV`, `PYTHONPATH` on `db`, non-canonical `PYTHONPATH` on `synapse`).
        r#"{"services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7","environment":{"LD_PRELOAD":"/tmp/evil.so"}}}}"#,
        r#"{"services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7","environment":{"NODE_OPTIONS":"--require /tmp/evil.js"}}}}"#,
        r#"{"services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7","environment":["BASH_ENV=/tmp/evil.sh"]}}}"#,
        r#"{"services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7","environment":{"PYTHONPATH":"/tmp/kodera-policy"}}}}"#,
        bad_synapse_pythonpath_json.as_str(),
        bad_synapse_pythonwarnings_browser_json.as_str(),
        r#"{"services":{"valkey":{"image":"valkey/valkey:8.1-alpine@sha256:1b426a5a4d7d4fcad15e9d40f0bd8bc2e5c1f09061f5cc8b2a5f6653d5bd5949","environment":{"POSTGRES_USER":"kodera"}}}}"#,
        r#"{"services":{"server":{"image":"ghcr.io/kodera/server:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a","environment":{"KODERA_BILLING_ENABLED":"true"}}}}"#,
        r#"{"services":{"web":{"image":"ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a","environment":{"NODE_OPTIONS":"--require /tmp/evil.js"}}}}"#,
        r#"{"services":{"web":{"image":"ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a","environment":{"KODERA_ATTACHMENT_BASE":"https://media.example.org/no-trailing-slash"}}}}"#,
        r#"{"services":{"web":{"image":"ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a","environment":{"KODERA_ATTACHMENT_BASE":"https://media.example.org//"}}}}"#,
        r#"{"services":{"web":{"image":"ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a","environment":{"KODERA_ATTACHMENT_BASE":"https://media.example.org/bucket//"}}}}"#,
        r#"{"services":{"web":{"image":"ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a","environment":{"KODERA_ATTACHMENT_BASE":"https://media.example.org/%2e%2e/"}}}}"#,
        r#"{"services":{"web":{"image":"ghcr.io/kodera/web:0.1.0@sha256:f1b43b8d9a5b7a5e8f17c91e6b3f0f8f0f9d4a6e3e9f6d7c8b9a0f1e2d3c4b5a","entrypoint":["/bin/sh","-ec","id","sh"]}}}"#,
        // Publishing `5432` on `db`, `22` on `caddy`, `"3478-7882"` TCP range on `livekit`, or `"8080-8090"` range on loopback `caddy`.
        r#"{"services":{"db":{"image":"postgres:17.12-alpine@sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7","ports":[{"target":5432,"published":"5432","protocol":"tcp"}]}}}"#,
        r#"{"services":{"caddy":{"image":"caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0","ports":[{"target":80,"published":"22","protocol":"tcp"}]}}}"#,
        r#"{"services":{"caddy":{"image":"caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0","ports":[{"host_ip":"127.0.0.1","target":80,"published":"22","protocol":"tcp"}]}}}"#,
        r#"{"services":{"livekit":{"image":"livekit/livekit-server:v1.13.11@sha256:25cd902de7cacbd5f1f779f6a6ac1eae20ba8f56b0935934ce6b0ab80d1e3d20","ports":[{"target":7881,"published":"3478-7882","protocol":"tcp"}]}}}"#,
        r#"{"services":{"caddy":{"image":"caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0","ports":[{"host_ip":"127.0.0.1","target":80,"published":"8080-8090","protocol":"tcp"}]}}}"#,
    ];
    for bad_json in bad_json_cases {
        assert_eq!(
            validate_resolved_compose_config_json(bad_json, &canonical_dir),
            Err(CommunityDeployError::ComposeConfigInvalid),
            "expected ComposeConfigInvalid for JSON: {bad_json}"
        );
    }

    // 5. Symlink hops to `/etc` (`/private/etc` on macOS) and `.ssh` are rejected.
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let hop_fixture = TempStackFixture::new_with_compose();
        let etc_link = hop_fixture.dir.join("etc-hop");
        symlink("/etc", &etc_link).unwrap();
        assert_eq!(
            canonicalize_authorized_stack_dir(etc_link.to_str().unwrap()),
            Err(CommunityDeployError::SymlinkRejected)
        );
        if let Ok(canon_etc) = fs::canonicalize("/etc") {
            assert!(is_sensitive_stack_root(&canon_etc));
        }

        let dot_ssh_target = hop_fixture.dir.join(".ssh");
        fs::create_dir_all(&dot_ssh_target).unwrap();
        let ssh_caddy_link = hop_fixture.dir.join("Caddyfile");
        fs::write(dot_ssh_target.join("id_ed25519"), "secret\n").unwrap();
        symlink(dot_ssh_target.join("id_ed25519"), &ssh_caddy_link).unwrap();
        let caddy_bind_json = serde_json::json!({
                "services": {
                    "caddy": {
                        "image": "caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0",
                        "volumes": [{
                            "type": "bind",
                            "source": canonical_dir.join("Caddyfile").to_str().unwrap(),
                            "target": "/etc/caddy/Caddyfile",
                            "read_only": true
                        }]
                    }
                }
            })
            .to_string();
        let canon_hop = fs::canonicalize(&hop_fixture.dir).unwrap();
        let hop_bind_json =
            caddy_bind_json.replace(canonical_dir.to_str().unwrap(), canon_hop.to_str().unwrap());
        assert_eq!(
            validate_resolved_compose_config_json(&hop_bind_json, &canon_hop),
            Err(CommunityDeployError::SymlinkRejected)
        );
    }
}
