"""The realm access delivery's enqueue: docs/specs/MEMBERSHIP_LIFECYCLE.md §6.1.1.

The one module of `apps.outbox` the API image carries. It runs inside the membership change's own
transaction and writes, for each realm identity of the person in that organisation, a pending
`identity_user_operation` delivery that changes the realm and its `outbox_realmaccess` payload. It
holds no credential and calls nothing outside the database: the run (apps/outbox/realm_access.py)
does that, in the worker, after the commit.

Raw SQL, and no import of this application's models: the API's profiles do not install
`apps.outbox` (docs/specs/JOB_QUEUE.md §3.1); the tables are the schema's, written by name.
"""

from __future__ import annotations

import logging
from uuid import UUID

from django.db import connection

from apps.identity.selectors import realm_identities
from core.db.ids import new_uuid7

logger = logging.getLogger("apps.outbox.realm_access")

ACCESS_OFF = "access_off"
ACCESS_ON = "access_on"
OPERATIONS = frozenset({ACCESS_OFF, ACCESS_ON})

_DELIVERY = (
    "INSERT INTO outbox_outboxdelivery (id, organisation_id, category, changes_realm, status, "
    "created_at, updated_at) VALUES (%s, %s, 'identity_user_operation', true, 'pending', "
    "clock_timestamp(), clock_timestamp())"
)
_PAYLOAD = (
    "INSERT INTO outbox_realmaccess (delivery_id, membership_id, identity_id, realm_user_id, "
    "operation) VALUES (%s, %s, %s, %s, %s)"
)


class RealmEnqueueError(RuntimeError):
    """The enqueue was called where it cannot be the change's own write."""


def require_caller_transaction() -> None:
    if not connection.in_atomic_block:
        raise RealmEnqueueError(
            "a realm access delivery is written inside the transaction of its membership change"
        )


def enqueue_realm_access(
    *, organisation_id: UUID, membership_id: UUID, user_id: UUID, operation: str
) -> tuple[UUID, ...]:
    """One pending realm access delivery per realm identity of the person in the organisation,
    in the caller's transaction; the deliveries' ids, none when the person has no realm user."""
    require_caller_transaction()
    if operation not in OPERATIONS:
        raise ValueError(f"{operation} is not a realm access operation")
    written = []
    # Turning access on concerns usable identities only: never a disabled or soft-deleted one.
    usable_only = operation == ACCESS_ON
    for identity in realm_identities(
        user_id=user_id, organisation_id=organisation_id, usable_only=usable_only
    ):
        written.append(
            insert_realm_access(
                organisation_id=organisation_id,
                membership_id=membership_id,
                identity_id=identity.id,
                realm_user_id=identity.subject,
                operation=operation,
            )
        )
    return tuple(written)


def insert_realm_access(
    *,
    organisation_id: UUID,
    membership_id: UUID,
    identity_id: UUID,
    realm_user_id: str,
    operation: str,
) -> UUID:
    """One delivery and its payload, in the caller's transaction; its id. The payload names
    Core's rows and the realm user id only: the run re-derives the realm from those rows and takes
    every Keycloak origin from its own settings, so nothing here chooses where a credential goes."""
    require_caller_transaction()
    if operation not in OPERATIONS:
        raise ValueError(f"{operation} is not a realm access operation")
    delivery_id = new_uuid7()
    with connection.cursor() as cursor:
        cursor.execute(_DELIVERY, [delivery_id, organisation_id])
        cursor.execute(
            _PAYLOAD,
            [delivery_id, membership_id, identity_id, realm_user_id, operation],
        )
    logger.info(
        "realm access enqueued: delivery %s operation %s membership %s",
        delivery_id,
        operation,
        membership_id,
    )
    return delivery_id


_ACCOUNT_PAYLOAD = "INSERT INTO outbox_realmaccount (delivery_id, invitation_id) VALUES (%s, %s)"


def enqueue_realm_account(*, organisation_id: UUID, invitation_id: UUID) -> UUID:
    """One pending realm account delivery for an invitation, in the caller's transaction
    (docs/specs/INVITATIONS.md §4); its id. The payload names the invitation only: the run reads
    the address and the realm from Core's rows and every Keycloak origin from its own settings."""
    require_caller_transaction()
    delivery_id = new_uuid7()
    with connection.cursor() as cursor:
        cursor.execute(_DELIVERY, [delivery_id, organisation_id])
        cursor.execute(_ACCOUNT_PAYLOAD, [delivery_id, invitation_id])
    logger.info("realm account enqueued: delivery %s invitation %s", delivery_id, invitation_id)
    return delivery_id


def account_realm_user_ids(*, invitation_id: UUID) -> frozenset[str]:
    """The realm users the run found or created for an invitation: the subjects that may accept it.
    The run records an account's id only when the delivery succeeds, so the payload alone answers,
    and the API reads nothing of the delivery itself."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT realm_user_id FROM outbox_realmaccount "
            "WHERE invitation_id = %s AND realm_user_id IS NOT NULL",
            [invitation_id],
        )
        return frozenset(row[0] for row in cursor.fetchall())
