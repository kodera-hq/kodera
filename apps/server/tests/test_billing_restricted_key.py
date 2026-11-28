"""The API holds a restricted billing key, never a full secret key: SETTINGS_AND_SECRETS.md §2.

No database, no network: the configuration function, then the deployable API profile started in a
child interpreter with each kind of key. The keys are synthetic strings shaped so no secret scanner
mistakes them for keys.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

from apps.billing import configuration

ROOT = Path(__file__).resolve().parents[1]
RESTRICTED = "rk_test_" + "SyntheticNotAKey0"
RESTRICTED_LIVE = "rk_live_" + "SyntheticNotAKey0"
# Shapes that start like a restricted key and are not one.
MALFORMED_RESTRICTED = [
    "rk_",
    "rk_test_",
    "rk_" + "SyntheticNotAKey0",
    "rk_test_" + "Synthetic NotAKey0",
    "rk_test_" + "Synthetic\tNotAKey0",
    "rk_sk_live_" + "SyntheticNotAKey0",
    "rk_prod_" + "SyntheticNotAKey0",
    "rk_test_" + "Synthetic-Not-A-Key",
]
WEBHOOK = "whsec_" + "synthetic-not-a-secret"
FULL_SECRET_KEYS = ["sk_live_" + "synthetic-not-a-key", "sk_test_" + "synthetic-not-a-key"]
MALFORMED = "KODERA_STRIPE_SECRET_KEY or KODERA_STRIPE_WEBHOOK_SECRET is malformed"


def keys(secret: str) -> dict[str, str]:
    return {"KODERA_STRIPE_SECRET_KEY": secret, "KODERA_STRIPE_WEBHOOK_SECRET": WEBHOOK}


@pytest.mark.parametrize("secret", FULL_SECRET_KEYS)
def test_the_configuration_refuses_a_full_secret_key(secret):
    with pytest.raises(ValueError) as refused:
        configuration.stripe_from_environment(keys(secret))
    assert str(refused.value) == MALFORMED
    assert secret not in str(refused.value)


@pytest.mark.parametrize("secret", MALFORMED_RESTRICTED)
def test_the_configuration_refuses_a_malformed_restricted_key(secret):
    with pytest.raises(ValueError) as refused:
        configuration.stripe_from_environment(keys(secret))
    assert str(refused.value) == MALFORMED


@pytest.mark.parametrize("secret", [RESTRICTED, RESTRICTED_LIVE, f"  {RESTRICTED}\n"])
def test_the_configuration_accepts_a_restricted_key_in_either_mode(secret):
    assert configuration.stripe_from_environment(keys(secret)) == (
        "stripe",
        secret.strip(),
        WEBHOOK,
    )


def start_api(
    secret: str,
    *,
    settings_module: str = "config.settings.deploy",
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    program = (
        "import django; django.setup(); from django.conf import settings; "
        "print('started', settings.KODERA_PAYMENT_PROVIDER, "
        "settings.KODERA_STRIPE_EXPECTED_LIVEMODE, settings.KODERA_STRIPE_PLATFORM_ACCOUNT_ID)"
    )
    env = {
        "PATH": os.defpath,
        "PYTHONPATH": str(ROOT),
        "PYTHONDONTWRITEBYTECODE": "1",
        "DJANGO_SETTINGS_MODULE": settings_module,
        "DJANGO_SECRET_KEY": "synthetic-deployment-only-" + "abc0123456789" * 5,
        "DJANGO_ALLOWED_HOSTS": "api.synthetic.test",
        "DATABASE_URL": "postgresql://synthetic:synthetic-pass@private-db.test/core",
        **keys(secret),
    }
    if extra_env:
        env.update(extra_env)
    return subprocess.run(  # noqa: S603 - a fixed interpreter and a fixed program
        [sys.executable, "-c", program],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


@pytest.mark.parametrize("secret", FULL_SECRET_KEYS)
def test_the_deployable_api_profile_refuses_to_start_with_a_full_secret_key(secret):
    refused = start_api(secret)
    assert refused.returncode != 0 and "started" not in refused.stdout
    assert refused.stderr.strip().splitlines()[-1] == f"ValueError: {MALFORMED}"
    assert secret not in refused.stderr + refused.stdout


@pytest.mark.parametrize(
    ("secret", "expected_live", "expected_platform", "platform_env"),
    [
        (
            RESTRICTED,
            False,
            "acct_1UgN9jRu1W0izUsy",
            {"KODERA_STRIPE_PLATFORM_ACCOUNT_ID": "acct_1UgN9jRu1W0izUsy"},
        ),
        (
            RESTRICTED_LIVE,
            True,
            "acct_1UgN9ORytJJnrEun",
            {"KODERA_STRIPE_PLATFORM_ACCOUNT_ID": "acct_1UgN9ORytJJnrEun"},
        ),
    ],
)
@pytest.mark.parametrize("profile", ["config.settings.deploy", "config.settings.customer_http"])
def test_the_deployable_api_starts_cleanly_with_restricted_keys_and_webhook_secret(
    secret, expected_live, expected_platform, platform_env, profile
):
    extra = dict(platform_env)
    if profile == "config.settings.customer_http":
        extra.update(
            {
                "DJANGO_ALLOWED_HOSTS": "localhost",
                "DATABASE_URL": "postgres://kodera:kodera@127.0.0.1:5432/kodera_server",
            }
        )
    started = start_api(secret, settings_module=profile, extra_env=extra or None)
    assert started.returncode == 0, started.stderr
    assert started.stdout.strip() == f"started stripe {expected_live} {expected_platform}"
    assert secret not in started.stderr + started.stdout


@pytest.mark.parametrize("secret", [RESTRICTED, RESTRICTED_LIVE])
def test_the_deployable_api_refuses_configured_key_without_explicit_platform_account_id(secret):
    refused = start_api(secret)
    assert refused.returncode != 0 and "started" not in refused.stdout
    assert (
        refused.stderr.strip().splitlines()[-1]
        == "ValueError: KODERA_STRIPE_PLATFORM_ACCOUNT_ID is required when KODERA_STRIPE_SECRET_KEY is configured"
    )
    assert secret not in refused.stderr + refused.stdout


def test_runtime_binding_allows_self_hosted_platform_and_refuses_mode_or_retired_account_mismatch():
    assert configuration.stripe_runtime_binding_from_environment(
        {"KODERA_STRIPE_PLATFORM_ACCOUNT_ID": "acct_SelfHostedPlatform01"},
        stripe_secret_key=RESTRICTED_LIVE,
    ) == (True, "acct_SelfHostedPlatform01")
    assert configuration.stripe_runtime_binding_from_environment(
        {"KODERA_STRIPE_PLATFORM_ACCOUNT_ID": "acct_SelfHostedTest01"},
        stripe_secret_key=RESTRICTED,
    ) == (False, "acct_SelfHostedTest01")
    for bad_env, secret in [
        ({}, RESTRICTED),
        ({}, RESTRICTED_LIVE),
        ({"KODERA_STRIPE_EXPECTED_LIVEMODE": "True"}, RESTRICTED_LIVE),
        ({"KODERA_STRIPE_EXPECTED_LIVEMODE": "FALSE"}, RESTRICTED),
        ({"KODERA_STRIPE_EXPECTED_LIVEMODE": "false"}, RESTRICTED_LIVE),
        ({"KODERA_STRIPE_EXPECTED_LIVEMODE": "true"}, RESTRICTED),
        ({"KODERA_STRIPE_PLATFORM_ACCOUNT_ID": "acct_1UgN9jRu1W0izUsy"}, RESTRICTED_LIVE),
        ({"KODERA_STRIPE_PLATFORM_ACCOUNT_ID": "acct_1UgN9ORytJJnrEun"}, RESTRICTED),
        ({"KODERA_STRIPE_PLATFORM_ACCOUNT_ID": "acct_1QhZ8fRwfVmWKPLR"}, RESTRICTED_LIVE),
        ({"KODERA_STRIPE_PLATFORM_ACCOUNT_ID": "not-an-account"}, RESTRICTED_LIVE),
    ]:
        with pytest.raises(ValueError):
            configuration.stripe_runtime_binding_from_environment(bad_env, stripe_secret_key=secret)


def test_outbound_stripe_provider_verifies_account_identity_parses_2025_02_24_acacia_and_handles_rolling_idempotency():
    import hashlib
    import hmac
    import json
    import time
    import urllib.parse
    from datetime import UTC, datetime, timedelta
    from uuid import uuid4

    from django.conf import settings

    from apps.billing.payments.port import LinkRequest, ProviderRefusedError
    from apps.billing.payments.stripe import API_VERSION, StripeProvider
    from apps.billing.payments.stripe_webhook import (
        OfflineWebhookDeduplicator,
        StripeWebhookMalformedError,
        StripeWebhookSignatureError,
    )

    assert API_VERSION == "2025-02-24.acacia"

    calls: list[tuple[str, str, dict[str, str], dict[str, list[str]]]] = []
    answers: list[tuple[int, dict[str, object]]] = []

    def transport(method, url, headers, body):
        calls.append((method, url, dict(headers), urllib.parse.parse_qs(body.decode("utf-8"))))
        status, payload = answers.pop(0)
        return status, json.dumps(payload).encode("utf-8")

    # 1. Wrong or retired account on /v1/account (200 or 403) refuses BEFORE any Checkout/Connect write!
    for wrong_status, wrong_payload in (
        (200, {"id": "acct_1QhZ8fRwfVmWKPLR", "object": "account"}),
        (
            403,
            {
                "error": {
                    "type": "invalid_request_error",
                    "message": "The provided key does not have the required permissions for this endpoint on account 'acct_1QhZ8fRwfVmWKPLR'.",
                }
            },
        ),
        (
            403,
            {
                "error": {
                    "type": "invalid_request_error",
                    "message": "Ambiguous account 'acct_1UgN9ORytJJnrEun' vs 'acct_1QhZ8fRwfVmWKPLR'.",
                }
            },
        ),
    ):
        calls.clear()
        answers[:] = [(wrong_status, wrong_payload)]
        wrong_provider = StripeProvider(
            secret_key=RESTRICTED_LIVE,
            webhook_secret=WEBHOOK,
            transport=transport,
            expected_account_id="acct_1UgN9ORytJJnrEun",
        )
        with pytest.raises(ProviderRefusedError, match="KODERA_STRIPE_PLATFORM_ACCOUNT_ID"):
            wrong_provider.create_link(
                LinkRequest(
                    invoice_id=uuid4(),
                    invoice_number="KOD-2026-00001",
                    amount_minor=12000,
                    currency="EUR",
                    expires_at=datetime.now(UTC) + timedelta(hours=2),
                    return_url="https://app.kodera.io/billing",
                    locale="fr",
                )
            )
        assert len(calls) == 1
        assert calls[0][:2] == ("GET", "https://api.stripe.com/v1/account")
        assert calls[0][2]["Stripe-Version"] == "2025-02-24.acacia"

    # 2. Restricted collector 403 naming exact expected account passes once, caches binding,
    #    and parses 2025-02-24.acacia responses for Checkout, Connect Accounts, AccountLinks, and expire.
    calls.clear()
    exp_ts = int(time.time()) + 3600
    answers[:] = [
        (
            403,
            {
                "error": {
                    "type": "invalid_request_error",
                    "message": "The provided key does not have the required permissions for this endpoint on account 'acct_1UgN9ORytJJnrEun'.",
                }
            },
        ),
        # Rolling-upgrade idempotency_error on first POST -> replays legacy param shape without samourai_project!
        (
            400,
            {
                "error": {
                    "type": "idempotency_error",
                    "code": "idempotency_key_in_use",
                    "message": "Keys for idempotent requests can only be used with the same parameters",
                }
            },
        ),
        (
            200,
            {
                "id": "cs_live_acacia_01",
                "object": "checkout.session",
                "url": "https://checkout.stripe.invalid/c/acacia01",
                "expires_at": exp_ts,
            },
        ),
        (
            200,
            {
                "id": "acct_1ConnectSeller01",
                "object": "account",
                "charges_enabled": False,
                "payouts_enabled": False,
                "details_submitted": True,
                "requirements": {"disabled_reason": "requirements.pending_verification"},
                "metadata": {"kodera_workspace_id": "ws-01", "samourai_project": "kodera"},
            },
        ),
        (
            200,
            {
                "object": "account_link",
                "url": "https://connect.stripe.invalid/setup/s/acacia01",
                "expires_at": exp_ts,
            },
        ),
        (200, {"id": "cs_live_acacia_01", "status": "expired"}),
    ]
    verified_provider = StripeProvider(
        secret_key=RESTRICTED_LIVE,
        webhook_secret=WEBHOOK,
        transport=transport,
        expected_account_id="acct_1UgN9ORytJJnrEun",
    )
    link = verified_provider.create_link(
        LinkRequest(
            invoice_id=uuid4(),
            invoice_number="EXT-01",
            amount_minor=2400,
            currency="EUR",
            expires_at=datetime.now(UTC) + timedelta(hours=2),
            return_url="https://app.kodera.io/extensions",
            locale="fr",
            reference_kind="extension_marketplace",
            idempotency_key="mkt-checkout-rolling-0",
        )
    )
    assert link.provider_ref == "cs_live_acacia_01"
    snap = verified_provider.retrieve_connect_account("acct_1ConnectSeller01")
    assert snap.restricted_reason == "requirements.pending_verification"
    assert snap.details_submitted is True
    onb = verified_provider.create_connect_onboarding_link(
        account_id="acct_1ConnectSeller01",
        refresh_url="https://app.kodera.io/r",
        return_url="https://app.kodera.io/ok",
    )
    assert onb.url.startswith("https://connect.stripe.invalid/")
    verified_provider.cancel_link("cs_live_acacia_01")
    # /v1/account was called only ONCE across all 5 operations, and every request carried 2025-02-24.acacia!
    assert [c[1] for c in calls].count("https://api.stripe.com/v1/account") == 1
    assert all(c[2]["Stripe-Version"] == "2025-02-24.acacia" for c in calls)
    # First checkout POST carried samourai_project; rolling-upgrade replay omitted it under same Idempotency-Key.
    first_post, replay_post = calls[1], calls[2]
    assert "metadata[samourai_project]" in first_post[3]
    assert "metadata[samourai_project]" not in replay_post[3]
    assert (
        first_post[2]["Idempotency-Key"]
        == replay_post[2]["Idempotency-Key"]
        == "mkt-checkout-rolling-0"
    )

    # 3. OfflineWebhookDeduplicator enforces KODERA_STRIPE_EXPECTED_LIVEMODE (missing -> 400, wrong -> 401).
    dedup = OfflineWebhookDeduplicator(webhook_secret=WEBHOOK)
    old_live = getattr(settings, "KODERA_STRIPE_EXPECTED_LIVEMODE", None)
    settings.KODERA_STRIPE_EXPECTED_LIVEMODE = True
    try:
        now_int = int(time.time())
        for payload, expected_exc in (
            (
                {
                    "id": "evt_missing_livemode_01",
                    "type": "checkout.session.completed",
                    "api_version": "2025-02-24.acacia",
                    "created": now_int,
                    "data": {"object": {"id": "cs_1"}},
                },
                StripeWebhookMalformedError,
            ),
            (
                {
                    "id": "evt_wrong_livemode_01",
                    "type": "checkout.session.completed",
                    "api_version": "2025-02-24.acacia",
                    "created": now_int,
                    "livemode": False,
                    "data": {"object": {"id": "cs_1"}},
                },
                StripeWebhookSignatureError,
            ),
        ):
            raw = json.dumps(payload).encode("utf-8")
            sig = hmac.new(
                WEBHOOK.encode("utf-8"), f"{now_int}.".encode("ascii") + raw, hashlib.sha256
            ).hexdigest()
            with pytest.raises(expected_exc):
                dedup.receive(
                    raw_body=raw,
                    headers={"Stripe-Signature": f"t={now_int},v1={sig}"},
                    handler=lambda *_a: "applied",
                )
    finally:
        settings.KODERA_STRIPE_EXPECTED_LIVEMODE = old_live
