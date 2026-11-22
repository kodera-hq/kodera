use super::*;
use std::collections::BTreeMap;

#[test]
fn token_never_leaks_in_debug_or_display() {
    let spec = SelfHostDeploymentSpec::validate(
        CloudProvider::Scaleway,
        "fr-par-1",
        "chat.acme-corp.eu",
        "ops@acme-corp.eu",
        "scw_secret_0123456789abcdef0123456789",
    )
    .expect("valid spec");

    let dbg_str = format!("{spec:?}");
    let disp_str = format!("{}", spec.token);
    assert!(!dbg_str.contains("scw_secret_"));
    assert!(!disp_str.contains("scw_secret_"));
    assert!(dbg_str.contains("REDACTED"));
    assert_eq!(spec.provider.api_origin(), "https://api.scaleway.com");
}

#[test]
fn redacted_api_token_forbids_clone_and_zeroizes_construction_and_rejection_buffers() {
    // Compile-time negative trait check: if `RedactedApiToken` implemented `Clone`,
    // `NotCloneCheck::IS_NOT_CLONE` would fail to resolve unambiguously.
    trait NotCloneFallback {
        const IS_NOT_CLONE: bool = true;
    }
    impl<T> NotCloneFallback for T {}
    struct NotCloneProbe<T>(core::marker::PhantomData<T>);
    #[allow(dead_code)]
    impl<T: Clone> NotCloneProbe<T> {
        const IS_NOT_CLONE: bool = false;
    }
    const { assert!(NotCloneProbe::<RedactedApiToken>::IS_NOT_CLONE) };

    // 1. Valid construction wipes the owned input slice and clear() wipes the stored bytes.
    let mut valid_buf = b"  scw_secret_0123456789abcdef0123456789  ".to_vec();
    let mut token = RedactedApiToken::validate_and_zeroize_slice(&mut valid_buf).unwrap();
    assert!(
        valid_buf.iter().all(|&b| b == 0),
        "owned input buffer must be zeroized on valid construction"
    );
    assert_eq!(
        token.expose_for_provider_call(),
        "scw_secret_0123456789abcdef0123456789"
    );
    token.clear();
    assert_eq!(token.expose_for_provider_call(), "");

    // 2. Invalid token rejections also wipe the owned input slice on every error path.
    let mut short_buf = b"short_secret".to_vec();
    assert_eq!(
        RedactedApiToken::validate_and_zeroize_slice(&mut short_buf).unwrap_err(),
        DeployValidationError::TokenTooShort
    );
    assert!(short_buf.iter().all(|&b| b == 0));

    let mut ws_buf = b"scw_secret_with internal_space_012345".to_vec();
    assert_eq!(
        RedactedApiToken::validate_and_zeroize_slice(&mut ws_buf).unwrap_err(),
        DeployValidationError::TokenContainsWhitespace
    );
    assert!(ws_buf.iter().all(|&b| b == 0));

    let mut nul_buf = b"scw_0123456789ab\0def012345".to_vec();
    assert_eq!(
        RedactedApiToken::validate_and_zeroize_slice(&mut nul_buf).unwrap_err(),
        DeployValidationError::TokenInvalidCharacters
    );
    assert!(nul_buf.iter().all(|&b| b == 0));
}

#[test]
fn rejects_invalid_domains_and_short_tokens() {
    assert_eq!(
        SelfHostDeploymentSpec::validate(
            CloudProvider::Hetzner,
            "fsn1",
            "localhost",
            "ops@acme.eu",
            "htz_0123456789abcdef012345"
        )
        .unwrap_err(),
        DeployValidationError::InvalidDomain
    );
    assert_eq!(
        SelfHostDeploymentSpec::validate(
            CloudProvider::OvhCloud,
            "gra11",
            "kodera.acme.eu",
            "ops@acme.eu",
            "short"
        )
        .unwrap_err(),
        DeployValidationError::TokenTooShort
    );
    for bad_ip in ["127.0.0.1", "169.254.169.254"] {
        assert_eq!(
            SelfHostDeploymentSpec::validate(
                CloudProvider::Scaleway,
                "fr-par-1",
                bad_ip,
                "ops@acme.eu",
                "scw_0123456789abcdef012345"
            )
            .unwrap_err(),
            DeployValidationError::InvalidDomain
        );
    }
    for bad_email in ["ops}@acme.eu", "ops$(id)@acme.eu", "ops\0@acme.eu"] {
        assert_eq!(
            SelfHostDeploymentSpec::validate(
                CloudProvider::Scaleway,
                "fr-par-1",
                "kodera.acme.eu",
                bad_email,
                "scw_0123456789abcdef012345"
            )
            .unwrap_err(),
            DeployValidationError::InvalidAdminEmail
        );
    }
    assert_eq!(
        SelfHostDeploymentSpec::validate(
            CloudProvider::Scaleway,
            "fr-par-1",
            "kodera.acme.eu",
            "ops@acme.eu",
            "scw_0123456789ab\0def012345"
        )
        .unwrap_err(),
        DeployValidationError::TokenInvalidCharacters
    );
}

