"""Pure raw-input boundary for realm discovery; no quota, lookup or replay state.

The route refuses a wrong media type, a missing/invalid compatibility key and a disallowed
browser origin from headers alone, before any quota charge; it then charges global/IP quotas
before calling this parser, and charges the returned typed value before selection. Success here is not permission
or evidence of a ready realm. Never log the raw body or compatibility header.
"""

import json
import re
from typing import Literal

_SLUG = re.compile(r"[a-z0-9][a-z0-9-]{3,18}[a-z0-9]")
_LOCAL = re.compile(r"[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*")
_LABEL = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?")
_PROBLEM_PREFIX = "https://kodera.io/problems/"


class DiscoveryInputError(ValueError):
    """Safe refusal metadata; no payload, key or underlying JSON exception."""

    def __init__(self, status: int, problem: str, reason: str) -> None:
        super().__init__(reason)
        self.status = status
        self.problem_type = _PROBLEM_PREFIX + problem
        self.reason = reason


class _DuplicateJSONKeyError(ValueError):
    pass


def is_canonical_organisation_slug(value: object) -> bool:
    """One canonical predicate for discovery and future creation callers."""
    return isinstance(value, str) and _SLUG.fullmatch(value) is not None


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for name, value in pairs:
        if name in result:
            raise _DuplicateJSONKeyError
        result[name] = value
    return result


def _reject_constant(_value: str) -> None:
    raise ValueError


def _domain(value: str) -> str:
    if not value.isascii() or len(value) > 254 or value.count("@") != 1:
        raise DiscoveryInputError(422, "validation-error", "email-shape")
    local, domain = value.split("@")
    if not 1 <= len(local) <= 64 or _LOCAL.fullmatch(local) is None:
        raise DiscoveryInputError(422, "validation-error", "email-local-shape")
    labels = domain.split(".")
    if (
        len(domain) > 253
        or len(labels) < 2
        or any(_LABEL.fullmatch(label) is None for label in labels)
    ):
        raise DiscoveryInputError(422, "validation-error", "email-domain-shape")
    return domain.lower()


def check_discovery_headers(content_type: str | None, compatibility_key: str | None) -> None:
    """Refuse a wrong media type or a missing/invalid compatibility key from headers alone.

    The route calls this before any quota charge or body read: a cross-site form or `text/plain`
    beacon (a CORS "simple" request, sent without preflight) must not spend shared counters.
    """
    if (
        not isinstance(content_type, str)
        or content_type.split(";", 1)[0].strip().lower() != "application/json"
    ):
        raise DiscoveryInputError(415, "unsupported-media-type", "media-type")
    if compatibility_key is None:
        raise DiscoveryInputError(400, "idempotency-key-missing", "key-missing")
    if (
        not isinstance(compatibility_key, str)
        or not 16 <= len(compatibility_key) <= 255
        or compatibility_key != compatibility_key.strip()
        or any(not 32 <= ord(char) <= 126 for char in compatibility_key)
    ):
        raise DiscoveryInputError(400, "malformed-request", "key-shape")


_ORIGIN = re.compile(r"https://[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?")
# A Console served over plain http on the machine itself, as the local end-to-end stack serves it
# (dev/e2e/README.md). Admitted only when the caller passes `loopback_http`, which only the
# end-to-end API profile does (`KODERA_CONSOLE_LOOPBACK_ORIGINS`, config/settings/e2e.py).
_LOOPBACK_ORIGIN = re.compile(r"http://localhost:([0-9]{1,5})")


def _loopback_origin(origin: str) -> bool:
    found = _LOOPBACK_ORIGIN.fullmatch(origin)
    return found is not None and 1 <= int(found.group(1)) <= 65535


def allowed_origins(raw: object, *, loopback_http: bool = False) -> frozenset[str] | None:
    """The comma-separated browser origins allowed to call discovery (the Console's), or None
    when the value is malformed. Unset or empty allows no browser origin at all. Each origin is
    `https`; `http://localhost:<port>` is admitted too only with `loopback_http`."""
    if raw is None:
        return frozenset()
    if not isinstance(raw, str):
        return None
    origins = [part.strip() for part in raw.split(",") if part.strip()]
    if any(
        _ORIGIN.fullmatch(origin) is None and not (loopback_http and _loopback_origin(origin))
        for origin in origins
    ):
        return None
    return frozenset(origins)


def browser_refusal(
    origin: str | None, fetch_site: str | None, allowed: frozenset[str]
) -> str | None:
    """Why a browser request must be refused before any quota charge, or None to admit it.

    A native client sends neither `Origin` nor `Sec-Fetch-Site` and is admitted. A browser always
    sends `Origin` on a POST: it must be an exact allowed origin, and a `cross-site` fetch is
    refused whatever it names.
    """
    if fetch_site is not None and fetch_site.strip().lower() == "cross-site":
        return "cross-site"
    if origin is not None and origin not in allowed:
        return "origin"
    return None


def parse_discovery_input(
    raw_body: bytes,
    *,
    content_type: str | None,
    compatibility_key: str | None,
) -> tuple[Literal["slug", "domain"], str]:
    """Validate received bytes; return only a typed canonical lookup value.

    HTTP size enforcement must also bound body ingestion before these bytes are
    materialized. The header is validated but never returned, hashed or stored.
    Only the media type before the first semicolon is checked. All following
    parameters are ignored, even conflicting charset declarations or malformed
    parameter text. Bytes are always decoded as strict UTF-8; parameters never
    select another codec or imply support for its encoding.
    Parsing failures are raised outside their exception handler so a JSON error
    containing the source document cannot become this refusal's exception context.
    """
    if not isinstance(raw_body, bytes):
        raise DiscoveryInputError(400, "malformed-request", "body-type")
    if len(raw_body) > 4096:
        raise DiscoveryInputError(413, "payload-too-large", "body-size")
    check_discovery_headers(content_type, compatibility_key)

    failure = None
    value: object = None
    try:
        value = json.loads(
            raw_body.decode("utf-8"),
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
        )
    except _DuplicateJSONKeyError:
        failure = "duplicate-json-key"
    except (UnicodeError, ValueError, RecursionError):
        failure = "invalid-json"
    if failure is not None:
        raise DiscoveryInputError(400, "malformed-request", failure)
    if not isinstance(value, dict):
        raise DiscoveryInputError(422, "validation-error", "request-not-object")
    if set(value) not in ({"slug"}, {"email"}):
        raise DiscoveryInputError(422, "validation-error", "exactly-one-known-input")
    field = next(iter(value))
    lookup = value[field]
    if not isinstance(lookup, str):
        raise DiscoveryInputError(422, "validation-error", "input-not-string")
    if field == "slug":
        if not is_canonical_organisation_slug(lookup):
            raise DiscoveryInputError(422, "validation-error", "slug-shape")
        return "slug", lookup
    return "domain", _domain(lookup)
