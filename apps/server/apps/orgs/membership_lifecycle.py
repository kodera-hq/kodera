"""getMembership, changeMembershipRole and removeMembership: docs/specs/MEMBERSHIP_LIFECYCLE.md.

The read runs in its own repeatable-read snapshot, and applies directory privacy (§2.1) before the
row leaves it: a caller who is neither the row's person nor an owner or admin receives a view
that carries no contact and no identity. Each write runs in one transaction: it resolves
the caller, touches the target row so that the membership triggers take the canonical locks (the
person, then their organisations in id order), resolves the caller again under those locks, and
only then checks the §2 rules in order, writes, audits and calls the engine hooks.
"""

import hashlib
import json
from dataclasses import dataclass, replace
from datetime import datetime
from uuid import UUID

from django.db import IntegrityError, connection, transaction
from django.db.models import F
from django.utils import timezone

from apps.audit.services import record_authz_denied, record_membership_event
from apps.identity.selectors import current_staff_identity, person_contacts, person_identities
from apps.outbox.realm_enqueue import ACCESS_OFF, ACCESS_ON, enqueue_realm_access
from services.identity.access_tokens import VerifiedAccessToken

from . import member_set_hooks
from .actor_selectors import (
    TenantCaller,
    TenantCallerNotFoundError,
    TenantCallerUnknownError,
    organisation_slug,
    organisation_state,
    read_tenant_caller,
)
from .membership_selectors import discloses_private_facts
from .models import Membership

OWNER = Membership.Role.OWNER
ACTIVE = Membership.State.ACTIVE
SUSPENDED = Membership.State.SUSPENDED
REMOVED = Membership.State.REMOVED
INVITED = Membership.State.INVITED
READING_ROLES = frozenset({"org_owner", "org_admin", "org_member"})
ADMINISTERING_ROLES = frozenset({"org_owner", "org_admin"})
# What an org_admin may touch and move to (ADR-0010); an owner touches every role.
ADMIN_REACH = frozenset({"org_admin", "org_member"})
PATCH_STATES = frozenset({ACTIVE, SUSPENDED})
READ_SCOPE = "membership:read"
UPDATE_SCOPE = "membership:update"
DELETE_SCOPE = "membership:delete"
DENIAL_REASON = "role_missing"
# Bounded like initialiseWorkspace's: an expired wait raises and the whole write rolls back.
LOCK_TIMEOUT = "SET LOCAL lock_timeout = '2s'"
OWNER_REQUIRED = "organisation_owner_required"
# Names the representation without the private member facts in its strong tag (`etag`).
WITHHELD_PROJECTION = "private-facts-withheld"


class MembershipCallerUnknownError(Exception):
    """No enabled identity for the token: `403 identity-unknown`."""


class MembershipNotFoundError(Exception):
    """Not the caller's organisation, no current membership for the caller, or no such target: `404`."""


class MembershipForbiddenError(Exception):
    """A §2 rule refuses the caller: `403`, recorded as `authz.denied` once the write rolled back."""

    def __init__(self, caller: TenantCaller | None) -> None:
        super().__init__("forbidden")
        self.caller = caller


class MembershipPatchInvalidError(Exception):
    """A body outside `MembershipPatchRequest`: `400`."""


class PreconditionRequiredError(Exception):
    """A `PATCH` without `If-Match`: `428`."""


class PreconditionFailedError(Exception):
    """`If-Match` is not the current `ETag`: `412`."""

    def __init__(self, current_etag: str) -> None:
        super().__init__("precondition failed")
        self.current_etag = current_etag


class LastOwnerError(Exception):
    """The change would leave no active owner: `409 last-owner-protected`."""

    def __init__(self, organisation_id: UUID) -> None:
        super().__init__("last owner")
        self.organisation_id = organisation_id


class MembershipStateError(Exception):
    """The target's state does not allow the change: `409 invalid-state-transition`."""

    allowed_states = (ACTIVE, SUSPENDED)


