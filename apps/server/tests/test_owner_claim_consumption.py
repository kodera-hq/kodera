"""Atomic first ownership and token-first refusal controls; hosted PostgreSQL only."""

import json
from datetime import UTC, datetime, timedelta

import pytest
from owner_claim_consume_fixtures import (
    call_consume,
    http_signer as http_signer,
    issued_owner as issued_owner,
    owner_world as owner_world,
    post_consume,
    w as w,
)

from apps.audit.models import AuditEvent
from apps.identity.models import User
from apps.orgs.models import Membership, Organisation, OwnerClaim, SlugReservation
from core.idempotency.models import IdempotencyRecord


def test_consumption_interface_exists_before_effectful_acceptance():
    from apps.orgs import claim_consumption

    assert callable(claim_consumption.consumption_operation)
    assert callable(claim_consumption.resolve_consumer)


@pytest.mark.django_db(transaction=True)
def test_consume_commits_exact_atomic_effects_and_only_safe_response(issued_owner):
    from apps.identity.models import Identity
    from apps.jobs.models import Job
    from apps.outbox.models import OutboxDelivery, OutboxMessage

    world, claim, token, _ = issued_owner
    people = User.objects.count()
    unaffected = (
        Identity.objects.count(),
        Job.objects.count(),
        OutboxDelivery.objects.count(),
        OutboxMessage.objects.count(),
    )
    response = call_consume(issued_owner)
    assert response.status_code == 200
    body = json.loads(response.content)
    claim.refresh_from_db()
    membership = Membership.objects.get(id=claim.membership_id)
    assert claim.state == "consumed" and claim.consumed_by_identity_id == claim.intended_identity_id
    assert membership.role == "org_owner" and membership.state == "active"
    assert membership.accepted_at is not None
    assert Organisation.objects.get(id=world.organisation.id).state == "active"
    assert SlugReservation.objects.get(organisation_id=world.organisation.id).state == "permanent"
    assert body["membership"]["id"] == str(membership.id)
    assert body["organisation"]["state"] == "active"
    assert User.objects.count() == people
    assert (
        Identity.objects.count(),
        Job.objects.count(),
        OutboxDelivery.objects.count(),
        OutboxMessage.objects.count(),
    ) == unaffected
    for action in ("owner_claim.consumed", "membership.created", "organisation.activated"):
        assert AuditEvent.objects.filter(action=action).count() == 1
    receipt = IdempotencyRecord.objects.get(path="/api/v1/owner-claims/actions/consume")
    assert bytes(receipt.body) == response.content
    assert token.encode() not in response.content
    assert bytes(claim.token_hash) not in response.content


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("name", [None, "", "  ", "é" * 200])
def test_consume_updates_only_existing_own_profile_without_coercion(issued_owner, name):
    _, claim, token, _ = issued_owner
    response = call_consume(issued_owner, payload={"token": token, "display_name": name})
    assert response.status_code == 200
    claim.refresh_from_db()
    person = User.objects.get(membership__id=claim.membership_id)
    assert person.display_name == name
    assert json.loads(response.content)["membership"]["display_name"] == name


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "facts,status,kind",
    [
        ({"email_verified": False}, 403, "owner-claim-contact-unverified"),
        ({"amr": ("pwd",)}, 403, "mfa-required"),
        ({"email_verified": False, "amr": ("pwd",)}, 403, "owner-claim-contact-unverified"),
    ],
)
def test_fresh_contact_and_mfa_denials_commit_receipt_and_audit_without_membership(
    issued_owner, facts, status, kind
):
    response = call_consume(issued_owner, facts=facts)
    assert response.status_code == status
    assert json.loads(response.content)["type"].endswith("/" + kind)
    assert Membership.objects.count() == 0
    assert IdempotencyRecord.objects.filter(status=status).count() == 1
    assert AuditEvent.objects.filter(action="authz.denied").count() == 1
    assert OwnerClaim.objects.get(id=issued_owner[1].id).state == "issued"


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "facts",
    [
        {"mfa_enrolled": False},
        {"mfa_enrolled": None},
        {"authorized_party": "near-miss-console"},
        {"authorized_party": None},
        {"amr": ("webauthn",)},
        {"amr": ("OTP",)},
    ],
)
def test_registered_factor_requires_exact_current_totp_evidence(issued_owner, facts):
    response = call_consume(issued_owner, facts=facts)
    assert response.status_code == 403
    body = json.loads(response.content)
    assert body["type"].endswith("/mfa-required")
    assert body["required_amr"] == ["otp"]
    assert Membership.objects.count() == 0


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("age", [0, 320])
def test_recent_login_up_to_the_inclusive_bound_consumes(issued_owner, monkeypatch, age):
    from apps.orgs import claim_consumption

    # A whole second just ahead of every row the fixture wrote, so effects stay ordered.
    epoch = int(datetime.now(UTC).timestamp()) + 1
    now = datetime.fromtimestamp(epoch, UTC)
    monkeypatch.setattr(claim_consumption, "database_now", lambda: now)
    response = call_consume(issued_owner, facts={"auth_time": epoch - age})
    assert response.status_code == 200
    assert Membership.objects.filter(role="org_owner").count() == 1


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "auth_time,reason",
    [
        (-321, "stale_authentication"),
        (None, "auth_time_missing"),
        ("now", "auth_time_missing"),
        (3, "future_auth_time"),
    ],
)
def test_old_absent_or_future_login_refuses_as_mfa_required_without_effect(
    issued_owner, monkeypatch, auth_time, reason
):
    from apps.orgs import claim_consumption

    verified = issued_owner[3]
    now = datetime.fromtimestamp(verified.issued_at, UTC)
    observations = []
    monkeypatch.setattr(claim_consumption, "database_now", lambda: now)
    monkeypatch.setattr(
        claim_consumption, "observe_recent_authentication_reason", observations.append
    )
    value = verified.issued_at + auth_time if isinstance(auth_time, int) else auth_time
    response = call_consume(issued_owner, facts={"auth_time": value})
    assert response.status_code == 403
    body = json.loads(response.content)
    assert body["type"].endswith("/mfa-required") and body["required_amr"] == ["otp"]
    assert [str(item) for item in observations] == [reason]
    assert Membership.objects.count() == 0
    assert OwnerClaim.objects.get(id=issued_owner[1].id).state == "issued"
    assert IdempotencyRecord.objects.filter(status=403).count() == 1
    assert AuditEvent.objects.filter(action="authz.denied").count() == 1


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "shape,reason",
    [
        ("string", "auth_time_missing"),
        ("float", "auth_time_missing"),
        ("bool", "auth_time_missing"),
        ("40 s ahead", "future_auth_time"),
    ],
)
def test_signed_malformed_or_future_auth_time_is_403_mfa_required_not_401(
    issued_owner, monkeypatch, shape, reason
):
    import time

    from apps.orgs import claim_consumption

    now = int(time.time())
    value = {"string": str(now), "float": float(now), "bool": True, "40 s ahead": now + 40}[shape]
    observations = []
    monkeypatch.setattr(
        claim_consumption, "observe_recent_authentication_reason", observations.append
    )
    response = post_consume(issued_owner, facts={"auth_time": value})
    assert response.status_code == 403
    body = response.json()
    assert body["type"].endswith("/mfa-required") and body["required_amr"] == ["otp"]
    assert [str(item) for item in observations] == [reason]
    assert Membership.objects.count() == 0


