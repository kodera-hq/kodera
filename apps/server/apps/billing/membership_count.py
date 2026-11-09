"""countMemberships' query and count, for apps/billing/api/membership_count.py.

The count is of exactly the population `listMemberships` pages through
(apps/orgs/membership_selectors.py), so `state=removed` counts 0. `role` and `state` take the
contract's values, once each. `account_kind` is refused with `400`, whatever its value: Core does
not store how an account signs in (`listMemberships` omits it too), and a count that ignored the
filter would be a wrong number on the federation screen.
"""

from typing import Any
from urllib.parse import parse_qsl
from uuid import UUID

from django.utils import timezone

from apps.orgs.membership_selectors import count_memberships

from .pagination import InvalidListQueryError
from .representations import instant

MAX_QUERY = 128
FILTERS = {
    "role": frozenset({"org_owner", "org_admin", "org_billing", "org_member"}),
    "state": frozenset({"invited", "active", "suspended", "removed"}),
}


def requested_filters(query_string: str) -> dict[str, str | None]:
    """The query's `role` and `state`, each at most once and of the contract's values, or `400`."""
    if len(query_string) > MAX_QUERY:
        raise InvalidListQueryError()
    try:
        pairs = parse_qsl(query_string, keep_blank_values=True, strict_parsing=bool(query_string))
    except ValueError:
        raise InvalidListQueryError() from None
    names = [name for name, _ in pairs]
    if len(set(names)) != len(names):
        raise InvalidListQueryError()
    found: dict[str, str | None] = {"role": None, "state": None}
    for name, value in pairs:
        if name not in FILTERS or value not in FILTERS[name]:
            raise InvalidListQueryError()
        found[name] = value
    return found


def counted(organisation_id: UUID, query_string: str) -> dict[str, Any]:
    filters = requested_filters(query_string)
    return {
        "count": count_memberships(organisation_id=organisation_id, **filters),
        "counted_at": instant(timezone.now()),
    }
