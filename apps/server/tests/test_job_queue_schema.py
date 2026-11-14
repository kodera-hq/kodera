"""The job-queue records as the acceptance tests read them: names, guards and migrations.

docs/specs/JOB_QUEUE.md §3 and docs/domain/MODEL.md §8 pin the physical names; the acceptance tests
read them by SQL and write some of them directly (§3.2). This module proves the names, each guard's
SQLSTATE and constraint name, the defaults the direct writes rely on, and that the migrations apply,
reverse and reapply on an empty database.
"""

import re
import uuid
from contextlib import contextmanager
from typing import Any

import pytest
from django.apps import apps
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from test_customer_persistence_migrations import empty_database, schema_objects

QUEUE_APPS = ("jobs", "outbox", "audit")

EVIDENCE = {
    "compute_terminated_provider": "text",
    "compute_terminated_resource_id": "text",
    "compute_terminated_request_id": "text",
    "compute_terminated_observed_at": "timestamptz",
    "target_read_provider": "text",
    "target_read_resource_id": "text",
    "target_read_request_id": "text",
    "target_read_observed_at": "timestamptz",
}

COLUMNS: dict[str, dict[str, str]] = {
    "jobs_job": {
        "id": "uuid",
        "organisation_id": "uuid",
        "tenant_id": "uuid",
        "kind": "text",
        "idempotency_key": "text",
        "desired_spec_hash": "text",
        "status": "text",
        "lease_expires_at": "timestamptz",
        "runner_id": "text",
        "fence": "int8",
        "unresolved_step_id": "uuid",
        "unresolved_operation_ref": "text",
        "reconciliation_decision_ref": "uuid",
        "lock_requested_at": "timestamptz",
        "depends_on_job_id": "uuid",
        "attempt": "int4",
        "max_attempts": "int4",
        "not_before": "timestamptz",
        "actor_type": "text",
        "actor_id": "uuid",
        "parent_job_id": "uuid",
        "request_id": "text",
        "started_at": "timestamptz",
        "finished_at": "timestamptz",
        "error_code": "text",
        "artefact_refs": "jsonb",
        "created_at": "timestamptz",
        "updated_at": "timestamptz",
    },
    "jobs_jobstep": {
        "id": "uuid",
        "job_id": "uuid",
        "seq": "int4",
        "name": "text",
        "status": "text",
        "retry_class": "text",
        "conditional": "bool",
        "attempt": "int4",
        "started_at": "timestamptz",
        "finished_at": "timestamptz",
        "timeout_s": "int4",
        "output_ref": "text",
        "error_code": "text",
    },
    "jobs_joblockreservation": {
        "id": "uuid",
        "job_id": "uuid",
        "fence": "int8",
        "lock_class": "text",
        "lock_key": "uuid",
        "mode": "text",
        "reserved_at": "timestamptz",
        "ended_at": "timestamptz",
    },
    "jobs_jobdispatch": {
        "id": "uuid",
        "job_id": "uuid",
        "step_id": "uuid",
        "fence": "int8",
        "operation_ref": "text",
        "sub_job_id": "uuid",
        "dispatched_at": "timestamptz",
        "closed_at": "timestamptz",
        "terminal_outcome": "text",
        "terminal_evidence_ref": "text",
    },
    "jobs_jobreconciliationdecision": {
        "id": "uuid",
        "job_id": "uuid",
        "exit": "text",
        "operation_outcome": "text",
        **EVIDENCE,
        "unresolved_step_id": "uuid",
        "unresolved_operation_ref": "text",
        "dispatch_outcome_at_decision": "text",
        "decided_by_identity_id": "uuid",
        "decided_by_role": "text",
        "decided_at": "timestamptz",
        "decided_txid": "int8",
    },
    "outbox_outboxdelivery": {
        "id": "uuid",
        "organisation_id": "uuid",
        "category": "text",
        "changes_realm": "bool",
        "status": "text",
        "operation_ref": "text",
        "reconciliation_decision_ref": "uuid",
        "started_at": "timestamptz",
        "finished_at": "timestamptz",
        "created_at": "timestamptz",
        "updated_at": "timestamptz",
    },
    "outbox_deliverydecision": {
        "id": "uuid",
        "delivery_id": "uuid",
        "exit": "text",
        "operation_outcome": "text",
        **EVIDENCE,
        "decided_by_identity_id": "uuid",
        "decided_by_role": "text",
        "decided_at": "timestamptz",
        "decided_txid": "int8",
    },
    "audit_auditevent": {
        "id": "uuid",
        "occurred_at": "timestamptz",
        "actor_type": "text",
        "actor_id": "uuid",
        "actor_label": "text",
        "organisation_id": "uuid",
        "action": "text",
        "target_urn": "text",
        "before": "jsonb",
        "after": "jsonb",
        "request_id": "text",
        "job_id": "uuid",
        "source_ip_trunc": "inet",
        "retention_class": "text",
        "metadata": "jsonb",
    },
}

