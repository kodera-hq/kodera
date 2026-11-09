"""Actual consume receipts and current-authority replay; hosted PostgreSQL only."""

import json
import time
from dataclasses import replace
from datetime import UTC, datetime

import pytest
from owner_claim_consume_fixtures import (
    http_signer as http_signer,
    issue_owner,
    issued_owner as issued_owner,
    owner_world as owner_world,
    post_consume,
    w as w,
)

from apps.audit.models import AuditEvent
from apps.identity.models import Identity, User
from apps.orgs.models import Membership, OwnerClaim
from core.idempotency.models import IdempotencyRecord


def receipt():
    return IdempotencyRecord.objects.filter(path="/api/v1/owner-claims/actions/consume").get()


def snapshot():
    row = receipt()
    return (row.id, row.status, bytes(row.body), row.body_sha256, row.created_at)


@pytest.mark.django_db(transaction=True)
def test_actual_signed_http_success_replays_exact_safe_bytes_and_preserves_original_profile(
    issued_owner,
):
    world, claim, secret, _ = issued_owner
    payload = {"token": secret, "display_name": "  Original own name  "}
    first = post_consume(issued_owner, payload=payload)
    assert first.status_code == 200
    before = snapshot()
    User.objects.filter(identity__id=claim.intended_identity_id).update(display_name="Later name")
    second = post_consume(issued_owner, payload=payload)
    assert second.status_code == 200 and second.content == first.content
    assert second["Idempotency-Replayed"] == "true" and snapshot() == before
    assert second.json()["membership"]["display_name"] == "  Original own name  "
    assert User.objects.get(identity__id=claim.intended_identity_id).display_name == "Later name"
    assert Membership.objects.filter(organisation_id=world.organisation.id).count() == 1
    assert secret.encode() not in bytes(receipt().body)
    assert bytes(OwnerClaim.objects.get(id=claim.id).token_hash) not in bytes(receipt().body)
    assert post_consume(issued_owner, key="consume-public-key-0002").status_code == 409


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("facts", [{"email_verified": False}, {"amr": ("pwd",)}])
def test_recorded_contact_or_mfa_refusal_replays_after_facts_improve_and_new_key_succeeds(
    issued_owner, facts
):
    first = post_consume(issued_owner, facts=facts)
    assert first.status_code == 403
    before = snapshot()
    repeated = post_consume(issued_owner)
    assert repeated.status_code == 403 and repeated.content == first.content
    assert repeated["Idempotency-Replayed"] == "true" and snapshot() == before
    assert Membership.objects.count() == 0
    assert post_consume(issued_owner, key="consume-public-key-0002").status_code == 200


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "facts",
    [
        {"email_verified": False},
        {"amr": ("pwd",)},
        {"kodera_mfa_enrolled": False},
        {"azp": "kodera-ios"},
    ],
)
def test_cached_success_current_fact_loss_refuses_without_releasing_or_replacing_receipt(
    issued_owner, facts
):
    first = post_consume(issued_owner)
    assert first.status_code == 200
    before = snapshot()
    repeated = post_consume(issued_owner, facts=facts)
    assert repeated.status_code == 403 and "Idempotency-Replayed" not in repeated
    assert repeated.content != first.content and snapshot() == before
    assert AuditEvent.objects.filter(action="authz.denied").count() == 1
    restored = post_consume(issued_owner)
    assert restored.status_code == 200 and restored.content == first.content
    assert restored["Idempotency-Replayed"] == "true"


def _stale_login():
    now = int(time.time())
    return {"iat": now, "exp": now + 300, "auth_time": now - 400}


@pytest.mark.django_db(transaction=True)
def test_cached_success_replay_requires_a_recent_login_with_a_fresh_token(issued_owner):
    first = post_consume(issued_owner)
    assert first.status_code == 200
    before = snapshot()
    repeated = post_consume(issued_owner, facts=_stale_login())
    assert repeated.status_code == 403 and "Idempotency-Replayed" not in repeated
    assert repeated.json()["type"].endswith("/mfa-required") and snapshot() == before
    assert AuditEvent.objects.filter(action="authz.denied").count() == 1
    restored = post_consume(issued_owner)
    assert restored.status_code == 200 and restored["Idempotency-Replayed"] == "true"


