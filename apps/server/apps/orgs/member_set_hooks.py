"""Where a membership change tells the engines who is active: docs/specs/MEMBERSHIP_LIFECYCLE.md §6.

Each hook runs last in the transaction that changed the membership, and records the organisation's
next member set (ADR-0016), then its next channel set when it has a workspace (ADR-0018,
ESPACE_STRUCTURE.md §13.2). The workspace row is locked first, before the member set takes the
engines' heads, so that a structural change, which locks the workspace before the heads too, never
waits on a head this transaction holds. A role change records the channel set alone
(`channel_set_changed`). A channel set the emitter refuses never blocks the membership change: it
is logged critical and audited, and the change commits. A set that would have to drop someone from its deny lists fails
closed: the hook raises and the change rolls back. `after_rollback` then records that refusal in a
transaction of its own, so that an operator sees it. A leaver with no realm subject at all does
not block the change: there is nothing to deny.
"""

import logging
from uuid import UUID

from .models import Membership

log = logging.getLogger(__name__)

MEMBER_REMOVED = "member_removed"
MEMBER_SUSPENDED = "member_suspended"
MEMBER_REACTIVATED = "member_reactivated"
MEMBER_ERASED = "member_erased"


CHANNEL_SET_REASON = "membership.changed"


def member_left(membership: Membership, *, reason: str) -> None:
    # Imported here: apps.engine_intents.services reads this app's selectors.
    from apps.engine_intents.services import emit_member_left
    from apps.workspaces import channel_sets

    from .community import refresh_community_staff_grants

    # The workspace row and the channel set's input before the heads, which the member set takes
    # first (ESPACE_STRUCTURE.md §13.5); then the member set, then the channel set.
    refresh_community_staff_grants(membership.organisation_id)
    prepared = channel_sets.prepare(membership.organisation_id)
    emit_member_left(membership, reason=reason)
    channel_sets.emit_prepared(prepared, reason=CHANNEL_SET_REASON)


def member_erased(membership: Membership) -> None:
    """Record an explicit GDPR erasure (ADR-0011, ADR-0018): mark the person's recorded subjects
    erased, then emit the member set and channel set in lock order. Nightly retention never calls
    this hook."""
    from apps.engine_intents.services import emit_member_left, mark_erased
    from apps.workspaces import channel_sets

    prepared = channel_sets.prepare(membership.organisation_id)
    mark_erased(organisation_id=membership.organisation_id, user_id=membership.user_id)
    emit_member_left(membership, reason=MEMBER_ERASED)
    channel_sets.emit_prepared(prepared, reason=CHANNEL_SET_REASON)


def member_set_changed(*, organisation_id: UUID, reason: str) -> None:
    from apps.engine_intents.services import emit_member_set
    from apps.workspaces import channel_sets

    from .community import refresh_community_staff_grants

    refresh_community_staff_grants(organisation_id)
    prepared = channel_sets.prepare(organisation_id)
    emit_member_set(organisation_id=organisation_id, reason=reason)
    channel_sets.emit_prepared(prepared, reason=CHANNEL_SET_REASON)


def channel_set_changed(*, organisation_id: UUID, reason: str) -> None:
    """A change that leaves the member set alone but not the channel set, such as a role change:
    `exempt` names owners and admins. The workspace row first, then the channel set only."""
    from apps.workspaces import channel_sets

    from .community import refresh_community_staff_grants

    refresh_community_staff_grants(organisation_id)
    channel_sets.emit_prepared(channel_sets.prepare(organisation_id), reason=reason)


def after_rollback(error: BaseException) -> None:
    """Called with whatever ended a membership change's transaction: records a member set
    refusal, and does nothing for anything else. The caller re-raises the error."""
    from apps.engine_intents.services import MemberSetRefusedError, record_member_set_refusal

    if not isinstance(error, MemberSetRefusedError):
        return
    try:
        record_member_set_refusal(error)
    except Exception as failure:
        # The refusal stands (the change rolled back); only its record is lost, and logged.
        log.critical(
            "member set refusal of organisation %s not recorded: %s",
            error.organisation_id,
            type(failure).__name__,
        )
