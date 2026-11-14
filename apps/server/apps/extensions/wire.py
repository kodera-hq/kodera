"""SDK-compatible timestamp.raw-body HMAC with signed installation and generation bindings."""

from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

EVENTS = frozenset(
    {
        "command.invoked",
        "message.created",
        "message.deleted",
        "release.published",
        "ci.workflow_failed",
        "incident.opened",
        "incident.acknowledged",
        "incident.resolved",
    }
)
MAX_BODY = 128 * 1024
MAX_GRACE_SECONDS = 86400


class ExtensionRefusedError(ValueError):
    def __init__(self, reason: str, status: int = 422) -> None:
        super().__init__(reason)
        self.reason, self.status = reason, status


def canonical(value: Any) -> bytes:
    try:
        raw = json.dumps(
            value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    except (ValueError, TypeError, RecursionError):
        raise ExtensionRefusedError("extension_payload_invalid") from None
    if len(raw) > MAX_BODY:
        raise ExtensionRefusedError("extension_payload_bound", 413)
    return raw


def event_payload(event_type: str, data: dict[str, Any]) -> bytes:
    if event_type not in EVENTS or not isinstance(data, dict):
        raise ExtensionRefusedError("extension_event_invalid")
    raw = canonical({"type": event_type, "data": data})
    # Reserve room for fixed scope/generation fields before queueing; an accepted event must
    # not become permanently unsignable when its authenticated envelope is added later.
    if len(raw) > MAX_BODY - 2048:
        raise ExtensionRefusedError("extension_payload_bound", 413)
    return raw


def signature(secret: str, timestamp: int, raw: bytes) -> str:
    if (
        not isinstance(secret, str)
        or not 32 <= len(secret.encode()) <= 512
        or not secret.isascii()
        or not secret.isprintable()
    ):
        raise ExtensionRefusedError("extension_signing_key_unavailable", 503)
    if type(timestamp) is not int or not 0 <= timestamp <= 9007199254740991:
        raise ExtensionRefusedError("extension_timestamp_invalid")
    return (
        "v1=" + hmac.digest(secret.encode(), str(timestamp).encode() + b"." + raw, "sha256").hex()
    )


@dataclass(frozen=True)
class Signed:
    body: bytes
    headers: dict[str, str]


def signed_delivery(
    *,
    organisation_id: UUID,
    installation_id: UUID,
    delivery_id: UUID,
    generation: UUID,
    event: bytes,
    secret: str,
    now: datetime,
    previous_generation: UUID | None = None,
    previous_secret: str | None = None,
    grace_expires_at: datetime | None = None,
) -> Signed:
    if now.tzinfo is None:
        raise ExtensionRefusedError("extension_clock_invalid")
    try:
        value = json.loads(event)
        if (
            not isinstance(value, dict)
            or set(value) != {"type", "data"}
            or event_payload(value["type"], value["data"]) != event
        ):
            raise ValueError
    except (ValueError, KeyError, TypeError, UnicodeError):
        raise ExtensionRefusedError("extension_event_invalid") from None
    body = {
        "schema": "kodera.extension.delivery.v2",
        "organisation_id": str(organisation_id),
        "installation_id": str(installation_id),
        "delivery_id": str(delivery_id),
        "key_generation": str(generation),
        "event_sha256": hashlib.sha256(event).hexdigest(),
        **value,
    }
    if grace_expires_at is not None and grace_expires_at.tzinfo is None:
        raise ExtensionRefusedError("extension_rotation_binding_invalid")
    grace = (
        grace_expires_at is not None
        and grace_expires_at.tzinfo is not None
        and now < grace_expires_at
    )
    if grace:
        if (
            grace_expires_at is None
            or previous_generation is None
            or previous_generation == generation
            or previous_secret is None
            or (grace_expires_at - now).total_seconds() > MAX_GRACE_SECONDS
        ):
            raise ExtensionRefusedError("extension_rotation_binding_invalid")
        if (
            isinstance(previous_secret, str)
            and isinstance(secret, str)
            and hmac.compare_digest(previous_secret.encode(), secret.encode())
        ):
            raise ExtensionRefusedError("extension_rotation_key_reused")
        body.update(
            previous_key_generation=str(previous_generation),
            grace_expires_at=int(grace_expires_at.timestamp()),
        )
    raw = canonical(body)
    timestamp = int(now.timestamp())
    headers = {
        "Content-Type": "application/json",
        "X-Kodera-Signature-256": signature(secret, timestamp, raw),
        "X-Kodera-Timestamp": str(timestamp),
        "X-Kodera-Event": value["type"],
        "X-Kodera-Delivery-Id": str(delivery_id),
        "Idempotency-Key": str(delivery_id),
    }
    if grace:
        if previous_secret is None:
            raise ExtensionRefusedError("extension_signing_key_unavailable", 503)
        headers["X-Kodera-Previous-Signature-256"] = signature(previous_secret, timestamp, raw)
    return Signed(raw, headers)