CONSTRAINTS: dict[str, set[str]] = {
    "jobs_job": {
        "jobs_job_idempotency_key_unique",
        "jobs_job_kind_valid",
        "jobs_job_status_valid",
        "jobs_job_hashes_valid",
        "jobs_job_actor_type_valid",
        "jobs_job_tenant_null_for_realm_kinds",
        "jobs_job_tenant_set_for_tenant_kinds",
        "jobs_job_lease_while_claimed",
        "jobs_job_no_lease_unless_claimed",
        "jobs_job_unresolved_step_when_reconciling",
        "jobs_job_unresolved_operation_when_reconciling",
        "jobs_job_error_code_when_failed",
        "jobs_job_no_error_code_unless_failed",
        "jobs_job_error_code_valid",
        "jobs_job_organisation_fk",
        "jobs_job_parent_fk",
        "jobs_job_depends_on_fk",
        "jobs_job_unresolved_step_fk",
        "jobs_job_decision_fk",
    },
    "jobs_jobstep": {
        "jobs_jobstep_seq_unique",
        "jobs_jobstep_status_valid",
        "jobs_jobstep_retry_class_valid",
        "jobs_jobstep_job_fk",
    },
    "jobs_joblockreservation": {
        "jobs_joblockreservation_claim_unique",
        "jobs_joblockreservation_lock_class_valid",
        "jobs_joblockreservation_mode_valid",
        "jobs_joblockreservation_job_fk",
    },
    "jobs_jobdispatch": {
        "jobs_jobdispatch_terminal_outcome_valid",
        "jobs_jobdispatch_job_fk",
        "jobs_jobdispatch_step_fk",
        "jobs_jobdispatch_sub_job_fk",
    },
    "jobs_jobreconciliationdecision": {
        "jobs_jobreconciliationdecision_exit_valid",
        "jobs_jobreconciliationdecision_operation_outcome_valid",
        "jobs_jobreconciliationdecision_dispatch_outcome_valid",
        "jobs_jobreconciliationdecision_role_valid",
        "jobs_jobreconciliationdecision_partial_only_fails",
        "jobs_jobreconciliationdecision_job_fk",
        "jobs_jobreconciliationdecision_step_fk",
        "jobs_jobreconciliationdecision_identity_fk",
    },
    "outbox_outboxdelivery": {
        "outbox_delivery_category_valid",
        "outbox_delivery_status_valid",
        "outbox_delivery_started_when_in_flight",
        "outbox_delivery_organisation_fk",
        "outbox_delivery_decision_fk",
    },
    "outbox_deliverydecision": {
        "outbox_deliverydecision_exit_valid",
        "outbox_deliverydecision_operation_outcome_valid",
        "outbox_deliverydecision_role_valid",
        "outbox_deliverydecision_partial_only_fails",
        "outbox_deliverydecision_evidence_present",
        "outbox_deliverydecision_delivery_fk",
        "outbox_deliverydecision_identity_fk",
    },
    "audit_auditevent": {
        "audit_auditevent_actor_type_valid",
        "audit_auditevent_retention_class_valid",
    },
}

TRIGGERS: dict[str, set[str]] = {
    "jobs_job": {"jobs_job_guard", "jobs_job_reconciliation_exit"},
    "jobs_jobstep": {"jobs_jobstep_guard"},
    "jobs_joblockreservation": {"jobs_joblockreservation_guard"},
    "jobs_jobdispatch": {"jobs_jobdispatch_guard"},
    "jobs_jobreconciliationdecision": {
        "jobs_jobreconciliationdecision_valid",
        "jobs_jobreconciliationdecision_immutable",
    },
    "outbox_outboxdelivery": {"outbox_delivery_reconciliation_exit"},
    "outbox_deliverydecision": {
        "outbox_deliverydecision_valid",
        "outbox_deliverydecision_immutable",
    },
    "audit_auditevent": {"audit_auditevent_immutable"},
}
# outbox 0007 fences the delivery records of a fenced organisation, and only where the
# retention schema (orgs 0025) is installed; the queue-only profile has no such table.
PRIVACY_CUTOFF_TRIGGERS: dict[str, set[str]] = {
    "outbox_outboxdelivery": {"aa_privacy_cutoff"},
}

INDEXES = {
    "jobs_job_claimable_idx",
    "jobs_job_request_order_idx",
    "jobs_job_parent_idx",
    "jobs_job_depends_on_idx",
    "jobs_reservation_unended_idx",
    "jobs_joblockreservation_one_unended",
    "jobs_jobdispatch_open_idx",
    "jobs_jobdispatch_sub_job_idx",
    "jobs_jobdispatch_step_idx",
    "jobs_decision_step_idx",
    "audit_auditevent_job_idx",
    "audit_auditevent_org_idx",
}

JOB_SPECIFICATION = (
    "id",
    "organisation_id",
    "tenant_id",
    "kind",
    "idempotency_key",
    "desired_spec_hash",
    "max_attempts",
    "actor_type",
    "actor_id",
    "parent_job_id",
    "depends_on_job_id",
    "request_id",
    "created_at",
)
STEP_SPECIFICATION = ("id", "job_id", "seq", "name", "retry_class", "conditional", "timeout_s")

