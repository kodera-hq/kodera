"""Authority revision triggers against the real tables, with real second connections.

Runs in the normal suite against the disposable test database: parent-tuple fencing races,
the write domain of the counter, lock order across organisations, concurrent monotonicity,
the trigger catalogue and its firing order, and committed function mutants that prove each
probe can fail. The customer persistence concurrency suite stays unchanged beside it.
"""

import threading
import time
from contextlib import contextmanager

import psycopg
import pytest
from django.db import connection
from django.utils import timezone
from psycopg import sql
from test_customer_persistence_concurrency import (
    begin,
    blocked_by,
    cleanup,
    finish_thread,
    session,
)
from test_customer_persistence_models import anchor, anchor_models

from core.db.ids import new_uuid7


@pytest.fixture(name="models")
def registered_models(transactional_db):
    assert connection.vendor == "postgresql"
    return anchor_models()


def revision(client, organisation):
    return client.execute(
        "SELECT authority_revision FROM orgs_organisation WHERE id=%s", [organisation.pk]
    ).fetchone()[0]


def user_state(client, user):
    return client.execute(
        "SELECT enabled,xmin::text FROM identity_user WHERE id=%s", [user.pk]
    ).fetchone()


def run_fanout_race(models, kind, isolation, first_action, commit_holder, *, check_version=True):
    old_org, _, _ = anchor(models)
    target, _, _ = anchor(models, slug="bravo")
    user = models.User.objects.create(email="fanout@customer.test")
    models.Membership.objects.create(
        user=user,
        organisation=old_org,
        role="org_member",
        state="active",
        accepted_at=timezone.now(),
    )
    link_id = new_uuid7()
    clients = []
    thread = None
    result = {}
    finished_dml = threading.Event()
    permit_commit = threading.Event()
    table = {"membership": "orgs_membership", "identity": "identity_identity"}[kind]

    def act(client, action):
        if action == "disable":
            client.execute("UPDATE identity_user SET enabled=false WHERE id=%s", [user.pk])
        elif kind == "membership":
            client.execute(
                "INSERT INTO orgs_membership "
                "(id,created_at,updated_at,user_id,organisation_id,role,state,accepted_at) "
                "VALUES (%s,now(),now(),%s,%s,'org_member','active',now())",
                [link_id, user.pk, target.pk],
            )
        else:
            client.execute(
                "INSERT INTO identity_identity "
                "(id,created_at,updated_at,user_id,organisation_id,issuer,realm,subject,email,enabled) "
                "VALUES (%s,now(),now(),%s,%s,%s,%s,'fanout-subject','fanout@customer.test',true)",
                [link_id, user.pk, target.pk, target.issuer, target.realm],
            )

    try:
        for _ in range(2):
            clients.append(session())
        holder, contender = clients
        for client in clients:
            begin(client, isolation)
            # Establish both snapshots before the first actual mutation.
            assert user_state(client, user)[0] is True
            assert client.execute(
                sql.SQL("SELECT count(*) FROM {} WHERE id=%s").format(sql.Identifier(table)),
                [link_id],
            ).fetchone() == (0,)
        baseline_target = revision(holder, target)
        baseline_old = revision(holder, old_org)
        baseline_xmin = user_state(holder, user)[1]
        act(holder, first_action)  # Must succeed; early isolation refusal fails this test.
        assert user_state(holder, user)[0] is (first_action != "disable")
        if check_version:
            assert user_state(holder, user)[1] != baseline_xmin, "parent tuple was not versioned"

        def competing_write():
            try:
                act(contender, "disable" if first_action == "link" else "link")
                result["dml"] = True
                finished_dml.set()
                if not permit_commit.wait(5):
                    raise AssertionError("test did not release contender commit")
                contender.execute("COMMIT")
                result["outcome"] = "committed"
            except psycopg.Error as error:
                result.update(
                    outcome="refused",
                    sqlstate=error.sqlstate,
                    constraint=error.diag.constraint_name,
                )
                contender.execute("ROLLBACK")
            except Exception as error:
                result.update(outcome="unexpected", category=type(error).__name__)
                contender.execute("ROLLBACK")
            finally:
                finished_dml.set()

        thread = threading.Thread(target=competing_write)
        thread.start()
        # Holder is also observer; no third raw connection needed for these new cases.
        blocked_by(holder, contender.info.backend_pid, holder.info.backend_pid)
        assert thread.is_alive()
        holder.execute("COMMIT" if commit_holder else "ROLLBACK")
        assert finished_dml.wait(4), "contender did not leave the observed database wait"
        # This sees only holder's committed effects while contender waits before COMMIT.
        after_holder = revision(holder, target)
        permit_commit.set()
        finish_thread(thread, contender)
        refuses = commit_holder and isolation != "READ COMMITTED"
        if refuses:
            assert result.get("outcome") == "refused" and result.get("sqlstate") == "40001", (
                "expected-stale-writer-refusal",
                result,
            )
        else:
            assert result.get("outcome") == "committed", result
            assert result.get("dml") is True
        holder_link = first_action == "link" and commit_holder
        contender_link = first_action == "disable" and not refuses
        link_exists = holder_link or contender_link
        disabled = (first_action == "disable" and commit_holder) or (
            first_action == "link" and not refuses
        )
        assert user_state(holder, user)[0] is (not disabled)
        assert holder.execute(
            sql.SQL("SELECT count(*) FROM {} WHERE id=%s").format(sql.Identifier(table)),
            [link_id],
        ).fetchone() == (int(link_exists),)
        final_target = revision(holder, target)
        if link_exists:
            assert final_target > baseline_target, "committed link did not advance target"
        else:
            assert final_target == baseline_target, "failed link leaked target revision"
        if first_action == "link" and commit_holder and not refuses:
            assert final_target > after_holder, "disable missed newly committed target"
        # Every successful case changes the shared user's original organisation too.
        assert revision(holder, old_org) > baseline_old
        return result
    finally:
        permit_commit.set()
        cleanup(clients, thread)


