"""Actual opposing connection admission controls; hosted PostgreSQL only."""

import time
from datetime import UTC, datetime

import psycopg
import pytest
from django.db import connection
from owner_claim_consume_fixtures import (
    http_signer as http_signer,
    issued_owner as issued_owner,
    owner_world as owner_world,
    post_consume,
    w as w,
)
from owner_claim_fixtures import (
    assert_database_wait,
    finish_db_call,
    settle_db_calls,
    start_db_call,
)

from apps.audit.models import AuditEvent
from apps.orgs.models import Membership, OwnerClaim
from core.idempotency.models import IdempotencyRecord


def blocker():
    connection.ensure_connection()
    info = connection.connection.info
    return psycopg.connect(info.dsn, password=info.password, autocommit=False)


def counts():
    return AuditEvent.objects.count(), Membership.objects.count(), IdempotencyRecord.objects.count()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("mode", ["advisory", "user"])
def test_actual_busy_admission_is_nonstored_503_with_no_audit_or_expiry(issued_owner, mode):
    world, claim, _, _ = issued_owner
    before = counts()
    with blocker() as held:
        if mode == "advisory":
            held.execute(
                "SELECT pg_advisory_lock(1,hashtext(%s::text))", [str(world.organisation.id)]
            )
        else:
            held.execute(
                "SELECT id FROM identity_user WHERE id=(SELECT user_id FROM identity_identity WHERE id=%s) FOR UPDATE",
                [claim.intended_identity_id],
            )
        response = post_consume(issued_owner)
        assert response.status_code == 503
        assert response.json()["retry_after_s"] == 1 and response["Retry-After"] == "1"
        assert response["Cache-Control"] == "no-store"
        assert "Idempotency-Replayed" not in response
        assert counts() == before
        assert OwnerClaim.objects.get(id=claim.id).state == "issued"
        if mode == "advisory":
            held.execute(
                "SELECT pg_advisory_unlock(1,hashtext(%s::text))", [str(world.organisation.id)]
            )
        held.rollback()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "phase,withdrawal",
    [
        (phase, actor)
        for phase in ("fresh", "replay")
        for actor in ("identity", "person", "organisation")
    ]
    + [("replay", "membership")],
)
def test_actual_response_hold_blocks_lawful_withdrawal_until_materialization_and_commit(
    issued_owner, monkeypatch, phase, withdrawal
):
    import threading
    from datetime import timedelta

    from django.utils import timezone
    from test_owner_claim_consume_replay import add_legitimate_other_owner, snapshot

    from apps.identity.models import Identity, User
    from apps.orgs.api import owner_claims as view
    from apps.orgs.models import Organisation
    from core.idempotency import store

    if phase == "replay":
        assert post_consume(issued_owner).status_code == 200
        if withdrawal == "membership":
            add_legitimate_other_owner(issued_owner)
        original = store._response
        target, name = store, "_response"
    else:
        original = view.serialize_consume_result
        target, name = view, "serialize_consume_result"
    entered, release = threading.Event(), threading.Event()

    def held_response(*args, **kwargs):
        entered.set()
        assert release.wait(10), "bounded response hold was not released"
        return original(*args, **kwargs)

    monkeypatch.setattr(target, name, held_response)
    consumer = writer = None
    try:
        consumer = start_db_call(lambda: post_consume(issued_owner))
        assert entered.wait(5), "actual safe response materialization was not reached"

        def disable():
            with connection.cursor() as cursor:
                cursor.execute("SET statement_timeout='10s'")
            if withdrawal == "identity":
                return Identity.objects.filter(id=issued_owner[1].intended_identity_id).update(
                    enabled=False
                )
            if withdrawal == "person":
                return User.objects.filter(
                    identity__id=issued_owner[1].intended_identity_id
                ).update(enabled=False)
            if withdrawal == "membership":
                claim = OwnerClaim.objects.get(id=issued_owner[1].id)
                deleted_at = timezone.now()
                return Membership.objects.filter(id=claim.membership_id).update(
                    deleted_at=deleted_at, purge_after=deleted_at + timedelta(days=1)
                )
            return Organisation.objects.filter(id=issued_owner[0].organisation.id).update(
                state="suspended"
            )

        writer = start_db_call(disable)
        assert_database_wait(writer[2])
        release.set()
        assert finish_db_call(consumer).status_code == 200
        assert finish_db_call(writer) == 1
    finally:
        release.set()
        settle_db_calls(consumer, writer)
    # Completed withdrawal wins the opposite ordering and cannot release the prior success.
    receipt_before = snapshot()
    after = post_consume(issued_owner)
    assert after.status_code == 403
    if withdrawal in {"identity", "person"}:
        assert after.json()["type"] == "https://kodera.io/problems/identity-unknown"
        assert "WWW-Authenticate" not in after
    assert "Idempotency-Replayed" not in after and snapshot() == receipt_before


