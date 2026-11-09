"""Database mutation recipes and guard restoration for the synthetic queue test database only."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any


@dataclass(frozen=True)
class Marker:
    """`/*guard:<flag>*/ true` becomes `false` in `function`, at exactly `count` places.

    `names`, when given, are the markers disarmed instead of the flag's own: a row whose function
    clause a database guard would otherwise refuse disarms that guard too (mutants.toml header)."""

    function: str
    count: int = 1
    names: tuple[str, ...] = ()


@dataclass(frozen=True)
class CheckRewrite:
    """The CHECK `constraint` of `table` redefined as `expression`: the guard with one clause fewer."""

    table: str
    constraint: str
    expression: str


@dataclass(frozen=True)
class DropConstraint:
    """The constraint `constraint` of `table` dropped."""

    table: str
    constraint: str


DatabaseMutant = Marker | CheckRewrite | DropConstraint

GUARD_FUNCTIONS = (
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
)

# Every constraint a database mutant touches, as pg_get_constraintdef prints it once migrated. The
# self-test compares these with the migrated database, so they cannot drift from the migrations.
PRISTINE_CONSTRAINTS: Mapping[tuple[str, str], str] = MappingProxyType(
    {
        ("jobs_job", "jobs_job_idempotency_key_unique"): "UNIQUE (idempotency_key)",
        ("jobs_job", "jobs_job_tenant_null_for_realm_kinds"): (
            "CHECK (((NOT (kind = ANY (ARRAY['realm_create'::text, 'realm_update'::text])))"
            " OR (tenant_id IS NULL)))"
        ),
        ("jobs_job", "jobs_job_tenant_set_for_tenant_kinds"): (
            "CHECK (((kind = ANY (ARRAY['realm_create'::text, 'realm_update'::text]))"
            " OR (tenant_id IS NOT NULL)))"
        ),
        ("jobs_job", "jobs_job_lease_while_claimed"): (
            "CHECK (((NOT (status = ANY (ARRAY['leased'::text, 'running'::text]))) OR (lease_expires_at IS NOT NULL)))"
        ),
        ("jobs_job", "jobs_job_no_lease_unless_claimed"): (
            "CHECK (((status = ANY (ARRAY['leased'::text, 'running'::text])) OR (lease_expires_at IS NULL)))"
        ),
        ("jobs_job", "jobs_job_unresolved_step_when_reconciling"): (
            "CHECK (((NOT (status = 'needs_reconciliation'::text))"
            " OR (unresolved_step_id IS NOT NULL)))"
        ),
        ("jobs_job", "jobs_job_unresolved_operation_when_reconciling"): (
            "CHECK (((NOT (status = 'needs_reconciliation'::text))"
            " OR (unresolved_operation_ref IS NOT NULL)))"
        ),
        ("jobs_job", "jobs_job_error_code_when_failed"): (
            "CHECK (((NOT (status = 'failed'::text)) OR (error_code IS NOT NULL)))"
        ),
        ("jobs_job", "jobs_job_no_error_code_unless_failed"): (
            "CHECK (((status = 'failed'::text) OR (error_code IS NULL)))"
        ),
        (
            "jobs_jobreconciliationdecision",
            "jobs_jobreconciliationdecision_partial_only_fails",
        ): "CHECK (((NOT (operation_outcome = 'partial'::text)) OR (exit = 'fail'::text)))",
        (
            "outbox_outboxdelivery",
            "outbox_delivery_started_when_in_flight",
        ): "CHECK (((status <> ALL (ARRAY['in_flight'::text, 'needs_reconciliation'::text]))"
        " OR (started_at IS NOT NULL)))",
        ("outbox_deliverydecision", "outbox_deliverydecision_evidence_present"): (
            "CHECK (((COALESCE(compute_terminated_provider, ''::text) <> ''::text)"
            " AND (COALESCE(compute_terminated_resource_id, ''::text) <> ''::text)"
            " AND (COALESCE(compute_terminated_request_id, ''::text) <> ''::text)"
            " AND (COALESCE(target_read_provider, ''::text) <> ''::text)"
            " AND (COALESCE(target_read_resource_id, ''::text) <> ''::text)"
            " AND (COALESCE(target_read_request_id, ''::text) <> ''::text)))"
        ),
        (
            "outbox_deliverydecision",
            "outbox_deliverydecision_partial_only_fails",
        ): "CHECK (((NOT (operation_outcome = 'partial'::text)) OR (exit = 'fail'::text)))",
    }
)

_MARKED = {
    "jobs_job_guard": (
        "job_delete_allowed",
        "place_may_be_cleared",
        "place_may_move_earlier",
        *(
            f"job_spec_mutable_{column}"
            for column in (
                "actor_id",
                "actor_type",
                "created_at",
                "depends_on_job_id",
                "desired_spec_hash",
                "id",
                "idempotency_key",
                "kind",
                "max_attempts",
                "organisation_id",
                "parent_job_id",
                "request_id",
                "tenant_id",
            )
        ),
    ),
    "jobs_jobstep_guard": (
        "step_delete_allowed",
        *(
            f"step_spec_mutable_{column}"
            for column in ("conditional", "id", "job_id", "name", "retry_class", "seq", "timeout_s")
        ),
    ),
    "audit_auditevent_guard": ("audit_delete_allowed", "audit_update_allowed"),
    "jobs_joblockreservation_guard": ("reservation_end_rewritable",),
    "jobs_jobdispatch_guard": (
        "dispatch_closed_at_rewritable",
        "dispatch_evidence_rewritable",
        "dispatch_outcome_rewritable",
    ),
    "jobs_jobreconciliationdecision_immutable": (
        "job_decision_update_allowed",
        "job_decision_delete_allowed",
    ),
    "jobs_job_reconciliation_exit": (
        "job_exit_unguarded",
        "job_exit_accepts_other_job",
        "job_exit_reuses_reference",
        "job_exit_any_transaction",
        "job_exit_resume_unbound",
        "job_exit_fail_unbound",
    ),
    "jobs_jobreconciliationdecision_valid": (
        "job_decided_txid_not_forced",
        "job_decided_at_future",
        "job_decided_at_before_dispatch",
    ),
    "outbox_delivery_guard": (
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
    ),
    "outbox_deliverydecision_valid": (
        "decided_at_not_forced",
        "decision_trigger_ignores_status",
        "decision_trigger_ignores_start_order",
        "decision_trigger_target_before_compute",
        "decision_trigger_future",
        "decided_txid_not_forced",
        "decision_trigger_no_start_tolerance",
        "decision_trigger_no_future_tolerance",
    ),
    "outbox_deliverydecision_immutable": (
        "delivery_decision_update_allowed",
        "delivery_decision_delete_allowed",
    ),
}
# The exit rule reads its transaction comparison at two places: one compares decided_txid, the other
# the row's xmin, and each flag flips both.
_MARKED_TWICE = frozenset({"delivery_exit_any_transaction", "delivery_exit_compares_xmin"})
_EVIDENCE = (
    "compute_terminated_provider",
    "compute_terminated_resource_id",
    "compute_terminated_request_id",
    "target_read_provider",
    "target_read_resource_id",
    "target_read_request_id",
)
_DELIVERY_STARTED = ("outbox_outboxdelivery", "outbox_delivery_started_when_in_flight")
_DELIVERY_EVIDENCE = ("outbox_deliverydecision", "outbox_deliverydecision_evidence_present")


# The job table's named CHECKs of §3.1 and §3.3, one clause each, so dropping one drops one clause.
_JOB_CHECKS = {
    "job_tenant_check_realm_missing": "jobs_job_tenant_null_for_realm_kinds",
    "job_tenant_check_tenant_missing": "jobs_job_tenant_set_for_tenant_kinds",
    "job_lease_check_claimed_missing": "jobs_job_lease_while_claimed",
    "job_lease_check_unclaimed_missing": "jobs_job_no_lease_unless_claimed",
    "job_unresolved_step_check_missing": "jobs_job_unresolved_step_when_reconciling",
    "job_unresolved_operation_check_missing": "jobs_job_unresolved_operation_when_reconciling",
    "job_error_code_check_failed_missing": "jobs_job_error_code_when_failed",
    "job_error_code_check_unfailed_missing": "jobs_job_no_error_code_unless_failed",
}


def _evidence_without(column: str) -> str:
    return " AND ".join(f"coalesce({name}, '') <> ''" for name in _EVIDENCE if name != column)


DATABASE_MUTANTS: Mapping[str, DatabaseMutant] = MappingProxyType(
    {
        **{
            flag: Marker(function, 2 if flag in _MARKED_TWICE else 1)
            for function, flags in _MARKED.items()
            for flag in flags
        },
        "start_check_skips_in_flight": CheckRewrite(
            *_DELIVERY_STARTED, "status <> 'needs_reconciliation' OR started_at IS NOT NULL"
        ),
        "start_check_skips_unresolved": CheckRewrite(
            *_DELIVERY_STARTED, "status <> 'in_flight' OR started_at IS NOT NULL"
        ),
        **{
            f"evidence_check_skips_{column}": CheckRewrite(
                *_DELIVERY_EVIDENCE, _evidence_without(column)
            )
            for column in _EVIDENCE
        },
        "job_partial_check_missing": DropConstraint(
            "jobs_jobreconciliationdecision", "jobs_jobreconciliationdecision_partial_only_fails"
        ),
        "delivery_partial_check_missing": DropConstraint(
            "outbox_deliverydecision", "outbox_deliverydecision_partial_only_fails"
        ),
        "no_dedupe": DropConstraint("jobs_job", "jobs_job_idempotency_key_unique"),
        **{
            flag: DropConstraint("jobs_job", constraint) for flag, constraint in _JOB_CHECKS.items()
        },
        "orphan_loses_place": Marker("jobs_job_guard", names=("place_may_be_cleared",)),
        "decision_rewrites_closed_dispatch": Marker(
            "jobs_jobdispatch_guard",
            names=(
                "dispatch_closed_at_rewritable",
                "dispatch_outcome_rewritable",
                "dispatch_evidence_rewritable",
            ),
        ),
    }
)

# Markers the migrations carry for guards whose mutants.toml rows are not written: none. The set stays,
# so the marker self-test keeps refusing a marker that is neither rowed nor listed here.
UNROWED_MARKERS: frozenset[str] = frozenset()

_DISARMED = re.compile(r"(/\*guard:[a-z0-9_]+\*/) false")


def _function_key(function: str) -> str:
    return f"function {function}"


def _constraint_key(table: str, constraint: str) -> str:
    return f"constraint {table}.{constraint}"


def snapshot_guards(cursor: Any) -> dict[str, str]:
    """The live text of every guard function of the three apps and of every constraint a database
    mutant touches; an absent one is the empty string."""
    cursor.execute(
        "SELECT proname, pg_get_functiondef(oid) FROM pg_proc"
        " WHERE pronamespace = current_schema()::regnamespace AND proname = ANY(%s)",
        [list(GUARD_FUNCTIONS)],
    )
    functions = dict(cursor.fetchall())
    cursor.execute(
        "SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid) FROM pg_constraint"
        " WHERE connamespace = current_schema()::regnamespace AND conname = ANY(%s)",
        [[constraint for _, constraint in PRISTINE_CONSTRAINTS]],
    )
    constraints = {(table, name): text for table, name, text in cursor.fetchall()}
    snapshot = {_function_key(name): functions.get(name, "") for name in GUARD_FUNCTIONS}
    for table, constraint in PRISTINE_CONSTRAINTS:
        snapshot[_constraint_key(table, constraint)] = constraints.get((table, constraint), "")
    return snapshot


def pristine_differences(snapshot: dict[str, str]) -> list[str]:
    """How `snapshot` differs from the migrated guards, or []."""
    differences = []
    for function in GUARD_FUNCTIONS:
        text = snapshot.get(_function_key(function), "")
        if not text:
            differences.append(f"{function} is missing")
        elif _DISARMED.search(text):
            differences.append(f"{function} has a disarmed guard marker")
    for (table, constraint), definition in PRISTINE_CONSTRAINTS.items():
        found = snapshot.get(_constraint_key(table, constraint), "")
        if found != definition:
            differences.append(
                f"{table}.{constraint} is {found or 'missing'!r}, not {definition!r}"
            )
    return differences


def _queue_tables() -> list[str]:
    from django.apps import apps

    return [
        model._meta.db_table
        for label in ("jobs", "outbox", "audit")
        for model in apps.get_app_config(label).get_models()
    ]


def restore_database(cursor: Any, snapshot: dict[str, str]) -> None:
    """Return every guard to its text in `snapshot`. Re-adding a constraint validates the rows a
    mutant let in, so when one must be re-added the queue's test rows are truncated first."""
    from apps.jobs.mutants import MutantsRefused, _require_permitted

    _require_permitted()
    current = snapshot_guards(cursor)
    if set(snapshot) != set(current):
        raise MutantsRefused("the snapshot does not name the job-queue guards")
    changed = [key for key in current if current[key] != snapshot[key]]
    if any(key.startswith("constraint ") for key in changed):
        cursor.execute(f"TRUNCATE {', '.join(_queue_tables())}")
    for key in changed:
        kind, name = key.split(" ", 1)
        if kind == "function":
            cursor.execute(snapshot[key])
            continue
        table, constraint = name.split(".", 1)
        if current[key]:
            cursor.execute(f"ALTER TABLE {table} DROP CONSTRAINT {constraint}")
        if snapshot[key]:
            cursor.execute(f"ALTER TABLE {table} ADD CONSTRAINT {constraint} {snapshot[key]}")


