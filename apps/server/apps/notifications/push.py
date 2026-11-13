"""VAPID-authenticated empty-body wakeups over the pinned public-address transport."""

from __future__ import annotations

import base64
import binascii
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlsplit

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from apps.media import outbound


class SubscriptionRefusedError(ValueError):
    def __init__(self) -> None:
        super().__init__("push subscription refused")


def encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def decode(value: str, *, size: int) -> bytes:
    if not isinstance(value, str) or re.fullmatch(r"[A-Za-z0-9_-]+", value) is None:
        raise SubscriptionRefusedError()
    try:
        decoded = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    except (ValueError, binascii.Error):
        raise SubscriptionRefusedError() from None
    if len(decoded) != size or encode(decoded) != value:
        raise SubscriptionRefusedError()
    return decoded


def point(value: str) -> bytes:
    decoded = decode(value, size=65)
    try:
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), decoded)
    except ValueError:
        raise SubscriptionRefusedError() from None
    return decoded


def subscription(endpoint: str, p256dh: str, auth: str, *, resolve: bool = True) -> str:
    destination = outbound.target(endpoint, https_only=True)
    if urlsplit(endpoint).fragment:
        raise SubscriptionRefusedError()
    point(p256dh)
    decode(auth, size=16)
    if resolve:
        outbound.addresses(destination, time.monotonic() + 3)
    return destination.url


def public_key(private_key: ec.EllipticCurvePrivateKey) -> str:
    if not isinstance(private_key.curve, ec.SECP256R1):
        raise SubscriptionRefusedError()
    return encode(
        private_key.public_key().public_bytes(
            serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint,
        )
    )


def headers(
    endpoint: str,
    private_key: ec.EllipticCurvePrivateKey,
    subject: str,
    *,
    now: datetime,
) -> dict[str, str]:
    destination = outbound.target(endpoint, https_only=True)
    if (
        now.tzinfo is None
        or not isinstance(subject, str)
        or len(subject) > 2048
        or any(ord(c) < 33 or ord(c) > 126 for c in subject)
    ):
        raise SubscriptionRefusedError()
    contact = urlsplit(subject)
    if contact.scheme == "mailto":
        if "@" not in contact.path or contact.query or contact.fragment:
            raise SubscriptionRefusedError()
    elif contact.scheme == "https":
        outbound.target(subject, https_only=True)
    else:
        raise SubscriptionRefusedError()
    key = public_key(private_key)
    token = jwt.encode(
        {
            "aud": "https://" + destination.authority,
            "exp": int(now.astimezone(UTC).timestamp()) + 300,
            "sub": subject,
        },
        private_key,
        algorithm="ES256",
    )
    return {"Authorization": f"vapid t={token}, k={key}", "TTL": "60", "Content-Length": "0"}


@dataclass(frozen=True)
class Result:
    outcome: str
    retry_after: int = 0


def send(
    endpoint: str,
    private_key: ec.EllipticCurvePrivateKey,
    subject: str,
) -> Result:
    # There is deliberately no notification, plaintext or resource argument.
    destination = outbound.target(endpoint, https_only=True)
    connection, response = outbound.request(
        destination,
        method="POST",
        body=b"",
        headers=headers(destination.url, private_key, subject, now=datetime.now(UTC)),
        deadline=time.monotonic() + 3,
    )
    try:
        if response.status in {201, 202, 204}:
            return Result("delivered")
        if response.status in {404, 410}:
            return Result("dead")
        if response.status == 429 or 500 <= response.status < 600:
            wait = response.getheader("Retry-After", "60")
            seconds = (
                int(wait) if isinstance(wait, str) and wait.isdigit() and len(wait) <= 6 else 60
            )
            return Result("retry", min(3600, max(1, seconds)))
        # Redirects are never followed, including redirects to another public provider.
        return Result("refused")
    finally:
        response.close()
        connection.close()
