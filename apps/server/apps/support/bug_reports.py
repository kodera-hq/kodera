"""Zero-PII in-app bug report collector, PNG/WebP metadata guard, and keyed-HMAC rate limiter."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import math
import re
import struct
import unicodedata
import zlib
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from django.conf import settings
from django.db import connection, transaction
from django.db.models import F
from django.utils import timezone

from apps.audit.services import record_authz_denied
from apps.identity.selectors import current_staff_identity
from apps.orgs.actor_selectors import (
    TenantCaller,
    TenantCallerNotFoundError,
    TenantCallerUnknownError,
    organisation_slug,
    read_tenant_caller,
)
from apps.tenancy.selectors import newest_tenant_not_deleted
from core.db.ids import new_uuid7
from services.identity.access_tokens import VerifiedAccessToken

from .models import (
    BUG_COMPONENTS,
    BUG_DEVICE_CLASSES,
    BUG_SCREENSHOT_CONTENT_TYPES,
    MAX_SCREENSHOT_BYTES,
    BugReport,
    BugReportRateEvent,
)
from .triage import redact_pii

SCOPE = "support_ticket:create"
NEW_BUG_REPORT_URN = "urn:kodera:bug_report:new"
TENANT_ROLES = frozenset({"org_owner", "org_admin", "org_billing", "org_member"})

MAX_REQUEST_BYTES = 384 * 1024
MAX_BASE64_SCREENSHOT_CHARS = ((MAX_SCREENSHOT_BYTES + 2) // 3) * 4
MAX_IMAGE_DIMENSION = 8192
NOTE_LENGTH = (1, 500)

RATE_WINDOW = timedelta(hours=1)
RATE_EVENT_RETENTION = timedelta(hours=2)
DEDUP_WINDOW = timedelta(hours=24)
PER_MEMBER_LIMIT = 5
PER_ORG_LIMIT = 20
GLOBAL_LIMIT = 200
MAX_UNDISPATCHED_QUEUE_DEPTH = 500
QUEUE_FULL_RETRY_AFTER_S = 60

TOP_LEVEL_MEMBERS = frozenset(
    {
        "build_id",
        "component",
        "error_code",
        "device_class",
        "consent",
        "note",
        "screenshot",
    }
)
REQUIRED_MEMBERS = ("build_id", "component", "error_code", "device_class", "consent")
SCREENSHOT_MEMBERS = frozenset({"contentType", "blurred", "dataBase64"})

BUILD_ID_RE = re.compile(
    r"^(?:"
    r"(?:(?:web|desktop|ios|android|server|cli)-)?v?\d{1,4}\.\d{1,4}\.\d{1,4}"
    r"(?:-[0-9A-Za-z.]{1,24})?(?:\+(?:sha\.)?[0-9a-f]{7,12})?"
    r"|[0-9a-f]{7,12}"
    r"|dev|local|unknown"
    r")\Z"
)
ERROR_CODE_RE = re.compile(r"^[A-Z][A-Z0-9_.:-]{0,79}\Z")
BASE64_TOKEN_RE = re.compile(r"^[A-Za-z0-9+/]+={0,2}\Z")

ALLOWED_NOTE_CONTROLS = frozenset("\n\t")
REFUSED_UNICODE_CATEGORIES = frozenset({"Cc", "Cs", "Zl", "Zp"})

# Hard refusal detectors: credentials, tokens, bare key=value assignments, PEM blocks,
# invite/claim/magic links, and explicit or protocol-relative URLs.
_FORBIDDEN_NOTE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("bearer_token", re.compile(r"\bBearer\s+\S+", re.IGNORECASE)),
    (
        "jwt_token",
        re.compile(
            r"(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]{4,})?"
        ),
    ),
    (
        "api_credential",
        re.compile(
            r"(?:"
            r"(?<![A-Za-z0-9])rk_[A-Za-z0-9_-]{4,}"
            r"|(?<![A-Za-z0-9])sk_[A-Za-z0-9_-]{4,}"
            r"|(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9_]{4,}"
            r"|(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{4,}"
            r"|(?<![A-Za-z0-9])ph[cs]_[A-Za-z0-9_]{4,}"
            r"|(?<![A-Za-z0-9])(?:syt|syr|mda)_[A-Za-z0-9_=-]{4,}"
            r"|(?<![A-Za-z0-9])SCW[A-Z0-9]{6,}"
            r"|(?<![A-Za-z0-9])A[KS]IA[A-Z0-9]{8,}"
            r"|(?<![A-Za-z0-9])oc1_[0-9a-fA-F_-]{4,}"
            r"|(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{4,}"
            r"|(?<![A-Za-z0-9_-])[\"']?(?:access_token|refresh_token|id_token|session_token|auth_token"
            r"|token|api_key|apikey|x_api_key|x-api-key|secret|client_secret|private_key"
            r"|password|passwd|authorization|bearer|jwt|cookie|set-cookie)[\"']?\s*[:=]\s*[\"']?\S+"
            r")",
            re.IGNORECASE,
        ),
    ),
    ("pem_material", re.compile(r"-----BEGIN\b", re.IGNORECASE)),
    (
        "invite_or_auth_link",
        re.compile(
            r"(?:"
            r"/invitations/"
            r"|/invite/"
            r"|/claim(?:/|\?|\b)"
            r"|/magic(?:/|\?|\b)"
            r"|[?&](?:token|code|access_token|id_token)="
            r"|#(?:token|access_token)="
            r")",
            re.IGNORECASE,
        ),
    ),
    (
        "url_forbidden",
        re.compile(
            r"(?:"
            r"\b(?:https?|wss?|ftps?|file|kodera)://"
            r"|\bmatrix:"
            r"|(?<![A-Za-z0-9+.-]:)//(?:[^\s/?#@]+@)?(?:localhost|\[[0-9a-fA-F:]+\]"
            r"|\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?::\d+)?"
            r"(?=[/?#\s),.:;!\]}>'\"]|\Z)"
            r")",
            re.IGNORECASE,
        ),
    ),
)

# Matrix identifiers (@user:server, !room:server, #alias:server, $event_id) and embedded PII shapes.
_MATRIX_USER_OR_ROOM_RE = re.compile(
    r"(?<![\w.])[!@#][A-Za-z0-9._=/+-]+:[A-Za-z0-9.-]+(?::\d{1,5})?"
)
_MATRIX_EVENT_RE = re.compile(r"(?<![\w.])\$[A-Za-z0-9._~+/-]{4,}(?::[A-Za-z0-9.-]+(?::\d{1,5})?)?")
_EMBEDDED_UUID_RE = re.compile(
    r"(?<![0-9a-fA-F])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9a-fA-F])"
)
_EMBEDDED_IPV4_RE = re.compile(
    r"(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}"
    r"(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])"
)
_EMBEDDED_IPV6_RE = re.compile(
    r"(?<![0-9a-fA-F:])(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}(?![0-9a-fA-F:])"
    r"|(?:[0-9a-fA-F]{0,4}:){1,6}:[0-9a-fA-F]{0,4}"
)
_EMBEDDED_PHONE_RE = re.compile(r"(?<!\d)\+?\d(?:[ .()/-]*\d){6,14}(?!\d)")
_LONG_DIGIT_RUN_RE = re.compile(r"\d{5,}")

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
FORBIDDEN_PNG_CHUNK_NAMES = frozenset({b"text", b"itxt", b"ztxt", b"exif", b"time"})
FORBIDDEN_WEBP_CHUNK_NAMES = frozenset({b"EXIF", b"XMP"})
WEBP_IMAGE_CHUNKS = frozenset({b"VP8 ", b"VP8L", b"ANMF"})


class BugReportCallerUnknownError(Exception):
    """Core holds no enabled identity for the verified token."""


class BugReportNotFoundError(Exception):
    """The target organisation is absent or the caller holds no membership in it."""


class BugReportForbiddenError(Exception):
    """The caller's role is not permitted to submit bug reports."""

    def __init__(
        self, *, identity_id: UUID | None, organisation_id: UUID | None, target_urn: str
    ) -> None:
        super().__init__("bug report refused")
        self.identity_id = identity_id
        self.organisation_id = organisation_id
        self.target_urn = target_urn