@pytest.mark.parametrize("kind", ["membership", "identity"])
@pytest.mark.parametrize("isolation", ["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"])
@pytest.mark.parametrize("first_action", ["link", "disable"])
@pytest.mark.parametrize("commit_holder", [True, False])
def test_actual_parent_tuple_fences_fanout(models, kind, isolation, first_action, commit_holder):
    run_fanout_race(models, kind, isolation, first_action, commit_holder)


@contextmanager
def committed_function_mutant(signature, mutate):
    """Committed mutation in the disposable test database; restore in finally.

    Uncommitted DDL would not expose the mutant to the separate clients.
    Do not run this suite in parallel or against a shared/non-test database.
    """
    assert connection.get_autocommit() and not connection.in_atomic_block
    assert str(connection.settings_dict["NAME"]).startswith("test_")
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_get_functiondef(%s::regprocedure)", [signature])
        original = cursor.fetchone()[0]
        cursor.execute(mutate(original))
    try:
        yield
    finally:
        with connection.cursor() as cursor:
            cursor.execute(original)
            cursor.execute("SELECT pg_get_functiondef(%s::regprocedure)", [signature])
            assert cursor.fetchone()[0] == original, "mutation restoration failed"


def replace_user_touch_function(body):
    return committed_function_mutant(
        "member_authority_user_touch()",
        lambda _original: (
            "CREATE OR REPLACE FUNCTION member_authority_user_touch() RETURNS trigger "
            "LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $mutant$ " + body + " $mutant$"
        ),
    )


def rewrite_function(signature, old, new):
    """Mutate exactly one occurrence of `old` in the installed function's own source."""

    def mutate(original):
        assert original.count(old) == 1, ("mutant anchor must occur once", signature, old)
        return original.replace(old, new)

    return committed_function_mutant(signature, mutate)


RETURN_ONLY = "BEGIN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END"
LOCK_ONLY = """
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM id FROM identity_user WHERE id=OLD.user_id FOR UPDATE;
    RETURN OLD;
  ELSE
    PERFORM id FROM identity_user WHERE id=NEW.user_id FOR UPDATE;
    RETURN NEW;
  END IF;
END
"""