@dataclass(frozen=True, slots=True, repr=False)
class MembershipView:
    """`email` is None only on a view whose private member facts are withheld (§2.1), which then
    carries no `identity_id` either; `private_facts` says which of the two a None identity is."""

    id: UUID
    organisation_id: UUID
    user_id: UUID
    identity_id: UUID | None
    email: str | None
    display_name: str | None
    role: str
    state: str
    created_at: datetime
    updated_at: datetime
    # False once directory privacy has withheld the private member facts from the reader.
    private_facts: bool = True


@dataclass(frozen=True, slots=True, repr=False)
class MembershipDetailView:
    membership: MembershipView
    can_change_role: bool
    can_remove: bool
    blocked_reason: str | None


def etag(view: MembershipView) -> str:
    """A strong tag over the authoritative fields and `updated_at` (CONVENTIONS §10).

    It hashes no private member fact, so it is never an oracle for one: a caller who cannot read
    an address cannot confirm a guess against the tag. The representation directory privacy
    withholds facts from is a different representation, so it carries a different strong tag,
    derived from the same fields and a constant: the tag an administrator round-trips as
    `If-Match` is unchanged, and no validator names two different bodies."""
    fields = {
        "id": str(view.id),
        "organisation_id": str(view.organisation_id),
        "role": view.role,
        "state": view.state,
        "updated_at": view.updated_at.isoformat(),
    }
    if not view.private_facts:
        fields["projection"] = WITHHELD_PROJECTION
    canonical = json.dumps(fields, sort_keys=True, separators=(",", ":"))
    return '"' + hashlib.sha256(canonical.encode()).hexdigest() + '"'


def withheld(view: MembershipView) -> MembershipView:
    """The view as directory privacy shows it to a caller it withholds the private member facts
    from: no contact and no identity leave the snapshot."""
    return replace(view, email=None, identity_id=None, private_facts=False)


def parse_patch(body: bytes) -> dict[str, str]:
    """A `MembershipPatchRequest`: an object with only `role` and `state`, each valid."""
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise MembershipPatchInvalidError() from None
    if not isinstance(value, dict) or not set(value) <= {"role", "state"}:
        raise MembershipPatchInvalidError()
    if not all(isinstance(item, str) for item in value.values()):
        raise MembershipPatchInvalidError()
    if "role" in value and value["role"] not in Membership.Role.values:
        raise MembershipPatchInvalidError()
    if "state" in value and value["state"] not in PATCH_STATES:
        raise MembershipPatchInvalidError()
    return dict(value)


def read_membership(
    *, verified: VerifiedAccessToken, organisation_id: UUID, membership_id: UUID
) -> tuple[MembershipDetailView, str]:
    if connection.in_atomic_block:
        raise RuntimeError("the membership read requires its own transaction")
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        caller = _caller(verified, organisation_id)
        if caller.role not in READING_ROLES:
            raise MembershipForbiddenError(caller)
        view = _view(caller.organisation_id, membership_id)
        if view is None or view.state == REMOVED:
            raise MembershipNotFoundError()
        last = _is_last_owner(view)
        blocked = "last_owner" if last else "self" if view.id == caller.membership_id else None
        administers = (
            blocked is None
            and caller.role in ADMINISTERING_ROLES
            and caller.organisation_state == "active"
            and (caller.role == OWNER or view.role in ADMIN_REACH)
        )
        # Directory privacy (§2.1), after every decision that reads the stored row: the answer is
        # still 200, without the private member facts of a colleague.
        if not discloses_private_facts(
            caller_role=caller.role, own_row=view.id == caller.membership_id
        ):
            view = withheld(view)
        # The same rules the writes apply: a role changes on an accepted membership, while an
        # invitation can still be removed.
        return (
            MembershipDetailView(
                view, administers and view.state in PATCH_STATES, administers, blocked
            ),
            etag(view),
        )