# Every guarded clause carries one marker naming the test-only flag that disables it (§9.2).
MARKERS = {
    "job_delete_allowed",
    *(f"job_spec_mutable_{column}" for column in JOB_SPECIFICATION),
    "place_may_be_cleared",
    "place_may_move_earlier",
    "step_delete_allowed",
    *(f"step_spec_mutable_{column}" for column in STEP_SPECIFICATION),
    "reservation_end_rewritable",
    "dispatch_closed_at_rewritable",
    "dispatch_outcome_rewritable",
    "dispatch_evidence_rewritable",
    "job_decision_update_allowed",
    "job_decision_delete_allowed",
    "job_exit_unguarded",
    "job_exit_accepts_other_job",
    "job_exit_reuses_reference",
    "job_exit_any_transaction",
    "job_exit_resume_unbound",
    "job_exit_fail_unbound",
    "job_decided_txid_not_forced",
    "job_decided_at_future",
    "job_decided_at_before_dispatch",
    "delete_allowed_in_flight",
    "delete_allowed_unresolved",
    "freeze_unresolved_only",
    "freeze_in_flight_only",
    "freeze_skips_changes_realm",
    "freeze_skips_category",
    "freeze_skips_organisation",
    "freeze_skips_started_at",
    "delivery_exit_unguarded",
    "delivery_exit_accepts_other_delivery",
    "delivery_exit_reuses_reference",
    "delivery_exit_any_transaction",
    "delivery_exit_compares_xmin",
    "delivery_exit_ignores_started_at",
    "delivery_exit_fail_unbound",
    "delivery_exit_completed_unbound",
    "delivery_exit_no_effect_unbound",
    "decided_at_not_forced",
    "decision_trigger_ignores_status",
    "decision_trigger_ignores_start_order",
    "decision_trigger_target_before_compute",
    "decision_trigger_future",
    "decision_trigger_no_start_tolerance",
    "decision_trigger_no_future_tolerance",
    "decided_txid_not_forced",
    "delivery_decision_update_allowed",
    "delivery_decision_delete_allowed",
    "audit_update_allowed",
    "audit_delete_allowed",
}

HEX_A, HEX_B = "a" * 64, "b" * 64


def fetch(statement: str, params: list[Any] | None = None) -> list[tuple[Any, ...]]:
    with connection.cursor() as cursor:
        cursor.execute(statement, params)
        return cursor.fetchall() if cursor.description else []


def insert(table: str, values: dict[str, Any]) -> Any:
    columns, markers = ", ".join(values), ", ".join(["%s"] * len(values))
    # The table and column names are this module's own constants; every value is bound.
    statement = f"INSERT INTO {table} ({columns}) VALUES ({markers}) RETURNING id"  # noqa: S608
    return fetch(statement, list(values.values()))[0][0]


@contextmanager
def refused(constraint: str):
    """The statement inside is refused with SQLSTATE 23514 under exactly `constraint`."""
    with pytest.raises(IntegrityError) as caught, transaction.atomic():
        yield
    diag = caught.value.__cause__.diag  # type: ignore[union-attr]
    assert (diag.sqlstate, diag.constraint_name) == ("23514", constraint), (
        f"refused as {diag.sqlstate}/{diag.constraint_name}, not 23514/{constraint}"
    )


def allowed(statement: str, params: list[Any] | None = None) -> None:
    with transaction.atomic():
        fetch(statement, params)


def test_queue_apps_are_installed_under_the_persistence_settings():
    for label in QUEUE_APPS:
        assert apps.is_installed(f"apps.{label}"), f"apps.{label} is not installed"


@pytest.mark.django_db
def test_every_pinned_table_has_exactly_its_pinned_columns_and_types():
    for table, expected in COLUMNS.items():
        rows = fetch(
            "SELECT column_name, udt_name FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = %s",
            [table],
        )
        assert dict(rows) == expected, f"{table} columns differ from MODEL.md §8"


@pytest.mark.django_db
def test_every_pinned_constraint_trigger_and_index_exists_and_none_fires_on_truncate():
    for table, expected in CONSTRAINTS.items():
        rows = fetch(
            "SELECT conname, convalidated FROM pg_constraint WHERE conrelid = %s::regclass",
            [table],
        )
        missing = expected - {name for name, _ in rows}
        assert not missing, f"{table} lacks constraints {sorted(missing)}"
        assert all(valid for _, valid in rows), f"{table} has an unvalidated constraint"
    retention = fetch("SELECT to_regclass('public.orgs_privacyerasure') IS NOT NULL")[0][0]
    for table, expected in TRIGGERS.items():
        if retention:
            expected = expected | PRIVACY_CUTOFF_TRIGGERS.get(table, set())
        rows = fetch(
            "SELECT tgname, (tgtype & 32) <> 0 FROM pg_trigger "
            "WHERE tgrelid = %s::regclass AND NOT tgisinternal",
            [table],
        )
        assert {name for name, _ in rows} == expected, f"{table} triggers differ"
        assert not any(truncate for _, truncate in rows), f"{table} has a TRUNCATE trigger"
    names = {name for (name,) in fetch("SELECT indexname FROM pg_indexes")}
    assert not INDEXES - names, f"indexes absent: {sorted(INDEXES - names)}"


