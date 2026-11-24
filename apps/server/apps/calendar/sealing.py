"""Per-tenant HKDF-SHA256 subkey derivation and AEAD sealing for CalDAV credentials."""

from __future__ import annotations

import ipaddress
import json
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import unquote, urlsplit, urlunsplit
from uuid import UUID

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from apps.media.outbound import BlockedTargetError, public_address, target
from core.sealing import KEY_BYTES, SealError, seal, unseal

HKDF_INFO = b"kodera-caldav-v1"
AAD_PREFIX = b"caldav-source:"
ALLOWED_CALDAV_PROVIDERS = frozenset({"lasuite", "open_xchange", "nextcloud", "generic"})


class CalDavCredentialError(ValueError):
    """CalDAV source endpoint or credential payload violates security bounds."""


def canonicalize_calendar_collection_url(raw_url: str) -> str:
    """Validate and canonicalize a CalDAV collection URL with a trailing slash and no query/fragment."""
    if not isinstance(raw_url, str) or not raw_url.strip():
        raise CalDavCredentialError("CalDAV calendar URL must be a public HTTPS URL")
    cleaned = raw_url.strip()
    lower = cleaned.lower()
    if "%2f" in lower or "%5c" in lower or "%00" in lower or "\\" in cleaned:
        raise CalDavCredentialError("CalDAV calendar URL contains forbidden path encoding")
    raw_parts = urlsplit(cleaned)
    if raw_parts.query or raw_parts.fragment:
        raise CalDavCredentialError("CalDAV calendar URL cannot include query or fragment")
    for seg in (raw_parts.path or "/").split("/"):
        if (
            seg in {".", ".."}
            or unquote(seg) in {".", ".."}
            or "/" in unquote(seg)
            or "\\" in unquote(seg)
        ):
            raise CalDavCredentialError("CalDAV calendar URL contains dot-segment traversal")
    normalized_path = (raw_parts.path or "/").rstrip("/") + "/"
    rebuilt = urlunsplit((raw_parts.scheme, raw_parts.netloc, normalized_path, "", ""))
    try:
        destination = target(rebuilt, https_only=True)
        try:
            ipaddress.ip_address(destination.host)
        except ValueError:
            pass
        else:
            public_address(destination.host)
    except BlockedTargetError as exc:
        raise CalDavCredentialError("CalDAV calendar URL must be a public HTTPS URL") from exc
    return destination.url


@dataclass(frozen=True)
class CalDavSecretConfig:
    calendar_url: str
    username: str
    password: str = field(repr=False)
    provider: str = "lasuite"

    def __post_init__(self) -> None:
        if (
            not isinstance(self.calendar_url, str)
            or not isinstance(self.username, str)
            or not 1 <= len(self.username) <= 255
            or ":" in self.username
            or any(ord(ch) < 32 or ord(ch) == 127 for ch in self.username)
            or not isinstance(self.password, str)
            or not 1 <= len(self.password) <= 512
            or any(ord(ch) < 32 or ord(ch) == 127 for ch in self.password)
            or self.provider not in ALLOWED_CALDAV_PROVIDERS
        ):
            raise CalDavCredentialError("invalid CalDAV credentials or provider")
        canonical = canonicalize_calendar_collection_url(self.calendar_url)
        object.__setattr__(self, "calendar_url", canonical)


def derive_caldav_subkey(master_key: bytes, *, organisation_id: UUID) -> bytes:
    if not isinstance(master_key, bytes) or len(master_key) != KEY_BYTES:
        raise SealError("master calendar seal key must be 32 bytes")
    if not isinstance(organisation_id, UUID):
        raise SealError("organisation_id must be a UUID")
    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=KEY_BYTES,
        salt=organisation_id.bytes,
        info=HKDF_INFO,
    )
    return hkdf.derive(master_key)


def caldav_aad(*, organisation_id: UUID, workspace_id: UUID, source_id: UUID) -> bytes:
    if (
        not isinstance(organisation_id, UUID)
        or not isinstance(workspace_id, UUID)
        or not isinstance(source_id, UUID)
    ):
        raise SealError("organisation_id, workspace_id, and source_id must be UUIDs")
    return AAD_PREFIX + organisation_id.bytes + b":" + workspace_id.bytes + b":" + source_id.bytes


def seal_caldav_credentials(
    master_key: bytes,
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    source_id: UUID,
    config: CalDavSecretConfig,
) -> bytes:
    subkey = derive_caldav_subkey(master_key, organisation_id=organisation_id)
    aad = caldav_aad(
        organisation_id=organisation_id,
        workspace_id=workspace_id,
        source_id=source_id,
    )
    payload = json.dumps(
        {
            "calendar_url": config.calendar_url,
            "username": config.username,
            "password": config.password,
            "provider": config.provider,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return seal(subkey, aad, payload)


def _unique_json_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    obj: dict[str, Any] = {}
    for key, value in pairs:
        if key in obj:
            raise SealError("duplicate key in sealed CalDAV credentials")
        obj[key] = value
    return obj


def unseal_caldav_credentials(
    master_key: bytes,
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    source_id: UUID,
    sealed_value: bytes,
) -> CalDavSecretConfig:
    if not sealed_value:
        raise SealError("sealed CalDAV credentials are empty")
    subkey = derive_caldav_subkey(master_key, organisation_id=organisation_id)
    aad = caldav_aad(
        organisation_id=organisation_id,
        workspace_id=workspace_id,
        source_id=source_id,
    )
    plaintext = unseal(subkey, aad, bytes(sealed_value))
    try:
        decoded = json.loads(plaintext.decode("utf-8"), object_pairs_hook=_unique_json_pairs)
    except (UnicodeDecodeError, ValueError) as exc:
        raise SealError("sealed CalDAV JSON is malformed") from exc
    if not isinstance(decoded, dict) or set(decoded) != {
        "calendar_url",
        "username",
        "password",
        "provider",
    }:
        raise SealError("sealed CalDAV credential fields are invalid")
    try:
        return CalDavSecretConfig(
            calendar_url=decoded["calendar_url"],
            username=decoded["username"],
            password=decoded["password"],
            provider=decoded["provider"],
        )
    except CalDavCredentialError as exc:
        raise SealError("sealed CalDAV credentials failed validation") from exc