@pytest.mark.django_db(transaction=True)
def test_changed_body_metadata_requires_a_recent_login(issued_owner):
    first = post_consume(issued_owner)
    assert first.status_code == 200
    before = snapshot()
    changed = {"token": issued_owner[2], "display_name": "A changed logical body"}
    refused = post_consume(issued_owner, payload=changed, facts=_stale_login())
    assert refused.status_code == 403 and "Idempotency-Replayed" not in refused
    assert "first_seen_at" not in refused.json() and snapshot() == before
    conflict = post_consume(issued_owner, payload=changed)
    assert conflict.status_code == 409 and "first_seen_at" in conflict.json()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "facts", [{"email_verified": False}, {"kodera_mfa_enrolled": False}, {"azp": "kodera-ios"}]
)
def test_changed_body_metadata_requires_current_facts_and_preserves_old_receipt(
    issued_owner, facts
):
    first = post_consume(issued_owner)
    assert first.status_code == 200
    before = snapshot()
    changed = {"token": issued_owner[2], "display_name": "A changed logical body"}
    refused = post_consume(issued_owner, payload=changed, facts=facts)
    assert refused.status_code == 403
    assert "first_seen_at" not in json.loads(refused.content)
    assert "Idempotency-Replayed" not in refused and snapshot() == before
    conflict = post_consume(issued_owner, payload=changed)
    assert conflict.status_code == 409 and "first_seen_at" in json.loads(conflict.content)
    assert snapshot() == before


@pytest.mark.django_db(transaction=True)
def test_expired_factor_horizon_hides_success_and_key_reuse_metadata(issued_owner, monkeypatch):
    from apps.orgs import claim_consumption as service

    issued_at = int(time.time())
    facts = {"iat": issued_at, "exp": issued_at + 600}
    first = post_consume(issued_owner, facts=facts)
    assert first.status_code == 200
    before = snapshot()
    monkeypatch.setattr(
        service, "database_now", lambda: datetime.fromtimestamp(issued_at + 290, UTC)
    )

    replay = post_consume(issued_owner, facts=facts)
    assert replay.status_code == 403 and "Idempotency-Replayed" not in replay
    assert replay.content != first.content and snapshot() == before

    changed = {"token": issued_owner[2], "display_name": "Hidden at factor horizon"}
    conflict = post_consume(issued_owner, payload=changed, facts=facts)
    assert conflict.status_code == 403 and "Idempotency-Replayed" not in conflict
    assert "first_seen_at" not in conflict.json() and snapshot() == before


@pytest.mark.django_db(transaction=True)
def test_invalid_token_refusal_replays_only_matching_negative_status_and_never_conflict_metadata(
    issued_owner,
):
    wrong = (
        issued_owner[2][:-2] + ("A" if issued_owner[2][-2] != "A" else "B") + issued_owner[2][-1]
    )
    payload = {"token": wrong}
    first = post_consume(issued_owner, payload=payload)
    assert first.status_code == 404
    before = snapshot()
    repeated = post_consume(issued_owner, payload=payload)
    assert repeated.status_code == 404 and repeated.content == first.content
    assert repeated["Idempotency-Replayed"] == "true"
    changed = post_consume(issued_owner, payload={**payload, "display_name": "changed"})
    assert changed.status_code == 404 and "first_seen_at" not in json.loads(changed.content)
    assert "Idempotency-Replayed" not in changed and snapshot() == before


def add_legitimate_other_owner(issued_owner):
    """Existing storage permits later accepted owners; never claim this fixture consumed a claim."""
    from django.db import transaction
    from django.utils import timezone

    world, _, _, _ = issued_owner
    with transaction.atomic():
        person = User.objects.create(email="second.legitimate.owner@customer.test", enabled=True)
        Identity.objects.create(
            user=person,
            organisation=world.organisation,
            issuer=world.organisation.issuer,
            realm=world.organisation.realm,
            subject="synthetic-additional-owner",
            email=person.email,
            enabled=True,
        )
        return Membership.objects.create(
            user=person,
            organisation=world.organisation,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("withdrawal", ["identity", "person", "membership", "organisation"])
def test_completed_authority_withdrawal_blocks_cached_success_and_changed_body(
    issued_owner, withdrawal
):
    from datetime import timedelta

    from django.utils import timezone

    from apps.orgs.models import Organisation

    first = post_consume(issued_owner)
    assert first.status_code == 200
    add_legitimate_other_owner(issued_owner)
    claim = OwnerClaim.objects.get(id=issued_owner[1].id)
    before = snapshot()
    identity = Identity.objects.get(id=claim.intended_identity_id)
    if withdrawal == "identity":
        Identity.objects.filter(id=identity.id).update(enabled=False)
    elif withdrawal == "person":
        User.objects.filter(id=identity.user_id).update(enabled=False)
    elif withdrawal == "membership":
        from django.db import IntegrityError, transaction

        deleted_at = timezone.now()
        with pytest.raises(IntegrityError) as refused:
            with transaction.atomic():
                Membership.objects.filter(id=claim.membership_id).update(deleted_at=deleted_at)
        assert refused.value.__cause__.sqlstate == "23514"
        assert refused.value.__cause__.diag.constraint_name == "membership_deletion_valid"
        assert snapshot() == before
        Membership.objects.filter(id=claim.membership_id).update(
            deleted_at=deleted_at, purge_after=deleted_at + timedelta(days=1)
        )
    else:
        Organisation.objects.filter(id=claim.organisation_id).update(state="suspended")
    for payload in (None, {"token": issued_owner[2], "display_name": "changed"}):
        response = post_consume(issued_owner, payload=payload)
        assert response.status_code == 403
        if withdrawal in {"identity", "person"}:
            assert response.json()["type"] == "https://kodera.io/problems/identity-unknown"
            assert "WWW-Authenticate" not in response
        assert "Idempotency-Replayed" not in response
        assert "first_seen_at" not in response.json() and snapshot() == before


@pytest.mark.django_db(transaction=True)
def test_route_preflight_unknown_identity_precedes_key_and_body_errors_without_new_identity(
    issued_owner,
):
    changed = (*issued_owner[:3], replace(issued_owner[3], subject="synthetic-unknown-identity"))
    people, identities = User.objects.count(), Identity.objects.count()
    response = post_consume(changed, key="", payload={"unexpected": True})
    assert response.status_code == 403 and "WWW-Authenticate" not in response
    assert response.json()["type"] == "https://kodera.io/problems/identity-unknown"
    assert IdempotencyRecord.objects.count() == 0
    assert AuditEvent.objects.filter(action="authz.denied").count() == 0
    assert (User.objects.count(), Identity.objects.count()) == (people, identities)


def wait_until_original_deadline(claim):
    from django.db import connection

    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_sleep(GREATEST(0,extract(epoch FROM (%s::timestamptz-clock_timestamp())))+0.05)",
            [claim.expires_at],
        )