@pytest.mark.django_db
def test_every_guard_clause_carries_exactly_one_named_marker():
    sources = fetch(
        "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n "
        "ON n.oid = p.pronamespace WHERE n.nspname = current_schema() AND p.proname = ANY(%s)",
        [
            [
                "jobs_job_guard",
                "jobs_jobstep_guard",
                "jobs_joblockreservation_guard",
                "jobs_jobdispatch_guard",
                "jobs_jobreconciliationdecision_immutable",
                "jobs_job_reconciliation_exit",
                "jobs_jobreconciliationdecision_valid",
                "outbox_delivery_guard",
                "outbox_deliverydecision_valid",
                "outbox_deliverydecision_immutable",
                "audit_auditevent_guard",
            ]
        ],
    )
    assert len(sources) == 11, "a guard function is absent"
    found = [
        m for (source,) in sources for m in re.findall(r"/\*guard:([a-z0-9_]+)\*/ true", source)
    ]
    counts = {marker: found.count(marker) for marker in set(found)}
    # delivery_exit_any_transaction and delivery_exit_compares_xmin guard the two forms of one rule.
    doubled = {"delivery_exit_any_transaction", "delivery_exit_compares_xmin"}
    assert set(counts) == MARKERS, (
        f"markers differ: missing {sorted(MARKERS - set(counts))}, extra {sorted(set(counts) - MARKERS)}"
    )
    assert {m for m, n in counts.items() if n != 1} == doubled, (
        "a marker guards more than one clause"
    )


@pytest.mark.django_db
def test_database_clock_defaults_the_direct_writes_rely_on():
    rows = fetch(
        "SELECT table_name, column_name, column_default, is_nullable FROM information_schema.columns "
        "WHERE table_schema = current_schema() AND table_name = ANY(%s)",
        [list(COLUMNS)],
    )
    defaults = {(table, column): default for table, column, default, _ in rows}
    for key in (
        ("jobs_job", "not_before"),
        ("jobs_job", "created_at"),
        ("jobs_job", "updated_at"),
        ("jobs_joblockreservation", "reserved_at"),
        ("jobs_jobdispatch", "dispatched_at"),
        ("jobs_jobreconciliationdecision", "decided_at"),
        ("audit_auditevent", "occurred_at"),
    ):
        assert defaults[key] == "clock_timestamp()", f"{key} does not default to clock_timestamp()"
    required = {
        column
        for table, column, default, nullable in rows
        if table == "outbox_outboxdelivery" and nullable == "NO" and default is None
    }
    # Exactly the columns A3-13 inserts directly, and nothing else required without a default.
    assert required == {
        "id",
        "organisation_id",
        "category",
        "changes_realm",
        "status",
        "created_at",
        "updated_at",
    }, f"outbox_outboxdelivery requires {sorted(required)}"
    for table, column, default, nullable in rows:
        if default is not None and "now()" in default.lower():
            pytest.fail(f"{table}.{column} defaults to the transaction clock")
        assert "statement_timestamp" not in (default or ""), (
            f"{table}.{column} uses the statement clock"
        )
        assert nullable in ("YES", "NO")


def organisation(slug: str) -> Any:
    """An organisation in `prospect` with the held name its deferred guard requires."""
    org = apps.get_model("orgs", "Organisation").objects.create(
        slug=slug, realm=slug, issuer=f"https://id.queue.test/realms/{slug}", name="Queue"
    )
    apps.get_model("orgs", "SlugReservation").objects.create(
        namespace="organisation", slug=slug, organisation=org, state="provisional"
    )
    return org


@pytest.fixture(name="world")
def queue_world(db):
    """One organisation, one staff identity, and a job in each state the guards distinguish."""
    User = apps.get_model("identity", "User")
    Identity = apps.get_model("identity", "Identity")
    org = organisation("queue1")
    user = User.objects.create(email="operator@queue.test")
    identity = Identity.objects.create(
        user=user,
        organisation=org,
        issuer=org.issuer,
        realm=org.realm,
        subject="operator",
        email="operator@queue.test",
    )
    job = insert("jobs_job", job_values(org.id, HEX_A))
    step = insert(
        "jobs_jobstep",
        {
            "id": uuid.uuid4(),
            "job_id": job,
            "seq": 1,
            "name": "plan",
            "retry_class": "C",
            "conditional": False,
            "timeout_s": 60,
        },
    )
    return {"org": org.id, "identity": identity.id, "job": job, "step": step}


def job_values(org: Any, key: str, **overrides: Any) -> dict[str, Any]:
    values = {
        "id": uuid.uuid4(),
        "organisation_id": org,
        "tenant_id": uuid.uuid4(),
        "kind": "provision",
        "idempotency_key": key,
        "desired_spec_hash": HEX_B,
        "status": "queued",
        "max_attempts": 3,
        "actor_type": "staff",
        "lock_requested_at": None,
    }
    values.update(overrides)
    return values