@pytest.mark.django_db(transaction=True)
def test_opposing_retained_fanout_nowait_admission_finishes_without_deadlock(owner_world):
    import queue
    import threading

    from django.db import DatabaseError, transaction

    from apps.identity.models import Identity, User
    from apps.orgs import claim_consumption as service
    from apps.orgs.models import Organisation, SlugReservation
    from services.identity.access_tokens import VerifiedAccessToken

    first = owner_world.organisation
    with transaction.atomic():
        second = Organisation.objects.create(
            slug="opposing-owner",
            realm="opposing-owner",
            issuer="https://identity.staff.test/realms/opposing-owner",
            name="Opposing owner",
            state="prospect",
        )
        SlugReservation.objects.create(organisation=second, slug=second.slug, state="provisional")
        principals = []
        for number, target in enumerate((first, second)):
            person = User.objects.create(email=f"opposing-{number}@customer.test", enabled=True)
            primary = Identity.objects.create(
                user=person,
                organisation=target,
                issuer=target.issuer,
                realm=target.realm,
                subject=f"opposing-{number}",
                email=person.email,
                enabled=True,
            )
            retained = second if target.id == first.id else first
            Identity.objects.create(
                user=person,
                organisation=retained,
                issuer=retained.issuer,
                realm=retained.realm,
                subject=f"retained-{number}",
                email=person.email,
                enabled=True,
            )
            principals.append(
                (
                    service.ConsumerPrincipal(primary.id, person.id, target.id),
                    VerifiedAccessToken(
                        target.issuer,
                        primary.subject,
                        ("kodera-server",),
                        1,
                        9999999999,
                        None,
                        ("otp",),
                        None,
                        1,
                    ),
                )
            )
    barrier, release, observed = threading.Barrier(2), threading.Event(), queue.Queue()

    def admission(item):
        principal, verified = item
        try:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute("SET LOCAL statement_timeout='8s'")
                    cursor.execute(
                        "SELECT id FROM identity_user WHERE id=%s FOR NO KEY UPDATE",
                        [principal.user_id],
                    )
                barrier.wait(5)
                held = service._hold_principal(principal, verified)
                assert held.organisation[0] == principal.organisation_id
                observed.put("held")
                assert release.wait(5)
            return "held"
        except DatabaseError as error:
            assert service._is_busy(error), "opposing admission raised a non-NOWAIT database error"
            observed.put("55P03")
            return "55P03"

    calls = []
    try:
        calls = [start_db_call(lambda item=item: admission(item)) for item in principals]
        results = [observed.get(timeout=6), observed.get(timeout=6)]
        assert "held" in results and set(results).issubset({"held", "55P03"})
        release.set()
        assert all(finish_db_call(call) in {"held", "55P03"} for call in calls)
    finally:
        release.set()
        barrier.abort()
        settle_db_calls(*calls)


@pytest.mark.django_db(transaction=True)
def test_locked_claim_wrong_secret_is_404_before_valid_token_transient_503(issued_owner):
    _, claim, token, _ = issued_owner
    wrong = token[:-2] + ("A" if token[-2] != "A" else "B") + token[-1]
    with blocker() as held:
        held.execute("SELECT id FROM orgs_ownerclaim WHERE id=%s FOR UPDATE", [claim.id])
        wrong_response = post_consume(issued_owner, payload={"token": wrong})
        assert wrong_response.status_code == 404
        before = counts()
        correct_response = post_consume(issued_owner, key="consume-public-key-0002")
        assert correct_response.status_code == 503
        assert counts() == before
        held.rollback()