def test_missing_parent_touch_is_distinguished(models):
    with replace_user_touch_function(RETURN_ONLY):
        with pytest.raises(
            AssertionError, match="contender never reached the expected database lock"
        ):
            run_fanout_race(
                models, "identity", "REPEATABLE READ", "link", True, check_version=False
            )


def test_lock_without_tuple_version_is_distinguished(models):
    with replace_user_touch_function(LOCK_ONLY):
        with pytest.raises(AssertionError, match="expected-stale-writer-refusal"):
            run_fanout_race(
                models, "identity", "REPEATABLE READ", "link", True, check_version=False
            )


@pytest.fixture(name="counter_world")
def counter_world_fixture(models):
    from types import SimpleNamespace

    from test_customer_persistence_models import identity

    first, _, _ = anchor(models, state="closed", owners=0)
    target, _, _ = anchor(models, slug="bravo", state="closed", owners=0)
    unrelated, _, _ = anchor(models, slug="charlie", state="closed", owners=0)
    user = models.User.objects.create(email="counter@customer.test")
    member = models.Membership.objects.create(
        user=user, organisation=first, role="org_member", state="active", accepted_at=timezone.now()
    )
    principal = identity(models, first, user)
    return SimpleNamespace(
        models=models,
        first=first,
        target=target,
        unrelated=unrelated,
        user=user,
        member=member,
        principal=principal,
    )


def counters(world):
    return dict(
        world.models.Organisation.objects.filter(
            pk__in=[world.first.pk, world.target.pk, world.unrelated.pk]
        ).values_list("id", "authority_revision")
    )


@pytest.mark.parametrize(
    "operation",
    [
        "org-save",
        "org-queryset",
        "org-raw",
        "org-counter-reset",
        "member-insert",
        "member-update",
        "member-delete",
        "member-soft-delete",
        "identity-insert",
        "identity-update",
        "identity-soft-delete",
        "user-save",
        "user-raw",
        "user-soft-delete",
    ],
)
def test_real_write_domain_advances_only_dependent_organisations(counter_world, operation):
    from datetime import timedelta

    from test_customer_persistence_models import identity

    w = counter_world
    before = counters(w)
    now = timezone.now()
    deleted = {"deleted_at": now, "purge_after": now + timedelta(days=1)}
    if operation == "org-save":
        w.first.name = "Changed"
        w.first.save(update_fields=["name"])
    elif operation == "org-queryset":
        w.models.Organisation.objects.filter(pk=w.first.pk).update(state="suspended")
    elif operation in {"org-raw", "org-counter-reset"}:
        statement = (
            "UPDATE orgs_organisation SET name=name WHERE id=%s"
            if operation == "org-raw"
            else "UPDATE orgs_organisation SET authority_revision=0 WHERE id=%s"
        )
        with connection.cursor() as cursor:
            cursor.execute(statement, [w.first.pk])
    elif operation == "member-insert":
        w.models.Membership.objects.create(
            user=w.user, organisation=w.target, role="org_member", state="active", accepted_at=now
        )
    elif operation == "member-update":
        w.models.Membership.objects.filter(pk=w.member.pk).update(role="org_billing")
    elif operation == "member-delete":
        with connection.cursor() as cursor:
            cursor.execute("DELETE FROM orgs_membership WHERE id=%s", [w.member.pk])
    elif operation == "member-soft-delete":
        w.models.Membership.objects.filter(pk=w.member.pk).update(**deleted)
    elif operation == "identity-insert":
        identity(w.models, w.target, w.user)
    elif operation == "identity-update":
        w.models.Identity.objects.filter(pk=w.principal.pk).update(enabled=False)
    elif operation == "identity-soft-delete":
        w.models.Identity.objects.filter(pk=w.principal.pk).update(**deleted)
    elif operation == "user-save":
        w.user.enabled = False
        w.user.save(update_fields=["enabled"])
    elif operation == "user-raw":
        with connection.cursor() as cursor:
            cursor.execute("UPDATE identity_user SET enabled=enabled WHERE id=%s", [w.user.pk])
    else:
        w.models.User.objects.filter(pk=w.user.pk).update(**deleted)
    after = counters(w)
    assert after[w.first.pk] > before[w.first.pk]
    assert after[w.unrelated.pk] == before[w.unrelated.pk]
    if operation in {"member-insert", "identity-insert"}:
        assert after[w.target.pk] > before[w.target.pk]
    else:
        assert after[w.target.pk] == before[w.target.pk]