def test_job_checks_refuse_each_invalid_row(world):
    org = world["org"]
    cases = [
        ("jobs_job_kind_valid", {"kind": "reboot"}),
        ("jobs_job_status_valid", {"status": "paused"}),
        ("jobs_job_hashes_valid", {"desired_spec_hash": "A" * 64}),
        ("jobs_job_actor_type_valid", {"actor_type": "robot"}),
        ("jobs_job_tenant_null_for_realm_kinds", {"kind": "realm_create"}),
        ("jobs_job_tenant_set_for_tenant_kinds", {"tenant_id": None}),
        ("jobs_job_lease_while_claimed", {"status": "leased", "runner_id": "r"}),
        ("jobs_job_no_lease_unless_claimed", {"lease_expires_at": "2030-01-01T00:00:00Z"}),
        (
            "jobs_job_unresolved_step_when_reconciling",
            {"status": "needs_reconciliation", "unresolved_operation_ref": "op"},
        ),
        (
            "jobs_job_unresolved_operation_when_reconciling",
            {"status": "needs_reconciliation", "unresolved_step_id": world["step"]},
        ),
        ("jobs_job_error_code_when_failed", {"status": "failed"}),
        ("jobs_job_no_error_code_unless_failed", {"error_code": "step_failed"}),
        ("jobs_job_error_code_valid", {"status": "failed", "error_code": "boom"}),
    ]
    for index, (constraint, overrides) in enumerate(cases):
        with refused(constraint):
            insert("jobs_job", job_values(org, f"{index:064x}", **overrides))
    with pytest.raises(IntegrityError), transaction.atomic():
        insert("jobs_job", job_values(org, HEX_A))


def test_job_specification_is_immutable_and_rows_are_retained(world):
    job = world["job"]
    other = organisation("queue2")
    changes = {
        "id": uuid.uuid4(),
        "organisation_id": other.id,
        "tenant_id": uuid.uuid4(),
        "kind": "upgrade",
        "idempotency_key": "c" * 64,
        "desired_spec_hash": "d" * 64,
        "max_attempts": 9,
        "actor_type": "system",
        "actor_id": uuid.uuid4(),
        "parent_job_id": job,
        "depends_on_job_id": job,
        "request_id": "other",
        "created_at": "2001-01-01T00:00:00Z",
    }
    assert set(changes) == set(JOB_SPECIFICATION)
    for column, value in changes.items():
        with refused("jobs_job_specification_immutable"):
            fetch(f"UPDATE jobs_job SET {column} = %s WHERE id = %s", [value, job])  # noqa: S608
    with refused("jobs_job_delete_refused"):
        fetch("DELETE FROM jobs_job WHERE id = %s", [job])


def test_job_place_is_never_cleared_or_moved_earlier(world):
    job = world["job"]
    allowed("UPDATE jobs_job SET lock_requested_at = clock_timestamp() WHERE id = %s", [job])
    with refused("jobs_job_place_kept"):
        fetch("UPDATE jobs_job SET lock_requested_at = NULL WHERE id = %s", [job])
    with refused("jobs_job_place_kept"):
        fetch(
            "UPDATE jobs_job SET lock_requested_at = lock_requested_at - interval '1 second' "
            "WHERE id = %s",
            [job],
        )
    allowed(
        "UPDATE jobs_job SET lock_requested_at = lock_requested_at + interval '1 second' "
        "WHERE id = %s",
        [job],
    )


def test_the_writes_section_3_2_promises_the_tests_are_not_refused(world):
    job = world["job"]
    for statement in (
        "UPDATE jobs_job SET not_before = not_before - interval '1 hour' WHERE id = %s",
        "UPDATE jobs_job SET not_before = not_before + interval '1 hour' WHERE id = %s",
        "UPDATE jobs_job SET status = 'leased', runner_id = 'r', "
        "lease_expires_at = clock_timestamp() + interval '2 minutes' WHERE id = %s",
        "UPDATE jobs_job SET lease_expires_at = clock_timestamp() - interval '1 minute' WHERE id = %s",
        "UPDATE jobs_job SET fence = fence + 1, attempt = attempt + 1 WHERE id = %s",
        "UPDATE jobs_job SET status = 'failed', error_code = 'step_failed', lease_expires_at = NULL "
        "WHERE id = %s",
    ):
        allowed(statement, [job])


def test_step_specification_is_immutable_and_rows_are_retained(world):
    step = world["step"]
    other = insert("jobs_job", job_values(world["org"], "e" * 64))
    changes = {
        "id": uuid.uuid4(),
        "job_id": other,
        "seq": 2,
        "name": "apply",
        "retry_class": "A",
        "conditional": True,
        "timeout_s": 5,
    }
    assert set(changes) == set(STEP_SPECIFICATION)
    for column, value in changes.items():
        with refused("jobs_jobstep_specification_immutable"):
            fetch(f"UPDATE jobs_jobstep SET {column} = %s WHERE id = %s", [value, step])  # noqa: S608
    allowed("UPDATE jobs_jobstep SET status = 'running' WHERE id = %s", [step])
    with refused("jobs_jobstep_delete_refused"):
        fetch("DELETE FROM jobs_jobstep WHERE id = %s", [step])


