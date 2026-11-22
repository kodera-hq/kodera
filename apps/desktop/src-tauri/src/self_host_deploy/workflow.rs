//! Preflight, `.env` preparation, and `docker compose up -d --wait` readiness orchestration.

use super::compose_json::validate_resolved_compose_config_json_with_source;
use super::dotenv::{
    create_dotenv_candidate_0600, publish_candidate_dotenv_no_replace, render_community_dotenv,
    verify_prepared_dotenv,
};
use super::input_and_stack::{
    derive_matrix_base_domain, validate_acme_email, validate_and_normalize_domain,
    validate_oidc_provider_origin, validate_ports, validate_stack_dir_and_compose,
};
use super::ps_parser::evaluate_core_services_from_ps;
use super::{
    CommunityCommandRunner, CommunityDeployError, CommunityDeployReport, CommunityPreflightReport,
    CommunityPreflightSpec, CommunityPrepareReport, CommunityPrepareSpec,
    COMPOSE_CONFIG_TIMEOUT_MS, DEFAULT_DEPLOY_TIMEOUT_MS, MAX_DEPLOY_TIMEOUT_MS,
    MIN_DEPLOY_TIMEOUT_MS, PREFLIGHT_COMMAND_TIMEOUT_MS, READINESS_MAX_POLL_ATTEMPTS,
};
use crate::self_host_health::{
    classify_docker_stderr, inspect_community_compose_ps, DockerUnavailableReason, ServiceReadiness,
};
use std::collections::BTreeMap;
use std::fs;
use std::thread;
use std::time::{Duration, Instant};

/// Runs local Docker Engine & `deploy/community` preflight checks without side effects on stack files.
pub fn self_host_preflight_community(
    spec: &CommunityPreflightSpec<'_>,
    runner: &dyn CommunityCommandRunner,
) -> Result<CommunityPreflightReport, CommunityDeployError> {
    validate_ports(spec.http_port, spec.https_port)?;
    let normalized_domain = validate_and_normalize_domain(spec.domain)?;
    let _validated_email = validate_acme_email(spec.acme_email)?;
    let (stack_path, _compose_path) = validate_stack_dir_and_compose(spec.stack_dir, true)?;

    let timeout = Duration::from_millis(PREFLIGHT_COMMAND_TIMEOUT_MS);
    let docker_out = runner
        .run_argv(
            "docker",
            &["--version".to_owned()],
            Some(&stack_path),
            timeout,
        )
        .map_err(CommunityDeployError::DockerUnavailable)?;
    if docker_out.timed_out {
        return Err(CommunityDeployError::DockerUnavailable(
            DockerUnavailableReason::ProbeTimedOut,
        ));
    }
    if !docker_out.is_success() {
        let reason = classify_docker_stderr(&docker_out.stderr);
        if reason == DockerUnavailableReason::PermissionDenied {
            return Err(CommunityDeployError::DockerUnavailable(reason));
        }
        return Err(CommunityDeployError::DockerVersionUnsupported);
    }
    let docker_version = sanitize_version_line(&docker_out.stdout)
        .ok_or(CommunityDeployError::DockerVersionUnsupported)?;

    let compose_out = runner
        .run_argv(
            "docker",
            &["compose".to_owned(), "version".to_owned()],
            Some(&stack_path),
            timeout,
        )
        .map_err(CommunityDeployError::DockerUnavailable)?;
    if compose_out.timed_out {
        return Err(CommunityDeployError::DockerUnavailable(
            DockerUnavailableReason::ProbeTimedOut,
        ));
    }
    if !compose_out.is_success() {
        return Err(CommunityDeployError::ComposePluginMissing);
    }
    let compose_version = sanitize_version_line(&compose_out.stdout)
        .ok_or(CommunityDeployError::ComposePluginMissing)?;

    let matrix_base_domain = derive_matrix_base_domain(&normalized_domain);

    Ok(CommunityPreflightReport {
        docker_version,
        compose_version,
        compose_file_present: true,
        stack_dir_writable: true,
        normalized_domain,
        matrix_base_domain,
        tls_mode: spec.tls_mode,
        http_port: spec.http_port,
        https_port: spec.https_port,
    })
}