def change_membership(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    membership_id: UUID,
    patch: dict[str, str],
    if_match: str | None,
    request_id: str,
) -> tuple[MembershipView, str]:
    if connection.in_atomic_block:
        raise RuntimeError("a membership change runs in its own transaction")
    try:
        with transaction.atomic():
            caller, view = _locked_target(verified, organisation_id, membership_id)
            if view.state == REMOVED:
                raise MembershipNotFoundError()
            if if_match is None:
                raise PreconditionRequiredError()
            current = etag(view)
            if if_match != current:
                raise PreconditionFailedError(current)
            role = patch.get("role", view.role)
            state = patch.get("state", view.state)
            _check_admin_reach(caller, view, role)
            if view.role == OWNER and (role != OWNER or state != ACTIVE) and _is_last_owner(view):
                raise LastOwnerError(view.organisation_id)
            _check_not_self(caller, view)
            if view.state == INVITED:
                raise MembershipStateError()
            if role == view.role and state == view.state:
                # Allowed, but nothing to change: undo the touch, so no revision advances.
                transaction.set_rollback(True)
                return view, current
            Membership.objects.filter(id=view.id).update(
                role=role, state=state, updated_at=timezone.now()
            )
            _audit(caller, view, request_id, role=role, state=state)
            if state != view.state:
                _enqueue_realm_access(view, ACCESS_OFF if state == SUSPENDED else ACCESS_ON)
                if state == SUSPENDED:
                    member_set_hooks.member_left(
                        Membership.objects.get(id=view.id),
                        reason=member_set_hooks.MEMBER_SUSPENDED,
                    )
                else:
                    member_set_hooks.member_set_changed(
                        organisation_id=view.organisation_id,
                        reason=member_set_hooks.MEMBER_REACTIVATED,
                    )
            elif role != view.role:
                # The channel set names owners and admins as exempt (ESPACE_STRUCTURE.md §13.1).
                member_set_hooks.channel_set_changed(
                    organisation_id=view.organisation_id, reason="membership.role_changed"
                )
            changed = _view(view.organisation_id, view.id)
            if changed is None:
                raise RuntimeError("the changed membership is no longer readable")
            return changed, etag(changed)
    except IntegrityError as error:
        if _owner_required(error):
            raise LastOwnerError(organisation_id) from error
        raise
    except Exception as error:
        member_set_hooks.after_rollback(error)
        raise


def remove_membership(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    membership_id: UUID,
    if_match: str | None,
    request_id: str,
) -> MembershipView:
    if connection.in_atomic_block:
        raise RuntimeError("a membership removal runs in its own transaction")
    try:
        with transaction.atomic():
            caller, view = _locked_target(verified, organisation_id, membership_id)
            _check_admin_reach(caller, view, view.role)
            if view.state == REMOVED:
                # A repeated removal, a retry whose answer was lost included: the same answer
                # whatever tag the first request carried, nothing written.
                transaction.set_rollback(True)
                return view
            if if_match is not None and if_match != etag(view):
                raise PreconditionFailedError(etag(view))
            if view.role == OWNER and view.state == ACTIVE and _is_last_owner(view):
                raise LastOwnerError(view.organisation_id)
            _check_not_self(caller, view)
            Membership.objects.filter(id=view.id).update(state=REMOVED, updated_at=timezone.now())
            _audit(caller, view, request_id, role=view.role, state=REMOVED)
            _enqueue_realm_access(view, ACCESS_OFF)
            if view.state == ACTIVE:
                # Only an active member is in the engines' member set; a suspended one already
                # left it, and an invitation never joined.
                member_set_hooks.member_left(
                    Membership.objects.get(id=view.id), reason=member_set_hooks.MEMBER_REMOVED
                )
            removed = _view(view.organisation_id, view.id)
            if removed is None:
                raise RuntimeError("the removed membership is no longer readable")
            return removed
    except IntegrityError as error:
        if _owner_required(error):
            raise LastOwnerError(organisation_id) from error
        raise
    except Exception as error:
        member_set_hooks.after_rollback(error)
        raise