def _rearm(cursor: Any) -> None:
    """Restore the migrated guards, whatever mutant an earlier run left installed."""
    current = snapshot_guards(cursor)
    pristine = {
        key: _DISARMED.sub(r"\1 true", text) if key.startswith("function ") else text
        for key, text in current.items()
    }
    for (table, constraint), definition in PRISTINE_CONSTRAINTS.items():
        pristine[_constraint_key(table, constraint)] = definition
    restore_database(cursor, pristine)


def apply_marker(cursor: Any, marker: Marker, flag: str) -> None:
    """Disarm `flag`'s markers in their function, each refused unless it occurs exactly
    `marker.count` times: a migration that moved the clause fails here instead of leaving the guard
    intact."""
    from apps.jobs.mutants import MutantsRefused, _require_permitted

    _require_permitted()
    cursor.execute("SELECT pg_get_functiondef(%s::regproc)", [marker.function])
    definition = str(cursor.fetchone()[0])
    for name in marker.names or (flag,):
        armed = f"/*guard:{name}*/ true"
        count = definition.count(armed)
        if count != marker.count:
            raise MutantsRefused(
                f"{name} occurs {count} times in {marker.function}, not {marker.count}"
            )
        definition = definition.replace(armed, f"/*guard:{name}*/ false")
    cursor.execute(definition)


def install_database_mutant(cursor: Any, flag: str) -> None:
    """Restore the migrated guards, then install `flag`'s database mutant."""
    from apps.jobs.mutants import _require_permitted

    _require_permitted()
    mutant = DATABASE_MUTANTS.get(flag)
    if mutant is None:
        raise ValueError(f"{flag!r} is not a database mutant flag")
    _rearm(cursor)
    if isinstance(mutant, Marker):
        apply_marker(cursor, mutant, flag)
    elif isinstance(mutant, CheckRewrite):
        cursor.execute(f"ALTER TABLE {mutant.table} DROP CONSTRAINT {mutant.constraint}")
        cursor.execute(
            f"ALTER TABLE {mutant.table} ADD CONSTRAINT {mutant.constraint}"
            f" CHECK ({mutant.expression})"
        )
    else:
        cursor.execute(f"ALTER TABLE {mutant.table} DROP CONSTRAINT {mutant.constraint}")
