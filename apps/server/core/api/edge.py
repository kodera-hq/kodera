"""What Core believes about a request that crossed the operator's edge, and what it answers there
(docs/specs/TRUSTED_EDGE.md, docs/specs/ABUSE_AND_ORIGIN_CONTROLS.md).

Four rules, each about something a caller can write or send at will:

- The client address is the direct peer, unless that peer is a configured trusted edge; then it is
  the rightmost `X-Forwarded-For` hop that is not itself a trusted edge. Nothing else reads
  `X-Forwarded-For`.
- A caller's `X-Request-Id` is kept, for its own correlation, under the `c-` namespace, so it can
  never pass for an id Core generated (a UUIDv7, which never starts with `c-`).
- A browser origin is named in an answer only when it is exactly one of the Console's own
  (`ConsoleCorsMiddleware`): never `*`, never a reflection of what was sent.
- One principal's writes are counted per rolling minute and refused `429` past the mutation
  bucket (`MutationRateLimitMiddleware`), keyed on the verified `(iss, sub)` and on nothing a
  caller can write: not the client address, not a header, not the path.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import math
import re
import threading
import time
from collections import OrderedDict, deque
from collections.abc import Callable, Mapping, Sequence
from typing import NamedTuple

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.utils.cache import patch_vary_headers

from core.api import lanes
from core.db.ids import new_uuid7
from services.identity.access_tokens import MAX_TOKEN, TokenVerificationError
from services.identity.discovery_input import allowed_origins
from services.identity.trusted_issuers import verify_configured_token

Network = ipaddress.IPv4Network | ipaddress.IPv6Network
Address = ipaddress.IPv4Address | ipaddress.IPv6Address

# The hops read from the right of `X-Forwarded-For`: a bound on the work, never on the answer for a
# real chain, which has one or two trusted hops. Past it, the peer's bucket is kept.
MAX_HOPS = 16
CALLER_PREFIX = "c-"
# docs/api/CONVENTIONS.md §9: a request id is 8 to 64 characters, so a caller's own has 62 at most.
CALLER_REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{8,62}\Z")


def _address(value: str) -> Address | None:
    try:
        address = ipaddress.ip_address(value.strip())
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


def _trusted(address: Address, trusted: Sequence[Network]) -> bool:
    return any(address in network for network in trusted)


def client_address(meta: Mapping[str, object], trusted: Sequence[Network]) -> str:
    """The client's address, as text, for per-client accounting.

    With no trusted edge configured, or a direct peer that is not one, this is `REMOTE_ADDR`
    unchanged: today's behaviour, and a forged header from anywhere else is never read. Behind a
    trusted edge, hops are read from the right; trusted hops are skipped and the first other one
    is the client. A malformed hop before that, an absent header, or a chain of trusted hops only
    keeps the peer: the request then shares the edge's bucket, which costs availability, never
    lets a caller choose an address."""
    peer = meta.get("REMOTE_ADDR", "")
    if not isinstance(peer, str):
        return ""
    peer_address = _address(peer)
    if peer_address is None or not _trusted(peer_address, trusted):
        return peer
    forwarded = meta.get("HTTP_X_FORWARDED_FOR", "")
    if not isinstance(forwarded, str) or not forwarded:
        return peer
    for hop in reversed(forwarded.split(",")[-MAX_HOPS:]):
        address = _address(hop)
        if address is None:
            return peer
        if not _trusted(address, trusted):
            return str(address)
    return peer


def caller_request_id(supplied: object) -> str | None:
    """The id Core answers with for a caller's `X-Request-Id`, or None (Core generates one)."""
    if isinstance(supplied, str) and CALLER_REQUEST_ID.fullmatch(supplied):
        return CALLER_PREFIX + supplied
    return None


class CallerRequestIdMiddleware:
    """Rewrites `X-Request-Id` before any view reads it: namespaced, or removed when unsafe.

    Every view keeps its own `[A-Za-z0-9_-]{8,64}` check and UUIDv7 fallback; this runs first so
    that the value they echo, log and record is never one a caller made look like Core's own."""

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        namespaced = caller_request_id(request.META.pop("HTTP_X_REQUEST_ID", None))
        request.META["HTTP_X_REQUEST_ID"] = namespaced or str(new_uuid7())
        # `request.headers` is cached from META on first read: drop a copy something ahead of
        # this may already have cached.
        request.__dict__.pop("headers", None)
        response = self.get_response(request)
        response["X-Request-Id"] = request.META["HTTP_X_REQUEST_ID"]
        return response


