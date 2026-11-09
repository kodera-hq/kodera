"""Explicit required fields and timestamp-sensitive resource ETag."""

import hashlib
import json
from datetime import UTC, datetime

from apps.orgs.detail_selectors import OrganisationDetail


def _timestamp(value: datetime, *, timespec: str = "auto") -> str:
    return value.astimezone(UTC).isoformat(timespec=timespec).replace("+00:00", "Z")


def _canonical(value: dict[str, str]) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )


def serialize_organisation(detail: OrganisationDetail) -> tuple[bytes, str]:
    fields = {
        "id": str(detail.id),
        "slug": detail.slug,
        "name": detail.name,
        "state": detail.state,
        "created_at": _timestamp(detail.created_at, timespec="milliseconds"),
    }
    authoritative = {**fields, "updated_at": _timestamp(detail.updated_at)}
    etag = '"' + hashlib.sha256(_canonical(authoritative)).hexdigest() + '"'
    return _canonical(fields), etag
