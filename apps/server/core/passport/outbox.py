"""Transactional sealed-outbox writer for Kodera Passport magic-link delivery.

Lives in `core.passport` so the production API image can seal and enqueue `passport_magic_link`
deliveries into `outbox_outboxdelivery` + `outbox_message` without importing `apps.outbox`
(whose API image surface is restricted to `realm_enqueue.py`).

Wire compatibility with `apps.outbox.mail.seal` and `apps.outbox.sender`:
- AES-256-GCM via `core.sealing.seal(key, b"kodera-outbox-message:" + delivery_id.bytes, plaintext)`
  where `plaintext` is compact sorted JSON `{"recipient": ..., "secret": ...}`.
- `outbox_outboxdelivery`: `category='message'`, `changes_realm=false`, `status='pending'`.
- `outbox_message`: `template_id='passport_magic_link'`, `link` without fragment on an allowed
  Console origin; the outbox worker later renders `${link}` as `<link>#<secret>` and wipes `sealed`.
"""

from __future__ import annotations

import json
import string
import unicodedata
from datetime import datetime
from urllib.parse import urlsplit
from uuid import UUID
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import connection

from core.db.ids import new_uuid7
from core.links import origin_of
from core.sealing import KEY_BYTES, seal

OUTBOX_MESSAGE_DOMAIN = b"kodera-outbox-message:"
PASSPORT_TEMPLATE_ID = "passport_magic_link"
DEFAULT_PASSPORT_PATH = "/login/passport"
MAX_LINK_LENGTH = 2048
MAX_PARAM_LENGTH = 200

_PARIS = ZoneInfo("Europe/Paris")
_NBSP = "\u00a0"
_MONTHS: dict[str, tuple[str, ...]] = {
    "fr": (
        "janvier",
        "février",
        "mars",
        "avril",
        "mai",
        "juin",
        "juillet",
        "août",
        "septembre",
        "octobre",
        "novembre",
        "décembre",
    ),
    "en": (
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ),
}
_ATEXT = frozenset(string.ascii_letters + string.digits + "_%+-")
_ALNUM = frozenset(string.ascii_letters + string.digits)
_LABEL = _ALNUM | {"-"}


class PassportDeliveryUnavailableError(RuntimeError):
    """Magic-link delivery has neither an explicit sink nor a valid sealed-outbox configuration."""


def _is_plain_text(value: str) -> bool:
    return not any(unicodedata.category(ch).startswith("C") for ch in value)


def is_outbox_recipient(value: str) -> bool:
    """Linear-pass check matching `apps.outbox.sender.RECIPIENT` without regex backtracking."""
    if len(value) > 254 or value.count("@") != 1:
        return False
    local, _, domain = value.partition("@")
    if not 0 < len(local) <= 64:
        return False
    for atom in local.split("."):
        if not atom or not set(atom) <= _ATEXT:
            return False
    labels = domain.split(".")
    if len(labels) < 2:
        return False
    for label in labels:
        if not 0 < len(label) <= 63 or label[0] not in _ALNUM or label[-1] not in _ALNUM:
            return False
        if not set(label[1:-1]) <= _LABEL:
            return False
    return True


def format_paris_instant(when: datetime, locale: str = "fr") -> str:
    """Format an aware timestamp in Paris local time matching `apps.outbox.mail.dates.mail_instant`."""
    if when.tzinfo is None or when.utcoffset() is None:
        raise ValueError("passport expiry timestamp must be timezone-aware")
    lang = locale if locale in _MONTHS else "fr"
    local = when.astimezone(_PARIS)
    month = _MONTHS[lang][local.month - 1]
    if lang == "fr":
        day = "1er" if local.day == 1 else str(local.day)
        return f"{day} {month} {local.year} à {local.hour}{_NBSP}h{_NBSP}{local.minute:02d}"
    return f"{local.day} {month} {local.year} at {local.hour:02d}:{local.minute:02d} (Paris time)"


def _clean_organisation_name(raw_name: str) -> str:
    cleaned = "".join(ch for ch in raw_name if not unicodedata.category(ch).startswith("C")).strip()
    if not cleaned:
        return "Kodera"
    return cleaned[:MAX_PARAM_LENGTH]


