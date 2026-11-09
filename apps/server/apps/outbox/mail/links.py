"""The origins a message may link to: docs/specs/OUTBOX_MAIL_SENDER.md §3 and §6.

KODERA_MAIL_LINK_ORIGINS lists them, comma-separated: the console's origin in each environment.
A link to any other origin is refused at enqueue, so a caller cannot make Core mail a claim token to
a host it does not serve. Unset, no link is accepted.
"""

from __future__ import annotations

from collections.abc import Mapping
from urllib.parse import urlsplit

from django.core.exceptions import ImproperlyConfigured

# One rule for every link origin Core checks; re-exported, the mail's own names stay.
from core.links import (
    LOCAL_LINK_HOSTS as LOCAL_LINK_HOSTS,
    is_local_link_host as is_local_link_host,
    origin_of as origin_of,
)


class LinkOriginsError(ImproperlyConfigured):
    """KODERA_MAIL_LINK_ORIGINS is malformed: the process refuses to start."""


def origins_from_environment(environment: Mapping[str, str]) -> frozenset[str]:
    value = environment.get("KODERA_MAIL_LINK_ORIGINS", "")
    origins = set()
    for entry in filter(None, (part.strip() for part in value.split(","))):
        origin = origin_of(entry)
        parsed = urlsplit(entry)
        if origin is None or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise LinkOriginsError(
                "KODERA_MAIL_LINK_ORIGINS holds scheme://host[:port] origins, https or local http"
            )
        origins.add(origin)
    return frozenset(origins)


def setup_redirect_from_environment(
    environment: Mapping[str, str], origins: frozenset[str]
) -> str | None:
    """Where the realm's account set-up mail returns the person (KODERA_REALM_SETUP_REDIRECT),
    or None: unset, the mail sends no client and Keycloak ends on its own page. Exactly the root,
    `<origin>/`, of one of KODERA_MAIL_LINK_ORIGINS: the one redirect the realm template's
    `console` client lists, so any other path makes Keycloak refuse every set-up mail. Anything
    else, the process refuses to start."""
    value = environment.get("KODERA_REALM_SETUP_REDIRECT", "").strip()
    if value == "":
        return None
    origin = origin_of(value)
    if origin not in origins or value != f"{origin}/":
        raise LinkOriginsError(
            "KODERA_REALM_SETUP_REDIRECT is the root of a KODERA_MAIL_LINK_ORIGINS origin, "
            "<origin>/, and nothing else"
        )
    return value