class BugReportMalformedError(Exception):
    """Syntactically invalid JSON, wrong media type, missing required fields, or unexpected keys."""

    def __init__(self, errors: list[tuple[str, str]] | None = None) -> None:
        super().__init__("malformed bug report")
        self.errors = errors or []


class BugReportPayloadTooLargeError(Exception):
    """Request body exceeds MAX_REQUEST_BYTES."""


class BugReportValidationError(Exception):
    """Semantic validation failure (422): consent, forbidden secret/URL, or image metadata."""

    def __init__(self, errors: list[tuple[str, str]]) -> None:
        super().__init__("invalid bug report")
        self.errors = errors


class BugReportRateLimitedError(Exception):
    """Rolling 1-hour rate limit exceeded on member, organisation, or global bucket."""

    def __init__(self, retry_after_s: int) -> None:
        super().__init__("bug report rate limited")
        self.retry_after_s = retry_after_s


class BugReportUnavailableError(Exception):
    """Undispatched triage queue is full; nothing stored."""

    def __init__(self, retry_after_s: int = QUEUE_FULL_RETRY_AFTER_S) -> None:
        super().__init__("bug report queue full")
        self.retry_after_s = retry_after_s


@dataclass(frozen=True, slots=True)
class BugReportCaller:
    identity_id: UUID
    membership_id: UUID
    organisation_id: UUID
    organisation_slug: str | None
    tenant_slug: str | None


