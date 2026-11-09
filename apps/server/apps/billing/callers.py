"""The tenant caller of a billing operation, resolved from current state: docs/api/AUTHZ.md §§2, 6.

The organisation and the role come from the caller's stored, current membership, never from a
token claim or the request. Read in the caller's transaction, so the rows the operation then reads
or writes are those the caller was authorised against.
"""

from uuid import UUID

from apps.orgs.actor_selectors import (
    TenantCaller,
    TenantCallerNotFoundError,
    TenantCallerUnknownError,
    read_tenant_caller,
)
from services.identity.access_tokens import VerifiedAccessToken


class BillingCallerUnknownError(Exception):
    """The verified token names no enabled identity: `403 identity-unknown`."""


class BillingNotFoundError(Exception):
    """Not the caller's organisation, no current membership, or no such row in it: `404`."""


class BillingForbiddenError(Exception):
    """A member whose stored role does not hold the operation's scope: `403`."""

    def __init__(self, caller: TenantCaller, scope: str) -> None:
        super().__init__("forbidden")
        self.caller = caller
        self.scope = scope


def tenant_caller(*, verified: VerifiedAccessToken, organisation_id: UUID) -> TenantCaller:
    try:
        return read_tenant_caller(verified=verified, organisation_id=organisation_id)
    except TenantCallerUnknownError:
        raise BillingCallerUnknownError() from None
    except TenantCallerNotFoundError:
        raise BillingNotFoundError() from None


def require_role(caller: TenantCaller, *, roles: frozenset[str], scope: str) -> None:
    if caller.role not in roles:
        raise BillingForbiddenError(caller, scope)
