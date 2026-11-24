"""Outbox delivery writes: docs/specs/JOB_QUEUE.md §5.4, for a delivery's reconciliation decision.

The decision function is orchestrated by apps.jobs.services and writes through these. The insert
trigger forces the decision's decided_at and decided_txid; the delivery's exit trigger requires the
decision recorded in the same transaction, bound to the status it names.
"""

from datetime import datetime
from typing import Any
from uuid import UUID

from django.db import connection

from core.db.ids import new_uuid7

from .models import DECIDING_ROLE
from .sender import (
    DEFAULT_LIMIT,
    MessageRefusedError,
    RunReport,
    SenderUnavailableError,
    enqueue_message,
    run_deliveries,
)

# The mail sender's entry points (docs/specs/OUTBOX_MAIL_SENDER.md §3 and §7): a caller enqueues a
# message in its own transaction; the run_deliveries command sends it.
__all__ = [
    "DEFAULT_LIMIT",
    "MessageRefusedError",
    "RunReport",
    "SenderUnavailableError",
    "count_active_deliveries_for_organisation",
    "count_residual_personal_outbox_for_user",
    "count_sealed_messages_for_organisation",
    "default_account_outbox_erasure_adapter",
    "disarm_rehearsal_outbound",
    "drain_snapshot_in_flight_leases",
    "enqueue_message",
    "insert_decision",
    "leave_reconciliation",
    "lock_reconciling",
    "run_deliveries",
    "scrub_personal_outbox_for_user",
]

_LOCK_DELIVERY = """
SELECT started_at, organisation_id FROM outbox_outboxdelivery
WHERE id = %s {status}
{row_lock}
"""
_RECONCILING = "AND status = 'needs_reconciliation'"

_INSERT_DECISION = """
INSERT INTO outbox_deliverydecision (
  id, delivery_id, exit, operation_outcome,
  compute_terminated_provider, compute_terminated_resource_id, compute_terminated_request_id,
  compute_terminated_observed_at,
  target_read_provider, target_read_resource_id, target_read_request_id, target_read_observed_at,
  decided_by_identity_id, decided_by_role)
VALUES (
  %(id)s, %(delivery)s, %(exit)s, %(operation_outcome)s,
  %(c_provider)s, %(c_resource_id)s, %(c_request_id)s, %(c_observed_at)s,
  %(t_provider)s, %(t_resource_id)s, %(t_request_id)s, %(t_observed_at)s,
  %(identity)s, %(role)s)
"""

_EXIT = """
UPDATE outbox_outboxdelivery SET status = %s, reconciliation_decision_ref = %s WHERE id = %s
"""


def _one(statement: str, parameters: Any) -> tuple[Any, ...] | None:
    with connection.cursor() as cursor:
        cursor.execute(statement, parameters)
        row: tuple[Any, ...] | None = cursor.fetchone()
        return row


def lock_reconciling(
    delivery_id: UUID, *, any_status: bool, row_lock: str
) -> tuple[datetime | None, UUID] | None:
    """The delivery's started_at and organisation, its row locked with `row_lock` while it is in
    needs_reconciliation; None when it is not. `any_status` is the mutant that does not check the
    status; the caller picks `row_lock` through the lock mode's own flags."""
    statement = _LOCK_DELIVERY.format(status="" if any_status else _RECONCILING, row_lock=row_lock)
    found = _one(statement, [delivery_id])
    return None if found is None else (found[0], found[1])


def insert_decision(
    *,
    delivery_id: UUID,
    identity_id: UUID,
    exit_: str,
    operation_outcome: str,
    compute_provider: str,
    compute_resource_id: str,
    compute_request_id: str,
    compute_observed_at: datetime,
    target_provider: str,
    target_resource_id: str,
    target_request_id: str,
    target_observed_at: datetime,
) -> UUID:
    """Insert outbox-owned values supplied by the decision orchestrator."""
    decision_id = new_uuid7()
    with connection.cursor() as cursor:
        cursor.execute(
            _INSERT_DECISION,
            {
                "id": decision_id,
                "delivery": delivery_id,
                "exit": exit_,
                "operation_outcome": operation_outcome,
                "c_provider": compute_provider,
                "c_resource_id": compute_resource_id,
                "c_request_id": compute_request_id,
                "c_observed_at": compute_observed_at,
                "t_provider": target_provider,
                "t_resource_id": target_resource_id,
                "t_request_id": target_request_id,
                "t_observed_at": target_observed_at,
                "identity": identity_id,
                "role": DECIDING_ROLE,
            },
        )
    return decision_id


def leave_reconciliation(delivery_id: UUID, *, status: str, decision_id: UUID) -> None:
    with connection.cursor() as cursor:
        cursor.execute(_EXIT, [status, decision_id, delivery_id])


