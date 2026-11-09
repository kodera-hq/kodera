"""Synthetic intake, held operator and ready realm; no real provider or SMTP."""

import hashlib

import pytest
from test_operator_realm_bootstrap import complete, to_trust_hold

from apps.identity.command_principal import staff_principal_for_command
from apps.orgs import owner_claims
from apps.orgs.realm_readiness import realm_ready


@pytest.fixture
def owner_world(w, capsys, settings):
    to_trust_hold(capsys, w)
    code, _, error = complete(capsys, w)
    assert code == 0, error
    assert realm_ready(organisation_id=w.organisation.id)
    settings.KODERA_OUTBOX_SEAL_KEY = hashlib.sha256(b"public synthetic owner claim seal").digest()
    settings.KODERA_OWNER_CLAIM_LINK = "https://app.localhost/claim"
    settings.KODERA_OWNER_CLAIM_LIFETIME_SECONDS = "259200"
    settings.KODERA_MAIL_LINK_ORIGINS = frozenset({"https://app.localhost"})
    return w


def arguments(world):
    return dict(
        principal=staff_principal_for_command(world.operator.id),
        organisation_id=world.organisation.id,
        subject="synthetic-intended-owner",
        account_record=owner_claims.AccountCreationRecord(
            issuer=world.organisation.issuer,
            subject="synthetic-intended-owner",
            credential_created=False,
            evidence_ref="synthetic-account-created-1",
        ),
        contact="first.owner@customer.test",
        request_id="req-owner-bind-1",
    )


def bind(world, **changes):
    supplied = arguments(world)
    supplied.update(changes)
    return owner_claims.bind_intended_owner(**supplied)


def activate_owner_history_fixture(organisation_id):
    """Legal stored-history setup; never proof of claim consumption or provider MFA."""
    from django.db import connection
    from django.utils import timezone

    from apps.orgs.models import Organisation, SlugReservation

    assert connection.in_atomic_block, "history setup requires one fixture transaction"
    assert (
        SlugReservation.objects.filter(organisation_id=organisation_id).update(
            state="permanent", protected_at=timezone.now()
        )
        == 1
    )
    assert Organisation.objects.filter(id=organisation_id).update(state="active") == 1


def written():
    from apps.audit.models import AuditEvent
    from apps.identity.models import Identity, User
    from apps.orgs.models import Membership, Organisation, OwnerBinding, OwnerClaim
    from apps.outbox.models import OutboxDelivery, OutboxMessage

    return tuple(
        model.objects.count()
        for model in (
            AuditEvent,
            Identity,
            User,
            Membership,
            Organisation,
            OwnerBinding,
            OwnerClaim,
            OutboxDelivery,
            OutboxMessage,
        )
    )


def start_db_call(function):
    """One actual independent thread/connection, with PID for observed row-lock evidence."""
    import queue
    import threading

    from django.db import connection, connections

    pid = queue.Queue()
    result = {}

    def run():
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_backend_pid()")
                pid.put(cursor.fetchone()[0])
            result["value"] = function()
        except Exception as error:  # noqa: BLE001 — surfaced as test failure, never product output
            result["error"] = error
        finally:
            connections.close_all()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread, result, pid.get(timeout=10)


def finish_db_call(call):
    thread, result, _ = call
    thread.join(15)
    assert not thread.is_alive(), "bounded database worker did not finish"
    assert "error" not in result, result.get("error")
    return result["value"]


def assert_database_wait(pid):
    """Prove an actual database lock waiter; no scheduling-delay inference."""
    import time

    from django.db import connection

    until = time.monotonic() + 4
    while time.monotonic() < until:
        with connection.cursor() as cursor:
            cursor.execute("SELECT cardinality(pg_blocking_pids(%s))", [pid])
            if cursor.fetchone()[0] > 0:
                return
        time.sleep(0.01)
    raise AssertionError("expected independent database connection to be lock-blocked")


def settle_db_calls(*calls):
    """Unconditionally finish owned workers even when the asserted race ordering fails."""
    for call in calls:
        if call is not None:
            call[0].join(15)
    assert all(call is None or not call[0].is_alive() for call in calls), (
        "database worker did not settle"
    )