def test_retained_links_participate_in_user_wide_invalidation(counter_world):
    from datetime import timedelta

    w = counter_world
    now = timezone.now()
    w.models.Membership.objects.create(
        user=w.user,
        organisation=w.target,
        role="org_member",
        state="removed",
        deleted_at=now,
        purge_after=now + timedelta(days=1),
    )
    before = counters(w)
    w.models.User.objects.filter(pk=w.user.pk).update(enabled=False)
    after = counters(w)
    assert all(after[pk] > before[pk] for pk in (w.first.pk, w.target.pk))
    assert after[w.unrelated.pk] == before[w.unrelated.pk]


def test_rollback_restores_all_counter_and_user_fields(counter_world):
    from django.db import transaction

    w = counter_world
    before = counters(w)
    with transaction.atomic():
        w.models.User.objects.filter(pk=w.user.pk).update(enabled=False)
        assert counters(w)[w.first.pk] > before[w.first.pk]
        transaction.set_rollback(True)
    assert counters(w) == before
    w.user.refresh_from_db()
    assert w.user.enabled


def test_overflow_refuses_entire_parent_mutation(counter_world):
    from django.db import IntegrityError, transaction

    w = counter_world
    original = counters(w)
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "ALTER TABLE orgs_organisation DISABLE TRIGGER aa_organisation_authority_advance"
            )
            cursor.execute(
                "UPDATE orgs_organisation SET authority_revision=9223372036854775807 WHERE id=%s",
                [w.first.pk],
            )
            # Validate the setup UPDATE's queued constraints before altering its table.
            cursor.execute(
                "SET CONSTRAINTS organisation_owner_required, organisation_reservation_required "
                "IMMEDIATE"
            )
            cursor.execute(
                "ALTER TABLE orgs_organisation ENABLE TRIGGER aa_organisation_authority_advance"
            )
            cursor.execute(
                "SET CONSTRAINTS organisation_owner_required, organisation_reservation_required "
                "DEFERRED"
            )
        with pytest.raises(IntegrityError) as refusal, transaction.atomic():
            w.models.User.objects.filter(pk=w.user.pk).update(enabled=False)
        assert refusal.value.__cause__.sqlstate == "23514"
        assert (
            refusal.value.__cause__.diag.constraint_name
            == "organisation_authority_revision_exhausted"
        )
        w.user.refresh_from_db()
        assert w.user.enabled
        assert counters(w)[w.first.pk] == 9223372036854775807
        transaction.set_rollback(True)
    assert counters(w) == original


def test_counter_guard_mutation_is_distinguished_and_restored(counter_world):
    from django.db import transaction

    w = counter_world
    before = counters(w)
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "ALTER TABLE orgs_organisation DISABLE TRIGGER aa_organisation_authority_advance"
            )
        with pytest.raises(AssertionError, match="counter did not advance"):
            w.models.Organisation.objects.filter(pk=w.first.pk).update(name="Mutant")
            assert counters(w)[w.first.pk] > before[w.first.pk], "counter did not advance"
        transaction.set_rollback(True)
    w.models.Organisation.objects.filter(pk=w.first.pk).update(name="Restored")
    assert counters(w)[w.first.pk] > before[w.first.pk]


@pytest.mark.parametrize("operation", ["identity-delete", "identity-rebind", "user-delete"])
def test_existing_refusals_leave_revisions_unchanged(counter_world, operation):
    from django.db import IntegrityError, transaction

    w = counter_world
    before = counters(w)
    statement = {
        "identity-delete": (
            "DELETE FROM identity_identity WHERE id=%s",
            w.principal.pk,
            "identity_delete_refused",
        ),
        "identity-rebind": (
            "UPDATE identity_identity SET subject='changed' WHERE id=%s",
            w.principal.pk,
            "identity_immutable_binding",
        ),
        "user-delete": ("DELETE FROM identity_user WHERE id=%s", w.user.pk, None),
    }[operation]
    with (
        pytest.raises(IntegrityError) as refusal,
        transaction.atomic(),
        connection.cursor() as cursor,
    ):
        cursor.execute(statement[0], [statement[1]])
    if statement[2] is not None:
        assert refusal.value.__cause__.sqlstate == "23514"
        assert refusal.value.__cause__.diag.constraint_name == statement[2]
    else:
        assert refusal.value.__cause__.sqlstate == "23503"
    assert counters(w) == before


