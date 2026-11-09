"""Application-level sealing of a stored value under a key from the environment.

AES-256-GCM, a fresh 96-bit nonce per seal, and associated data the caller chooses so that a
sealed value moved to another row, or read for another purpose, does not open. Stored as a
version byte, the nonce and the ciphertext. The construction is the outbox's
(apps/outbox/mail/seal.py, docs/specs/OUTBOX_MAIL_SENDER.md §5.1), with the payload and the
associated data left to the caller; each use has its own key and its own context prefix.
"""

from __future__ import annotations

import base64
import binascii
import os
from collections.abc import Mapping

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from django.core.exceptions import ImproperlyConfigured

VERSION = b"\x01"
NONCE_BYTES = 12
KEY_BYTES = 32
# The smallest sealed value: the version byte, the nonce and the 16-byte tag of an empty payload.
MIN_SEALED_BYTES = 1 + NONCE_BYTES + 16


class SealError(ValueError):
    """A sealed value does not open under this key and this associated data."""


class SealKeyError(ImproperlyConfigured):
    """A seal key in the environment is malformed: the process refuses to start."""


def key_from_environment(environment: Mapping[str, str], name: str) -> bytes | None:
    """The 32-byte key named `name`, in URL-safe base64, or None when unset or empty."""
    value = environment.get(name, "")
    if value == "":
        return None
    try:
        key = base64.urlsafe_b64decode(value.encode("ascii"))
    except (binascii.Error, UnicodeEncodeError, ValueError):
        raise SealKeyError(f"{name} is not URL-safe base64") from None
    if len(key) != KEY_BYTES:
        raise SealKeyError(f"{name} must decode to {KEY_BYTES} bytes")
    return key


def seal(key: bytes, associated_data: bytes, plaintext: bytes) -> bytes:
    if len(key) != KEY_BYTES:
        raise SealError("a seal key is 32 bytes")
    nonce = os.urandom(NONCE_BYTES)
    return VERSION + nonce + AESGCM(key).encrypt(nonce, plaintext, associated_data)


def unseal(key: bytes, associated_data: bytes, value: bytes) -> bytes:
    if len(value) < MIN_SEALED_BYTES or value[:1] != VERSION:
        raise SealError("the sealed value is malformed")
    nonce, ciphertext = value[1 : 1 + NONCE_BYTES], value[1 + NONCE_BYTES :]
    try:
        return AESGCM(key).decrypt(nonce, ciphertext, associated_data)
    except InvalidTag:
        raise SealError("the sealed value does not open") from None