@dataclass(frozen=True, slots=True)
class VerifiedScreenshot:
    content_type: str
    raw_bytes: bytes
    sha256: str


@dataclass(frozen=True, slots=True)
class BugReportRequest:
    build_id: str
    component: str
    error_code: str
    device_class: str
    consent: bool
    note: str | None
    screenshot: VerifiedScreenshot | None


@dataclass(frozen=True, slots=True)
class BugReportSubmissionResult:
    report: BugReport
    status: str


def _pointer(path: str) -> str:
    return "/" + "/".join(part.replace("~", "~0").replace("/", "~1") for part in path.split("/"))


def _resolve_caller(*, verified: VerifiedAccessToken, organisation_id: UUID) -> BugReportCaller:
    try:
        caller: TenantCaller = read_tenant_caller(
            verified=verified, organisation_id=organisation_id, allow_community=True
        )
    except TenantCallerUnknownError:
        raise BugReportCallerUnknownError() from None
    except TenantCallerNotFoundError:
        raise BugReportNotFoundError() from None

    if caller.role not in TENANT_ROLES:
        raise BugReportForbiddenError(
            identity_id=caller.identity_id,
            organisation_id=caller.organisation_id,
            target_urn=NEW_BUG_REPORT_URN,
        )
    org_slug = organisation_slug(organisation_id=caller.organisation_id)
    tenant = newest_tenant_not_deleted(caller.organisation_id)
    tenant_slug = None if tenant is None else tenant.slug
    return BugReportCaller(
        identity_id=caller.identity_id,
        membership_id=caller.membership_id,
        organisation_id=caller.organisation_id,
        organisation_slug=org_slug,
        tenant_slug=tenant_slug,
    )


def authorise(*, verified: VerifiedAccessToken, organisation_id: UUID) -> BugReportCaller:
    """Authorise the caller in an isolated read-only repeatable-read snapshot."""
    if connection.in_atomic_block or not connection.get_autocommit():
        raise RuntimeError("authorisation requires its own transaction")
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        return _resolve_caller(verified=verified, organisation_id=organisation_id)


def record_tenant_denial(*, refused: BugReportForbiddenError, request_id: str) -> None:
    with transaction.atomic():
        record_authz_denied(
            actor_type="tenant",
            actor_id=refused.identity_id,
            organisation_id=refused.organisation_id,
            target_urn=refused.target_urn,
            request_id=request_id,
            required_scope=SCOPE,
            reason="role_missing",
        )


def record_staff_denial(
    *, verified: VerifiedAccessToken, organisation_id: UUID, request_id: str
) -> None:
    with transaction.atomic():
        staff = current_staff_identity(issuer=verified.issuer, subject=verified.subject)
        record_authz_denied(
            actor_type="staff",
            actor_id=None if staff is None else staff.id,
            organisation_id=organisation_id,
            target_urn=NEW_BUG_REPORT_URN,
            request_id=request_id,
            required_scope=SCOPE,
            reason="role_missing",
        )


def find_forbidden_note_reasons(text: str) -> tuple[str, ...]:
    """Return closed refusal codes for any secret, token, PEM block, invite path, or URL."""
    if not text:
        return ()
    reasons: list[str] = []
    for code, pattern in _FORBIDDEN_NOTE_PATTERNS:
        if pattern.search(text):
            reasons.append(code)
    return tuple(reasons)


_SEMVER_BUILD_CORE_RE = re.compile(
    r"^(?:(?:web|desktop|ios|android|server|cli)-)?v?\d{1,4}\.\d{1,4}\.\d{1,4}"
    r"(?:\+(?:sha\.)?[0-9a-f]{7,12})?"
)