def test_insert_forces_revision_baseline(models):
    from django.db import transaction

    with transaction.atomic():
        org = models.Organisation.objects.create(
            slug="delta",
            realm="delta",
            issuer="https://identity.customer.test/realms/delta",
            name="Initial",
            authority_revision=99,
        )
        org.refresh_from_db()
        assert org.authority_revision == 1
        # No reservation exists in this deliberately incomplete insert probe.
        transaction.set_rollback(True)


def test_authority_catalog_matches_declared_protocol(models):
    functions = {
        "organisation_authority_advance",
        "member_authority_user_touch",
        "user_authority_fanout",
        "member_authority_org_touch",
    }
    expected = {
        ("orgs_organisation", "aa_organisation_authority_advance"): (
            23,
            "organisation_authority_advance",
        ),
        ("orgs_membership", "aa_member_authority_user_touch"): (31, "member_authority_user_touch"),
        ("identity_identity", "aa_member_authority_user_touch"): (
            31,
            "member_authority_user_touch",
        ),
        ("orgs_membership", "d_member_authority_org_touch"): (29, "member_authority_org_touch"),
        ("identity_identity", "d_member_authority_org_touch"): (29, "member_authority_org_touch"),
        ("identity_user", "d_user_authority_fanout"): (25, "user_authority_fanout"),
    }
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT p.proname,p.pronargs,p.provolatile,p.prosecdef,"
            "p.prorettype::regtype::text,l.lanname FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang "
            "WHERE p.pronamespace=current_schema()::regnamespace AND p.proname=ANY(%s)",
            [sorted(functions)],
        )
        rows = cursor.fetchall()
        assert {r[0] for r in rows} == functions
        assert all(tuple(r[1:]) == (0, "v", False, "trigger", "plpgsql") for r in rows)
        cursor.execute(
            "SELECT c.relname,t.tgname,t.tgtype,p.proname,t.tgenabled,t.tgdeferrable,t.tginitdeferred "
            "FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid "
            "WHERE c.relnamespace=current_schema()::regnamespace AND p.proname=ANY(%s)",
            [sorted(functions)],
        )
        rows = cursor.fetchall()
        assert {(r[0], r[1]): (r[2], r[3]) for r in rows} == expected
        assert all(tuple(r[4:]) == ("O", False, False) for r in rows)
        cursor.execute(
            "SELECT convalidated,pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conrelid='orgs_organisation'::regclass AND conname='organisation_authority_revision_valid'"
        )
        valid, definition = cursor.fetchone()
        assert valid and "authority_revision >= 1" in definition


def test_last_owner_refusal_restores_counter(models):
    from django.db import IntegrityError, transaction

    org, _, owners = anchor(models)
    org.refresh_from_db()
    before = org.authority_revision
    with (
        pytest.raises(IntegrityError) as refusal,
        transaction.atomic(),
        connection.cursor() as cursor,
    ):
        cursor.execute("DELETE FROM orgs_membership WHERE id=%s", [owners[0].pk])
    assert refusal.value.__cause__.sqlstate == "23514"
    assert refusal.value.__cause__.diag.constraint_name == "organisation_owner_required"
    org.refresh_from_db()
    assert org.authority_revision == before
    assert models.Membership.objects.filter(pk=owners[0].pk).exists()