def erase_member(*, organisation_id: UUID, membership_id: UUID) -> None:
    """Explicit GDPR erasure (ADR-0011, ADR-0018): removes the membership when not already
    removed, marks the person's recorded subjects erased via `member_set_hooks.member_erased`, and
    emits the member set (`erased_subjects`) and channel set in the same transaction. Nightly
    retention never calls this path."""
    if connection.in_atomic_block:
        raise RuntimeError("a member erasure runs in its own transaction")
    try:
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(LOCK_TIMEOUT)
            touched = Membership.objects.filter(
                id=membership_id,
                organisation_id=organisation_id,
                deleted_at__isnull=True,
            ).update(state=F("state"))
            if touched != 1:
                raise MembershipNotFoundError()
            membership = Membership.objects.get(id=membership_id, organisation_id=organisation_id)
            if (
                membership.role == OWNER
                and membership.state == ACTIVE
                and not Membership.objects.filter(
                    organisation_id=organisation_id,
                    role=OWNER,
                    state=ACTIVE,
                    accepted_at__isnull=False,
                    deleted_at__isnull=True,
                )
                .exclude(id=membership.id)
                .exists()
            ):
                raise LastOwnerError(organisation_id)
            if membership.state != REMOVED:
                Membership.objects.filter(id=membership.id).update(
                    state=REMOVED, updated_at=timezone.now()
                )
                membership.state = REMOVED
                enqueue_realm_access(
                    organisation_id=organisation_id,
                    membership_id=membership.id,
                    user_id=membership.user_id,
                    operation=ACCESS_OFF,
                )
            member_set_hooks.member_erased(membership)
    except IntegrityError as error:
        if _owner_required(error):
            raise LastOwnerError(organisation_id) from error
        raise
    except Exception as error:
        member_set_hooks.after_rollback(error)
        raise


def record_tenant_denial(*, refused: MembershipForbiddenError, scope: str, request_id: str) -> None:
    """`authz.denied` for a tenant caller, in a transaction of its own after the refused one."""
    caller = refused.caller
    if caller is None:
        raise ValueError("a tenant denial names its caller")
    _record_denial(
        actor_type="tenant",
        actor_id=caller.identity_id,
        organisation_id=caller.organisation_id,
        scope=scope,
        request_id=request_id,
    )


def record_staff_denial(
    *, verified: VerifiedAccessToken, organisation_id: UUID, scope: str, request_id: str
) -> None:
    """`authz.denied` for a staff token, which holds no write on a customer's memberships."""
    staff = current_staff_identity(issuer=verified.issuer, subject=verified.subject)
    _record_denial(
        actor_type="staff",
        actor_id=None if staff is None else staff.id,
        organisation_id=organisation_id,
        scope=scope,
        request_id=request_id,
    )


def _record_denial(
    *, actor_type: str, actor_id: UUID | None, organisation_id: UUID, scope: str, request_id: str
) -> None:
    if connection.in_atomic_block:
        raise RuntimeError("a denial is recorded in a transaction of its own")
    with transaction.atomic():
        slug = organisation_slug(organisation_id=organisation_id)
        record_authz_denied(
            actor_type=actor_type,
            actor_id=actor_id,
            organisation_id=None if slug is None else organisation_id,
            target_urn=f"urn:kodera:organisation:{slug or 'unknown'}",
            request_id=request_id,
            required_scope=scope,
            reason=DENIAL_REASON,
        )


def _caller(verified: VerifiedAccessToken, organisation_id: UUID) -> TenantCaller:
    try:
        return read_tenant_caller(verified=verified, organisation_id=organisation_id)
    except TenantCallerUnknownError:
        raise MembershipCallerUnknownError() from None
    except TenantCallerNotFoundError:
        raise MembershipNotFoundError() from None


