"""Server-side C1 PII/secret scrubber and input validators (SAR, public JWKS)."""

from __future__ import annotations

import re

from .errors import StaffApiError

MAX_SCRUB_LENGTH = 4000

BEARER_RE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}", re.IGNORECASE)
JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")
SECRET_PREFIX_RE = re.compile(
    r"\b(?:sk_live_|sk_test_|rk_live_|rk_test_|whsec_|ghp_|gho_|github_pat_|glpat-|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}\b"
)
QUERY_SECRET_RE = re.compile(
    r"([?&](?:token|access_token|id_token|refresh_token|code|secret|api_key|key)=)[^&\s#]+",
    re.IGNORECASE,
)
EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
UUID_RE = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
    re.IGNORECASE,
)
IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
IPV6_RE = re.compile(r"\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b", re.IGNORECASE)
PHONE_RE = re.compile(r"(?<!\w)\+?[0-9][0-9().\-\s]{7,}[0-9](?!\w)")

SAR_PSEUDONYM_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
PRINTABLE_REF_RE = re.compile(r"[\x20-\x7e]{1,256}\Z")
SLUG_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
COHORT_CODE_RE = re.compile(r"[a-z0-9][a-z0-9_-]{1,62}\Z")
PERIOD_MONTH_RE = re.compile(r"\d{4}-(?:0[1-9]|1[0-2])\Z")

PRIVATE_JWK_FIELDS = frozenset({"d", "p", "q", "dp", "dq", "qi", "oth", "k"})
ALLOWED_JWK_KTYS = frozenset({"RSA", "EC", "OKP"})


def scrub_c1_text(raw: str) -> str:
    """Scrub tokens, secrets, emails, UUIDs, IPs, and phone numbers from C1 text."""
    text = raw[:MAX_SCRUB_LENGTH]
    text = BEARER_RE.sub("Bearer [REDACTED_TOKEN]", text)
    text = JWT_RE.sub("[REDACTED_JWT]", text)
    text = SECRET_PREFIX_RE.sub("[REDACTED_SECRET]", text)
    text = QUERY_SECRET_RE.sub(r"\1[REDACTED_SECRET]", text)
    text = EMAIL_RE.sub("[REDACTED_EMAIL]", text)
    text = UUID_RE.sub("[REDACTED_UUID]", text)
    text = IPV4_RE.sub("[REDACTED_IP]", text)
    text = IPV6_RE.sub("[REDACTED_IP]", text)
    text = PHONE_RE.sub("[REDACTED_PHONE]", text)
    return text


def validate_sar_pseudonym(value: object) -> str:
    if not isinstance(value, str):
        raise StaffApiError(
            400,
            "invalid_sar_pseudonym",
            "Invalid SAR pseudonym",
            "subject_pseudonym must be a lowercase sha256:<64-hex> digest",
        )
    trimmed = value.strip()
    if SAR_PSEUDONYM_RE.fullmatch(trimmed) is None:
        raise StaffApiError(
            400,
            "invalid_sar_pseudonym",
            "Invalid SAR pseudonym",
            "subject_pseudonym must match sha256:<64 lowercase hex>; raw emails and names are forbidden",
        )
    return trimmed


def validate_sar_evidence_ref(value: object) -> str:
    if not isinstance(value, str):
        raise StaffApiError(
            400,
            "invalid_evidence_ref",
            "Invalid SAR evidence reference",
            "evidence_ref must be a non-empty C1 reference string",
        )
    trimmed = value.strip()
    if (
        not trimmed
        or PRINTABLE_REF_RE.fullmatch(trimmed) is None
        or "@" in trimmed
        or BEARER_RE.search(trimmed) is not None
        or JWT_RE.search(trimmed) is not None
        or SECRET_PREFIX_RE.search(trimmed) is not None
    ):
        raise StaffApiError(
            400,
            "invalid_evidence_ref",
            "Invalid SAR evidence reference",
            "evidence_ref must be 1..256 printable ASCII characters without emails, tokens, or secrets",
        )
    return trimmed


def validate_public_jwks(value: object) -> dict[str, list[dict[str, object]]]:
    if not isinstance(value, dict):
        raise StaffApiError(
            400,
            "invalid_public_jwks",
            "Invalid public JWKS",
            "public_jwks must be a JSON object containing a non-empty keys array",
        )
    keys = value.get("keys")
    if not isinstance(keys, list) or not (1 <= len(keys) <= 16):
        raise StaffApiError(
            400,
            "invalid_public_jwks",
            "Invalid public JWKS",
            "public_jwks.keys must contain between 1 and 16 JWK entries",
        )
    sanitized: list[dict[str, object]] = []
    for entry in keys:
        if not isinstance(entry, dict):
            raise StaffApiError(
                400,
                "invalid_public_jwks",
                "Invalid public JWKS",
                "Every JWK entry must be a JSON object",
            )
        forbidden = PRIVATE_JWK_FIELDS.intersection(entry.keys())
        if forbidden:
            raise StaffApiError(
                400,
                "private_jwk_rejected",
                "Private key material refused",
                "public_jwks must contain public key parameters only; private or symmetric JWK fields are forbidden",
            )
        kty = entry.get("kty")
        kid = entry.get("kid")
        if kty not in ALLOWED_JWK_KTYS or not isinstance(kid, str) or not kid.strip():
            raise StaffApiError(
                400,
                "invalid_public_jwks",
                "Invalid public JWKS",
                "Each JWK entry requires kty in (RSA, EC, OKP) and a non-empty kid",
            )
        sanitized.append(dict(entry))
    return {"keys": sanitized}