# ------------------------------------------------------------------- the Console's origins ----
#
# Which browser origins may read the customer API (ABUSE_AND_ORIGIN_CONTROLS.md §3). A browser
# lets a page read a cross-origin answer only when the answer names the page's origin; Core names
# an origin only when it is, exactly, one of the Console's own: the comma-separated
# KODERA_CONSOLE_ORIGINS that realm discovery already admits browsers with, read by the same
# parser (`services.identity.discovery_input.allowed_origins`).
#
# - Exact match, from the list. `Origin` is compared as a string with each listed origin: no
#   pattern, no suffix, no scheme or port folding, no `null`.
# - Never `*`, never a reflection. `Access-Control-Allow-Origin` is absent or a listed origin. An
#   unlisted origin gets no CORS header at all, and its preflight is refused. A malformed setting,
#   a `*` included, lists no origin: it fails closed.
# - Credentials only for a listed origin: `Access-Control-Allow-Credentials: true` is sent with,
#   and only with, a listed origin.
# - `Vary: Origin` on every answer of the customer API, with or without an `Origin` header, so no
#   cache serves one origin the answer made for another.
# - The preflight is answered here and never reaches a view; the methods and request headers it
#   allows are fixed lists, never the ones the browser asked for.
#
# It covers the customer API (`/api/`) only: the Agent API and the diagnostics are not called from
# a page, and are answered with no CORS header whatever the origin.

# The customer API. The Agent API (`/agent/`) is another principal with its own credential and its
# own limits (CONVENTIONS §11), and the diagnostics take no write and no page.
API_PREFIX = "/api/"
# What a page may send. Fixed: a preflight is never answered with what it asked for.
ALLOWED_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")
ALLOWED_HEADERS = (
    "Authorization",
    "Content-Type",
    "Idempotency-Key",
    "If-Match",
    "If-None-Match",
    "X-Request-Id",
)
# What a page may read besides the body: the headers the contract answers with.
EXPOSED_HEADERS = (
    "ETag",
    "Idempotency-Replayed",
    "Location",
    "RateLimit-Limit",
    "RateLimit-Remaining",
    "RateLimit-Reset",
    "Retry-After",
    "WWW-Authenticate",
    "X-Job-Id",
    "X-Request-Id",
)
PREFLIGHT_MAX_AGE_S = 600
FORBIDDEN_TYPE = "https://kodera.io/problems/forbidden"


def console_origins() -> frozenset[str]:
    """The exact origins the Console is served from; none when the setting is unset or malformed."""
    listed = allowed_origins(
        getattr(settings, "KODERA_CONSOLE_ORIGINS", None),
        # True only in the local end-to-end API profile, config.settings.e2e.
        loopback_http=getattr(settings, "KODERA_CONSOLE_LOOPBACK_ORIGINS", False) is True,
    )
    return frozenset() if listed is None else listed


def listed_origin(request: HttpRequest) -> str | None:
    """The request's `Origin` when it is exactly a listed one, else None."""
    origin = request.META.get("HTTP_ORIGIN")
    if isinstance(origin, str) and origin in console_origins():
        return origin
    return None


def _grant(response: HttpResponse, origin: str) -> None:
    response["Access-Control-Allow-Origin"] = origin
    response["Access-Control-Allow-Credentials"] = "true"


def _refused_preflight(request: HttpRequest) -> HttpResponse:
    request_id = request.META.get("HTTP_X_REQUEST_ID") or str(new_uuid7())
    response = HttpResponse(
        json.dumps(
            {
                "type": FORBIDDEN_TYPE,
                "title": "Access refused",
                "status": 403,
                "request_id": request_id,
            }
        ),
        status=403,
        content_type="application/problem+json",
    )
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response