@pytest.mark.django_db(transaction=True)
def test_busy_replay_key_metadata_requires_full_current_authority(issued_owner):
    from core.idempotency.store import Scope, lock_key

    verified = issued_owner[3]
    scope = Scope(
        issuer=verified.issuer,
        subject=verified.subject,
        method="POST",
        path="/api/v1/owner-claims/actions/consume",
        key="consume-public-key-0001",
    )
    with blocker() as held:
        held.execute("SELECT pg_advisory_lock(%s)", [lock_key(scope)])
        try:
            contact = post_consume(issued_owner, facts={"email_verified": False})
            assert contact.status_code == 403 and "retry_after_s" not in contact.json()
            factor = post_consume(issued_owner, facts={"kodera_mfa_enrolled": False})
            assert factor.status_code == 403 and "retry_after_s" not in factor.json()
            token = issued_owner[2]
            wrong = token[:-2] + ("A" if token[-2] != "A" else "B") + token[-1]
            negative = post_consume(issued_owner, payload={"token": wrong})
            assert negative.status_code == 404 and "retry_after_s" not in negative.json()
            current = post_consume(issued_owner)
            assert current.status_code == 409 and current.json()["retry_after_s"] == 1
            assert current.json()["type"].endswith("/idempotency-key-in-flight")
            assert all(
                "Idempotency-Replayed" not in response
                for response in (contact, factor, negative, current)
            )
            assert IdempotencyRecord.objects.count() == 0 and Membership.objects.count() == 0
            assert OwnerClaim.objects.get(id=issued_owner[1].id).state == "issued"
        finally:
            held.execute("SELECT pg_advisory_unlock(%s)", [lock_key(scope)])
            held.rollback()


@pytest.mark.django_db(transaction=True)
def test_busy_replay_key_hides_in_flight_metadata_at_factor_horizon(issued_owner, monkeypatch):
    from apps.orgs import claim_consumption as service
    from core.idempotency.store import Scope, lock_key

    issued_at = int(time.time())
    facts = {"iat": issued_at, "exp": issued_at + 600}
    verified = issued_owner[3]
    scope = Scope(
        issuer=verified.issuer,
        subject=verified.subject,
        method="POST",
        path="/api/v1/owner-claims/actions/consume",
        key="consume-public-key-0001",
    )
    with blocker() as held:
        held.execute("SELECT pg_advisory_lock(%s)", [lock_key(scope)])
        try:
            monkeypatch.setattr(
                service,
                "database_now",
                lambda: datetime.fromtimestamp(issued_at + 290, UTC),
            )
            refused = post_consume(issued_owner, facts=facts)
            assert refused.status_code == 403 and "retry_after_s" not in refused.json()
            assert "Idempotency-Replayed" not in refused
            assert IdempotencyRecord.objects.count() == 0 and Membership.objects.count() == 0
            assert OwnerClaim.objects.get(id=issued_owner[1].id).state == "issued"
        finally:
            held.execute("SELECT pg_advisory_unlock(%s)", [lock_key(scope)])
            held.rollback()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("second_key", ["consume-public-key-0001", "consume-public-key-0002"])
def test_two_actual_consumers_create_one_owner_and_release_session_lock(
    issued_owner, monkeypatch, second_key
):
    import threading

    from apps.orgs.api import owner_claims as view

    entered, release = threading.Event(), threading.Event()
    original = view.serialize_consume_result

    def held_response(result):
        entered.set()
        assert release.wait(10)
        return original(result)

    monkeypatch.setattr(view, "serialize_consume_result", held_response)
    consumer = None
    try:
        consumer = start_db_call(lambda: post_consume(issued_owner))
        assert entered.wait(5)
        second = post_consume(issued_owner, key=second_key)
        assert second.status_code == 503 and "Idempotency-Replayed" not in second
        assert not IdempotencyRecord.objects.exists()
        release.set()
        assert finish_db_call(consumer).status_code == 200
    finally:
        release.set()
        settle_db_calls(consumer)
    retry = post_consume(issued_owner, key=second_key)
    assert retry.status_code == (200 if second_key.endswith("0001") else 409)
    assert Membership.objects.filter(organisation_id=issued_owner[0].organisation.id).count() == 1
    assert AuditEvent.objects.filter(action="owner_claim.consumed").count() == 1


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("child", ["identity", "membership"])
def test_child_first_writer_conflict_refuses_nowait_and_parent_locks_release(issued_owner, child):
    if child == "membership":
        assert post_consume(issued_owner).status_code == 200
    claim = OwnerClaim.objects.get(id=issued_owner[1].id)
    before = counts()
    with blocker() as writer:
        writer.execute("SET LOCAL statement_timeout='5s'")
        if child == "identity":
            writer.execute(
                "SELECT id FROM identity_identity WHERE id=%s FOR UPDATE",
                [claim.intended_identity_id],
            )
        else:
            writer.execute(
                "SELECT id FROM orgs_membership WHERE id=%s FOR UPDATE", [claim.membership_id]
            )
        response = post_consume(issued_owner)
        assert response.status_code == 503 and counts() == before
        assert "Idempotency-Replayed" not in response
        # The actual invoker trigger now reaches its User and sorted organisation writes.
        # A parent hold leaked by the refused caller would fail this bounded statement.
        if child == "identity":
            updated = writer.execute(
                "UPDATE identity_identity SET enabled=enabled WHERE id=%s",
                [claim.intended_identity_id],
            )
        else:
            updated = writer.execute(
                "UPDATE orgs_membership SET state=state WHERE id=%s", [claim.membership_id]
            )
        assert updated.rowcount == 1
        writer.rollback()
    assert post_consume(issued_owner).status_code == 200


