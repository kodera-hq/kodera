"""Pure registered-factor evidence and bounded configuration acceptance."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest
from django.core.exceptions import ImproperlyConfigured

from config.environment import console_client_id
from services.identity.access_tokens import (
    RegisteredFactorReason,
    VerifiedAccessToken,
    evaluate_registered_factor,
)

NOW = datetime(2033, 5, 18, 3, 33, 20, tzinfo=UTC)
CLIENT = "kodera.console:test-1"


def evidence(**changes):
    value = VerifiedAccessToken(
        issuer="https://identity.test/realms/customer",
        subject="subject",
        audience=("kodera-server",),
        issued_at=int(NOW.timestamp()),
        expires_at=int(NOW.timestamp()) + 300,
        not_before=None,
        amr=("pwd", "otp"),
        acr=None,
        auth_time=int(NOW.timestamp()),
        email_verified=True,
        authorized_party=CLIENT,
        mfa_enrolled=True,
    )
    return replace(value, **changes)


def evaluate(token=None, **changes):
    return evaluate_registered_factor(
        verified=token or evidence(),
        lane=changes.pop("lane", "customer"),
        console_client_id=changes.pop("console_client_id", CLIENT),
        database_now=changes.pop("database_now", NOW),
        **changes,
    )


@pytest.mark.parametrize("fact", [True, False])
def test_strict_boolean_is_known_with_exact_horizon(fact):
    result = evaluate(evidence(mfa_enrolled=fact))
    assert result.value is fact
    assert result.horizon == NOW + timedelta(seconds=290)
    assert result.reason is RegisteredFactorReason.ADMITTED


@pytest.mark.parametrize(
    "token,changes,reason",
    [
        (evidence(mfa_enrolled=None), {}, RegisteredFactorReason.EVIDENCE_UNKNOWN),
        (evidence(email_verified=False), {}, RegisteredFactorReason.CONTACT_UNVERIFIED),
        (evidence(authorized_party=None), {}, RegisteredFactorReason.CLIENT_MISMATCH),
        (evidence(authorized_party=CLIENT + " "), {}, RegisteredFactorReason.CLIENT_MISMATCH),
        (evidence(amr=("OTP",)), {}, RegisteredFactorReason.OTP_MISSING),
        (evidence(amr=("webauthn",)), {}, RegisteredFactorReason.OTP_MISSING),
        (evidence(), {"lane": "staff"}, RegisteredFactorReason.WRONG_LANE),
        (evidence(), {"console_client_id": None}, RegisteredFactorReason.CLIENT_UNCONFIGURED),
    ],
)
def test_unknown_never_infers_enrollment(token, changes, reason):
    result = evaluate(token, **changes)
    assert result.value is None and result.reason is reason


def test_short_and_long_token_horizons_are_strict():
    short = evidence(expires_at=int(NOW.timestamp()) + 10)
    assert evaluate(short, database_now=NOW + timedelta(seconds=39)).value is True
    assert evaluate(short, database_now=NOW + timedelta(seconds=40)).value is None
    assert evaluate(database_now=NOW + timedelta(seconds=289)).value is True
    assert evaluate(database_now=NOW + timedelta(seconds=290)).value is None


def test_integer_horizon_binds_before_far_future_expiry_conversion():
    result = evaluate(evidence(expires_at=253402300799))
    assert result.value is True
    assert result.horizon == NOW + timedelta(seconds=290)


def test_future_iat_tolerance_is_two_seconds_not_verifier_leeway():
    assert evaluate(evidence(issued_at=int(NOW.timestamp()) + 2)).value is True
    result = evaluate(evidence(issued_at=int(NOW.timestamp()) + 3))
    assert result.value is None and result.reason is RegisteredFactorReason.FUTURE_IAT


def test_console_client_configuration_distinguishes_absent_from_malformed():
    assert console_client_id({}) is None
    assert console_client_id({"KODERA_CONSOLE_CLIENT_ID": CLIENT}) == CLIENT
    assert console_client_id({"KODERA_CONSOLE_CLIENT_ID": "a" * 128}) == "a" * 128
    for value in ("", " console", "console ", "a" * 129, "café", "line\nbreak"):
        with pytest.raises(ImproperlyConfigured):
            console_client_id({"KODERA_CONSOLE_CLIENT_ID": value})


def test_all_consuming_profiles_call_the_shared_parser():
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    for name in ("customer_http.py", "deploy.py", "e2e.py", "test.py"):
        source = (root / "config/settings" / name).read_text()
        assert "KODERA_CONSOLE_CLIENT_ID = console_client_id(os.environ)" in source
