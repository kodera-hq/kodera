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
    "enqueue_message",
    "insert_decision",
    "leave_reconciliation",
    "lock_reconciling",
    "run_deliveries",
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