# The order PostgreSQL fires same-timing, same-event row triggers: by name, byte order.
BEFORE_ROW_TRIGGER_ORDER = {
    ("identity_user", "UPDATE"): ["a_customer_immutable"],
    ("identity_identity", "INSERT"): ["aa_member_authority_user_touch"],
    ("identity_identity", "UPDATE"): ["a_customer_immutable", "aa_member_authority_user_touch"],
    ("identity_identity", "DELETE"): ["aa_member_authority_user_touch", "customer_identity_delete"],
    ("orgs_membership", "INSERT"): [
        "aa_member_authority_user_touch",
        "b_customer_touch_owner_guard",
    ],
    ("orgs_membership", "UPDATE"): [
        "a_customer_immutable",
        "aa_member_authority_user_touch",
        "b_customer_touch_owner_guard",
    ],
    ("orgs_membership", "DELETE"): [
        "aa_member_authority_user_touch",
        "b_customer_touch_owner_guard",
    ],
    ("orgs_organisation", "INSERT"): ["aa_organisation_authority_advance"],
    ("orgs_organisation", "UPDATE"): [
        "a_customer_immutable",
        "aa_organisation_authority_advance",
        "b_customer_activate_owner_guard",
    ],
}
EVENT_BITS = {"INSERT": 4, "DELETE": 8, "UPDATE": 16}


def test_before_row_triggers_fire_in_the_declared_order(models):
    # Binding immutability refuses before the parent user is touched, and the user
    # touch (with its organisation pre-lock) runs before the owner guard locks the
    # target: read from pg_trigger, not from the names this test was written with.
    with connection.cursor() as cursor:
        for (table, event), expected in BEFORE_ROW_TRIGGER_ORDER.items():
            cursor.execute(
                "SELECT t.tgname FROM pg_trigger t WHERE t.tgrelid=%s::regclass "
                "AND NOT t.tgisinternal AND t.tgtype & 3 = 3 AND t.tgtype & 64 = 0 "
                'AND t.tgtype & %s <> 0 ORDER BY t.tgname COLLATE "C"',
                [table, EVENT_BITS[event]],
            )
            assert [row[0] for row in cursor.fetchall()] == expected, (table, event)


def link(models, user, organisation):
    return models.Membership.objects.create(
        user=user,
        organisation=organisation,
        role="org_member",
        state="active",
        accepted_at=timezone.now(),
    )


def insert_membership(client, user_id, organisation_id):
    client.execute(
        "INSERT INTO orgs_membership "
        "(id,created_at,updated_at,user_id,organisation_id,role,state,accepted_at) "
        "VALUES (%s,now(),now(),%s,%s,'org_member','active',now())",
        [new_uuid7(), user_id, organisation_id],
    )


def wait_until_blocked(observer, blocked):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if observer.execute("SELECT pg_blocking_pids(%s)", [blocked]).fetchone()[0]:
            return
        time.sleep(0.02)
    raise AssertionError("writer never reached a database lock wait")


def free_organisations(observer, organisation_ids):
    """Which of these organisations no other transaction holds a row lock on."""
    observer.execute("BEGIN")
    try:
        return {
            row[0]
            for row in observer.execute(
                "SELECT id FROM orgs_organisation WHERE id = ANY(%s) FOR NO KEY UPDATE SKIP LOCKED",
                [list(organisation_ids)],
            ).fetchall()
        }
    finally:
        observer.execute("ROLLBACK")


LOCK_ORDER_SIZE = 5
LOCK_ORDER_TARGET = 2


def lock_order_world(models, operation):
    organisations = sorted(
        (anchor(models, slug=f"lock-order-{index}")[0] for index in range(LOCK_ORDER_SIZE)),
        key=lambda organisation: organisation.pk,
    )
    user = models.User.objects.create(email="lock-order@customer.test")
    target = organisations[LOCK_ORDER_TARGET]
    for organisation in organisations:
        # A membership insert links one more organisation, in the middle of the order.
        if operation == "user-update" or organisation is not target:
            link(models, user, organisation)
    return organisations, user, target