fn valid_spec() -> SelfHostDeploymentSpec {
    SelfHostDeploymentSpec::validate(
        CloudProvider::Scaleway,
        "fr-par-1",
        " CHAT.EXAMPLE.ORG ",
        "ops@example.org",
        "fixture-token-never-in-preview",
    )
    .unwrap()
}

#[test]
fn deployment_plan_is_deterministic_public_and_secret_free() {
    for provider in [
        CloudProvider::Scaleway,
        CloudProvider::Hetzner,
        CloudProvider::Hostinger,
        CloudProvider::OvhCloud,
    ] {
        let mut spec = valid_spec();
        spec.provider = provider;
        let plan = SelfHostDeploymentPlan::from_spec(&spec).unwrap();
        assert_eq!(plan, SelfHostDeploymentPlan::from_spec(&spec).unwrap());
        assert_eq!(plan.provider, provider);
        assert_eq!(plan.region, "fr-par-1");
        let names = [
            "chat.example.org",
            "matrix.chat.example.org",
            "visio.chat.example.org",
            "docs.chat.example.org",
            "auth.chat.example.org",
        ];
        assert_eq!(
            plan.required_dns
                .iter()
                .map(|record| record.fqdn.as_str())
                .collect::<Vec<_>>(),
            names
        );
        assert!(plan
            .required_dns
            .iter()
            .all(|record| record.target == PublicDnsTarget::AllocatedServerPublicAddresses));
        assert_eq!(
            plan.https_origins,
            names.map(|name| format!("https://{name}"))
        );
        assert_eq!(
            plan.community_public_config,
            BTreeMap::from([
                ("KODERA_DOMAIN".to_owned(), "chat.example.org".to_owned()),
                ("KODERA_ACME_EMAIL".to_owned(), "ops@example.org".to_owned())
            ])
        );
        for diagnostic in [
            format!("{spec:?}"),
            format!("{}", spec.token),
            format!("{plan:?}"),
            format!("{:?}", plan.community_public_config),
        ] {
            assert!(!diagnostic.contains("fixture-token-never-in-preview"));
        }
        assert_eq!(
            spec.token.expose_for_provider_call(),
            "fixture-token-never-in-preview"
        );
    }
}

#[test]
fn deployment_plan_revalidates_mutable_spec_and_derived_domain_lengths() {
    let mut spec = valid_spec();
    for fqdn in [
        "localhost",
        "https://chat.example.org",
        "127.0.0.1",
        "bad.example.org/path",
        "bad\n.example.org",
    ] {
        spec.fqdn = fqdn.to_owned();
        assert_eq!(
            SelfHostDeploymentPlan::from_spec(&spec),
            Err(DeployValidationError::InvalidDomain)
        );
    }
    spec = valid_spec();
    spec.region = "fr-par-1; id".to_owned();
    assert_eq!(
        SelfHostDeploymentPlan::from_spec(&spec),
        Err(DeployValidationError::InvalidRegion)
    );
    spec = valid_spec();
    spec.acme_email = "ops@example.org\nKODERA_DOMAIN=invalid".to_owned();
    assert_eq!(
        SelfHostDeploymentPlan::from_spec(&spec),
        Err(DeployValidationError::InvalidAdminEmail)
    );
    let domain = format!(
        "{}.{}.{}.{}",
        "a".repeat(63),
        "b".repeat(63),
        "c".repeat(63),
        "d".repeat(61)
    );
    assert_eq!(domain.len(), 253);
    spec = SelfHostDeploymentSpec::validate(
        CloudProvider::Scaleway,
        "fr-par-1",
        &domain,
        "ops@example.org",
        "fixture-token-never-in-preview",
    )
    .unwrap();
    assert_eq!(
        SelfHostDeploymentPlan::from_spec(&spec),
        Err(DeployValidationError::InvalidDomain)
    );
    spec.fqdn = format!(
        "{}.{}.{}.{}",
        "a".repeat(63),
        "b".repeat(63),
        "c".repeat(63),
        "d".repeat(54)
    );
    let plan = SelfHostDeploymentPlan::from_spec(&spec).unwrap();
    assert_eq!(plan.required_dns[1].fqdn.len(), 253);
}