def contains_pii_or_identifier(
    text: str,
    *,
    organisation_slug_value: str | None = None,
    tenant_slug_value: str | None = None,
    allow_semver_digits: bool = False,
) -> bool:
    """Return True if `text` carries any UUID, IP, email, phone, Matrix ID, or caller slug."""
    if not text:
        return False
    if (
        _EMBEDDED_UUID_RE.search(text)
        or _EMBEDDED_IPV4_RE.search(text)
        or _EMBEDDED_IPV6_RE.search(text)
        or _MATRIX_USER_OR_ROOM_RE.search(text)
        or _MATRIX_EVENT_RE.search(text)
    ):
        return True
    probe = _SEMVER_BUILD_CORE_RE.sub("v", text, count=1) if allow_semver_digits else text
    if _EMBEDDED_PHONE_RE.search(probe) or redact_pii(probe) != probe:
        return True
    for slug in (organisation_slug_value, tenant_slug_value):
        if slug and len(slug) >= 2:
            slug_re = re.compile(
                rf"(?<![A-Za-z0-9]){re.escape(slug)}(?![A-Za-z0-9])", re.IGNORECASE
            )
            if slug_re.search(text):
                return True
    return False


def find_forbidden_diagnostic_field_reasons(
    text: str,
    *,
    organisation_slug_value: str | None = None,
    tenant_slug_value: str | None = None,
    allow_semver_digits: bool = False,
    forbid_long_digit_runs: bool = False,
) -> tuple[str, ...]:
    """Return refusal codes for secrets, URLs, or PII/identifiers inside `build_id`/`error_code`."""
    reasons = list(find_forbidden_note_reasons(text))
    if contains_pii_or_identifier(
        text,
        organisation_slug_value=organisation_slug_value,
        tenant_slug_value=tenant_slug_value,
        allow_semver_digits=allow_semver_digits,
    ) or (forbid_long_digit_runs and _LONG_DIGIT_RUN_RE.search(text) is not None):
        reasons.append("pii_or_identifier_forbidden")
    return tuple(reasons)


def is_safe_build_id(
    value: str,
    *,
    organisation_slug_value: str | None = None,
    tenant_slug_value: str | None = None,
) -> bool:
    """Verify strict release/build grammar and absence of credentials, URLs, or PII."""
    return (
        1 <= len(value) <= 64
        and BUILD_ID_RE.fullmatch(value) is not None
        and not find_forbidden_diagnostic_field_reasons(
            value,
            organisation_slug_value=organisation_slug_value,
            tenant_slug_value=tenant_slug_value,
            allow_semver_digits=True,
        )
    )


def is_safe_error_code(
    value: str,
    *,
    organisation_slug_value: str | None = None,
    tenant_slug_value: str | None = None,
) -> bool:
    """Verify strict error-code grammar and absence of credentials, URLs, long digit runs, or PII."""
    return (
        1 <= len(value) <= 80
        and ERROR_CODE_RE.fullmatch(value) is not None
        and _LONG_DIGIT_RUN_RE.search(value) is None
        and not find_forbidden_diagnostic_field_reasons(
            value,
            organisation_slug_value=organisation_slug_value,
            tenant_slug_value=tenant_slug_value,
            forbid_long_digit_runs=True,
        )
    )


def scrub_bug_report_note(
    text: str,
    *,
    organisation_slug_value: str | None = None,
    tenant_slug_value: str | None = None,
) -> str:
    """Scrub Matrix IDs, emails, UUIDs, IPv4/IPv6, phone numbers, and org/tenant slugs."""
    if not text:
        return ""
    sanitized = _MATRIX_USER_OR_ROOM_RE.sub("[REDACTED_MATRIX_ID]", text)
    sanitized = _MATRIX_EVENT_RE.sub("[REDACTED_MATRIX_ID]", sanitized)
    sanitized = redact_pii(sanitized, tenant_slug=tenant_slug_value)
    sanitized = _EMBEDDED_PHONE_RE.sub("[REDACTED_PHONE]", sanitized)
    if organisation_slug_value:
        sanitized = re.sub(
            re.escape(organisation_slug_value),
            "[REDACTED_ORG]",
            sanitized,
            flags=re.IGNORECASE,
        )
    return sanitized


def compute_bug_dedup_fingerprint(
    *,
    build_id: str,
    component: str,
    error_code: str,
    device_class: str,
    sanitized_note: str,
) -> str:
    """Compute `sha256(f"{build_id}:{component}:{error_code}:{device_class}:{normalized_note}")`."""
    normalized_note = " ".join(sanitized_note.lower().split())
    payload = f"{build_id}:{component}:{error_code}:{device_class}:{normalized_note}".encode()
    return hashlib.sha256(payload).hexdigest()


