"""An operator's decision on a realm access delivery whose outcome is unknown:
docs/specs/MEMBERSHIP_LIFECYCLE.md §6.1.4.

The sweep holds a delivery whose attempt was abandoned in `needs_reconciliation` (ADR-0004: an
ambiguous outcome is reconciled, never retried automatically). The operator supplies the evidence
that the runner which held the attempt has stopped; this function then reads the realm user's
current state with the realm's own worker credential, records the decision through the queue's
decision function with that read as its target evidence, and, in the same transaction, enqueues a
fresh delivery when the realm does not show what Core's membership asks now. It decides what was
observed, never what was hoped: an `access_on` that landed is `completed` even when the member was
suspended since, and the fresh `access_off` turns them off again.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from django.db import connection, transaction

from apps.identity.staff import StaffPrincipal
from apps.jobs.services import (
    DecisionRefused,
    Evidence,
    ReconciliationDecision,
    record_delivery_reconciliation_decision,
)
from apps.outbox import realm_access
from apps.outbox.realm.keycloak import RealmCallError, RealmTarget
from apps.outbox.realm_access import (
    AdminFactory,
    RealmState,
    desired_operation,
    enqueue_desired,
    observe,
    reached,
    unresolved,
)
from core.db.ids import new_uuid7

from .owner_claims import authorized_operator


class RealmDecisionRefusedError(Exception):
    """The decision was refused; nothing was written. The message is the reason."""


@dataclass(frozen=True)
class AttemptDecided:
    decision_id: UUID
    exit: str
    operation_outcome: str
    observed: RealmState
    enqueued: str | None


def _database_now() -> datetime:
    with connection.cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        now: datetime = cursor.fetchone()[0]
    return now


def decide_realm_access_attempt(
    *,
    principal: StaffPrincipal,
    delivery_id: UUID,
    compute_terminated: Evidence | None,
    admin_factory: AdminFactory,
    origins_issuer: str,
) -> AttemptDecided:
    if connection.in_atomic_block:
        raise RuntimeError("a realm access decision runs in its own transaction")
    try:
        held = unresolved(delivery_id, origins_issuer=origins_issuer)
    except Exception as error:
        raise RealmDecisionRefusedError(str(error)) from None
    if compute_terminated is None:
        # A runner that closed its attempt `ambiguous` itself left the record that its side ended:
        # that record is the evidence. An abandoned attempt has no such record; its runner may
        # still be alive, so the operator must supply evidence that it stopped.
        if held.last_attempt_outcome != "ambiguous" or held.last_attempt_at is None:
            raise RealmDecisionRefusedError("compute_terminated_required")
        compute_terminated = Evidence(
            provider="kodera-realm-worker",
            resource_id=f"outbox_deliveryattempt:{held.last_attempt_id}",
            request_id="closed-ambiguous",
            observed_at=held.last_attempt_at,
        )
    # Keycloak may still be executing the write whose outcome is unknown: nothing is read or
    # decided until the quiet period has passed since the attempt ended and since the runner was
    # seen stopped, whichever is later.
    quiet_since = max(
        instant
        for instant in (held.last_attempt_at, compute_terminated.observed_at)
        if instant is not None
    )
    waited = _database_now() - quiet_since
    if waited < realm_access.RECONCILE_QUIET_PERIOD:
        remaining = int((realm_access.RECONCILE_QUIET_PERIOD - waited).total_seconds()) + 1
        raise RealmDecisionRefusedError(f"quiet_period: decide again in {remaining}s")
    try:
        with admin_factory(RealmTarget(held.realm)) as admin:
            state = observe(admin, held.realm_user_id)
    except RealmCallError as error:
        raise RealmDecisionRefusedError(f"realm_unreadable:{error.kind}") from None
    target_read = Evidence(
        provider="keycloak",
        resource_id=f"{held.realm}/users/{held.realm_user_id}",
        request_id=f"realm-read:{new_uuid7()}",
        observed_at=_database_now(),
    )
    completed = reached(held.operation, state)
    decision = ReconciliationDecision(
        subject_id=delivery_id,
        exit="resume" if completed else "fail",
        operation_outcome="completed" if completed else "no_effect",
        compute_terminated=compute_terminated,
        target_read=target_read,
    )
    with authorized_operator(principal), transaction.atomic():
        result = record_delivery_reconciliation_decision(principal=principal, decision=decision)
        if isinstance(result, DecisionRefused):
            raise RealmDecisionRefusedError(result.reason)
        desired = desired_operation(held)
        enqueued = None
        if not reached(desired, state):
            enqueue_desired(held, desired)
            enqueued = desired
    return AttemptDecided(
        decision_id=result.decision_id,
        exit=decision.exit,
        operation_outcome=decision.operation_outcome,
        observed=state,
        enqueued=enqueued,
    )