def _locked_target(
    verified: VerifiedAccessToken, organisation_id: UUID, membership_id: UUID
) -> tuple[TenantCaller, MembershipView]:
    """Rules 1 and 2 under the canonical locks, and the target read after them."""
    with connection.cursor() as cursor:
        cursor.execute(LOCK_TIMEOUT)
    caller = _caller(verified, organisation_id)
    if caller.role not in ADMINISTERING_ROLES:
        raise MembershipForbiddenError(caller)
    touched = Membership.objects.filter(
        id=membership_id, organisation_id=caller.organisation_id, deleted_at__isnull=True
    ).update(state=F("state"))
    if touched != 1:
        raise MembershipNotFoundError()
    # The caller's own authority may have changed while this transaction waited for the locks.
    caller = _caller(verified, organisation_id)
    if caller.role not in ADMINISTERING_ROLES:
        raise MembershipForbiddenError(caller)
    if organisation_state(organisation_id=caller.organisation_id) != "active":
        raise MembershipForbiddenError(caller)
    view = _view(caller.organisation_id, membership_id)
    if view is None:
        raise MembershipNotFoundError()
    return caller, view


def _check_admin_reach(caller: TenantCaller, view: MembershipView, role: str) -> None:
    """Rule 5: an admin only reaches admins and members, and moves them only between those."""
    if caller.role != OWNER and (view.role not in ADMIN_REACH or role not in ADMIN_REACH):
        raise MembershipForbiddenError(caller)


def _check_not_self(caller: TenantCaller, view: MembershipView) -> None:
    """Rule 7: no one changes or removes their own membership."""
    if view.id == caller.membership_id:
        raise MembershipForbiddenError(caller)


def _is_last_owner(view: MembershipView) -> bool:
    """Whether `view` is an active, accepted owner and no other one exists."""
    if view.role != OWNER or view.state != ACTIVE:
        return False
    return (
        not Membership.objects.filter(
            organisation_id=view.organisation_id,
            role=OWNER,
            state=ACTIVE,
            accepted_at__isnull=False,
            deleted_at__isnull=True,
        )
        .exclude(id=view.id)
        .exists()
    )


def _view(organisation_id: UUID, membership_id: UUID) -> MembershipView | None:
    row = (
        Membership.objects.filter(
            id=membership_id, organisation_id=organisation_id, deleted_at__isnull=True
        )
        .values_list("id", "user_id", "role", "state", "created_at", "updated_at")
        .first()
    )
    if row is None:
        return None
    id_, user_id, role, state, created_at, updated_at = row
    contacts = person_contacts(user_ids=(user_id,))
    if not contacts:
        return None
    identity_id = next(
        (
            identity.id
            for identity in person_identities(user_id=user_id)
            if identity.organisation_id == organisation_id
        ),
        None,
    )
    return MembershipView(
        id=id_,
        organisation_id=organisation_id,
        user_id=user_id,
        identity_id=identity_id,
        email=contacts[0].email,
        display_name=contacts[0].display_name,
        role=role,
        state=state,
        created_at=created_at,
        updated_at=updated_at,
    )


def _audit(
    caller: TenantCaller, view: MembershipView, request_id: str, *, role: str, state: str
) -> None:
    events = []
    if role != view.role:
        events.append(("membership.role_changed", {"role": view.role}, {"role": role}))
    if state != view.state:
        action = {
            "suspended": "membership.suspended",
            "active": "membership.reactivated",
            "removed": "membership.removed",
        }[state]
        events.append((action, {"state": view.state}, {"state": state}))
    for action, before, after in events:
        record_membership_event(
            action=action,
            organisation_id=view.organisation_id,
            membership_id=view.id,
            actor_id=caller.identity_id,
            request_id=request_id,
            before=before,
            after=after,
        )


def _enqueue_realm_access(view: MembershipView, operation: str) -> None:
    """The realm access delivery of the change, in its transaction (§6.1.1)."""
    enqueue_realm_access(
        organisation_id=view.organisation_id,
        membership_id=view.id,
        user_id=view.user_id,
        operation=operation,
    )


def _owner_required(error: IntegrityError) -> bool:
    """Whether the deferred `organisation_owner_required` trigger refused the commit, the
    backstop of rule 5."""
    diagnostics = getattr(error.__cause__, "diag", None)
    return getattr(diagnostics, "constraint_name", None) == OWNER_REQUIRED