def verify_png_clean(data: bytes) -> str | None:
    """Verify PNG magic bytes, structure, CRCs, and absence of metadata chunks."""
    if len(data) < 33 or not data.startswith(PNG_SIGNATURE):
        return "invalid_magic"
    offset = len(PNG_SIGNATURE)
    saw_ihdr = False
    saw_idat = False
    saw_iend = False
    while offset < len(data):
        if saw_iend or offset + 8 > len(data):
            return "invalid_png_structure"
        (length,) = struct.unpack(">I", data[offset : offset + 4])
        chunk_type = data[offset + 4 : offset + 8]
        offset += 8
        if not all((65 <= b <= 90) or (97 <= b <= 122) for b in chunk_type):
            return "invalid_png_chunk"
        if offset + length + 4 > len(data):
            return "truncated_png_chunk"
        chunk_data = data[offset : offset + length]
        (expected_crc,) = struct.unpack(">I", data[offset + length : offset + length + 4])
        actual_crc = zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF
        if actual_crc != expected_crc:
            return "invalid_png_crc"
        offset += length + 4

        if chunk_type.lower() in FORBIDDEN_PNG_CHUNK_NAMES:
            return "metadata_chunk_forbidden"

        if not saw_ihdr:
            if chunk_type != b"IHDR" or length != 13:
                return "missing_ihdr"
            width, height = struct.unpack(">II", chunk_data[:8])
            if not (1 <= width <= MAX_IMAGE_DIMENSION and 1 <= height <= MAX_IMAGE_DIMENSION):
                return "invalid_dimensions"
            saw_ihdr = True
        elif chunk_type == b"IHDR":
            return "duplicate_ihdr"
        elif chunk_type == b"IDAT":
            if length > 0:
                saw_idat = True
        elif chunk_type == b"IEND":
            if length != 0:
                return "invalid_iend"
            saw_iend = True

    if not (saw_ihdr and saw_idat and saw_iend and offset == len(data)):
        return "incomplete_png"
    return None


def verify_webp_clean(data: bytes) -> str | None:
    """Verify RIFF/WEBP magic bytes, exact container bounds, and absence of EXIF/XMP metadata."""
    if len(data) < 20 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return "invalid_magic"
    (riff_size,) = struct.unpack("<I", data[4:8])
    if riff_size + 8 != len(data):
        return "invalid_webp_container"

    offset = 12
    saw_image_chunk = False
    while offset < len(data):
        if offset + 8 > len(data):
            return "truncated_webp_chunk"
        fourcc = data[offset : offset + 4]
        (chunk_size,) = struct.unpack("<I", data[offset + 4 : offset + 8])
        offset += 8
        if offset + chunk_size > len(data):
            return "truncated_webp_payload"
        payload = data[offset : offset + chunk_size]
        if not all(32 <= b <= 126 for b in fourcc):
            return "invalid_webp_fourcc"

        if fourcc.strip().upper() in FORBIDDEN_WEBP_CHUNK_NAMES:
            return "metadata_chunk_forbidden"

        if fourcc == b"VP8X":
            if chunk_size != 10:
                return "invalid_vp8x"
            # Bit 3 (0x08) = EXIF metadata present, Bit 2 (0x04) = XMP metadata present.
            if (payload[0] & 0x0C) != 0:
                return "metadata_chunk_forbidden"
            width_minus_one = int.from_bytes(payload[4:7], "little")
            height_minus_one = int.from_bytes(payload[7:10], "little")
            if (
                width_minus_one + 1 > MAX_IMAGE_DIMENSION
                or height_minus_one + 1 > MAX_IMAGE_DIMENSION
            ):
                return "invalid_dimensions"
        elif fourcc in WEBP_IMAGE_CHUNKS and chunk_size > 0:
            saw_image_chunk = True

        offset += chunk_size
        if chunk_size % 2 == 1:
            if offset >= len(data) or data[offset] != 0:
                return "invalid_webp_padding"
            offset += 1

    if not saw_image_chunk:
        return "missing_webp_bitstream"
    return None


def _normalize_note(value: str) -> str | None:
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    if any(
        ch not in ALLOWED_NOTE_CONTROLS and unicodedata.category(ch) in REFUSED_UNICODE_CATEGORIES
        for ch in normalized
    ):
        return None
    return normalized