def disarm_rehearsal_outbound(
    *,
    now: datetime,
    excluded_organisation_ids: tuple[UUID, ...] = (),
) -> dict[str, int]:
    """Cancel pending/in-flight outbox deliveries and clear sealed mail payloads in rehearsal DB."""
    if not connection.in_atomic_block:
        raise RuntimeError("disarm_rehearsal_outbound requires an enclosing atomic transaction")

    excluded = [str(org_id) for org_id in excluded_organisation_ids]
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE outbox_deliveryattempt SET outcome = 'abandoned', finished_at = %s "
            "WHERE outcome IS NULL",
            [now],
        )
        attempts_abandoned = int(cursor.rowcount or 0)

        cursor.execute(
            "UPDATE outbox_message m SET sealed = NULL "
            "FROM outbox_outboxdelivery d "
            "WHERE m.delivery_id = d.id "
            "  AND m.sealed IS NOT NULL "
            "  AND NOT (d.organisation_id::text = ANY(%s)) "
            "  AND NOT EXISTS ("
            "    SELECT 1 FROM orgs_privacyerasure pe "
            "    WHERE pe.organisation_reference = d.organisation_id"
            "  )",
            [excluded],
        )
        messages_cleared = int(cursor.rowcount or 0)

        cursor.execute(
            "UPDATE outbox_outboxdelivery d "
            "SET status = 'failed', "
            "    finished_at = COALESCE(d.finished_at, %s), "
            "    updated_at = %s "
            "WHERE d.status IN ('pending', 'in_flight') "
            "  AND NOT (d.organisation_id::text = ANY(%s)) "
            "  AND NOT EXISTS ("
            "    SELECT 1 FROM orgs_privacyerasure pe "
            "    WHERE pe.organisation_reference = d.organisation_id"
            "  )",
            [now, now, excluded],
        )
        deliveries_cancelled = int(cursor.rowcount or 0)

    return {
        "outbox_deliveries_cancelled": deliveries_cancelled,
        "outbox_messages_cleared": messages_cleared,
        "outbox_attempts_abandoned": attempts_abandoned,
    }


def drain_snapshot_in_flight_leases(*, now: datetime) -> dict[str, int]:
    """Drain frozen `in_flight` outbox deliveries and open attempts from a point-in-time snapshot."""
    if not connection.in_atomic_block:
        raise RuntimeError(
            "drain_snapshot_in_flight_leases requires an enclosing atomic transaction"
        )
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE outbox_deliveryattempt SET outcome = 'abandoned', finished_at = %s "
            "WHERE outcome IS NULL",
            [now],
        )
        attempts_abandoned = int(cursor.rowcount or 0)

        cursor.execute(
            "SELECT DISTINCT d.organisation_id FROM outbox_outboxdelivery d "
            "JOIN orgs_privacyerasure pe ON pe.organisation_reference = d.organisation_id "
            "WHERE d.status = 'in_flight' "
            "ORDER BY d.organisation_id"
        )
        fenced_orgs = [row[0] for row in cursor.fetchall()]

        for org_id in fenced_orgs:
            cursor.execute(
                "INSERT INTO public.retention_worker_context "
                "VALUES (pg_backend_pid(), txid_current(), 'erase', 'orgs_organisation', %s, '{}')",
                [org_id],
            )
        try:
            # Preserve `started_at`, `category`, `changes_realm`, and `organisation_id` unchanged
            # so `outbox_delivery_guard` (`0002_guards`) permits `in_flight -> failed`.
            cursor.execute(
                "UPDATE outbox_outboxdelivery "
                "SET status = 'failed', "
                "    finished_at = COALESCE(finished_at, %s), "
                "    updated_at = %s "
                "WHERE status = 'in_flight'",
                [now, now],
            )
            deliveries_drained = int(cursor.rowcount or 0)
        finally:
            for org_id in fenced_orgs:
                cursor.execute(
                    "DELETE FROM public.retention_worker_context "
                    "WHERE backend = pg_backend_pid() AND transaction = txid_current() "
                    "  AND purpose = 'erase' AND source_table = 'orgs_organisation' AND source_id = %s",
                    [org_id],
                )
    return {
        "outbox_in_flight_drained": deliveries_drained,
        "outbox_attempts_abandoned": attempts_abandoned,
    }


def count_sealed_messages_for_organisation(*, organisation_id: UUID) -> int:
    """Count remaining un-cleared sealed outbox messages for an erased organisation."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT count(*) FROM outbox_message m "
            "JOIN outbox_outboxdelivery d ON d.id = m.delivery_id "
            "WHERE d.organisation_id = %s AND m.sealed IS NOT NULL",
            [organisation_id],
        )
        row = cursor.fetchone()
    return int(row[0]) if row is not None else 0


def count_active_deliveries_for_organisation(*, organisation_id: UUID) -> int:
    """Count remaining pending or in-flight outbox deliveries for an erased organisation."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT count(*) FROM outbox_outboxdelivery "
            "WHERE organisation_id = %s AND status IN ('pending', 'in_flight')",
            [organisation_id],
        )
        row = cursor.fetchone()
    return int(row[0]) if row is not None else 0


