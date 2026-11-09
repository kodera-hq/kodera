"""Pure, bounded discovery quota policy; no request/replay persistence."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import ipaddress
import math
import re
from dataclasses import dataclass
from datetime import datetime, timedelta

from .discovery_input import is_canonical_organisation_slug

LIMITS = {"global": 600, "ip": 30, "slug": 60, "domain": 300}
WINDOW = timedelta(seconds=60)
_DOMAIN = re.compile(
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+"
)


class DiscoveryUnavailableError(Exception):
    """Safe dependency refusal, never a raw database/configuration exception."""

    def __init__(self, reason: str, *, quota: QuotaDecision | None = None) -> None:
        super().__init__("discovery dependency unavailable")
        self.reason = reason
        self.quota = quota


@dataclass(frozen=True, slots=True)
class QuotaDecision:
    admitted: bool
    scope: str
    limit: int
    remaining: int
    reset_s: int
    retry_after_s: int | None


def configured_key(raw: object) -> bytes:
    if isinstance(raw, bytes) and len(raw) == 32:
        return raw
    decoded = b""
    if isinstance(raw, str) and len(raw) == 44:
        try:
            decoded = base64.b64decode(raw, validate=True)
        except (ValueError, binascii.Error):
            pass
        if len(decoded) == 32 and base64.b64encode(decoded).decode("ascii") == raw:
            return decoded
    raise DiscoveryUnavailableError("configuration")


def normalized_peer(peer: str) -> str:
    address = None
    if isinstance(peer, str) and len(peer) <= 45 and "%" not in peer:
        try:
            address = ipaddress.ip_address(peer)
        except ValueError:
            pass
    if address is None:
        raise DiscoveryUnavailableError("peer")
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            return str(address.ipv4_mapped)
        # One subscriber usually holds a whole /64: count it as one client, not 2**64.
        return str(ipaddress.IPv6Network((address, 64), strict=False))
    return str(address)


def validate_value(kind: str, value: str) -> None:
    if isinstance(value, str):
        if kind == "slug" and is_canonical_organisation_slug(value):
            return
        if kind == "domain" and len(value) <= 252 and _DOMAIN.fullmatch(value):
            return
    raise DiscoveryUnavailableError("lookup-input")


def value_bucket(peer_bucket: str, value: str) -> str:
    """A typed value's bucket is per client: a stranger exhausting it never locks a tenant out."""
    return peer_bucket + "\0" + value


def bucket_digest(key: bytes, scope: str, value: str) -> str:
    return hmac.new(
        key,
        b"kodera-discovery-v1\0" + scope.encode("ascii") + b"\0" + value.encode("ascii"),
        hashlib.sha256,
    ).hexdigest()


def evaluate(buckets: dict[str, list[datetime]], now: datetime) -> QuotaDecision:
    """Decide before insertion; allowed metadata describes the proposed single charge."""
    states = []
    for scope, events in buckets.items():
        limit = LIMITS[scope]
        live = sorted(at for at in events if at > now - WINDOW)
        exhausted = len(live) >= limit
        if exhausted:
            expiry = live[len(live) - limit] + WINDOW
        else:
            expiry = (live[0] if live else now) + WINDOW
        reset = max(1, math.ceil((expiry - now).total_seconds()))
        states.append((scope, limit, max(0, limit - len(live) - 1), reset, exhausted))
    exhausted_states = [state for state in states if state[4]]
    if exhausted_states:
        scope, limit, _, reset, _ = max(exhausted_states, key=lambda state: state[3])
        return QuotaDecision(False, scope, limit, 0, reset, reset)
    scope, limit, remaining, reset, _ = min(
        states, key=lambda state: (state[2], -state[3], state[0])
    )
    return QuotaDecision(True, scope, limit, remaining, reset, None)
