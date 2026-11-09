"""Pure claim locator and byte-verifier primitives, without issuance orchestration."""

import base64
import binascii
import re
from uuid import RFC_4122, UUID

from argon2 import PasswordHasher, extract_parameters
from argon2.exceptions import InvalidHashError, VerificationError
from argon2.profiles import RFC_9106_LOW_MEMORY

_HASHER = PasswordHasher.from_parameters(RFC_9106_LOW_MEMORY)
_SECRET = re.compile(r"[A-Za-z0-9_-]{43}\Z", re.ASCII)


class ClaimTokenError(ValueError):
    """A claim token has refused grammar or bounds."""


def format_claim_token(claim_id: UUID, secret: str) -> str:
    if not isinstance(claim_id, UUID) or claim_id.version != 7 or claim_id.variant != RFC_4122:
        raise ClaimTokenError("owner claim token refused")
    if not isinstance(secret, str) or not _SECRET.fullmatch(secret):
        raise ClaimTokenError("owner claim token refused")
    try:
        raw = base64.b64decode(secret + "=", altchars=b"-_", validate=True)
    except (ValueError, binascii.Error):
        raise ClaimTokenError("owner claim token refused") from None
    if len(raw) != 32 or base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=") != secret:
        raise ClaimTokenError("owner claim token refused")
    return f"oc1_{claim_id}_{secret}"


def claim_id_for_token(token: str) -> UUID | None:
    if not isinstance(token, str) or len(token) != 84:
        return None
    if token[:4] != "oc1_" or token[40] != "_":
        return None
    try:
        claim_id = UUID(token[4:40])
        return claim_id if format_claim_token(claim_id, token[41:]) == token else None
    except (ValueError, TypeError):
        return None


def _bounded_secret(secret: str) -> bool:
    return isinstance(secret, str) and secret.isascii() and 43 <= len(secret) <= 256


def hash_claim_secret(secret: str) -> bytes:
    if not _bounded_secret(secret):
        raise ClaimTokenError("owner claim token refused")
    return _HASHER.hash(secret).encode("ascii")


def verify_claim_secret(secret: str, verifier: bytes) -> bool:
    if not _bounded_secret(secret) or not isinstance(verifier, bytes) or len(verifier) > 512:
        return False
    try:
        if extract_parameters(verifier.decode("ascii")) != RFC_9106_LOW_MEMORY:
            return False
        return _HASHER.verify(verifier, secret)
    except (InvalidHashError, VerificationError, UnicodeError, ValueError):
        return False
