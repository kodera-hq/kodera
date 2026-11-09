"""Reads of outbox deliveries other apps rely on."""

from uuid import UUID

from django.db import connection

from apps.jobs import mutants

_REALM_CHANGE_OPEN = """
SELECT 1 FROM outbox_outboxdelivery
WHERE organisation_id = %s {changes_realm} AND status IN ({statuses})
LIMIT 1
"""


def realm_change_open(organisation_id: UUID) -> bool:
    """Whether a realm-changing delivery of the organisation is in flight or unresolved: what a
    realm job's claim refuses as `delivery_in_flight` (docs/specs/JOB_QUEUE.md §4.3, check 1)."""
    changes_realm = (
        "" if mutants.on("delivery_check_ignores_changes_realm") else "AND changes_realm"
    )
    statuses = "'in_flight'"
    if not mutants.on("delivery_in_flight_only"):
        statuses += ", 'needs_reconciliation'"
    with connection.cursor() as cursor:
        cursor.execute(
            _REALM_CHANGE_OPEN.format(changes_realm=changes_realm, statuses=statuses),
            [organisation_id],
        )
        return cursor.fetchone() is not None


def held_owner_claim_operation(delivery_id: UUID) -> str | None:
    """Lock one exact owner-claim message delivery; never expose its sealed payload."""
    if not connection.in_atomic_block:
        raise RuntimeError("owner claim delivery read requires held transaction")
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT d.operation_ref FROM outbox_outboxdelivery d JOIN outbox_message m ON m.delivery_id=d.id WHERE d.id=%s AND d.category='message' AND m.template_id='owner_claim' FOR UPDATE OF d",
            [delivery_id],
        )
        row = cursor.fetchone()
    return None if row is None else row[0]


def succeeded_deliveries(delivery_ids: list[UUID]) -> set[UUID]:
    """Which of these deliveries ended `succeeded`: the server accepted the message."""
    if not delivery_ids:
        return set()
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT id FROM outbox_outboxdelivery WHERE id = ANY(%s) AND status = 'succeeded'",
            [delivery_ids],
        )
        return {row[0] for row in cursor.fetchall()}


def ended_messages(delivery_ids: list[UUID]) -> dict[UUID, bool]:
    """Which of these message deliveries will never be built again: ended `succeeded` (True) or
    `failed`, or past their `expires_at` whatever their status (False)."""
    if not delivery_ids:
        return {}
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT d.id, d.status = 'succeeded' FROM outbox_outboxdelivery d"
            " JOIN outbox_message m ON m.delivery_id = d.id WHERE d.id = ANY(%s)"
            " AND (d.status IN ('succeeded', 'failed') OR m.expires_at <= clock_timestamp())",
            [delivery_ids],
        )
        return {row[0]: row[1] for row in cursor.fetchall()}


def failed_deliveries(delivery_ids: list[UUID]) -> set[UUID]:
    """Which of these deliveries ended `failed`: expired, rejected or out of attempts."""
    if not delivery_ids:
        return set()
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT id FROM outbox_outboxdelivery WHERE id = ANY(%s) AND status = 'failed'",
            [delivery_ids],
        )
        return {row[0] for row in cursor.fetchall()}