def _validate_screenshot(
    raw_screenshot: Any,
    malformed_errors: list[tuple[str, str]],
    validation_errors: list[tuple[str, str]],
) -> VerifiedScreenshot | None:
    if not isinstance(raw_screenshot, dict):
        malformed_errors.append(("/screenshot", "invalid_type"))
        return None
    unexpected = sorted(set(raw_screenshot) - SCREENSHOT_MEMBERS)
    for key in unexpected:
        malformed_errors.append((_pointer(f"screenshot/{key}"), "unexpected"))
    for req in ("contentType", "blurred", "dataBase64"):
        if req not in raw_screenshot:
            malformed_errors.append((f"/screenshot/{req}", "required"))
    if malformed_errors:
        return None

    content_type = raw_screenshot["contentType"]
    blurred = raw_screenshot["blurred"]
    data_b64 = raw_screenshot["dataBase64"]

    if not isinstance(content_type, str) or content_type not in BUG_SCREENSHOT_CONTENT_TYPES:
        validation_errors.append(("/screenshot/contentType", "invalid_enum"))
    if not isinstance(blurred, bool) or blurred is not True:
        validation_errors.append(("/screenshot/blurred", "blur_required"))
    if not isinstance(data_b64, str):
        validation_errors.append(("/screenshot/dataBase64", "invalid_type"))
        return None
    if len(data_b64) < 16 or len(data_b64) > MAX_BASE64_SCREENSHOT_CHARS:
        validation_errors.append(("/screenshot/dataBase64", "size_out_of_bounds"))
        return None
    if len(data_b64) % 4 != 0 or BASE64_TOKEN_RE.fullmatch(data_b64) is None:
        validation_errors.append(("/screenshot/dataBase64", "invalid_base64"))
        return None
    try:
        decoded = base64.b64decode(data_b64, validate=True)
    except (binascii.Error, ValueError):
        validation_errors.append(("/screenshot/dataBase64", "invalid_base64"))
        return None

    if not (1 <= len(decoded) <= MAX_SCREENSHOT_BYTES):
        validation_errors.append(("/screenshot/dataBase64", "size_out_of_bounds"))
        return None

    if validation_errors:
        return None

    verdict = (
        verify_png_clean(decoded) if content_type == "image/png" else verify_webp_clean(decoded)
    )
    if verdict is not None:
        validation_errors.append(("/screenshot/dataBase64", verdict))
        return None

    return VerifiedScreenshot(
        content_type=content_type,
        raw_bytes=decoded,
        sha256=hashlib.sha256(decoded).hexdigest(),
    )


def parse_bug_report_request(
    raw: bytes,
    content_type: str,
    *,
    organisation_slug_value: str | None = None,
    tenant_slug_value: str | None = None,
) -> BugReportRequest:
    """Parse and validate a closed Zero-PII BugReportCreateRequest."""
    media = content_type.split(";", 1)[0].strip().lower()
    if media != "application/json":
        raise BugReportMalformedError()
    if len(raw) > MAX_REQUEST_BYTES:
        raise BugReportPayloadTooLargeError()
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise BugReportMalformedError() from None
    if not isinstance(body, dict):
        raise BugReportMalformedError()

    malformed: list[tuple[str, str]] = [
        (_pointer(name), "unexpected") for name in sorted(set(body) - TOP_LEVEL_MEMBERS)
    ]
    malformed += [(f"/{name}", "required") for name in REQUIRED_MEMBERS if name not in body]
    if malformed:
        raise BugReportMalformedError(malformed)

    validation: list[tuple[str, str]] = []

    build_id = body["build_id"]
    if not isinstance(build_id, str):
        validation.append(("/build_id", "invalid_pattern"))
    else:
        build_reasons = find_forbidden_diagnostic_field_reasons(
            build_id,
            organisation_slug_value=organisation_slug_value,
            tenant_slug_value=tenant_slug_value,
            allow_semver_digits=BUILD_ID_RE.fullmatch(build_id) is not None,
        )
        for reason in build_reasons:
            validation.append(("/build_id", reason))
        if not (1 <= len(build_id) <= 64) or BUILD_ID_RE.fullmatch(build_id) is None:
            validation.append(("/build_id", "invalid_pattern"))

    component = body["component"]
    if not isinstance(component, str) or component not in BUG_COMPONENTS:
        validation.append(("/component", "invalid_enum"))

    error_code = body["error_code"]
    if not isinstance(error_code, str):
        validation.append(("/error_code", "invalid_pattern"))
    else:
        code_reasons = find_forbidden_diagnostic_field_reasons(
            error_code,
            organisation_slug_value=organisation_slug_value,
            tenant_slug_value=tenant_slug_value,
            forbid_long_digit_runs=True,
        )
        for reason in code_reasons:
            validation.append(("/error_code", reason))
        if not (1 <= len(error_code) <= 80) or ERROR_CODE_RE.fullmatch(error_code) is None:
            validation.append(("/error_code", "invalid_pattern"))

    device_class = body["device_class"]
    if not isinstance(device_class, str) or device_class not in BUG_DEVICE_CLASSES:
        validation.append(("/device_class", "invalid_enum"))

    consent = body["consent"]
    if not isinstance(consent, bool):
        validation.append(("/consent", "invalid_type"))

    raw_note = body.get("note")
    note: str | None = None
    if raw_note is not None:
        if not isinstance(raw_note, str):
            validation.append(("/note", "invalid_type"))
        else:
            cleaned_note = _normalize_note(raw_note)
            if cleaned_note is None or not (NOTE_LENGTH[0] <= len(cleaned_note) <= NOTE_LENGTH[1]):
                validation.append(("/note", "invalid_length_or_control"))
            else:
                refusal_codes = find_forbidden_note_reasons(cleaned_note)
                if refusal_codes:
                    for code in refusal_codes:
                        validation.append(("/note", code))
                else:
                    note = cleaned_note

    raw_screenshot = body.get("screenshot")
    screenshot: VerifiedScreenshot | None = None
    if raw_screenshot is not None:
        screenshot = _validate_screenshot(raw_screenshot, malformed, validation)
        if malformed:
            raise BugReportMalformedError(malformed)

    if (
        isinstance(consent, bool)
        and not consent
        and (raw_note is not None or raw_screenshot is not None)
    ):
        validation.append(("/consent", "consent_required"))

    if validation:
        raise BugReportValidationError(validation)

    assert isinstance(build_id, str)  # noqa: S101
    assert isinstance(component, str)  # noqa: S101
    assert isinstance(error_code, str)  # noqa: S101
    assert isinstance(device_class, str)  # noqa: S101
    assert isinstance(consent, bool)  # noqa: S101

    return BugReportRequest(
        build_id=build_id,
        component=component,
        error_code=error_code,
        device_class=device_class,
        consent=consent,
        note=note,
        screenshot=screenshot,
    )