@pytest.mark.django_db(transaction=True)
def test_post_rollback_denial_audit_failure_is_closed_500_and_preserves_success_receipt(
    issued_owner, monkeypatch
):
    from apps.orgs import claim_consumption as service

    assert post_consume(issued_owner).status_code == 200
    before = snapshot()

    def fail(**row):
        raise RuntimeError("synthetic-private-audit-failure-marker")

    monkeypatch.setattr(service, "record_authz_denied", fail)
    response = post_consume(issued_owner, facts={"email_verified": False})
    assert response.status_code == 500 and response["Cache-Control"] == "no-store"
    assert "Idempotency-Replayed" not in response and snapshot() == before
    assert b"synthetic-private-audit-failure-marker" not in response.content


@pytest.mark.django_db(transaction=True)
def test_late_issued_consumption_persists_single_expiry_audit_and_stored_410(owner_world, settings):
    settings.KODERA_OWNER_CLAIM_LIFETIME_SECONDS = "1"
    issued = issue_owner(owner_world, settings)
    wait_until_original_deadline(issued[1])
    response = post_consume(issued)
    assert response.status_code == 410
    claim = OwnerClaim.objects.get(id=issued[1].id)
    assert claim.state == "expired" and claim.revoked_by_identity_id is None
    assert AuditEvent.objects.filter(action="owner_claim.expired").count() == 1
    assert receipt().status == 410 and Membership.objects.count() == 0
    repeated = post_consume(issued)
    assert repeated.status_code == 410 and repeated.content == response.content
    assert repeated["Idempotency-Replayed"] == "true"
    assert AuditEvent.objects.filter(action="owner_claim.expired").count() == 1


@pytest.mark.django_db(transaction=True)
def test_actual_consumption_replay_and_recorder_confirmation_remain_valid_after_old_deadline(
    owner_world, settings, capsys
):
    from test_operator_realm_bootstrap import run

    settings.KODERA_OWNER_CLAIM_LIFETIME_SECONDS = "2"
    issued = issue_owner(owner_world, settings)
    first = post_consume(issued)
    assert first.status_code == 200
    wait_until_original_deadline(issued[1])
    before = snapshot()
    repeated = post_consume(issued)
    assert repeated.status_code == 200 and repeated.content == first.content
    assert repeated["Idempotency-Replayed"] == "true" and snapshot() == before

    def confirm(actor, evidence="independent-channel-1"):
        return run(
            capsys,
            "confirm_owner_contact",
            "--staff-identity",
            str(actor.id),
            "--organisation",
            owner_world.organisation.slug,
            "--claim",
            str(issued[1].id),
            "--evidence-ref",
            evidence,
        )

    assert confirm(owner_world.operator)[0] != 0
    assert not AuditEvent.objects.filter(action="owner_claim.confirmed").exists()
    assert confirm(owner_world.recorder, "not an evidence reference")[0] != 0
    assert confirm(owner_world.recorder)[0] == 0
    confirmed = AuditEvent.objects.get(action="owner_claim.confirmed")
    assert confirmed.actor_id == owner_world.recorder.id
    assert confirmed.metadata == {"evidence_ref": "independent-channel-1"}
    assert confirm(owner_world.recorder)[0] == 0
    assert AuditEvent.objects.filter(action="owner_claim.confirmed").count() == 1
    assert OwnerClaim.objects.get(id=issued[1].id).state == "consumed"
    assert post_consume(issued, key="consume-public-key-0002").status_code == 409