@pytest.mark.django_db(transaction=True)
def test_truly_disjoint_principal_admits_token_denial_while_other_parent_is_locked(
    issued_owner, settings
):
    from dataclasses import replace
    from types import SimpleNamespace

    from customer_http_fixtures import configure, trust_entry
    from django.db import transaction

    from apps.identity.models import Identity, User
    from apps.orgs.models import Organisation, SlugReservation

    world, claim, secret, verified = issued_owner
    with transaction.atomic():
        other = Organisation.objects.create(
            slug="disjoint-owner",
            realm="disjoint-owner",
            issuer="https://identity.staff.test/realms/disjoint-owner",
            name="Disjoint owner",
            state="prospect",
        )
        SlugReservation.objects.create(organisation=other, slug=other.slug, state="provisional")
        person = User.objects.create(email="disjoint.person@customer.test", enabled=True)
        identity = Identity.objects.create(
            user=person,
            organisation=other,
            issuer=other.issuer,
            realm=other.realm,
            subject="disjoint-person",
            email=person.email,
            enabled=True,
        )
    configure(settings, [*world.trust, trust_entry(world.signer, other.issuer)])
    disjoint = (
        SimpleNamespace(signer=world.signer, organisation=other),
        claim,
        secret,
        replace(verified, issuer=other.issuer, subject=identity.subject),
    )
    with blocker() as held:
        held.execute(
            "SELECT id FROM identity_user WHERE id=(SELECT user_id FROM identity_identity WHERE id=%s) FOR UPDATE",
            [claim.intended_identity_id],
        )
        assert post_consume(issued_owner).status_code == 503
        # A real signature, current stored identity and independent parent/organisation are admitted.
        # The other organisation's token receives its required scoped 404, not an admission 503.
        response = post_consume(disjoint)
        assert response.status_code == 404
        assert IdempotencyRecord.objects.filter(subject=identity.subject, status=404).count() == 1
        held.rollback()


@pytest.mark.django_db(transaction=True)
def test_early_cached_materialization_release_mutation_loses_actual_writer_wait(
    issued_owner, monkeypatch
):
    import inspect
    import textwrap
    import threading

    from apps.identity.models import User
    from core.idempotency import store

    first = post_consume(issued_owner)
    assert first.status_code == 200
    source = textwrap.dedent(inspect.getsource(store._execute))
    guarded = "replayed = Replayed(response=_response(record), first_seen_at=record.created_at)"
    assert source.count(guarded) == 1
    namespace = dict(store.__dict__)
    # Defer the actual record materializer until AFTER the real store transaction has committed.
    exec(  # noqa: S102 — one fixed mutation of checked local code, no external input
        compile(
            source.replace(
                guarded, "replayed = Replayed(response=record, first_seen_at=record.created_at)"
            ),
            "<early-replay-release-mutation>",
            "exec",
        ),
        namespace,
    )
    monkeypatch.setattr(store, "_execute", namespace["_execute"])
    original_run, original_response = store.run_once, store._response
    entered, release = threading.Event(), threading.Event()

    def held_response(record):
        assert not connection.in_atomic_block, (
            "the deliberate mutant did not release its transaction"
        )
        entered.set()
        assert release.wait(10)
        return original_response(record)

    def deferred_run(**kwargs):
        outcome = original_run(**kwargs)
        assert isinstance(outcome, store.Replayed)
        assert isinstance(outcome.response, IdempotencyRecord)
        return store.Replayed(
            response=held_response(outcome.response), first_seen_at=outcome.first_seen_at
        )

    monkeypatch.setattr(store, "run_once", deferred_run)
    consumer = writer = None
    try:
        consumer = start_db_call(lambda: post_consume(issued_owner))
        assert entered.wait(5)
        writer = start_db_call(
            lambda: User.objects.filter(identity__id=issued_owner[1].intended_identity_id).update(
                enabled=False
            )
        )
        assert (
            finish_db_call(writer) == 1
        )  # Real withdrawal completes before materialization release.
        with pytest.raises(
            AssertionError, match="expected independent database connection to be lock-blocked"
        ):
            assert_database_wait(writer[2])
        release.set()
        escaped = finish_db_call(consumer)
        assert escaped.status_code == 200 and escaped.content == first.content
        assert escaped["Idempotency-Replayed"] == "true"
    finally:
        release.set()
        settle_db_calls(consumer, writer)
    refused = post_consume(issued_owner)
    assert refused.status_code == 403 and "WWW-Authenticate" not in refused
    assert refused.json()["type"] == "https://kodera.io/problems/identity-unknown"