def _collect_person_bound_delivery_ids(
    cursor: Any,
    *,
    user_id: UUID,
    email_sha256s: tuple[str, ...] = (),
) -> list[str]:
    found: set[str] = set()
    cursor.execute(
        "SELECT delivery_id::text FROM identity_passportoutboxbinding WHERE user_id = %s",
        [user_id],
    )
    found.update(str(row[0]) for row in cursor.fetchall())

    cursor.execute("SELECT to_regclass('public.orgs_invitationoutboxbinding') IS NOT NULL")
    if cursor.fetchone()[0]:
        cursor.execute(
            "SELECT ib.delivery_id::text FROM orgs_invitationoutboxbinding ib "
            "LEFT JOIN orgs_invitation inv ON inv.id = ib.invitation_id "
            "LEFT JOIN orgs_membership m ON m.id = inv.membership_id "
            "WHERE m.user_id = %s OR ib.recipient_email_sha256 = ANY(%s)",
            [user_id, list(email_sha256s)],
        )
        found.update(str(row[0]) for row in cursor.fetchall())

    cursor.execute("SELECT to_regclass('public.support_supportticket') IS NOT NULL")
    if cursor.fetchone()[0]:
        cursor.execute(
            "SELECT t.mail_delivery_id::text FROM support_supportticket t "
            "JOIN identity_identity i ON i.id = t.created_by_id "
            "WHERE i.user_id = %s AND t.mail_delivery_id IS NOT NULL",
            [user_id],
        )
        found.update(str(row[0]) for row in cursor.fetchall())

    cursor.execute("SELECT to_regclass('public.extensions_digestjob') IS NOT NULL")
    if cursor.fetchone()[0]:
        cursor.execute(
            "SELECT j.delivery_id::text FROM extensions_digestjob j "
            "JOIN extensions_digestconsent c ON c.id = j.consent_id "
            "JOIN orgs_membership m ON m.id = c.membership_id "
            "WHERE m.user_id = %s AND j.delivery_id IS NOT NULL",
            [user_id],
        )
        found.update(str(row[0]) for row in cursor.fetchall())

    return sorted(found)


def scrub_personal_outbox_for_user(
    *,
    user_id: UUID,
    email_sha256s: tuple[str, ...] = (),
    now: datetime,
) -> int:
    """Clear sealed mail ciphertexts and cancel pending deliveries bound to `user_id`."""
    with connection.cursor() as cursor:
        delivery_ids = _collect_person_bound_delivery_ids(
            cursor,
            user_id=user_id,
            email_sha256s=email_sha256s,
        )
        if not delivery_ids:
            return 0
        cursor.execute(
            "UPDATE outbox_deliveryattempt SET outcome = 'abandoned', finished_at = %s "
            "WHERE delivery_id::text = ANY(%s) AND outcome IS NULL",
            [now, delivery_ids],
        )
        cursor.execute(
            "UPDATE outbox_message m SET sealed = NULL "
            "FROM outbox_outboxdelivery d "
            "WHERE m.delivery_id = d.id "
            "  AND d.id::text = ANY(%s) "
            "  AND m.sealed IS NOT NULL "
            "  AND (d.organisation_id IS NULL OR NOT EXISTS ("
            "    SELECT 1 FROM orgs_privacyerasure pe WHERE pe.organisation_reference = d.organisation_id"
            "  ))",
            [delivery_ids],
        )
        cleared = int(cursor.rowcount or 0)
        cursor.execute(
            "UPDATE outbox_outboxdelivery d "
            "SET status = 'failed', finished_at = COALESCE(d.finished_at, %s), updated_at = %s "
            "WHERE d.id::text = ANY(%s) "
            "  AND d.status IN ('pending', 'in_flight') "
            "  AND (d.organisation_id IS NULL OR NOT EXISTS ("
            "    SELECT 1 FROM orgs_privacyerasure pe WHERE pe.organisation_reference = d.organisation_id"
            "  ))",
            [now, now, delivery_ids],
        )
        return cleared + int(cursor.rowcount or 0)


def count_residual_personal_outbox_for_user(
    *,
    user_id: UUID,
    email_sha256s: tuple[str, ...] = (),
) -> int:
    """Count remaining sealed payloads or pending/in-flight personal outbox deliveries for `user_id`."""
    with connection.cursor() as cursor:
        delivery_ids = _collect_person_bound_delivery_ids(
            cursor,
            user_id=user_id,
            email_sha256s=email_sha256s,
        )
        if not delivery_ids:
            return 0
        cursor.execute(
            "SELECT count(*) FROM outbox_outboxdelivery d "
            "LEFT JOIN outbox_message m ON m.delivery_id = d.id "
            "WHERE d.id::text = ANY(%s) "
            "  AND (m.sealed IS NOT NULL OR ("
            "    d.status IN ('pending', 'in_flight') "
            "    AND (d.organisation_id IS NULL OR NOT EXISTS ("
            "      SELECT 1 FROM orgs_privacyerasure pe WHERE pe.organisation_reference = d.organisation_id"
            "    ))"
            "  ))",
            [delivery_ids],
        )
        row = cursor.fetchone()
    return int(row[0]) if row is not None else 0


def default_account_outbox_erasure_adapter() -> Any:
    """Return the authoritative `account_message_outbox` erasure adapter."""
    from .passport_erasure import PassportAccountOutboxErasureAdapter

    return PassportAccountOutboxErasureAdapter()