/// Generates CSPRNG secrets for Postgres, Synapse, LiveKit, Server, and Keycloak community bootstrap,
/// validates the rendered stack via `docker compose config --quiet` against an isolated `0600`
/// temporary candidate file, and publishes `<stack_dir>/.env` atomically with strict `create_new`
/// semantics without ever overwriting an existing `.env`.
pub fn self_host_prepare_community(
    spec: &CommunityPrepareSpec<'_>,
    runner: &dyn CommunityCommandRunner,
) -> Result<CommunityPrepareReport, CommunityDeployError> {
    validate_ports(spec.http_port, spec.https_port)?;
    let normalized_domain = validate_and_normalize_domain(spec.domain)?;
    let acme_email = validate_acme_email(spec.acme_email)?;
    let oidc_origin = validate_oidc_provider_origin(spec.oidc_provider_origin)?;
    let (stack_path, compose_path) = validate_stack_dir_and_compose(spec.stack_dir, true)?;

    let env_path = stack_path.join(".env");
    match fs::symlink_metadata(&env_path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err(CommunityDeployError::SymlinkRejected);
            }
            return Err(CommunityDeployError::EnvAlreadyExists);
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(CommunityDeployError::EnvWriteFailed),
    }

    let matrix_base_domain = derive_matrix_base_domain(&normalized_domain);
    let oidc_issuer = format!("{oidc_origin}/realms/community");
    let (rendered_env, secret_keys) = render_community_dotenv(
        &normalized_domain,
        &matrix_base_domain,
        &acme_email,
        &oidc_origin,
        &oidc_issuer,
        spec.tls_mode,
        spec.http_port,
        spec.https_port,
    )?;

    let candidate_path = create_dotenv_candidate_0600(&stack_path, rendered_env.as_bytes())?;

    let candidate_arg = match candidate_path.to_str() {
        Some(raw) => raw.to_owned(),
        None => {
            let _ = fs::remove_file(&candidate_path);
            return Err(CommunityDeployError::InvalidStackDir);
        }
    };
    let compose_arg = match compose_path.to_str() {
        Some(raw) => raw.to_owned(),
        None => {
            let _ = fs::remove_file(&candidate_path);
            return Err(CommunityDeployError::InvalidStackDir);
        }
    };

    let config_args = vec![
        "compose".to_owned(),
        "--env-file".to_owned(),
        candidate_arg,
        "-f".to_owned(),
        compose_arg,
        "config".to_owned(),
        "--format".to_owned(),
        "json".to_owned(),
    ];
    let config_out = match runner.run_argv(
        "docker",
        &config_args,
        Some(&stack_path),
        Duration::from_millis(COMPOSE_CONFIG_TIMEOUT_MS),
    ) {
        Ok(out) => out,
        Err(reason) => {
            let _ = fs::remove_file(&candidate_path);
            return Err(CommunityDeployError::DockerUnavailable(reason));
        }
    };

    if !config_out.is_success() {
        let _ = fs::remove_file(&candidate_path);
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    if let Err(err) =
        validate_resolved_compose_config_json_with_source(&config_out.stdout, &stack_path, None)
    {
        let _ = fs::remove_file(&candidate_path);
        return Err(err);
    }

    let unix_mode = publish_candidate_dotenv_no_replace(&candidate_path, &env_path)?;

    Ok(CommunityPrepareReport {
        env_file_written: true,
        unix_file_mode: unix_mode,
        compose_config_valid: true,
        generated_secret_keys: secret_keys,
        normalized_domain,
        matrix_base_domain,
        oidc_issuer,
        tls_mode: spec.tls_mode,
        http_port: spec.http_port,
        https_port: spec.https_port,
    })
}