def _allowed_link_origins() -> frozenset[str]:
    mail_origins = getattr(settings, "KODERA_MAIL_LINK_ORIGINS", None)
    if isinstance(mail_origins, (set, frozenset)) and mail_origins:
        return frozenset(str(item) for item in mail_origins if isinstance(item, str) and item)
    return_origins = getattr(settings, "KODERA_PAYMENT_RETURN_ORIGINS", None)
    if isinstance(return_origins, (set, frozenset)) and return_origins:
        return frozenset(str(item) for item in return_origins if isinstance(item, str) and item)
    return frozenset()


def _validate_magic_link_url(candidate: str, allowed_origins: frozenset[str]) -> str:
    if (
        not 1 <= len(candidate) <= MAX_LINK_LENGTH
        or not _is_plain_text(candidate)
        or any(ch.isspace() for ch in candidate)
        or "#" in candidate
    ):
        raise PassportDeliveryUnavailableError("passport magic-link URL is malformed")
    origin = origin_of(candidate)
    parsed = urlsplit(candidate)
    if origin is None or origin not in allowed_origins or parsed.query or parsed.fragment:
        raise PassportDeliveryUnavailableError(
            "passport magic-link URL is not on an allowed origin"
        )
    return candidate


def resolve_passport_outbox_config() -> tuple[bytes, str]:
    """Return `(seal_key, magic_link_url)` or raise `PassportDeliveryUnavailableError`."""
    seal_key = getattr(settings, "KODERA_OUTBOX_SEAL_KEY", None)
    if not isinstance(seal_key, bytes) or len(seal_key) != KEY_BYTES:
        raise PassportDeliveryUnavailableError("KODERA_OUTBOX_SEAL_KEY is not configured")

    allowed_origins = _allowed_link_origins()
    if not allowed_origins:
        raise PassportDeliveryUnavailableError("no allowed console link origin is configured")

    configured_url = getattr(settings, "KODERA_PASSPORT_MAGIC_LINK", None)
    if isinstance(configured_url, str) and configured_url.strip():
        return seal_key, _validate_magic_link_url(configured_url.strip(), allowed_origins)

    if len(allowed_origins) == 1:
        origin = next(iter(allowed_origins)).rstrip("/")
        return seal_key, _validate_magic_link_url(
            f"{origin}{DEFAULT_PASSPORT_PATH}", allowed_origins
        )

    raise PassportDeliveryUnavailableError(
        "KODERA_PASSPORT_MAGIC_LINK is required when multiple console origins are configured"
    )


def enqueue_passport_magic_link(
    *,
    seal_key: bytes,
    link: str,
    organisation_id: UUID,
    organisation_name: str,
    recipient: str,
    raw_token: str,
    expires_at: datetime,
    locale: str = "fr",
    delivery_id: UUID | None = None,
) -> UUID | None:
    """Seal `(recipient, raw_token)` and insert pending outbox message rows in caller's transaction."""
    if not connection.in_atomic_block:
        raise RuntimeError("enqueue_passport_magic_link must run inside transaction.atomic()")
    if len(seal_key) != KEY_BYTES:
        raise ValueError("seal_key must be 32 bytes")
    if not is_outbox_recipient(recipient):
        return None

    lang = locale if locale in _MONTHS else "fr"
    actual_delivery_id = delivery_id if delivery_id is not None else new_uuid7()
    plaintext = json.dumps(
        {"recipient": recipient, "secret": raw_token},
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    sealed_payload = seal(seal_key, OUTBOX_MESSAGE_DOMAIN + actual_delivery_id.bytes, plaintext)
    params = {
        "organisation_name": _clean_organisation_name(organisation_name),
        "expires_at": format_paris_instant(expires_at, lang),
    }

    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO outbox_outboxdelivery "
            "(id, organisation_id, category, changes_realm, status, created_at, updated_at) "
            "VALUES (%s, %s, 'message', false, 'pending', clock_timestamp(), clock_timestamp())",
            [actual_delivery_id, organisation_id],
        )
        cursor.execute(
            "INSERT INTO outbox_message "
            "(delivery_id, template_id, locale, params, link, sealed, expires_at) "
            "VALUES (%s, %s, %s, %s::jsonb, %s, %s, %s)",
            [
                actual_delivery_id,
                PASSPORT_TEMPLATE_ID,
                lang,
                json.dumps(params),
                link,
                sealed_payload,
                expires_at,
            ],
        )
    return actual_delivery_id
