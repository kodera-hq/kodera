"""What Core believes about a request that crossed the operator's edge (docs/specs/TRUSTED_EDGE.md).

Two rules, both about values a caller can write:

- The client address is the direct peer, unless that peer is a configured trusted edge; then it is
  the rightmost `X-Forwarded-For` hop that is not itself a trusted edge. Nothing else reads
  `X-Forwarded-For`.
- A caller's `X-Request-Id` is kept, for its own correlation, under the `c-` namespace, so it can
  never pass for an id Core generated (a UUIDv7, which never starts with `c-`).
"""

from __future__ import annotations

import ipaddress
import re
from collections.abc import Callable, Mapping, Sequence

from django.http import HttpRequest, HttpResponse

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
        if namespaced is not None:
            request.META["HTTP_X_REQUEST_ID"] = namespaced
        # `request.headers` is cached from META on first read: drop a copy something ahead of
        # this may already have cached.
        request.__dict__.pop("headers", None)
        return self.get_response(request)
