"""The organisation lock a realm-changing outbox delivery takes: docs/domain/JOB_CATALOGUE.md §1,
"Outbox deliveries are not jobs".

A delivery that changes an organisation's realm is not started while a job holds or has reserved
that organisation's lock exclusively, nor while a `realm_create` or `realm_update` of that
organisation has requested its locks and waits to be claimed. It checks both, takes the lock shared
for the length of its execution, and checks them again; if the second check fails it releases the
lock and does not start. The lock is a session lock under the queue's own key (locks.py), so it
excludes a job's live lock, and it survives the delivery's several transactions.
"""

from __future__ import annotations

from uuid import UUID

from django.db import connection

from . import locks
from .kinds import REALM_KINDS, Lock

_EXCLUSIVE_RESERVATION = """
SELECT 1 FROM jobs_joblockreservation
WHERE ended_at IS NULL AND lock_class = 'organisation' AND lock_key = %s AND mode = 'exclusive'
LIMIT 1
"""

# A realm job that requested its locks and waits: claimable now, not yet claimed (JOB_QUEUE.md
# §5.3), the same population a claim's request order reads.
_WAITING_REALM_JOB = """
SELECT 1 FROM jobs_job
WHERE organisation_id = %s AND kind = ANY(%s) AND parent_job_id IS NULL
  AND status IN ('queued', 'orphaned') AND lock_requested_at IS NOT NULL
LIMIT 1
"""


def _organisation_lock(organisation_id: UUID) -> Lock:
    return Lock("organisation", organisation_id, "shared")


def _blocked(organisation_id: UUID) -> bool:
    with connection.cursor() as cursor:
        cursor.execute(_EXCLUSIVE_RESERVATION, [organisation_id])
        if cursor.fetchone() is not None:
            return True
        cursor.execute(_WAITING_REALM_JOB, [organisation_id, sorted(REALM_KINDS)])
        return cursor.fetchone() is not None


def try_realm_delivery_lock(*, organisation_id: UUID) -> bool:
    """Take the organisation lock shared for a realm-changing delivery, never waiting; False, with
    nothing held, when a job holds, reserves or waits for it in a way the delivery must yield to."""
    if _blocked(organisation_id):
        return False
    lock = _organisation_lock(organisation_id)
    if not locks.try_lock(lock):
        return False
    if _blocked(organisation_id):
        locks.unlock([lock])
        return False
    return True


def release_realm_delivery_lock(*, organisation_id: UUID) -> None:
    """Release the hold `try_realm_delivery_lock` took."""
    locks.unlock([_organisation_lock(organisation_id)])
