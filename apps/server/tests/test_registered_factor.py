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
    evaluate_staff_community_factor,
)

NOW = datetime(2033, 5, 18, 3, 33, 20, tzinfo=UTC)
CLIENT = "kodera.console:test-1"
COMMUNITY_ISSUER = "https://identity.test/realms/community"


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


@pytest.mark.parametrize("amr", [("pwd", "otp"), ("pwd", "hwk")])
def test_community_issuer_admits_otp_or_hwk_when_mfa_enrolled_claim_absent(amr):
    token = evidence(issuer=COMMUNITY_ISSUER, amr=amr, mfa_enrolled=None)
    result = evaluate(token, community_issuer=COMMUNITY_ISSUER)
    assert result.value is True
    assert result.horizon == NOW + timedelta(seconds=290)
    assert result.reason is RegisteredFactorReason.ADMITTED


def test_community_issuer_preserves_explicit_false_and_refuses_missing_or_stale_evidence():
    false_token = evidence(issuer=COMMUNITY_ISSUER, amr=("pwd", "otp"), mfa_enrolled=False)
    false_result = evaluate(false_token, community_issuer=COMMUNITY_ISSUER)
    assert false_result.value is False and false_result.reason is RegisteredFactorReason.ADMITTED

    for bad_token, expected_reason in (
        (
            evidence(issuer=COMMUNITY_ISSUER, amr=("pwd",), mfa_enrolled=None),
            RegisteredFactorReason.OTP_MISSING,
        ),
        (
            evidence(issuer=COMMUNITY_ISSUER, amr=("mfa",), mfa_enrolled=None),
            RegisteredFactorReason.OTP_MISSING,
        ),
        (
            evidence(issuer=COMMUNITY_ISSUER, email_verified=False, mfa_enrolled=None),
            RegisteredFactorReason.CONTACT_UNVERIFIED,
        ),
        (
            evidence(issuer=COMMUNITY_ISSUER, authorized_party="other-client", mfa_enrolled=None),
            RegisteredFactorReason.CLIENT_MISMATCH,
        ),
        (
            evidence(
                issuer=COMMUNITY_ISSUER,
                issued_at=int(NOW.timestamp()) + 3,
                mfa_enrolled=None,
            ),
            RegisteredFactorReason.FUTURE_IAT,
        ),
    ):
        refused_result = evaluate(bad_token, community_issuer=COMMUNITY_ISSUER)
        assert refused_result.value is None and refused_result.reason is expected_reason

    stale_result = evaluate(
        evidence(issuer=COMMUNITY_ISSUER, mfa_enrolled=None),
        community_issuer=COMMUNITY_ISSUER,
        database_now=NOW + timedelta(seconds=290),
    )
    assert stale_result.value is None and stale_result.reason is RegisteredFactorReason.STALE


def test_community_issuer_never_relaxes_hosted_tenant_issuers_or_unconfigured_community():
    tenant_missing_claim = evidence(mfa_enrolled=None)
    assert (
        evaluate(tenant_missing_claim, community_issuer=COMMUNITY_ISSUER).reason
        is RegisteredFactorReason.EVIDENCE_UNKNOWN
    )
    tenant_hwk = evidence(amr=("pwd", "hwk"), mfa_enrolled=True)
    assert (
        evaluate(tenant_hwk, community_issuer=COMMUNITY_ISSUER).reason
        is RegisteredFactorReason.OTP_MISSING
    )
    community_without_opt_in = evidence(issuer=COMMUNITY_ISSUER, mfa_enrolled=None)
    assert (
        evaluate(community_without_opt_in, community_issuer="").reason
        is RegisteredFactorReason.EVIDENCE_UNKNOWN
    )
    assert (
        evaluate(community_without_opt_in, community_issuer=None).reason
        is RegisteredFactorReason.EVIDENCE_UNKNOWN
    )


@pytest.mark.parametrize("amr", [("pwd", "hwk"), ("pwd", "otp")])
def test_staff_community_factor_admits_hwk_or_otp_within_horizon(amr):
    staff_token = evidence(
        issuer="https://identity.staff.test/realms/kodera-staff",
        amr=amr,
        mfa_enrolled=None,
        authorized_party=None,
    )
    assert evaluate_staff_community_factor(verified=staff_token, database_now=NOW) is True
    assert (
        evaluate_staff_community_factor(
            verified=staff_token, database_now=NOW + timedelta(seconds=289)
        )
        is True
    )
    assert (
        evaluate_staff_community_factor(
            verified=staff_token, database_now=NOW + timedelta(seconds=290)
        )
        is None
    )


def test_staff_community_factor_refuses_missing_factor_future_iat_or_naive_clock():
    base = evidence(
        issuer="https://identity.staff.test/realms/kodera-staff",
        amr=("pwd",),
        mfa_enrolled=None,
    )
    assert evaluate_staff_community_factor(verified=base, database_now=NOW) is None
    mfa_only = replace(base, amr=("mfa",))
    assert evaluate_staff_community_factor(verified=mfa_only, database_now=NOW) is None
    future = replace(base, amr=("pwd", "hwk"), issued_at=int(NOW.timestamp()) + 3)
    assert evaluate_staff_community_factor(verified=future, database_now=NOW) is None
    valid = replace(base, amr=("pwd", "hwk"))
    assert (
        evaluate_staff_community_factor(verified=valid, database_now=NOW.replace(tzinfo=None))
        is None
    )
