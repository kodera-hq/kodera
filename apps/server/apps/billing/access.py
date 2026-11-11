"""Who may read an organisation's billing rows, and the other customer reads served the same way
(tenants, the status summary, the membership count, the help context): docs/api/AUTHZ.md §§5–6, 9.

The caller is resolved from the verified token against current state, never from a token claim,
in the same REPEATABLE READ READ ONLY snapshot as the rows it reads. A caller who is not a current
member of the organisation gets `404`, so an organisation cannot be probed. A member whose stored
role holds no cell of the row gets `403`, recorded as `authz.denied` in a transaction of its own.
Staff tokens are refused with `403` until the staff lane of these reads is built, as for
`getOrganisation`; the refusal is recorded too.
"""

from collections.abc import Callable
from uuid import UUID

from django.db import connection, transaction

from apps.audit.services import record_authz_denied
from apps.identity.selectors import current_identity, current_staff_identity, is_storable_subject
from apps.orgs.actor_selectors import TenantCaller
from apps.orgs.membership_selectors import DIRECTORY_ROLES
from services.identity.access_tokens import VerifiedAccessToken

from .callers import (
    BillingCallerUnknownError as BillingCallerUnknownError,
    BillingForbiddenError as BillingForbiddenError,
    BillingNotFoundError as BillingNotFoundError,
    require_role,
    tenant_caller,
)

# AUTHZ.md §5: the tenant roles holding `read` on each row (the contract's x-kodera-authz).
READERS = {
    "order:read": frozenset({"org_owner", "org_admin", "org_billing"}),
    "subscription:read": frozenset({"org_owner", "org_admin", "org_billing"}),
    "invoice:read": frozenset({"org_owner", "org_admin", "org_billing"}),
    "payment:read": frozenset({"org_owner", "org_billing"}),
    # The tenant reads and the shell's status summary: every tenant role (contracts
    # listTenants, getTenant, getTenantStatus, getOrganisationStatusSummary).
    "tenant:read": frozenset({"org_owner", "org_admin", "org_billing", "org_member"}),
    "organisation:read": frozenset({"org_owner", "org_admin", "org_billing", "org_member"}),
    # Not reads: who may place or cancel an order, authorised in the same way before the replay
    # store.
    "order:create": frozenset({"org_owner"}),
    "order:act": frozenset({"org_owner"}),
    # Who may have a payment link created for an invoice (createPaymentLink).
    "payment:create": frozenset({"org_owner", "org_billing"}),
    # countMemberships: the roles that read the People directory, listMemberships' own set.
    "membership:read": DIRECTORY_ROLES,
    # getHelpContext: every tenant role.
    "support_ticket:read": frozenset({"org_owner", "org_admin", "org_billing", "org_member"}),
}


def read_as_member[T](
    *,
    verified: VerifiedAccessToken,
    organisation: Callable[[], UUID | None],
    scope: str,
    read: Callable[[TenantCaller], T],
    roles: frozenset[str] | None = None,
    allow_community: bool = False,
) -> T:
    """`read(caller)` in one read-only snapshot, once the caller may read `scope` here.

    `organisation` names the organisation the request is about: the path's, or the row's for a
    read by id. It is looked up only once the token is known to name an enabled identity, so an
    unknown caller learns nothing about which identifiers exist. `roles`, when given, replaces
    the scope's readers: for an operation whose contract admits fewer roles than its scope's.
    """
    if roles is not None and not roles <= READERS[scope]:
        raise ValueError(f"roles wider than the readers of {scope}")
    if connection.in_atomic_block or not connection.get_autocommit():
        raise RuntimeError("a billing read requires its own transaction")
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        if allow_community:
            from apps.orgs.actor_selectors import (
                TenantCallerNotFoundError,
                TenantCallerUnknownError,
                read_tenant_caller,
            )
            from apps.orgs.community import is_community

            owner = organisation()
            if scope != "tenant:read" or owner is None or not is_community(owner):
                raise BillingNotFoundError()
            try:
                shared_caller = read_tenant_caller(
                    verified=verified, organisation_id=owner, allow_community=True
                )
            except (TenantCallerNotFoundError, TenantCallerUnknownError):
                raise BillingNotFoundError() from None
            require_role(shared_caller, roles=READERS[scope], scope=scope)
            return read(shared_caller)
        if not is_storable_subject(verified.subject) or (
            current_identity(issuer=verified.issuer, subject=verified.subject) is None
        ):
            raise BillingCallerUnknownError()
        organisation_id = organisation()
        if organisation_id is None:
            raise BillingNotFoundError()
        caller = tenant_caller(verified=verified, organisation_id=organisation_id)
        require_role(caller, roles=READERS[scope] if roles is None else roles, scope=scope)
        return read(caller)


def record_member_denial(
    *, refused: BillingForbiddenError, target_urn: str, request_id: str
) -> None:
    with transaction.atomic():
        record_authz_denied(
            actor_type="tenant",
            actor_id=refused.caller.identity_id,
            organisation_id=refused.caller.organisation_id,
            target_urn=target_urn,
            request_id=request_id,
            required_scope=refused.scope,
            reason="role_missing",
        )


def record_staff_denial(
    *, verified: VerifiedAccessToken, target_urn: str, request_id: str, scope: str
) -> None:
    with transaction.atomic():
        staff = current_staff_identity(issuer=verified.issuer, subject=verified.subject)
        record_authz_denied(
            actor_type="staff",
            actor_id=None if staff is None else staff.id,
            organisation_id=None,
            target_urn=target_urn,
            request_id=request_id,
            required_scope=scope,
            reason="role_missing",
        )


def own_organisation(verified: VerifiedAccessToken) -> UUID | None:
    """The organisation the caller's identity belongs to: the path names none."""
    resolved = current_identity(issuer=verified.issuer, subject=verified.subject)
    return None if resolved is None else resolved[1].organisation_id


def record_no_membership_denial(
    *, verified: VerifiedAccessToken, target_urn: str, request_id: str, scope: str
) -> None:
    """A known caller with no current membership in its own organisation: `403`, recorded with
    the identity it was refused to and that identity's organisation."""
    with transaction.atomic():
        resolved = current_identity(issuer=verified.issuer, subject=verified.subject)
        record_authz_denied(
            actor_type="tenant",
            actor_id=None if resolved is None else resolved[1].id,
            organisation_id=None if resolved is None else resolved[1].organisation_id,
            target_urn=target_urn,
            request_id=request_id,
            required_scope=scope,
            reason="role_missing",
        )


def is_shared_community(organisation_id: UUID) -> bool:
    """The sole cross-issuer billing read exception is the canonical tenant list."""
    from apps.orgs.community import is_community

    return is_community(organisation_id)