class ConsoleCorsMiddleware:
    """Answers preflights and names a listed origin on the customer API's answers.

    Installed right after `CallerRequestIdMiddleware` and outside every other middleware, so that
    an answer made before any view, a `429` included, is one the Console can read."""

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        if not request.path.startswith(API_PREFIX):
            return self.get_response(request)
        origin = listed_origin(request)
        preflight = (
            request.method == "OPTIONS"
            and "HTTP_ORIGIN" in request.META
            and "HTTP_ACCESS_CONTROL_REQUEST_METHOD" in request.META
        )
        if preflight:
            response = self._preflight(request, origin)
            patch_vary_headers(
                response,
                ("Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"),
            )
            return response
        response = self.get_response(request)
        patch_vary_headers(response, ("Origin",))
        if origin is not None:
            _grant(response, origin)
            response["Access-Control-Expose-Headers"] = ", ".join(EXPOSED_HEADERS)
        return response

    @staticmethod
    def _preflight(request: HttpRequest, origin: str | None) -> HttpResponse:
        method = request.META.get("HTTP_ACCESS_CONTROL_REQUEST_METHOD", "")
        if origin is None or method not in ALLOWED_METHODS:
            return _refused_preflight(request)
        response = HttpResponse(status=204)
        _grant(response, origin)
        response["Access-Control-Allow-Methods"] = ", ".join(ALLOWED_METHODS)
        response["Access-Control-Allow-Headers"] = ", ".join(ALLOWED_HEADERS)
        response["Access-Control-Max-Age"] = str(PREFLIGHT_MAX_AGE_S)
        return response


# --------------------------------------------------------------------- the mutation bucket ----
#
# How many writes one principal may send (ABUSE_AND_ORIGIN_CONTROLS.md §2). CONVENTIONS §11 gives
# every authenticated principal a mutation bucket: `POST`, `PUT`, `PATCH` and `DELETE` on the
# customer API, per rolling minute. The middleware enforces it before any view runs, so a refused
# request reaches no handler, writes nothing and stores nothing against an `Idempotency-Key`.
#
# - The key is the verified principal, and nothing a caller can write. The middleware verifies the
#   bearer token exactly as the views do and keys the bucket on its `(iss, sub)`. It never reads
#   the client address, `X-Forwarded-For`, a header, the path or the body, so a caller cannot
#   choose a bucket, and a fresh token of the same principal lands in the same one.
# - A request without a verified principal is not charged and not refused here. Its view answers
#   it `401`, which a client needs in order to sign in again; answering `429` instead would let
#   anyone turn other people's expired tokens into a lockout.
# - The window is rolling. A principal's last admitted writes are kept as instants; a write is
#   admitted while fewer than the limit fall inside the last 60 seconds. A refused write is not
#   recorded, so hammering a full bucket does not extend the wait.
# - The count is per API process. It lives in the serving process, with no shared store: a
#   deployment of N API processes admits at most N times the limit per principal per minute, and a
#   restart forgets the window. The bound is finite and stated; it is not the exact shared bucket
#   of CONVENTIONS §11, which needs a store the API role is granted.
# - Memory is bounded. At most `MAX_PRINCIPALS` buckets are kept; past it the idle ones go first,
#   then the least recently used.

MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
WINDOW_S = 60.0
# CONVENTIONS §11: 60 writes per principal per rolling minute, unless the operator sets another.
DEFAULT_LIMIT = 60
MAX_LIMIT = 6000
MAX_PRINCIPALS = 50_000
SCOPE = "mutation"
RATE_LIMITED_TYPE = "https://kodera.io/problems/rate-limited"
RATE_LIMITED_TITLE = "Too many requests"
_DOMAIN = b"kodera-mutation-bucket-v1\x00"


class Decision(NamedTuple):
    admitted: bool
    limit: int
    remaining: int
    # Seconds until the bucket has room again: the wait of a refusal, the reset of an admission.
    reset_s: int


