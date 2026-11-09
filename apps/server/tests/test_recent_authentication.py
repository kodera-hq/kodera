"""Owner-claim consumption requires a recent login; pure evidence, no database."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID

import pytest

from services.identity.access_tokens import (
    COMMIT_LAG_BUDGET_S,
    RECENT_AUTHENTICATION_BOUND_S,
    RECENT_AUTHENTICATION_MAX_AGE_S,
    RECENT_AUTHENTICATION_SKEW_S,
    RecentAuthenticationReason,
    VerifiedAccessToken,
    evaluate_recent_authentication,
    recent_authentication_horizon,
)

NOW = datetime(2033, 5, 18, 3, 33, 20, tzinfo=UTC)
EPOCH = int(NOW.timestamp())
CLIENT = "synthetic-console"


def evidence(**changes):
    value = VerifiedAccessToken(
        issuer="https://identity.test/realms/customer",
        subject="subject",
        audience=("kodera-server",),
        issued_at=EPOCH,
        expires_at=EPOCH + 300,
        not_before=None,
        amr=("pwd", "otp"),
        acr=None,
        auth_time=EPOCH,
        email_verified=True,
        authorized_party=CLIENT,
        mfa_enrolled=True,
    )
    return replace(value, **changes)


def test_one_bound_of_320_s_leaves_the_commit_budget_under_the_330_s_ceiling():
    assert (RECENT_AUTHENTICATION_MAX_AGE_S, RECENT_AUTHENTICATION_SKEW_S) == (300, 30)
    assert COMMIT_LAG_BUDGET_S == 10
    assert RECENT_AUTHENTICATION_BOUND_S == 320


@pytest.mark.parametrize(
    "auth_time,reason",
    [
        (EPOCH, RecentAuthenticationReason.RECENT),
        (EPOCH - 120, RecentAuthenticationReason.RECENT),
        (EPOCH - 320, RecentAuthenticationReason.RECENT),
        (EPOCH - 321, RecentAuthenticationReason.STALE),
        (EPOCH - 330, RecentAuthenticationReason.STALE),
        (EPOCH - 36000, RecentAuthenticationReason.STALE),
        (EPOCH + 2, RecentAuthenticationReason.RECENT),
        (EPOCH + 3, RecentAuthenticationReason.FUTURE),
        (None, RecentAuthenticationReason.MISSING),
        ("1999999999", RecentAuthenticationReason.MISSING),
        (float(EPOCH), RecentAuthenticationReason.MISSING),
        (True, RecentAuthenticationReason.MISSING),
        (10**20, RecentAuthenticationReason.MISSING),
    ],
)
def test_recent_authentication_is_bounded_on_the_database_clock(auth_time, reason):
    result = evaluate_recent_authentication(
        verified=evidence(auth_time=auth_time), database_now=NOW
    )
    assert result is reason


def test_boundary_is_inclusive_to_the_microsecond():
    token = evidence(auth_time=EPOCH - 320)
    assert (
        evaluate_recent_authentication(verified=token, database_now=NOW)
        is RecentAuthenticationReason.RECENT
    )
    assert (
        evaluate_recent_authentication(verified=token, database_now=NOW + timedelta(microseconds=1))
        is RecentAuthenticationReason.STALE
    )


def test_a_naive_clock_is_never_recent():
    result = evaluate_recent_authentication(
        verified=evidence(), database_now=NOW.replace(tzinfo=None)
    )
    assert result is RecentAuthenticationReason.STALE


def _consumption():
    from apps.orgs.claim_consumption import ConsumerPrincipal, Consumption

    principal = ConsumerPrincipal(
        UUID("01900000-0000-7000-8000-000000000003"),
        UUID("01900000-0000-7000-8000-000000000002"),
        UUID("01900000-0000-7000-8000-000000000001"),
    )

    def build(**changes):
        return Consumption(
            principal=principal,
            verified=evidence(**changes),
            body=b"{}",
            request_id="recent-authentication-request-1",
            console_client_id=CLIENT,
        )

    return build


def test_commit_horizon_reserves_the_commit_lag_budget():
    assert COMMIT_LAG_BUDGET_S == 10
    token = evidence(auth_time=EPOCH - 100)
    horizon = recent_authentication_horizon(token)
    # The decision and the final read share one bound: at most auth + 320 s, inclusive.
    assert horizon == NOW + timedelta(seconds=220, microseconds=1)
    for unreadable in (None, "1999999999", True, 10**20):
        assert recent_authentication_horizon(evidence(auth_time=unreadable)) is None


@pytest.mark.parametrize(
    "age,horizon",
    [
        (0, timedelta(seconds=290)),
        (120, timedelta(seconds=200, microseconds=1)),
        (320, timedelta(microseconds=1)),
    ],
)
def test_consumer_admits_a_recent_login_until_the_nearer_horizon(age, horizon, monkeypatch):
    from apps.orgs import claim_consumption

    observed = []
    monkeypatch.setattr(claim_consumption, "observe_recent_authentication_reason", observed.append)
    operation = _consumption()(auth_time=EPOCH - age)
    operation._facts(SimpleNamespace(state="issued"), NOW)
    # The commit-time read in `final_authority` refuses at or after this instant.
    assert operation.factor_horizon == NOW + horizon
    assert observed == []


@pytest.mark.parametrize(
    "auth_time,reason",
    [
        (EPOCH - 321, RecentAuthenticationReason.STALE),
        (EPOCH - 36000, RecentAuthenticationReason.STALE),
        (None, RecentAuthenticationReason.MISSING),
        ("1999999999", RecentAuthenticationReason.MISSING),
        (EPOCH + 3, RecentAuthenticationReason.FUTURE),
    ],
)
def test_consumer_refuses_an_old_absent_or_future_login_as_mfa_required(
    auth_time, reason, monkeypatch
):
    from apps.orgs import claim_consumption

    observed = []
    monkeypatch.setattr(claim_consumption, "observe_recent_authentication_reason", observed.append)
    operation = _consumption()(auth_time=auth_time)
    with pytest.raises(claim_consumption.ConsumeGuardError) as refused:
        operation._facts(SimpleNamespace(state="issued"), NOW)
    assert (refused.value.kind, refused.value.reason) == ("mfa-required", "issued")
    assert observed == [reason]
    assert operation.factor_horizon is None


def test_registered_factor_refusal_keeps_its_precedence_over_login_age(monkeypatch):
    from apps.orgs import claim_consumption

    observed = []
    monkeypatch.setattr(claim_consumption, "observe_recent_authentication_reason", observed.append)
    operation = _consumption()(auth_time=None, mfa_enrolled=False)
    with pytest.raises(claim_consumption.ConsumeGuardError) as refused:
        operation._facts(SimpleNamespace(state="issued"), NOW)
    assert refused.value.kind == "mfa-required"
    assert observed == []