def test_a_reservation_ends_once(world):
    reservation = insert(
        "jobs_joblockreservation",
        {
            "id": uuid.uuid4(),
            "job_id": world["job"],
            "fence": 1,
            "lock_class": "tenant",
            "lock_key": uuid.uuid4(),
            "mode": "exclusive",
        },
    )
    allowed(
        "UPDATE jobs_joblockreservation SET ended_at = clock_timestamp() WHERE id = %s",
        [reservation],
    )
    with refused("jobs_joblockreservation_end_once"):
        fetch(
            "UPDATE jobs_joblockreservation SET ended_at = clock_timestamp() WHERE id = %s",
            [reservation],
        )


def test_a_dispatch_closes_once(world):
    dispatch = insert(
        "jobs_jobdispatch",
        {
            "id": uuid.uuid4(),
            "job_id": world["job"],
            "step_id": world["step"],
            "fence": 1,
            "operation_ref": "op-1",
        },
    )
    allowed("UPDATE jobs_jobdispatch SET operation_ref = 'op-2' WHERE id = %s", [dispatch])
    allowed(
        "UPDATE jobs_jobdispatch SET closed_at = clock_timestamp(), terminal_outcome = 'completed', "
        "terminal_evidence_ref = 'proof' WHERE id = %s",
        [dispatch],
    )
    for assignment in (
        "closed_at = clock_timestamp()",
        "terminal_outcome = 'failed'",
        "terminal_evidence_ref = 'other'",
    ):
        with refused("jobs_jobdispatch_close_once"):
            fetch(f"UPDATE jobs_jobdispatch SET {assignment} WHERE id = %s", [dispatch])  # noqa: S608


def decision_values(world: dict[str, Any], exit_: str, outcome: str) -> dict[str, Any]:
    return {
        "id": uuid.uuid4(),
        "job_id": world["job"],
        "exit": exit_,
        "operation_outcome": outcome,
        "compute_terminated_provider": "p",
        "compute_terminated_resource_id": "r",
        "compute_terminated_request_id": "q",
        "compute_terminated_observed_at": "2030-01-01T00:00:00Z",
        "target_read_provider": "p",
        "target_read_resource_id": "r",
        "target_read_request_id": "q",
        "target_read_observed_at": "2030-01-01T00:00:00Z",
        "unresolved_step_id": world["step"],
        "unresolved_operation_ref": "op-1",
        "decided_by_identity_id": world["identity"],
        "decided_by_role": "staff_operator",
    }


def test_a_job_decision_never_changes_and_partial_only_fails(world):
    with refused("jobs_jobreconciliationdecision_partial_only_fails"):
        insert("jobs_jobreconciliationdecision", decision_values(world, "resume", "partial"))
    with refused("jobs_jobreconciliationdecision_role_valid"):
        insert(
            "jobs_jobreconciliationdecision",
            {**decision_values(world, "fail", "partial"), "decided_by_role": "org_owner"},
        )
    decision = insert(
        "jobs_jobreconciliationdecision",
        {**decision_values(world, "fail", "partial"), "decided_txid": 1},
    )
    decided = fetch(
        "SELECT decided_at > now(), decided_txid = txid_current() "
        "FROM jobs_jobreconciliationdecision WHERE id = %s",
        [decision],
    )
    assert decided == [(True, True)], (
        "decided_at did not default to the evaluation instant, or decided_txid was taken from the "
        "insert"
    )
    with refused("jobs_jobreconciliationdecision_immutable"):
        fetch("UPDATE jobs_jobreconciliationdecision SET exit = 'fail' WHERE id = %s", [decision])
    with refused("jobs_jobreconciliationdecision_immutable"):
        fetch("DELETE FROM jobs_jobreconciliationdecision WHERE id = %s", [decision])


def delivery(world: dict[str, Any], status: str, started: str | None = "clock_timestamp()") -> Any:
    # The shape A3-13 inserts; `started` is an SQL expression of this module's own.
    return fetch(
        "INSERT INTO outbox_outboxdelivery (id, organisation_id, category, changes_realm, status, "  # noqa: S608
        f"started_at, created_at, updated_at) VALUES (gen_random_uuid(), %s, "
        f"'identity_user_operation', true, %s, {started or 'NULL'}, now(), now()) RETURNING id",
        [world["org"], status],
    )[0][0]


def delivery_decision(
    world: dict[str, Any], target: Any, exit_: str, outcome: str, **overrides: Any
) -> Any:
    values = {
        "id": uuid.uuid4(),
        "delivery_id": target,
        "exit": exit_,
        "operation_outcome": outcome,
        "compute_terminated_provider": "p",
        "compute_terminated_resource_id": "r",
        "compute_terminated_request_id": "q",
        "compute_terminated_observed_at": fetch("SELECT clock_timestamp()")[0][0],
        "target_read_provider": "p",
        "target_read_resource_id": "r",
        "target_read_request_id": "q",
        "target_read_observed_at": fetch("SELECT clock_timestamp()")[0][0],
        "decided_by_identity_id": world["identity"],
        "decided_by_role": "staff_operator",
    }
    values.update(overrides)
    return insert("outbox_deliverydecision", values)