@pytest.mark.django_db(transaction=True)
def test_claim_lock_ahead_mutation_discloses_locked_locator_while_unknown_and_foreign_stay_404(
    issued_owner, settings, monkeypatch
):
    import inspect
    import textwrap
    from dataclasses import replace
    from types import SimpleNamespace

    from customer_http_fixtures import configure, trust_entry
    from django.db import transaction

    from apps.identity.models import Identity, User
    from apps.orgs import claim_consumption as service
    from apps.orgs.models import Organisation, SlugReservation
    from core.db.ids import new_uuid7

    world, claim, token, verified = issued_owner
    with transaction.atomic():
        other = Organisation.objects.create(
            slug="foreign-owner",
            realm="foreign-owner",
            issuer="https://identity.staff.test/realms/foreign-owner",
            name="Foreign owner",
            state="prospect",
        )
        SlugReservation.objects.create(organisation=other, slug=other.slug, state="provisional")
        person = User.objects.create(email="foreign.person@customer.test", enabled=True)
        identity = Identity.objects.create(
            user=person,
            organisation=other,
            issuer=other.issuer,
            realm=other.realm,
            subject="foreign-person",
            email=person.email,
            enabled=True,
        )
    configure(settings, [*world.trust, trust_entry(world.signer, other.issuer)])
    foreign = (
        SimpleNamespace(signer=world.signer, organisation=other),
        claim,
        token,
        replace(verified, issuer=other.issuer, subject=identity.subject),
    )
    wrong = token[:-2] + ("A" if token[-2] != "A" else "B") + token[-1]
    unknown = token[:4] + str(new_uuid7()) + token[40:]
    source = textwrap.dedent(inspect.getsource(service.Consumption._context))
    hash_start, lock_start, lock_end = (
        source.index("    row = ("),
        source.index("    claim = ("),
        source.index("    if claim is None:"),
    )
    mutation = (
        source[:hash_start]
        + source[lock_start:lock_end]
        + source[hash_start:lock_start]
        + source[lock_end:]
    )

    def require_uniform_negative():
        response = post_consume(issued_owner, payload={"token": wrong})
        assert response.status_code == 404, "wrong secret exposed located claim admission"

    with blocker() as held:
        held.execute("SELECT id FROM orgs_ownerclaim WHERE id=%s FOR UPDATE", [claim.id])
        require_uniform_negative()
        assert (
            post_consume(
                issued_owner, key="consume-public-key-unknown", payload={"token": unknown}
            ).status_code
            == 404
        )
        assert post_consume(foreign).status_code == 404
        assert post_consume(issued_owner, key="consume-public-key-valid").status_code == 503
        namespace = dict(service.__dict__)
        exec(  # noqa: S102 — one fixed local function order mutation, no external input
            compile(mutation, "<claim-lock-before-proof-mutation>", "exec"), namespace
        )
        monkeypatch.setattr(service.Consumption, "_context", namespace["_context"])
        with pytest.raises(AssertionError, match="wrong secret exposed located claim admission"):
            require_uniform_negative()
        assert (
            post_consume(
                issued_owner, key="consume-public-key-unknown", payload={"token": unknown}
            ).status_code
            == 404
        )
        assert post_consume(foreign).status_code == 404
        held.rollback()
