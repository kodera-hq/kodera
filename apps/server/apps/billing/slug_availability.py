"""checkSlugAvailability's reads, for apps/billing/api/slug_availability.py: the query's one
tenant slug and the answer. The caller's own organisation and the `403` of a known
caller with no current membership are apps/billing/access.py's, shared with getHelpContext."""

from typing import Any
from urllib.parse import parse_qsl

from apps.tenancy.selectors import slug_availability
from apps.tenancy.services import SLUG_PATTERN

from .pagination import InvalidListQueryError

MAX_QUERY = 128


def requested_slug(query_string: str) -> str:
    """The one `slug` the query carries, of the tenant slug pattern, or `400`."""
    if len(query_string) > MAX_QUERY:
        raise InvalidListQueryError()
    try:
        pairs = parse_qsl(query_string, keep_blank_values=True, strict_parsing=True)
    except ValueError:
        raise InvalidListQueryError() from None
    if len(pairs) != 1 or pairs[0][0] != "slug" or not SLUG_PATTERN.match(pairs[0][1]):
        raise InvalidListQueryError()
    slug: str = pairs[0][1]
    return slug


def availability(query_string: str) -> dict[str, Any]:
    return slug_availability(requested_slug(query_string))
