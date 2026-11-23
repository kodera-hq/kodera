"""Per-tenant HKDF-SHA256 subkey derivation and AEAD sealing for BYOM AI configurations."""

from __future__ import annotations

import ipaddress
import json
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from apps.media.outbound import BlockedTargetError, public_address, target
from core.sealing import KEY_BYTES, SealError, seal, unseal

HKDF_INFO = b"kodera-ai-byom-v1"
AAD_PREFIX = b"ai-byom:"


class ByomConfigError(ValueError):
    """A BYOM configuration payload is malformed or violates security bounds."""


@dataclass(frozen=True)
class ByomSecretConfig:
    endpoint: str
    model: str
    api_key: str = field(repr=False)
    region: str = "eu"

    def __post_init__(self) -> None:
        if (
            not isinstance(self.endpoint, str)
            or not isinstance(self.model, str)
            or not 1 <= len(self.model) <= 128
            or any(ord(ch) <= 32 or ord(ch) == 127 for ch in self.model)
            or not isinstance(self.api_key, str)
            or not 1 <= len(self.api_key) <= 512
            or any(ord(ch) < 32 or ord(ch) == 127 for ch in self.api_key)
            or self.region not in {"eu", "non_eu"}
        ):
            raise ByomConfigError("invalid BYOM secret configuration")
        try:
            destination = target(self.endpoint, https_only=True)
            try:
                ipaddress.ip_address(destination.host)
            except ValueError:
                pass
            else:
                public_address(destination.host)
        except BlockedTargetError as exc:
            raise ByomConfigError("BYOM endpoint must be a valid public HTTPS URL") from exc
        object.__setattr__(self, "endpoint", destination.url)


def derive_byom_subkey(master_key: bytes, *, organisation_id: UUID) -> bytes:
    if not isinstance(master_key, bytes) or len(master_key) != KEY_BYTES:
        raise SealError("master AI seal key must be 32 bytes")
    if not isinstance(organisation_id, UUID):
        raise SealError("organisation_id must be a UUID")
    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=KEY_BYTES,
        salt=organisation_id.bytes,
        info=HKDF_INFO,
    )
    return hkdf.derive(master_key)


def byom_aad(*, organisation_id: UUID, workspace_id: UUID) -> bytes:
    if not isinstance(organisation_id, UUID) or not isinstance(workspace_id, UUID):
        raise SealError("organisation_id and workspace_id must be UUIDs")
    return AAD_PREFIX + organisation_id.bytes + b":" + workspace_id.bytes


def seal_byom_config(
    master_key: bytes,
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    config: ByomSecretConfig,
) -> bytes:
    subkey = derive_byom_subkey(master_key, organisation_id=organisation_id)
    aad = byom_aad(organisation_id=organisation_id, workspace_id=workspace_id)
    payload = json.dumps(
        {
            "endpoint": config.endpoint,
            "model": config.model,
            "api_key": config.api_key,
            "region": config.region,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return seal(subkey, aad, payload)


def _unique_json_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    obj: dict[str, Any] = {}
    for key, value in pairs:
        if key in obj:
            raise SealError("duplicate key in sealed BYOM config")
        obj[key] = value
    return obj


def unseal_byom_config(
    master_key: bytes,
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    sealed_value: bytes,
) -> ByomSecretConfig:
    if not sealed_value:
        raise SealError("sealed BYOM config is empty")
    subkey = derive_byom_subkey(master_key, organisation_id=organisation_id)
    aad = byom_aad(organisation_id=organisation_id, workspace_id=workspace_id)
    plaintext = unseal(subkey, aad, bytes(sealed_value))
    try:
        decoded = json.loads(plaintext.decode("utf-8"), object_pairs_hook=_unique_json_pairs)
    except (UnicodeDecodeError, ValueError) as exc:
        raise SealError("sealed BYOM config JSON is malformed") from exc
    if not isinstance(decoded, dict) or set(decoded) != {"endpoint", "model", "api_key", "region"}:
        raise SealError("sealed BYOM config fields are invalid")
    try:
        return ByomSecretConfig(
            endpoint=decoded["endpoint"],
            model=decoded["model"],
            api_key=decoded["api_key"],
            region=decoded["region"],
        )
    except ByomConfigError as exc:
        raise SealError("sealed BYOM config failed validation") from exc
