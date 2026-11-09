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


def start_api(secret: str) -> subprocess.CompletedProcess[str]:
    program = (
        "import django; django.setup(); from django.conf import settings; "
        "print('started', settings.KODERA_PAYMENT_PROVIDER)"
    )
    return subprocess.run(  # noqa: S603 - a fixed interpreter and a fixed program
        [sys.executable, "-c", program],
        cwd=ROOT,
        env={
            "PATH": os.defpath,
            "PYTHONPATH": str(ROOT),
            "PYTHONDONTWRITEBYTECODE": "1",
            "DJANGO_SETTINGS_MODULE": "config.settings.deploy",
            "DJANGO_SECRET_KEY": "synthetic-deployment-only-" + "abc0123456789" * 5,
            "DJANGO_ALLOWED_HOSTS": "api.synthetic.test",
            "DATABASE_URL": "postgresql://synthetic:synthetic-pass@private-db.test/core",
            **keys(secret),
        },
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


def test_the_deployable_api_profile_starts_with_a_restricted_key():
    started = start_api(RESTRICTED)
    assert started.returncode == 0, started.stderr[-2000:]
    assert started.stdout.split() == ["started", "stripe"]
