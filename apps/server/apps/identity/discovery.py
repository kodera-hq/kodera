"""Fresh charged discovery orchestration; no HTTP adapter or replay mechanism."""

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from django.conf import settings

from apps.orgs.discovery_selectors import select_realms
from services.identity.discovery_input import (
    DiscoveryInputError,
    allowed_origins,
    browser_refusal,
    check_discovery_headers,
    parse_discovery_input,
)
from services.identity.discovery_policy import DiscoveryUnavailableError, QuotaDecision

from .discovery_db import Deadline
from .discovery_quotas import admit_peer, admit_value

PROBLEMS = "https://kodera.io/problems/"


class DiscoveryRefusedError(Exception):
    """A refusal; `quota` is None when it happened before any quota was evaluated, and
    `cause_class` names an unexpected exception's class (never its text) for the 500 log."""

    def __init__(
        self,
        status: int,
        reason: str,
        quota: QuotaDecision | None,
        problem_type: str,
        *,
        cause_class: str | None = None,
    ) -> None:
        super().__init__("discovery request refused")
        self.status, self.reason, self.quota, self.problem_type = (
            status,
            reason,
            quota,
            problem_type,
        )
        self.cause_class = cause_class


@dataclass(frozen=True, slots=True)
class ResolvedDiscovery:
    selection: dict[str, Any]
    quota: QuotaDecision


def _exhausted(quota: QuotaDecision) -> None:
    if not quota.admitted:
        raise DiscoveryRefusedError(429, "rate-limited", quota, PROBLEMS + "rate-limited")


def _admit_headers(
    content_type: str | None,
    compatibility_key: str | None,
    origin: str | None,
    fetch_site: str | None,
) -> None:
    """Refuse from headers alone, before any quota charge or body read."""
    failure: tuple[int, str, str] | None = None
    try:
        check_discovery_headers(content_type, compatibility_key)
    except DiscoveryInputError as error:
        failure = (error.status, error.reason, error.problem_type)
    if failure is not None:
        raise DiscoveryRefusedError(failure[0], failure[1], None, failure[2])
    if origin is None and fetch_site is None:
        return
    allowed = allowed_origins(
        getattr(settings, "KODERA_CONSOLE_ORIGINS", None),
        # True only in the local end-to-end API profile, config.settings.e2e.
        loopback_http=getattr(settings, "KODERA_CONSOLE_LOOPBACK_ORIGINS", False) is True,
    )
    if allowed is None:
        raise DiscoveryUnavailableError("configuration")
    refused = browser_refusal(origin, fetch_site, allowed)
    if refused is not None:
        raise DiscoveryRefusedError(403, refused, None, PROBLEMS + "forbidden")


def discover(
    raw_body: bytes | Callable[[], bytes],
    *,
    peer: str,
    content_type: str | None,
    compatibility_key: str | None,
    origin: str | None = None,
    fetch_site: str | None = None,
) -> ResolvedDiscovery:
    _admit_headers(content_type, compatibility_key, origin, fetch_site)
    deadline = Deadline()
    first = admit_peer(peer, _deadline=deadline)
    _exhausted(first)
    # Keep only unspent DB time; bounded body ingestion has its own transport timeout.
    remaining = max(0.0, deadline.end - time.monotonic())
    failure: tuple[int, str, str, str | None] | None = None
    try:
        received = raw_body() if callable(raw_body) else raw_body
        kind, value = parse_discovery_input(
            received, content_type=content_type, compatibility_key=compatibility_key
        )
    except DiscoveryInputError as error:
        failure = (error.status, error.reason, error.problem_type, None)
    except OSError:
        failure = (400, "body-read", PROBLEMS + "malformed-request", None)
    except Exception as error:
        failure = (500, "internal-error", PROBLEMS + "internal-error", type(error).__name__)
    if failure is not None:
        raise DiscoveryRefusedError(
            failure[0], failure[1], first, failure[2], cause_class=failure[3]
        )
    deadline = Deadline(seconds=remaining)
    unexpected: str | None = None
    try:
        second = admit_value(kind, value, peer, _deadline=deadline)
    except DiscoveryUnavailableError as error:
        error.quota = first
        raise
    except Exception as error:
        unexpected = type(error).__name__
    if unexpected is not None:
        raise DiscoveryRefusedError(
            500, "internal-error", first, PROBLEMS + "internal-error", cause_class=unexpected
        )
    _exhausted(second)
    tightest = min((first, second), key=lambda q: (q.remaining, -q.reset_s, q.scope))
    try:
        selection = select_realms(kind, value)
    except DiscoveryUnavailableError as error:
        error.quota = tightest
        raise
    except Exception as error:
        unexpected = type(error).__name__
    if unexpected is not None:
        raise DiscoveryRefusedError(
            500, "internal-error", tightest, PROBLEMS + "internal-error", cause_class=unexpected
        )
    return ResolvedDiscovery(selection, tightest)