/// Launches the prepared local `deploy/community` stack via `docker compose up -d --wait` and polls
/// `docker compose ps --format json` through [`inspect_community_compose_ps`] until Keycloak, Server,
/// Web, LiveKit, PostgreSQL, and Synapse report healthy.
pub fn self_host_deploy_community(
    stack_dir: &str,
    timeout_ms: Option<u64>,
    runner: &dyn CommunityCommandRunner,
) -> Result<CommunityDeployReport, CommunityDeployError> {
    let total_timeout_ms = timeout_ms
        .unwrap_or(DEFAULT_DEPLOY_TIMEOUT_MS)
        .clamp(MIN_DEPLOY_TIMEOUT_MS, MAX_DEPLOY_TIMEOUT_MS);
    let total_budget = Duration::from_millis(total_timeout_ms);
    let started_at = Instant::now();

    let (stack_path, compose_path) = validate_stack_dir_and_compose(stack_dir, false)?;
    let env_path = stack_path.join(".env");
    let dotenv_policy = verify_prepared_dotenv(&env_path)?;
    let external_oidc_configured = dotenv_policy.external_oidc_configured;

    let env_arg = env_path
        .to_str()
        .ok_or(CommunityDeployError::InvalidStackDir)?
        .to_owned();
    let compose_arg = compose_path
        .to_str()
        .ok_or(CommunityDeployError::InvalidStackDir)?
        .to_owned();

    let config_args = vec![
        "compose".to_owned(),
        "--env-file".to_owned(),
        env_arg.clone(),
        "-f".to_owned(),
        compose_arg.clone(),
        "config".to_owned(),
        "--format".to_owned(),
        "json".to_owned(),
    ];
    let config_out = runner
        .run_argv(
            "docker",
            &config_args,
            Some(&stack_path),
            Duration::from_millis(COMPOSE_CONFIG_TIMEOUT_MS),
        )
        .map_err(CommunityDeployError::DockerUnavailable)?;
    if config_out.timed_out || !config_out.is_success() {
        return Err(CommunityDeployError::ComposeConfigInvalid);
    }
    validate_resolved_compose_config_json_with_source(
        &config_out.stdout,
        &stack_path,
        dotenv_policy.configured_source_root.as_deref(),
    )?;

    let up_args = vec![
        "compose".to_owned(),
        "--env-file".to_owned(),
        env_arg.clone(),
        "-f".to_owned(),
        compose_arg.clone(),
        "up".to_owned(),
        "-d".to_owned(),
        "--wait".to_owned(),
    ];
    let up_out = runner
        .run_argv("docker", &up_args, Some(&stack_path), total_budget)
        .map_err(CommunityDeployError::DockerUnavailable)?;
    if up_out.timed_out || !up_out.is_success() {
        return Err(CommunityDeployError::ComposeLaunchFailed);
    }

    let ps_args = vec![
        "compose".to_owned(),
        "--env-file".to_owned(),
        env_arg,
        "-f".to_owned(),
        compose_arg,
        "ps".to_owned(),
        "--format".to_owned(),
        "json".to_owned(),
    ];

    for attempt in 1..=READINESS_MAX_POLL_ATTEMPTS {
        let elapsed = started_at.elapsed();
        let remaining = total_budget
            .checked_sub(elapsed)
            .unwrap_or(Duration::from_millis(250))
            .max(Duration::from_millis(250));
        let probe_timeout = remaining.min(Duration::from_millis(3_000));

        let ps_out = runner
            .run_argv("docker", &ps_args, Some(&stack_path), probe_timeout)
            .map_err(CommunityDeployError::DockerUnavailable)?;
        if ps_out.timed_out {
            return Err(CommunityDeployError::DockerUnavailable(
                DockerUnavailableReason::ProbeTimedOut,
            ));
        }
        if !ps_out.is_success() {
            return Err(CommunityDeployError::DockerUnavailable(
                classify_docker_stderr(&ps_out.stderr),
            ));
        }

        let health_report = inspect_community_compose_ps(&ps_out.stdout, &BTreeMap::new())
            .map_err(CommunityDeployError::ReadinessProbeFailed)?;
        let core_services =
            evaluate_core_services_from_ps(&ps_out.stdout, external_oidc_configured)?;

        let all_core_ready = core_services
            .iter()
            .all(|item| item.readiness == ServiceReadiness::Ready);
        if all_core_ready && health_report.is_healthy() {
            return Ok(CommunityDeployReport {
                stack_healthy: true,
                poll_attempts: attempt,
                core_services,
                health_report,
            });
        }

        let any_transient = core_services.iter().any(|item| {
            matches!(
                item.readiness,
                ServiceReadiness::Starting | ServiceReadiness::Restarting
            )
        }) || matches!(
            health_report.state,
            crate::self_host_health::StackHealthState::Starting
                | crate::self_host_health::StackHealthState::Restarting
        );

        if !any_transient
            || attempt == READINESS_MAX_POLL_ATTEMPTS
            || started_at.elapsed() >= total_budget
        {
            return Err(CommunityDeployError::StackUnhealthy);
        }

        let backoff = runner.poll_backoff();
        if !backoff.is_zero() {
            thread::sleep(backoff);
        }
    }

    Err(CommunityDeployError::StackUnhealthy)
}

fn sanitize_version_line(stdout: &str) -> Option<String> {
    let first = stdout.lines().find(|line| !line.trim().is_empty())?.trim();
    if first.is_empty() || first.len() > 160 {
        return None;
    }
    let cleaned: String = first
        .chars()
        .filter(|ch| !ch.is_control())
        .take(120)
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}
