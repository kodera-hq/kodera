"""The sealed recipient, link secret and Reply-To of a message: docs/specs/OUTBOX_MAIL_SENDER.md
§5.1. A message without its own Reply-To seals no `reply_to` member at all, the format it always had.

AES-256-GCM under the seal key, a fresh 96-bit nonce per seal, and associated data naming the
delivery, so a sealed value moved to another delivery does not open. Stored as a version byte, the
nonce and the ciphertext.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from uuid import UUID

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from django.core.exceptions import ImproperlyConfigured

VERSION = b"\x01"
NONCE_BYTES = 12
KEY_BYTES = 32
CONTEXT = b"kodera-outbox-message:"


class SealError(ValueError):
    """A sealed value does not open."""


class SealKeyError(ImproperlyConfigured):
    """KODERA_OUTBOX_SEAL_KEY is malformed: the process refuses to start."""


@dataclass(frozen=True)
class Sealed:
    recipient: str = field(repr=False)
    secret: str = field(repr=False)
    reply_to: str | None = field(default=None, repr=False)


def key_from_environment(environment: Mapping[str, str]) -> bytes | None:
    """KODERA_OUTBOX_SEAL_KEY: 32 bytes in URL-safe base64, or None when unset or empty."""
    value = environment.get("KODERA_OUTBOX_SEAL_KEY", "")
    if value == "":
        return None
    try:
        key = base64.urlsafe_b64decode(value.encode("ascii"))
    except (binascii.Error, UnicodeEncodeError, ValueError):
        raise SealKeyError("KODERA_OUTBOX_SEAL_KEY is not URL-safe base64") from None
    if len(key) != KEY_BYTES:
        raise SealKeyError("KODERA_OUTBOX_SEAL_KEY must decode to 32 bytes")
    return key


def associated_data(delivery_id: UUID) -> bytes:
    return CONTEXT + delivery_id.bytes


def nonce() -> bytes:
    """A fresh random 96-bit nonce: GCM under one key never sees a nonce twice."""
    return os.urandom(NONCE_BYTES)


def seal(
    key: bytes, delivery_id: UUID, recipient: str, secret: str, *, reply_to: str | None = None
) -> bytes:
    content = {"recipient": recipient, "secret": secret}
    if reply_to is not None:
        content["reply_to"] = reply_to
    plaintext = json.dumps(content, separators=(",", ":"), sort_keys=True).encode("utf-8")
    fresh = nonce()
    return VERSION + fresh + AESGCM(key).encrypt(fresh, plaintext, associated_data(delivery_id))


def unseal(key: bytes, delivery_id: UUID, value: bytes) -> Sealed:
    if len(value) <= 1 + NONCE_BYTES or value[:1] != VERSION:
        raise SealError(f"the sealed value of delivery {delivery_id} is malformed")
    used, ciphertext = value[1 : 1 + NONCE_BYTES], value[1 + NONCE_BYTES :]
    try:
        plaintext = AESGCM(key).decrypt(used, ciphertext, associated_data(delivery_id))
    except InvalidTag:
        raise SealError(f"the sealed value of delivery {delivery_id} does not open") from None
    content = json.loads(plaintext)
    reply_to = content.get("reply_to")
    return Sealed(
        recipient=str(content["recipient"]),
        secret=str(content["secret"]),
        reply_to=None if reply_to is None else str(reply_to),
    )