@pytest.mark.django_db(transaction=True)
def test_signed_token_without_auth_time_refuses_over_http(issued_owner):
    response = post_consume(issued_owner, omit=("auth_time",))
    assert response.status_code == 403
    assert response.json()["type"].endswith("/mfa-required")
    assert Membership.objects.count() == 0


@pytest.mark.django_db(transaction=True)
def test_future_iat_observation_is_bounded_and_contains_no_claims(issued_owner, monkeypatch):
    from apps.orgs import claim_consumption
    from services.identity.access_tokens import RegisteredFactorReason

    verified = issued_owner[3]
    now = datetime.fromtimestamp(verified.issued_at, UTC)
    observations = []
    monkeypatch.setattr(claim_consumption, "database_now", lambda: now)
    monkeypatch.setattr(claim_consumption, "observe_registered_factor_reason", observations.append)
    response = call_consume(
        issued_owner,
        facts={"issued_at": verified.issued_at + 3},
    )
    assert response.status_code == 403
    assert observations == [RegisteredFactorReason.FUTURE_IAT]


@pytest.mark.django_db(transaction=True)
def test_horizon_crossed_after_writes_rolls_back_every_effect_and_receipt(
    issued_owner, monkeypatch
):
    from apps.orgs import claim_consumption

    world, claim, _, _ = issued_owner
    fresh = datetime.now(UTC) + timedelta(seconds=1)
    horizon = fresh + timedelta(seconds=600)
    readings = []

    def clock():
        readings.append(True)
        return fresh if len(readings) == 1 else horizon

    before_audits = AuditEvent.objects.count()
    monkeypatch.setattr(claim_consumption, "database_now", clock)
    response = post_consume(issued_owner)
    assert response.status_code == 503
    assert response.json()["type"].endswith("/service-unavailable")
    assert Membership.objects.count() == 0
    assert OwnerClaim.objects.get(id=claim.id).state == "issued"
    assert Organisation.objects.get(id=world.organisation.id).state == "prospect"
    assert SlugReservation.objects.get(organisation_id=world.organisation.id).state == "provisional"
    assert IdempotencyRecord.objects.count() == 0
    assert AuditEvent.objects.count() == before_audits

    monkeypatch.setattr(claim_consumption, "database_now", lambda: fresh)
    retry = post_consume(issued_owner, facts={"kodera_mfa_enrolled": False})
    assert retry.status_code == 403
    assert retry.json()["type"].endswith("/mfa-required")


