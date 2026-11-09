"""Issuance-only configuration; importing it requires no claim inputs."""

import re
from collections.abc import Mapping
from datetime import timedelta
from urllib.parse import urlsplit
from uuid import UUID


class ClaimConfigurationError(ValueError):
    """The operator's claim configuration is unavailable or invalid."""


def claim_lifetime(environment: Mapping[str, str]) -> timedelta:
    raw = environment.get("KODERA_OWNER_CLAIM_LIFETIME_SECONDS", "259200")
    if not isinstance(raw, str) or not re.fullmatch(r"[0-9]{1,6}", raw):
        raise ClaimConfigurationError("owner claim lifetime refused")
    seconds = int(raw)
    if not 1 <= seconds <= 604800:
        raise ClaimConfigurationError("owner claim lifetime refused")
    return timedelta(seconds=seconds)


def claim_link(environment: Mapping[str, str], origins: frozenset[str]) -> str:
    raw = environment.get("KODERA_OWNER_CLAIM_LINK", "")
    if not isinstance(raw, str) or not raw or len(raw) > 2048:
        raise ClaimConfigurationError("owner claim link refused")
    if any(character.isspace() or ord(character) < 32 for character in raw):
        raise ClaimConfigurationError("owner claim link refused")
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError:
        raise ClaimConfigurationError("owner claim link refused") from None
    if (
        parsed.scheme not in {"https", "http"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or parsed.query
        or port == 0
        or f"{parsed.scheme}://{parsed.netloc}" not in origins
    ):
        raise ClaimConfigurationError("owner claim link refused")
    return raw


def organisation_claim_link(
    environment: Mapping[str, str],
    origins: frozenset[str],
    *,
    organisation_id: UUID,
    slug: str,
) -> str:
    """Append the persisted organisation locator to a trusted non-secret base."""
    base = claim_link(environment, origins)
    if not isinstance(organisation_id, UUID):
        raise ClaimConfigurationError("owner claim link refused")
    if (
        not isinstance(slug, str)
        or re.fullmatch(r"[a-z0-9]([a-z0-9-]{3,18}[a-z0-9])", slug) is None
    ):
        raise ClaimConfigurationError("owner claim link refused")
    # Even an empty delimiter would move the appended locator out of the path.
    if "?" in base or "#" in base:
        raise ClaimConfigurationError("owner claim link refused")
    link = f"{base.removesuffix('/')}/{organisation_id}/{slug}"
    return claim_link({"KODERA_OWNER_CLAIM_LINK": link}, origins)