def test_a_delivery_that_started_keeps_its_identity_and_is_retained(world):
    with refused("outbox_delivery_started_when_in_flight"):
        delivery(world, "in_flight", None)
    with refused("outbox_delivery_started_when_in_flight"):
        delivery(world, "needs_reconciliation", None)
    other = organisation("queue3").id
    for status in ("in_flight", "needs_reconciliation"):
        target = delivery(world, status)
        for assignment, params in (
            ("changes_realm = false", []),
            ("category = 'message'", []),
            ("organisation_id = %s", [other]),
            ("started_at = started_at - interval '1 minute'", []),
        ):
            with refused("outbox_delivery_frozen"):
                fetch(
                    f"UPDATE outbox_outboxdelivery SET {assignment} WHERE id = %s",  # noqa: S608
                    [*params, target],
                )
        with refused("outbox_delivery_delete_refused"):
            fetch("DELETE FROM outbox_outboxdelivery WHERE id = %s", [target])
    pending = delivery(world, "pending", None)
    allowed("UPDATE outbox_outboxdelivery SET category = 'message' WHERE id = %s", [pending])
    allowed("DELETE FROM outbox_outboxdelivery WHERE id = %s", [pending])


def test_a_delivery_leaves_reconciliation_only_on_its_own_fresh_decision(world):
    target = delivery(world, "needs_reconciliation", "clock_timestamp() - interval '1 minute'")
    with refused("outbox_delivery_reconciliation_exit"):
        fetch("UPDATE outbox_outboxdelivery SET status = 'pending' WHERE id = %s", [target])
    other = delivery(world, "needs_reconciliation", "clock_timestamp() - interval '1 minute'")
    foreign = delivery_decision(world, other, "resume", "completed")
    with refused("outbox_delivery_reconciliation_exit"):
        fetch(
            "UPDATE outbox_outboxdelivery SET status = 'succeeded', reconciliation_decision_ref = %s "
            "WHERE id = %s",
            [foreign, target],
        )
    decision = delivery_decision(world, target, "resume", "completed")
    with refused("outbox_delivery_reconciliation_exit"):
        fetch(
            "UPDATE outbox_outboxdelivery SET status = 'pending', reconciliation_decision_ref = %s "
            "WHERE id = %s",
            [decision, target],
        )
    allowed(
        "UPDATE outbox_outboxdelivery SET status = 'succeeded', reconciliation_decision_ref = %s "
        "WHERE id = %s",
        [decision, target],
    )


def test_a_delivery_decision_is_forced_checked_and_never_changes(world):
    settled = delivery(world, "in_flight")
    with refused("outbox_deliverydecision_valid"):
        delivery_decision(world, settled, "fail", "partial")
    target = delivery(world, "needs_reconciliation", "clock_timestamp() - interval '1 minute'")
    with refused("outbox_deliverydecision_valid"):
        delivery_decision(
            world,
            target,
            "fail",
            "partial",
            compute_terminated_observed_at="2001-01-01T00:00:00Z",
        )
    for column in [name for name, kind in EVIDENCE.items() if kind == "text"]:
        with refused("outbox_deliverydecision_evidence_present"):
            delivery_decision(world, target, "fail", "partial", **{column: ""})
    with refused("outbox_deliverydecision_partial_only_fails"):
        delivery_decision(world, target, "resume", "partial")
    decision = delivery_decision(
        world, target, "fail", "partial", decided_at="2001-01-01T00:00:00Z", decided_txid=1
    )
    forced = fetch(
        "SELECT decided_at > now(), decided_txid = txid_current() FROM outbox_deliverydecision "
        "WHERE id = %s",
        [decision],
    )
    assert forced == [(True, True)], "decided_at or decided_txid was taken from the insert"
    with refused("outbox_deliverydecision_immutable"):
        fetch("UPDATE outbox_deliverydecision SET exit = 'resume' WHERE id = %s", [decision])
    with refused("outbox_deliverydecision_immutable"):
        fetch("DELETE FROM outbox_deliverydecision WHERE id = %s", [decision])


CLOSED_SETS = ("DECISION_EXITS", "OPERATION_OUTCOMES", "DECIDING_ROLE")


def closed_set_differences(jobs: Any, outbox: Any) -> list[str]:
    """The closed sets of a reconciliation decision that `outbox` does not hold as `jobs` does. A
    name one side lacks is reported, and so is a name both lack: CLOSED_SETS is kept by hand, and
    a name renamed on both sides would otherwise compare nothing."""
    differences = []
    for name in CLOSED_SETS:
        missing = [
            side
            for side, module in (("a job", jobs), ("a delivery", outbox))
            if not hasattr(module, name)
        ]
        if missing:
            differences.append(f"{name} is missing for {' and for '.join(missing)}")
        elif getattr(outbox, name) != getattr(jobs, name):
            differences.append(
                f"{name} is {getattr(outbox, name)!r} for a delivery and "
                f"{getattr(jobs, name)!r} for a job"
            )
    return differences


