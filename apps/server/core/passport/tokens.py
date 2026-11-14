"""Pure cryptographic and validation primitives for Kodera Passport.

Kept inside `core.passport` with zero `apps.*` imports so layer boundaries hold:
- 32-byte CSPRNG magic-link token generation (`secrets.token_bytes(32)`), SHA-256 hashed at rest.
- Strict email and domain normalization with deterministic error pointers.
- RFC 7636 PKCE (`S256`) and optional device challenge constant-time verification.
- Stateless HMAC-SHA256 Passport session token (`kp1.<payload>.<signature>`) for cross-workspace
  session establishment immediately after magic-link verification.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import time
from dataclasses import dataclass
from uuid import UUID

TOKEN_BYTES = 32
MAGIC_LINK_TTL_SECONDS = 600
PASSPORT_SESSION_TTL_SECONDS = 3600
PASSPORT_SESSION_PREFIX = "kp1."

_LOCAL_RE = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}\Z")
_RAW_TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{43}\Z")
_PKCE_CHALLENGE_RE = re.compile(r"[A-Za-z0-9_-]{43}\Z")
_PKCE_VERIFIER_RE = re.compile(r"[A-Za-z0-9._~-]{43,128}\Z")
_DEVICE_CHALLENGE_RE = re.compile(r"[A-Za-z0-9._~:-]{16,128}\Z")
_SESSION_PART_RE = re.compile(r"[A-Za-z0-9_-]{1,2048}\Z")
_DOMAIN_CHARS = frozenset("abcdefghijklmnopqrstuvwxyz0123456789-")


def _is_valid_domain(domain: str) -> bool:
    if not 3 <= len(domain) <= 253:
        return False
    labels = domain.split(".")
    if len(labels) < 2:
        return False
    for label in labels:
        if not 1 <= len(label) <= 63:
            return False
        if label[0] == "-" or label[-1] == "-":
            return False
        if any(ch not in _DOMAIN_CHARS for ch in label):
            return False
    return True


class PassportInputError(ValueError):
    """Deterministic input validation error carrying a JSON pointer and stable code."""

    def __init__(self, pointer: str, code: str) -> None:
        super().__init__(f"{pointer}: {code}")
        self.pointer = pointer
        self.code = code


class PassportSessionError(ValueError):
    """Raised when a Passport token or session credential fails verification."""


@dataclass(frozen=True, slots=True)
class PassportSessionClaims:
    user_id: UUID
    active_organisation_id: UUID | None
    issued_at: int
    expires_at: int


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(encoded: str) -> bytes:
    if not _SESSION_PART_RE.fullmatch(encoded):
        raise PassportSessionError("invalid base64url segment")
    padding = "=" * (-len(encoded) % 4)
    try:
        return base64.urlsafe_b64decode((encoded + padding).encode("ascii"))
    except ValueError as exc:
        raise PassportSessionError("malformed base64url segment") from exc


def normalize_passport_email(raw: object) -> tuple[str, str]:
    """Normalize an email address to `(email_normalized, domain_normalized)` or raise."""
    if not isinstance(raw, str):
        raise PassportInputError("/email", "invalid-email")
    trimmed = raw.strip()
    if not 3 <= len(trimmed) <= 254 or not trimmed.isascii():
        raise PassportInputError("/email", "invalid-email")
    if any(ch.isspace() or ord(ch) < 0x21 or ord(ch) > 0x7E for ch in trimmed):
        raise PassportInputError("/email", "invalid-email")
    if trimmed.count("@") != 1:
        raise PassportInputError("/email", "invalid-email")
    local_raw, domain_raw = trimmed.split("@")
    local = local_raw.lower()
    domain = domain_raw.lower()
    if (
        not _LOCAL_RE.fullmatch(local)
        or local.startswith(".")
        or local.endswith(".")
        or ".." in local
    ):
        raise PassportInputError("/email", "invalid-email")
    if not _is_valid_domain(domain):
        raise PassportInputError("/email", "invalid-email")
    return f"{local}@{domain}", domain


def generate_magic_link_token() -> tuple[str, str]:
    """Return `(raw_token, token_sha256)` from 32 bytes of CSPRNG entropy."""
    raw_token = _b64url_encode(secrets.token_bytes(TOKEN_BYTES))
    token_sha256 = hashlib.sha256(raw_token.encode("ascii")).hexdigest()
    return raw_token, token_sha256


def hash_magic_link_token(raw: object) -> str:
    """Validate shape and return the lowercase SHA-256 hex digest of a magic-link token."""
    if not isinstance(raw, str) or not _RAW_TOKEN_RE.fullmatch(raw):
        raise PassportSessionError("invalid magic-link token shape")
    return hashlib.sha256(raw.encode("ascii")).hexdigest()


def compute_pkce_s256(code_verifier: str) -> str:
    """Compute the RFC 7636 S256 challenge for an ASCII code_verifier."""
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    return _b64url_encode(digest)


def validate_pkce_challenge(
    code_challenge: object, code_challenge_method: object = "S256"
) -> tuple[str, str]:
    """Validate a PKCE S256 challenge before persisting a magic-link request."""
    if code_challenge_method != "S256":
        raise PassportInputError("/code_challenge_method", "unsupported-challenge-method")
    if not isinstance(code_challenge, str) or not _PKCE_CHALLENGE_RE.fullmatch(code_challenge):
        raise PassportInputError("/code_challenge", "invalid-code-challenge")
    return code_challenge, "S256"


def verify_pkce_verifier(*, code_verifier: object, expected_challenge: str) -> bool:
    """Verify a PKCE S256 verifier in constant time."""
    if not isinstance(code_verifier, str) or not _PKCE_VERIFIER_RE.fullmatch(code_verifier):
        return False
    computed = compute_pkce_s256(code_verifier).encode("ascii")
    return hmac.compare_digest(computed, expected_challenge.encode("ascii"))


def validate_device_challenge(device_challenge: object) -> str | None:
    """Hash an optional client device challenge with SHA-256 for at-rest binding."""
    if device_challenge is None:
        return None
    if not isinstance(device_challenge, str) or not _DEVICE_CHALLENGE_RE.fullmatch(
        device_challenge
    ):
        raise PassportInputError("/device_challenge", "invalid-device-challenge")
    return hashlib.sha256(device_challenge.encode("ascii")).hexdigest()


def verify_device_verifier(*, device_verifier: object, expected_sha256: str | None) -> bool:
    """Verify an optional device verifier in constant time against its stored SHA-256 digest."""
    if expected_sha256 is None:
        return device_verifier is None
    if not isinstance(device_verifier, str) or not _DEVICE_CHALLENGE_RE.fullmatch(device_verifier):
        return False
    actual = hashlib.sha256(device_verifier.encode("ascii")).hexdigest().encode("ascii")
    return hmac.compare_digest(actual, expected_sha256.encode("ascii"))


def rate_limit_digest(*, secret: str, scope: str, value: str) -> str:
    """Pseudonymous HMAC-SHA256 digest for Passport rate-limit buckets."""
    if not secret:
        raise ValueError("secret must not be empty")
    material = f"kodera-passport-rl-v1\x00{scope}\x00{value}".encode()
    return hmac.new(secret.encode("utf-8"), material, hashlib.sha256).hexdigest()


def _session_hmac_key(secret: str) -> bytes:
    if not secret or len(secret) < 16:
        raise PassportSessionError("passport signing secret unavailable")
    return hmac.new(
        secret.encode("utf-8"),
        b"kodera-passport-session-v1",
        hashlib.sha256,
    ).digest()


def issue_passport_session_token(
    *,
    secret: str,
    user_id: UUID,
    active_organisation_id: UUID | None,
    now: int | None = None,
    ttl_seconds: int = PASSPORT_SESSION_TTL_SECONDS,
) -> str:
    """Issue a short-lived signed `kp1.<payload>.<sig>` cross-workspace session token."""
    issued_at = int(time.time()) if now is None else int(now)
    expires_at = issued_at + ttl_seconds
    payload = {
        "v": 1,
        "sub": str(user_id),
        "org": None if active_organisation_id is None else str(active_organisation_id),
        "iat": issued_at,
        "exp": expires_at,
    }
    encoded_payload = _b64url_encode(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    signing_input = f"kp1.{encoded_payload}".encode("ascii")
    signature = _b64url_encode(
        hmac.new(_session_hmac_key(secret), signing_input, hashlib.sha256).digest()
    )
    return f"kp1.{encoded_payload}.{signature}"


def verify_passport_session_token(
    token: str,
    *,
    secret: str,
    now: int | None = None,
) -> PassportSessionClaims:
    """Verify a `kp1.<payload>.<sig>` session token in constant time and return its claims."""
    if not isinstance(token, str) or not token.startswith(PASSPORT_SESSION_PREFIX):
        raise PassportSessionError("not a passport session token")
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != "kp1":
        raise PassportSessionError("malformed passport session token")
    _, encoded_payload, encoded_sig = parts
    if not _SESSION_PART_RE.fullmatch(encoded_payload) or not _SESSION_PART_RE.fullmatch(
        encoded_sig
    ):
        raise PassportSessionError("malformed passport session token segment")
    signing_input = f"kp1.{encoded_payload}".encode("ascii")
    expected_sig = _b64url_encode(
        hmac.new(_session_hmac_key(secret), signing_input, hashlib.sha256).digest()
    )
    if not hmac.compare_digest(expected_sig.encode("ascii"), encoded_sig.encode("ascii")):
        raise PassportSessionError("passport session signature mismatch")
    try:
        decoded = json.loads(_b64url_decode(encoded_payload).decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise PassportSessionError("invalid passport session payload") from exc
    if not isinstance(decoded, dict) or decoded.get("v") != 1:
        raise PassportSessionError("unsupported passport session version")
    iat = decoded.get("iat")
    exp = decoded.get("exp")
    if (
        isinstance(iat, bool)
        or isinstance(exp, bool)
        or not isinstance(iat, int)
        or not isinstance(exp, int)
    ):
        raise PassportSessionError("invalid passport session timestamps")
    current = int(time.time()) if now is None else int(now)
    if exp <= current or iat > current + 60 or exp <= iat:
        raise PassportSessionError("expired passport session token")
    try:
        user_id = UUID(str(decoded["sub"]))
        raw_org = decoded.get("org")
        active_org_id = None if raw_org is None else UUID(str(raw_org))
    except (KeyError, ValueError, TypeError) as exc:
        raise PassportSessionError("invalid passport session claims") from exc
    return PassportSessionClaims(
        user_id=user_id,
        active_organisation_id=active_org_id,
        issued_at=iat,
        expires_at=exp,
    )
