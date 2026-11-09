"""Shared rolling database quotas; no raw input, replay identity or response storage."""

from datetime import datetime
from typing import cast

from django.conf import settings
from django.db import connection

from services.identity.discovery_policy import (
    WINDOW,
    DiscoveryUnavailableError,
    QuotaDecision,
    bucket_digest,
    configured_key,
    evaluate,
    normalized_peer,
    validate_value,
    value_bucket,
)

from .discovery_db import Deadline, discovery_transaction
from .models import DiscoveryQuotaEvent, DiscoveryQuotaGate

MAX_EVENTS = 10000


def database_now() -> datetime:
    with connection.cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        return cast(datetime, cursor.fetchone()[0])


def _lock() -> None:
    if DiscoveryQuotaGate.objects.select_for_update().filter(singleton=True).first() is None:
        raise DiscoveryUnavailableError("quota-storage")


def cleanup_expired() -> int:
    with discovery_transaction(Deadline()):
        _lock()
        removed, _ = DiscoveryQuotaEvent.objects.filter(
            occurred_at__lte=database_now() - WINDOW
        ).delete()
    return removed


def _charge(scope: str, digest: str, deadline: Deadline) -> QuotaDecision:
    with discovery_transaction(deadline):
        _lock()
        now = database_now()
        DiscoveryQuotaEvent.objects.filter(occurred_at__lte=now - WINDOW).delete()
        count = DiscoveryQuotaEvent.objects.count()
        if count >= MAX_EVENTS:
            raise DiscoveryUnavailableError("capacity")
        rows = DiscoveryQuotaEvent.objects.filter(scope=scope).order_by("occurred_at")
        if scope == "entry":
            values = list(rows.values_list("digest", "occurred_at"))
            buckets = {
                "global": [at for _, at in values],
                "ip": [at for peer, at in values if peer == digest],
            }
        else:
            buckets = {
                scope: list(rows.filter(digest=digest).values_list("occurred_at", flat=True))
            }
        decision = evaluate(buckets, now)
        if decision.admitted:
            DiscoveryQuotaEvent.objects.create(scope=scope, digest=digest, occurred_at=now)
    return decision


def admit_peer(peer: str, *, _deadline: Deadline | None = None) -> QuotaDecision:
    key = configured_key(getattr(settings, "KODERA_DISCOVERY_HMAC_KEY", None))
    normalized = normalized_peer(peer)
    return _charge("entry", bucket_digest(key, "ip", normalized), _deadline or Deadline())


def admit_value(
    kind: str, value: str, peer: str, *, _deadline: Deadline | None = None
) -> QuotaDecision:
    key = configured_key(getattr(settings, "KODERA_DISCOVERY_HMAC_KEY", None))
    validate_value(kind, value)
    bucket = value_bucket(normalized_peer(peer), value)
    return _charge(kind, bucket_digest(key, kind, bucket), _deadline or Deadline())