def held_while_blocked(organisations, blocked, operation, user, target):
    """The organisations an authority write already holds when it waits on `blocked`."""
    clients = []
    thread = None
    result = {}
    try:
        for _ in range(3):
            clients.append(session())
        blocker, writer, observer = clients
        begin(blocker, "READ COMMITTED")
        blocker.execute(
            "SELECT 1 FROM orgs_organisation WHERE id=%s FOR NO KEY UPDATE", [blocked.pk]
        )
        begin(writer, "READ COMMITTED")

        def write():
            try:
                if operation == "user-update":
                    writer.execute(
                        "UPDATE identity_user SET enabled=enabled WHERE id=%s", [user.pk]
                    )
                else:
                    insert_membership(writer, user.pk, target.pk)
                result["outcome"] = "written"
            except psycopg.Error as error:
                result.update(outcome="refused", sqlstate=error.sqlstate)

        thread = threading.Thread(target=write)
        thread.start()
        blocked_by(observer, writer.info.backend_pid, blocker.info.backend_pid)
        others = {organisation.pk for organisation in organisations} - {blocked.pk}
        held = others - free_organisations(observer, others)
        blocker.execute("ROLLBACK")
        finish_thread(thread, writer)
        assert result == {"outcome": "written"}, result
        writer.execute("ROLLBACK")
        return held
    finally:
        cleanup(clients, thread)


def assert_ascending_lock_order(models, operation):
    organisations, user, target = lock_order_world(models, operation)
    for index, blocked in enumerate(organisations):
        held = held_while_blocked(organisations, blocked, operation, user, target)
        expected = {organisation.pk for organisation in organisations[:index]}
        assert held == expected, ("organisation-lock-order", operation, index)


@pytest.mark.parametrize("operation", ["user-update", "membership-insert"])
def test_authority_writes_lock_organisations_in_ascending_id(models, operation):
    # Blocked on the k-th organisation, a writer holds exactly the k lower ones and
    # none above: the fan-out alone for a user update, and for an association write
    # the pre-lock, which includes the target before the fan-out and owner guard.
    assert_ascending_lock_order(models, operation)


@pytest.mark.parametrize(
    ("operation", "signature", "old", "new"),
    [
        (
            "user-update",
            "user_authority_fanout()",
            "ORDER BY organisation_id",
            "ORDER BY organisation_id DESC",
        ),
        (
            "membership-insert",
            "member_authority_user_touch()",
            ") ORDER BY id FOR NO KEY UPDATE",
            ") ORDER BY id DESC FOR NO KEY UPDATE",
        ),
        (
            "membership-insert",
            "member_authority_user_touch()",
            "\n    UNION\n    SELECT target_organisation\n",
            "\n",
        ),
    ],
    ids=["fanout-descending", "prelock-descending", "prelock-without-target"],
)
def test_lock_order_mutants_are_distinguished(models, operation, signature, old, new):
    with (
        rewrite_function(signature, old, new),
        pytest.raises(AssertionError, match="organisation-lock-order"),
    ):
        assert_ascending_lock_order(models, operation)


def run_crossed_invitations(models):
    """Two writers each link a user, already in one organisation, to the other one."""
    low, high = sorted(
        (anchor(models, slug=slug)[0] for slug in ("crossed-a", "crossed-c")),
        key=lambda organisation: organisation.pk,
    )
    into_low = models.User.objects.create(email="crossed-one@customer.test")
    into_high = models.User.objects.create(email="crossed-two@customer.test")
    link(models, into_low, high)
    link(models, into_high, low)
    clients = []
    threads = []
    results = {}
    try:
        for _ in range(4):
            clients.append(session())
        blocker, first, second, observer = clients
        before = dict(
            observer.execute(
                "SELECT id,authority_revision FROM orgs_organisation WHERE id = ANY(%s)",
                [[low.pk, high.pk]],
            ).fetchall()
        )
        begin(blocker, "READ COMMITTED")
        blocker.execute("SELECT 1 FROM orgs_organisation WHERE id=%s FOR NO KEY UPDATE", [low.pk])

        def invite(name, client, user, organisation):
            try:
                insert_membership(client, user.pk, organisation.pk)
                client.execute("COMMIT")
                results[name] = ("committed",)
            except psycopg.Error as error:
                results[name] = ("refused", error.sqlstate)
                client.execute("ROLLBACK")

        # The old two-phase order, fan-out then target, let `first` hold `high`
        # while waiting for `low`, and `second` hold `low` while waiting for `high`.
        for name, client, user, organisation in (
            ("second", second, into_high, high),
            ("first", first, into_low, low),
        ):
            begin(client, "READ COMMITTED")
            thread = threading.Thread(target=invite, args=(name, client, user, organisation))
            threads.append(thread)
            thread.start()
            wait_until_blocked(observer, client.info.backend_pid)
        assert free_organisations(observer, [high.pk]) == {high.pk}, (
            "crossed-writer-holds-higher",
        )
        blocker.execute("ROLLBACK")
        for thread, client in zip(threads, (second, first), strict=True):
            finish_thread(thread, client)
        assert results == {"first": ("committed",), "second": ("committed",)}, results
        rows = observer.execute(
            "SELECT id,authority_revision FROM orgs_organisation WHERE id = ANY(%s)",
            [[low.pk, high.pk]],
        ).fetchall()
        assert len(rows) == 2 and all(revision > before[pk] for pk, revision in rows)
        assert (
            observer.execute(
                "SELECT count(*) FROM orgs_membership WHERE (user_id,organisation_id) IN "
                "((%s,%s),(%s,%s))",
                [into_low.pk, low.pk, into_high.pk, high.pk],
            ).fetchone()[0]
            == 2
        )
    finally:
        for client in clients:
            try:
                client.cancel()
            except Exception:  # noqa: S110 - best-effort release before close
                pass
        for thread in threads:
            thread.join(9)
        for client in clients:
            client.close()
        assert not any(thread.is_alive() for thread in threads)