@pytest.mark.django_db(transaction=True)
def test_revoked_claim_stores_and_replays_exact_410_without_consumption(issued_owner):
    from apps.identity.command_principal import staff_principal_for_command
    from apps.orgs.owner_claims import revoke_owner_claim

    world, claim, _, _ = issued_owner
    revoke_owner_claim(
        principal=staff_principal_for_command(world.operator.id),
        organisation_id=world.organisation.id,
        claim_id=claim.id,
        request_id="public-revoke-before-consume",
    )
    first = post_consume(issued_owner)
    assert first.status_code == 410 and first.json()["type"].endswith("/owner-claim-revoked")
    before = snapshot()
    repeated = post_consume(issued_owner)
    assert repeated.status_code == 410 and repeated.content == first.content
    assert repeated["Idempotency-Replayed"] == "true" and snapshot() == before
    assert OwnerClaim.objects.get(id=claim.id).state == "revoked"
    assert Membership.objects.count() == 0
    assert AuditEvent.objects.filter(action="owner_claim.consumed").count() == 0


@pytest.mark.django_db(transaction=True)
def test_same_realm_misbinding_stores_and_replays_only_exact_403_without_metadata(issued_owner):
    from django.db import transaction

    world, claim, secret, verified = issued_owner
    with transaction.atomic():
        person = User.objects.create(email="wrong.same.realm@customer.test", enabled=True)
        identity = Identity.objects.create(
            user=person,
            organisation=world.organisation,
            issuer=world.organisation.issuer,
            realm=world.organisation.realm,
            subject="synthetic-wrong-bound-identity",
            email=person.email,
            enabled=True,
        )
    wrong = (world, claim, secret, replace(verified, subject=identity.subject))
    first = post_consume(wrong)
    assert first.status_code == 403 and first.json()["type"].endswith(
        "/owner-claim-identity-mismatch"
    )
    before = snapshot()
    repeated = post_consume(wrong)
    assert repeated.status_code == 403 and repeated.content == first.content
    assert repeated["Idempotency-Replayed"] == "true" and snapshot() == before
    changed = post_consume(wrong, payload={"token": secret, "display_name": "changed"})
    assert changed.status_code == 403 and "first_seen_at" not in changed.json()
    assert "Idempotency-Replayed" not in changed and snapshot() == before
    assert Membership.objects.count() == 0
    assert OwnerClaim.objects.get(id=claim.id).state == "issued"


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("body", ["invalid-json", "extra-member"])
def test_malformed_body_stores_exact_400_and_replays_without_metadata(issued_owner, body):
    import time

    from customer_http_fixtures import token
    from django.test import Client

    world, claim, secret, verified = issued_owner
    now = int(time.time())
    credential = token(
        world.signer,
        verified.issuer,
        verified.subject,
        iat=now,
        exp=now + 300,
        amr=["pwd", "otp"],
        email_verified=True,
    )
    raw = (
        json.dumps({"token": secret})[:-1]
        if body == "invalid-json"
        else json.dumps({"token": secret, "unexpected": True})
    )

    def send(value):
        return Client().post(
            "/api/v1/owner-claims/actions/consume",
            data=value,
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer " + credential,
            HTTP_IDEMPOTENCY_KEY="consume-public-malformed-key",
        )

    first = send(raw)
    assert first.status_code == 400 and first.json()["type"].endswith("/malformed-request")
    before = snapshot()
    repeated = send(raw)
    assert repeated.status_code == 400 and repeated.content == first.content
    assert repeated["Idempotency-Replayed"] == "true" and snapshot() == before
    whitespace = send(raw + " ")
    assert whitespace.status_code == 400 and whitespace.content == first.content
    assert whitespace["Idempotency-Replayed"] == "true" and snapshot() == before
    changed_raw = (
        json.dumps({"token": secret + "x"})[:-1]
        if body == "invalid-json"
        else json.dumps({"token": secret + "x", "unexpected": True})
    )
    from core.idempotency.fingerprint import body_sha256

    assert body_sha256(raw.encode()) == body_sha256((raw + " ").encode())
    assert body_sha256(raw.encode()) != body_sha256(changed_raw.encode())
    changed = send(changed_raw)
    assert changed.status_code == 400 and "first_seen_at" not in changed.json()
    assert "Idempotency-Replayed" not in changed and snapshot() == before
    assert Membership.objects.count() == 0 and OwnerClaim.objects.get(id=claim.id).state == "issued"