def rate_bucket_digest(tier: str, identifier: str) -> str:
    """Compute an irreversible keyed-HMAC digest for a rate-limit bucket."""
    secret = settings.SECRET_KEY.encode("utf-8")
    message = f"kodera:bug_report_rate:v1:{tier}:{identifier}".encode()
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def _retry_after(timestamps: list[datetime], limit: int, now: datetime) -> int | None:
    if len(timestamps) < limit:
        return None
    expires_at = timestamps[len(timestamps) - limit] + RATE_WINDOW
    return max(1, math.ceil((expires_at - now).total_seconds()))


def _recent_bucket_timestamps(tier: str, bucket_digest: str, since: datetime) -> list[datetime]:
    return list(
        BugReportRateEvent.objects.filter(
            tier=tier, bucket_digest=bucket_digest, created_at__gt=since
        )
        .order_by("created_at")
        .values_list("created_at", flat=True)
    )


def _insert_collector_bug_report(
    *,
    now: datetime,
    request: BugReportRequest,
    sanitized_note: str,
    fingerprint: str,
) -> BugReport:
    """Insert strictly the collector-owned columns of `support_bugreport`.

    Worker-owned claim and dispatch columns populate exclusively from SQL DEFAULTs so `kodera_api`
    holds zero INSERT or UPDATE privilege on worker state.
    """
    report_id = new_uuid7()
    screenshot_type = None if request.screenshot is None else request.screenshot.content_type
    screenshot_raw = None if request.screenshot is None else request.screenshot.raw_bytes
    screenshot_hash = None if request.screenshot is None else request.screenshot.sha256
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO support_bugreport (
                id, created_at, updated_at, build_id, component, error_code,
                device_class, consent, sanitized_note, screenshot_content_type,
                screenshot_bytes, screenshot_sha256, dedup_fingerprint, occurrences
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            [
                report_id,
                now,
                now,
                request.build_id,
                request.component,
                request.error_code,
                request.device_class,
                request.consent,
                sanitized_note,
                screenshot_type,
                screenshot_raw,
                screenshot_hash,
                fingerprint,
                1,
            ],
        )
    return BugReport.objects.get(pk=report_id)