@pytest.mark.django_db(transaction=True)
def test_login_age_crossed_only_at_the_commit_read_rolls_back_every_effect(
    issued_owner, monkeypatch
):
    from apps.orgs import claim_consumption

    world, claim, _, _ = issued_owner
    issued = int(datetime.now(UTC).timestamp())
    authenticated = issued - 300
    # Decisive read: the login is 301 s old, recent. Commit read: 331 s, one second past the
    # bound, while the registered factor's own horizon (iat + 290) is still far ahead.
    readings = iter(
        [datetime.fromtimestamp(issued + 1, UTC), datetime.fromtimestamp(issued + 31, UTC)]
    )
    before_audits = AuditEvent.objects.count()
    monkeypatch.setattr(claim_consumption, "database_now", lambda: next(readings))
    response = post_consume(
        issued_owner, facts={"iat": issued, "exp": issued + 300, "auth_time": authenticated}
    )
    assert response.status_code == 503
    assert response.json()["type"].endswith("/service-unavailable")
    assert Membership.objects.count() == 0
    assert OwnerClaim.objects.get(id=claim.id).state == "issued"
    assert Organisation.objects.get(id=world.organisation.id).state == "prospect"
    assert SlugReservation.objects.get(organisation_id=world.organisation.id).state == "provisional"
    assert IdempotencyRecord.objects.count() == 0
    assert AuditEvent.objects.count() == before_audits


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("final_offset,status", [(320.5, 503), (319, 200)])
def test_final_read_reserves_the_commit_lag_budget(issued_owner, monkeypatch, final_offset, status):
    from datetime import timedelta

    from apps.orgs import claim_consumption

    world, claim, _, _ = issued_owner
    issued = int(datetime.now(UTC).timestamp())
    authenticated = issued - 300
    at = datetime.fromtimestamp(authenticated, UTC)
    # Decided at auth + 301 s, recent. The final read must leave the 10 s commit budget:
    # at auth + 320.5 s it refuses, since a pause before COMMIT could land past 330 s.
    readings = iter([at + timedelta(seconds=301), at + timedelta(seconds=final_offset)])
    monkeypatch.setattr(claim_consumption, "database_now", lambda: next(readings))
    response = post_consume(
        issued_owner, facts={"iat": issued, "exp": issued + 300, "auth_time": authenticated}
    )
    assert response.status_code == status
    if status == 503:
        assert Membership.objects.count() == 0
        assert OwnerClaim.objects.get(id=claim.id).state == "issued"
        assert Organisation.objects.get(id=world.organisation.id).state == "prospect"
        assert IdempotencyRecord.objects.count() == 0
    else:
        assert Membership.objects.filter(role="org_owner").count() == 1


@pytest.mark.django_db(transaction=True)
def test_commit_lag_is_observed_only_after_replay_transaction_exit(issued_owner, monkeypatch):
    from django.db import connection

    from apps.orgs import claim_consumption

    original = claim_consumption.database_now
    reads = []
    observations = []

    def observed_clock():
        reads.append(connection.in_atomic_block)
        return original()

    def observed_lag(seconds):
        observations.append((connection.in_atomic_block, seconds))

    monkeypatch.setattr(claim_consumption, "database_now", observed_clock)
    monkeypatch.setattr(claim_consumption, "observe_consume_commit_lag", observed_lag)
    assert call_consume(issued_owner).status_code == 200
    assert reads == [True, True]
    assert len(observations) == 1
    assert observations[0][0] is False and observations[0][1] >= 0


@pytest.mark.django_db(transaction=True)
def test_wrong_secret_refuses_before_unverified_contact_or_missing_second_factor(issued_owner):
    token = issued_owner[2]
    wrong = token[:-2] + ("A" if token[-2] != "A" else "B") + token[-1]
    response = call_consume(
        issued_owner,
        payload={"token": wrong},
        facts={"email_verified": False, "amr": ("pwd",)},
    )
    assert response.status_code == 404
    assert Membership.objects.count() == 0
    assert IdempotencyRecord.objects.filter(status=404).count() == 1
    assert AuditEvent.objects.filter(action="authz.denied").count() == 1


@pytest.mark.django_db(transaction=True)
def test_consumption_audit_failure_rolls_back_effects_profile_and_receipt(
    issued_owner, monkeypatch
):
    from apps.orgs import claim_consumption

    before = list(User.objects.values_list("id", "display_name"))

    def fail(**kwargs):
        raise RuntimeError("synthetic audit failure")

    monkeypatch.setattr(claim_consumption, "record_consumption_event", fail)
    with pytest.raises(RuntimeError, match="synthetic audit failure"):
        call_consume(issued_owner, payload={"token": issued_owner[2], "display_name": "changed"})
    assert list(User.objects.values_list("id", "display_name")) == before
    assert Membership.objects.count() == 0
    assert OwnerClaim.objects.get(id=issued_owner[1].id).state == "issued"
    assert Organisation.objects.get(id=issued_owner[0].organisation.id).state == "prospect"
    assert (
        SlugReservation.objects.get(organisation_id=issued_owner[0].organisation.id).state
        == "provisional"
    )
    assert IdempotencyRecord.objects.count() == 0
