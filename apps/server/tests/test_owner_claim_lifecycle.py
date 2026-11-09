"""Actual DB-clock expiry and atomic revoke/reissue; no token redelivery."""

import pytest
from django.db import connection
from owner_claim_fixtures import bind, owner_world as owner_world, written
from test_operator_realm_bootstrap import http_signer as http_signer, w as w

from apps.audit.models import AuditEvent
from apps.identity.command_principal import staff_principal_for_command
from apps.orgs import owner_claims
from apps.orgs.models import OwnerClaim


def test_lifecycle_interfaces_exist_before_effectful_acceptance():
    for name in ("revoke_owner_claim", "reissue_owner_claim"):
        assert callable(getattr(owner_claims, name, None)), (
            "specified claim lifecycle service missing"
        )


def operator(world):
    return dict(
        principal=staff_principal_for_command(world.operator.id),
        organisation_id=world.organisation.id,
        request_id="req-owner-lifecycle",
    )


@pytest.mark.django_db(transaction=True)
def test_reissue_revokes_and_atomically_creates_fresh_claim_and_delivery(owner_world):
    first = bind(owner_world)
    old = OwnerClaim.objects.get(id=first.claim_id)
    outcome = owner_claims.reissue_owner_claim(**operator(owner_world))
    old.refresh_from_db()
    new = OwnerClaim.objects.get(id=outcome.claim_id)
    assert old.state == "revoked" and new.state == "issued"
    assert old.revoked_by_identity_id == owner_world.operator.id
    assert new.delivery_id != first.delivery_id and new.id != first.claim_id
    assert bytes(new.token_hash) != bytes(old.token_hash)
    assert OwnerClaim.objects.filter(state="issued").count() == 1
    assert AuditEvent.objects.filter(action="owner_claim.revoked").count() == 1
    assert AuditEvent.objects.filter(action="owner_claim.issued").count() == 2


@pytest.mark.django_db(transaction=True)
def test_reissue_delivery_failure_rolls_back_revocation_and_new_issuance(owner_world, monkeypatch):
    first = bind(owner_world)
    before = written()

    def crash(**kwargs):
        raise RuntimeError("public synthetic delivery failure")

    monkeypatch.setattr(owner_claims, "enqueue_message", crash)
    with pytest.raises(RuntimeError, match="public synthetic delivery failure"):
        owner_claims.reissue_owner_claim(**operator(owner_world))
    assert written() == before
    assert OwnerClaim.objects.get(id=first.claim_id).state == "issued"


@pytest.mark.django_db(transaction=True)
def test_authorized_revoke_commits_first_observed_expiry_before_refusal(owner_world, settings):
    settings.KODERA_OWNER_CLAIM_LIFETIME_SECONDS = "1"
    first = bind(owner_world)
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_sleep(1.05)")
    with pytest.raises(owner_claims.ClaimRefusedError, match="claim_not_issued"):
        owner_claims.revoke_owner_claim(**operator(owner_world), claim_id=first.claim_id)
    claim = OwnerClaim.objects.get(id=first.claim_id)
    assert claim.state == "expired" and claim.revoked_by_identity_id is None
    row = AuditEvent.objects.get(action="owner_claim.expired")
    assert row.actor_type == "system" and row.actor_id is None
    before = written()
    with pytest.raises(owner_claims.ClaimRefusedError):
        owner_claims.revoke_owner_claim(**operator(owner_world), claim_id=first.claim_id)
    assert written() == before


@pytest.mark.django_db(transaction=True)
def test_two_readers_expire_once_using_database_clock(owner_world, settings, monkeypatch):
    from apps.orgs.claim_readiness import expire_claims

    settings.KODERA_OWNER_CLAIM_LIFETIME_SECONDS = "1"
    first = bind(owner_world)
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_sleep(1.05)")
    import threading

    from owner_claim_fixtures import (
        assert_database_wait,
        finish_db_call,
        settle_db_calls,
        start_db_call,
    )

    from apps.audit import services as audit_services

    entered = threading.Event()
    release = threading.Event()
    real_audit = audit_services.record_owner_event

    def held_audit(**kwargs):
        entered.set()
        assert release.wait(10), "first expiry was not released"
        return real_audit(**kwargs)

    monkeypatch.setattr(audit_services, "record_owner_event", held_audit)
    first_call = start_db_call(lambda: expire_claims(organisation_id=owner_world.organisation.id))
    second_call = None
    try:
        assert entered.wait(10)
        second_call = start_db_call(
            lambda: expire_claims(organisation_id=owner_world.organisation.id)
        )
        assert_database_wait(second_call[2])
    finally:
        release.set()
        settle_db_calls(first_call, second_call)
    assert finish_db_call(first_call) == 1
    assert second_call is not None and finish_db_call(second_call) == 0
    assert AuditEvent.objects.filter(action="owner_claim.expired").count() == 1
    assert OwnerClaim.objects.get(id=first.claim_id).state == "expired"


@pytest.mark.django_db(transaction=True)
def test_recorder_and_revoked_operator_do_not_even_observe_expiry(owner_world, settings):
    from django.utils import timezone

    from apps.identity.models import StaffRole

    settings.KODERA_OWNER_CLAIM_LIFETIME_SECONDS = "1"
    first = bind(owner_world)
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_sleep(1.05)")
    for actor in (owner_world.recorder, owner_world.operator):
        if actor == owner_world.operator:
            StaffRole.objects.filter(identity=actor).update(revoked_at=timezone.now())
        before = written()
        with pytest.raises(owner_claims.ClaimRefusedError):
            owner_claims.revoke_owner_claim(
                principal=staff_principal_for_command(actor.id),
                organisation_id=owner_world.organisation.id,
                claim_id=first.claim_id,
                request_id="req-refused-expiry",
            )
        assert written() == before
    assert OwnerClaim.objects.get(id=first.claim_id).state == "issued"


@pytest.mark.django_db(transaction=True)
def test_failed_expiry_audit_rolls_back_state_and_releases_row(owner_world, settings, monkeypatch):
    from owner_claim_fixtures import finish_db_call, start_db_call

    from apps.audit import services as audit_services
    from apps.orgs.claim_readiness import expire_claims

    settings.KODERA_OWNER_CLAIM_LIFETIME_SECONDS = "1"
    first = bind(owner_world)
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_sleep(1.05)")
    real_audit = audit_services.record_owner_event

    def crash(**kwargs):
        raise RuntimeError("public synthetic audit failure")

    monkeypatch.setattr(audit_services, "record_owner_event", crash)
    with pytest.raises(RuntimeError, match="public synthetic audit failure"):
        expire_claims(organisation_id=owner_world.organisation.id)
    assert OwnerClaim.objects.get(id=first.claim_id).state == "issued"
    assert AuditEvent.objects.filter(action="owner_claim.expired").count() == 0
    monkeypatch.setattr(audit_services, "record_owner_event", real_audit)
    assert (
        finish_db_call(
            start_db_call(lambda: expire_claims(organisation_id=owner_world.organisation.id))
        )
        == 1
    )
    assert AuditEvent.objects.filter(action="owner_claim.expired").count() == 1