def test_a_delivery_decision_and_a_job_decision_share_their_closed_sets():
    """apps.outbox keeps its own copy of the closed sets its table's CHECKs use, because a models
    module imports no other application; the two copies must not drift."""
    from apps.jobs import types
    from apps.outbox import models

    assert closed_set_differences(types, models) == [], (
        "a delivery decision and a job decision are checked against different closed sets"
    )


def test_the_closed_set_check_names_a_set_that_differs_and_one_that_is_missing():
    from types import SimpleNamespace

    jobs = SimpleNamespace(
        DECISION_EXITS=("resume", "fail"),
        OPERATION_OUTCOMES=("completed", "no_effect", "partial"),
        DECIDING_ROLE="staff_operator",
    )
    outbox = SimpleNamespace(
        DECISION_EXITS=("resume", "fail"), OPERATION_OUTCOMES=("completed", "no_effect")
    )
    assert closed_set_differences(jobs, outbox) == [
        "OPERATION_OUTCOMES is ('completed', 'no_effect') for a delivery and "
        "('completed', 'no_effect', 'partial') for a job",
        "DECIDING_ROLE is missing for a delivery",
    ], "the closed-set check passed a delivery set that differs or is missing"
    # A name missing on both sides compares nothing: it is reported, not passed as equal.
    assert closed_set_differences(SimpleNamespace(), SimpleNamespace())[:1] == [
        "DECISION_EXITS is missing for a job and for a delivery"
    ], "the closed-set check passed a name that neither side defines"


def test_an_audit_row_never_changes(world):
    event = insert(
        "audit_auditevent",
        {
            "id": uuid.uuid4(),
            "actor_type": "system",
            "actor_label": "queue",
            "action": "job.created",
            "target_urn": "urn:kodera:job:x",
            "retention_class": "standard",
            "job_id": world["job"],
        },
    )
    metadata = fetch("SELECT metadata = '{}'::jsonb FROM audit_auditevent WHERE id = %s", [event])
    assert metadata == [(True,)], "metadata does not default to an empty object"
    with refused("audit_auditevent_retention_class_valid"):
        insert(
            "audit_auditevent",
            {
                "id": uuid.uuid4(),
                "actor_type": "system",
                "actor_label": "q",
                "action": "a",
                "target_urn": "u",
                "retention_class": "forever",
            },
        )
    with refused("audit_auditevent_immutable"):
        fetch("UPDATE audit_auditevent SET action = 'job.failed' WHERE id = %s", [event])
    with refused("audit_auditevent_immutable"):
        fetch("DELETE FROM audit_auditevent WHERE id = %s", [event])


def test_queue_migrations_apply_reverse_and_reapply_on_an_empty_database(
    transactional_db, django_db_blocker
):
    tables = set(COLUMNS)
    observed_timeouts: list[tuple[str, str]] = []

    def checked_ddl(execute, statement, params, many, context):
        text = str(statement).lstrip().upper()
        if (
            text.startswith(
                (
                    "CREATE",
                    "ALTER TABLE",
                    "DROP TABLE",
                    "DROP FUNCTION",
                    "DROP TRIGGER",
                    "DROP INDEX",
                )
            )
            and "DJANGO_MIGRATIONS" not in text
        ):
            execute(
                "SELECT current_setting('lock_timeout'), current_setting('statement_timeout')",
                None,
                False,
                context,
            )
            values = context["cursor"].fetchone()
            assert all(value not in ("0", "0ms", "0s") for value in values), (
                f"migration DDL lacks finite timeouts: {text[:60]}"
            )
            observed_timeouts.append(values)
        return execute(statement, params, many, context)

    with django_db_blocker.unblock(), empty_database() as target:
        executor = MigrationExecutor(target)
        leaves = executor.loader.graph.leaf_nodes()
        anchors = [node for node in leaves if node[0] in ("identity", "orgs")]
        queue = [node for node in leaves if node[0] in QUEUE_APPS]
        assert {node[0] for node in queue} == set(QUEUE_APPS), "queue migrations absent"
        executor.migrate(anchors)
        baseline = schema_objects(target)
        with target.execute_wrapper(checked_ddl):
            MigrationExecutor(target).migrate(queue)
            first = schema_objects(target)
            assert tables <= first[0], "a queue table is absent after the forward migration"
            assert first[1] - baseline[1], "guard functions absent"
            assert first[2] - baseline[2], "guard triggers absent"
            with target.cursor() as cursor:
                cursor.execute(
                    "SELECT conname FROM pg_constraint WHERE conrelid = ANY(%s::regclass[]) "
                    "AND NOT convalidated",
                    [sorted(tables)],
                )
                assert cursor.fetchall() == [], "forward migration left unvalidated constraints"
            MigrationExecutor(target).migrate([(label, None) for label in QUEUE_APPS])
            reverted = schema_objects(target)
            assert not tables & reverted[0], "reverse left a queue table behind"
            assert reverted[1] == baseline[1], "reverse left a guard function behind"
            assert reverted[2] == baseline[2], "reverse left a guard trigger behind"
            MigrationExecutor(target).migrate(queue)
            assert schema_objects(target) == first, "reapply changed the queue schema objects"
    assert observed_timeouts, "no migration DDL timeout was observed"