class SlidingWindow:
    """A rolling window of admitted instants per key, in this process only."""

    def __init__(
        self,
        *,
        window_s: float = WINDOW_S,
        max_keys: int = MAX_PRINCIPALS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._window_s = window_s
        self._max_keys = max_keys
        self._clock = clock
        self._lock = threading.Lock()
        self._buckets: OrderedDict[str, deque[float]] = OrderedDict()

    def charge(self, key: str, *, limit: int) -> Decision:
        """Admit and record one write for `key`, or refuse it; a refusal records nothing."""
        with self._lock:
            now = self._clock()
            horizon = now - self._window_s
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = self._buckets[key] = deque()
                self._bound(horizon)
            else:
                self._buckets.move_to_end(key)
            while bucket and bucket[0] <= horizon:
                bucket.popleft()
            if len(bucket) >= limit:
                # Room returns when the oldest write that still counts leaves the window.
                oldest = bucket[len(bucket) - limit]
                return Decision(False, limit, 0, self._seconds(oldest + self._window_s - now))
            bucket.append(now)
            return Decision(
                True,
                limit,
                limit - len(bucket),
                self._seconds(bucket[0] + self._window_s - now),
            )

    @staticmethod
    def _seconds(wait: float) -> int:
        return max(1, math.ceil(wait))

    def _bound(self, horizon: float) -> None:
        """Keep at most `max_keys` buckets: drop the idle ones, then the least recently used."""
        if len(self._buckets) <= self._max_keys:
            return
        for idle in [key for key, kept in self._buckets.items() if not kept or kept[-1] <= horizon]:
            del self._buckets[idle]
        while len(self._buckets) > self._max_keys:
            self._buckets.popitem(last=False)

    def __len__(self) -> int:
        return len(self._buckets)


def configured_limit() -> int:
    """The bucket's size, `KODERA_MUTATION_RATE_PER_MINUTE`. There is no value that turns the
    bucket off: anything that is not an integer within the bounds a profile admits
    (config.environment.mutation_rate_per_minute) is read as the default."""
    limit = getattr(settings, "KODERA_MUTATION_RATE_PER_MINUTE", DEFAULT_LIMIT)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_LIMIT:
        return DEFAULT_LIMIT
    return limit


def principal_key(issuer: str, subject: str) -> str:
    """The bucket of a verified principal: a digest, so no subject is held in memory in clear."""
    return hashlib.sha256(
        _DOMAIN + issuer.encode("utf-8") + b"\x00" + subject.encode("utf-8")
    ).hexdigest()


def _bearer(request: HttpRequest) -> str | None:
    value = request.META.get("HTTP_AUTHORIZATION", "")
    if not isinstance(value, str) or len(value) > MAX_TOKEN + 7:
        return None
    parts = value.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        return None
    return parts[1]


def verified_principal(request: HttpRequest) -> str | None:
    """The bucket key of the request's verified bearer token, or None when it carries none that
    verifies. The same verification the views apply, lane guard included; nothing is trusted that
    they would refuse."""
    bearer = _bearer(request)
    if bearer is None:
        return None
    try:
        verified, lane = verify_configured_token(bearer, trusted=settings.KODERA_AUTH_TRUST)
        verified, lane = lanes.admit(verified, lane)
    except TokenVerificationError:
        return None
    except Exception:
        # A trust configuration the views cannot use either: they answer it; this does not guess.
        return None
    return principal_key(verified.issuer, verified.subject)


def rate_limited(request: HttpRequest, decision: Decision) -> HttpResponse:
    """`429 rate-limited` (CONVENTIONS §6, §11): the wait in `Retry-After` and `retry_after_s`."""
    request_id = request.META.get("HTTP_X_REQUEST_ID") or str(new_uuid7())
    response = HttpResponse(
        json.dumps(
            {
                "type": RATE_LIMITED_TYPE,
                "title": RATE_LIMITED_TITLE,
                "status": 429,
                "request_id": request_id,
                "retry_after_s": decision.reset_s,
                "scope": SCOPE,
                "limit": decision.limit,
            }
        ),
        status=429,
        content_type="application/problem+json",
    )
    response["Retry-After"] = str(decision.reset_s)
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response


def _quota_headers(response: HttpResponse, decision: Decision) -> None:
    """The bucket's state (CONVENTIONS §11), unless the view already reported a tighter one."""
    if "RateLimit-Limit" in response:
        return
    response["RateLimit-Limit"] = str(decision.limit)
    response["RateLimit-Remaining"] = str(decision.remaining)
    response["RateLimit-Reset"] = str(decision.reset_s)


class MutationRateLimitMiddleware:
    """Refuses a principal's write past the mutation bucket, before any view runs.

    Installed after `CallerRequestIdMiddleware`, so the refusal carries the request's id, and
    inside `ConsoleCorsMiddleware`, so the Console can read the refusal it is sent."""

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response
        # One window per serving process: Django builds the middleware once per handler.
        self.window = SlidingWindow()

    def __call__(self, request: HttpRequest) -> HttpResponse:
        if request.method not in MUTATING_METHODS or not request.path.startswith(API_PREFIX):
            return self.get_response(request)
        limit = configured_limit()
        key = verified_principal(request)
        if key is None:
            return self.get_response(request)
        decision = self.window.charge(key, limit=limit)
        if not decision.admitted:
            response = rate_limited(request, decision)
        else:
            response = self.get_response(request)
        _quota_headers(response, decision)
        return response