def open_bug_report(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    request: BugReportRequest,
) -> BugReportSubmissionResult:
    """Persist or coalesce a zero-PII bug report inside `respond_once`'s transaction."""
    if not connection.in_atomic_block:
        raise RuntimeError("a bug report is opened in the replay store's transaction")

    caller = _resolve_caller(verified=verified, organisation_id=organisation_id)

    field_errors: list[tuple[str, str]] = []
    for reason in find_forbidden_diagnostic_field_reasons(
        request.build_id,
        organisation_slug_value=caller.organisation_slug,
        tenant_slug_value=caller.tenant_slug,
        allow_semver_digits=BUILD_ID_RE.fullmatch(request.build_id) is not None,
    ):
        field_errors.append(("/build_id", reason))
    if (
        not is_safe_build_id(
            request.build_id,
            organisation_slug_value=caller.organisation_slug,
            tenant_slug_value=caller.tenant_slug,
        )
        and ("/build_id", "invalid_pattern") not in field_errors
        and not field_errors
    ):
        field_errors.append(("/build_id", "invalid_pattern"))

    for reason in find_forbidden_diagnostic_field_reasons(
        request.error_code,
        organisation_slug_value=caller.organisation_slug,
        tenant_slug_value=caller.tenant_slug,
        forbid_long_digit_runs=True,
    ):
        field_errors.append(("/error_code", reason))
    if not is_safe_error_code(
        request.error_code,
        organisation_slug_value=caller.organisation_slug,
        tenant_slug_value=caller.tenant_slug,
    ) and not any(ptr == "/error_code" for ptr, _ in field_errors):
        field_errors.append(("/error_code", "invalid_pattern"))
    if field_errors:
        raise BugReportValidationError(field_errors)

    sanitized_note = (
        ""
        if request.note is None
        else scrub_bug_report_note(
            request.note,
            organisation_slug_value=caller.organisation_slug,
            tenant_slug_value=caller.tenant_slug,
        )
    )
    fingerprint = compute_bug_dedup_fingerprint(
        build_id=request.build_id,
        component=request.component,
        error_code=request.error_code,
        device_class=request.device_class,
        sanitized_note=sanitized_note,
    )

    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended('support_bug_reports:v1', 0))"
        )

    now = timezone.now()
    since = now - RATE_WINDOW
    BugReportRateEvent.objects.filter(created_at__lte=now - RATE_EVENT_RETENTION).delete()

    member_digest = rate_bucket_digest("member", str(caller.membership_id))
    org_digest = rate_bucket_digest("org", str(caller.organisation_id))
    global_digest = rate_bucket_digest("global", "all")

    waits = [
        _retry_after(
            _recent_bucket_timestamps("member", member_digest, since), PER_MEMBER_LIMIT, now
        ),
        _retry_after(_recent_bucket_timestamps("org", org_digest, since), PER_ORG_LIMIT, now),
        _retry_after(_recent_bucket_timestamps("global", global_digest, since), GLOBAL_LIMIT, now),
    ]
    active_waits = [wait for wait in waits if wait is not None]
    if active_waits:
        raise BugReportRateLimitedError(max(active_waits))

    undispatched_depth = BugReport.objects.filter(dispatched_at__isnull=True).count()
    if undispatched_depth >= MAX_UNDISPATCHED_QUEUE_DEPTH:
        raise BugReportUnavailableError(QUEUE_FULL_RETRY_AFTER_S)

    BugReportRateEvent.objects.bulk_create(
        [
            BugReportRateEvent(tier="member", bucket_digest=member_digest),
            BugReportRateEvent(tier="org", bucket_digest=org_digest),
            BugReportRateEvent(tier="global", bucket_digest=global_digest),
        ]
    )

    existing = (
        BugReport.objects.filter(
            dedup_fingerprint=fingerprint,
            created_at__gte=now - DEDUP_WINDOW,
        )
        .order_by("-created_at")
        .first()
    )
    if existing is not None:
        BugReport.objects.filter(pk=existing.pk).update(
            occurrences=F("occurrences") + 1,
            updated_at=now,
        )
        existing.refresh_from_db()
        return BugReportSubmissionResult(report=existing, status="deduplicated")

    created = _insert_collector_bug_report(
        now=now,
        request=request,
        sanitized_note=sanitized_note,
        fingerprint=fingerprint,
    )
    return BugReportSubmissionResult(report=created, status="queued")


def _stamp(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def representation(result: BugReportSubmissionResult) -> dict[str, Any]:
    """Zero-PII receipt returned to the submitting client."""
    report = result.report
    return {
        "id": str(report.id),
        "status": result.status,
        "dedup_fingerprint": report.dedup_fingerprint,
        "occurrences": report.occurrences,
        "created_at": _stamp(report.created_at),
    }