def test_crossed_invitations_between_two_organisations_both_commit(models):
    run_crossed_invitations(models)


def test_target_locked_after_fanout_is_distinguished_by_crossed_invitations(models):
    with (
        rewrite_function(
            "member_authority_user_touch()",
            "\n    UNION\n    SELECT target_organisation\n",
            "\n",
        ),
        pytest.raises(AssertionError, match="crossed-writer-holds-higher"),
    ):
        run_crossed_invitations(models)


CONCURRENT_WRITES = {
    # Each writer assigns the value its own read implies: the lost-update shape.
    "stale-assignment": (
        "UPDATE orgs_organisation SET authority_revision=%s WHERE id=%s",
        lambda stale: stale + 1,
    ),
    "descriptive": ("UPDATE orgs_organisation SET name=name WHERE id=%s", None),
}


def run_concurrent_writers(models, write):
    """Two committed writers of one organisation, the second waiting on the first."""
    statement, assigned = CONCURRENT_WRITES[write]
    organisation, _, _ = anchor(models)
    clients = []
    thread = None
    result = {}
    try:
        for _ in range(2):
            clients.append(session())
        holder, contender = clients
        for client in clients:
            begin(client, "READ COMMITTED")
        stale = revision(holder, organisation)
        assert revision(contender, organisation) == stale
        parameters = [organisation.pk] if assigned is None else [assigned(stale), organisation.pk]
        holder.execute(statement, parameters)

        def contend():
            try:
                contender.execute(statement, parameters)
                contender.execute("COMMIT")
                result["outcome"] = "committed"
            except psycopg.Error as error:
                result.update(outcome="refused", sqlstate=error.sqlstate)
                contender.execute("ROLLBACK")

        thread = threading.Thread(target=contend)
        thread.start()
        blocked_by(holder, contender.info.backend_pid, holder.info.backend_pid)
        holder.execute("COMMIT")
        finish_thread(thread, contender)
        assert result == {"outcome": "committed"}, result
        final = revision(holder, organisation)
        assert final == stale + 2, ("lost-authority-update", stale, final)
    finally:
        cleanup(clients, thread)


@pytest.mark.parametrize("write", sorted(CONCURRENT_WRITES))
def test_two_committed_writers_advance_the_revision_twice(models, write):
    run_concurrent_writers(models, write)


def test_caller_assigned_revision_mutant_is_distinguished_by_concurrent_writers(models):
    with (
        rewrite_function(
            "organisation_authority_advance()",
            "NEW.authority_revision := OLD.authority_revision + 1;",
            "NULL;",
        ),
        pytest.raises(AssertionError, match="lost-authority-update"),
    ):
        run_concurrent_writers(models, "stale-assignment")
