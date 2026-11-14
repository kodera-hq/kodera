"""Durable frozen-source adapter; capture and disclosure policy remain explicit per source."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from .privacy_archives import (
    MAX_ARCHIVE_BYTES,
    MAX_ENTRIES,
    MAX_ENTRY_BYTES,
    MAX_PAGE_ENTRIES,
    NAME,
    OPAQUE,
    SECTIONS,
    ArchiveRefusalError,
    Entry,
    Page,
    Request,
    canonical,
    digest,
    require,
)
from .privacy_storage import MissingPrivateObjectError, PrivateVolume

RESOURCE = re.compile(r"[a-z][a-z_]{0,40}:[0-9a-f-]{36}\Z")
MAX_MANIFEST_BYTES = 8 * 1024 * 1024


@dataclass(frozen=True)
class CapturedEntry:
    resource: str
    entry: Entry


class ExportSigner:
    """Worker instance only, constructed from a per-job secret provider's explicit key bytes."""

    def __init__(self, key_id: str, private_bytes: bytes) -> None:
        require(bool(OPAQUE.fullmatch(key_id)), "export signing identity unavailable")
        require(type(private_bytes) is bytes and len(private_bytes) == 32, "export signing key")
        self.key_id = key_id
        self._key = Ed25519PrivateKey.from_private_bytes(private_bytes)
        self.public_key = self._key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)

    def sign(self, content: bytes) -> bytes:
        return self._key.sign(content)

    def __repr__(self) -> str:
        return "ExportSigner([redacted])"


class FrozenSource:
    """Persist captured entries before committing a snapshot manifest, then reuse it on restart.

    Capture must exhaust its complete scope before returning, or raise. Current disclosure
    policy checks every captured resource on every resume, independent of membership checks.
    No missing source is converted to an empty capture.
    """

    def __init__(
        self,
        section: str,
        storage: PrivateVolume,
        capture: Callable[[Request], tuple[CapturedEntry, ...]],
        permitted: Callable[[Request, str], bool],
    ) -> None:
        require(section in SECTIONS, "export source section")
        self.section, self.storage, self.capture, self.permitted = (
            section,
            storage,
            capture,
            permitted,
        )

    def _prefix(self, request: Request) -> str:
        request.validate()
        return f"privacy/{request.id}/sources/{self.section}"

    def _manifest(self, request: Request, snapshot: str | None = None) -> tuple[bytes, dict]:
        raw = self.storage.read(self._prefix(request) + "/manifest.json", MAX_MANIFEST_BYTES)
        try:
            value = json.loads(raw)
            require(
                isinstance(value, dict)
                and set(value) == {"binding", "section", "entries"}
                and value["binding"] == request.binding
                and value["section"] == self.section
                and type(value["entries"]) is list
                and len(value["entries"]) <= MAX_ENTRIES
                and canonical(value) == raw,
                "frozen source manifest binding",
            )
            total, names = 0, set()
            for record in value["entries"]:
                require(
                    isinstance(record, dict)
                    and set(record) == {"resource", "name", "size", "sha256"}
                    and isinstance(record["resource"], str)
                    and RESOURCE.fullmatch(record["resource"]) is not None
                    and isinstance(record["name"], str)
                    and NAME.fullmatch(record["name"]) is not None
                    and record["name"].startswith(self.section + "/")
                    and all(part not in {".", ".."} for part in record["name"].split("/"))
                    and record["name"].casefold() not in names
                    and type(record["size"]) is int
                    and 0 <= record["size"] <= MAX_ENTRY_BYTES
                    and isinstance(record["sha256"], str)
                    and re.fullmatch(r"[0-9a-f]{64}", record["sha256"]) is not None,
                    "frozen source entry binding",
                )
                total += record["size"]
                names.add(record["name"].casefold())
            require(total <= MAX_ARCHIVE_BYTES, "frozen source bound")
        except (ValueError, TypeError, KeyError, AttributeError):
            raise ArchiveRefusalError("frozen source manifest binding") from None
        require(snapshot is None or digest(raw) == snapshot, "frozen source snapshot binding")
        return raw, value

    def snapshot(self, request: Request) -> str:
        try:
            return digest(self._manifest(request)[0])
        except MissingPrivateObjectError:
            pass
        entries = self.capture(request)
        require(type(entries) is tuple and len(entries) <= MAX_ENTRIES, "frozen source bound")
        records = []
        total, names = 0, set()
        for captured in entries:
            item = captured.entry
            require(
                isinstance(captured.resource, str)
                and RESOURCE.fullmatch(captured.resource) is not None
                and isinstance(item.name, str)
                and NAME.fullmatch(item.name) is not None
                and item.name.startswith(self.section + "/")
                and all(part not in {".", ".."} for part in item.name.split("/"))
                and item.name.casefold() not in names
                and type(item.content) is bytes
                and len(item.content) <= MAX_ENTRY_BYTES,
                "frozen source entry binding",
            )
            require(
                self.permitted(request, captured.resource) is True,
                "export resource authority revoked",
                403,
            )
            total += len(item.content)
            require(total <= MAX_ARCHIVE_BYTES, "frozen source bound")
            names.add(item.name.casefold())
            records.append(
                {
                    "resource": captured.resource,
                    "name": item.name,
                    "size": len(item.content),
                    "sha256": digest(item.content),
                }
            )
            self.storage.put_immutable(
                self._prefix(request) + f"/{digest(item.content)}.bin",
                item.content,
                request.expires_at,
            )
        raw = canonical({"binding": request.binding, "section": self.section, "entries": records})
        require(len(raw) <= MAX_MANIFEST_BYTES, "frozen source manifest bound")
        try:
            self.storage.put_immutable(
                self._prefix(request) + "/manifest.json", raw, request.expires_at
            )
        except ArchiveRefusalError as failure:
            if failure.reason != "private immutable replacement":
                raise
            # Another capture committed first. Reuse its bound immutable manifest; never
            # overwrite it with a later Core view. Unselected content bodies expire normally.
            return digest(self._manifest(request)[0])
        return digest(self._manifest(request)[0])

    def authorize(self, request: Request, snapshot: str) -> bool:
        _, value = self._manifest(request, snapshot)
        return all(self.permitted(request, item["resource"]) is True for item in value["entries"])

    def page(self, request: Request, snapshot: str, cursor: str | None) -> Page:
        _, manifest = self._manifest(request, snapshot)
        require(self.authorize(request, snapshot), "export resource authority revoked", 403)
        require(
            cursor is None
            or isinstance(cursor, str)
            and re.fullmatch(r"[1-9][0-9]{0,4}", cursor) is not None,
            "frozen source cursor",
        )
        offset = int(cursor) if cursor else 0
        records = manifest["entries"]
        require(
            offset % MAX_PAGE_ENTRIES == 0 and (offset == 0 or offset < len(records)),
            "frozen source cursor",
        )
        entries = []
        for index in range(offset, min(offset + MAX_PAGE_ENTRIES, len(records))):
            record = records[index]
            raw = self.storage.read(
                self._prefix(request) + f"/{record['sha256']}.bin", record["size"] + 1
            )
            require(
                len(raw) == record["size"] and digest(raw) == record["sha256"],
                "frozen source entry integrity",
            )
            entries.append(Entry(record["name"], raw))
        following = offset + len(entries)
        return Page(
            request.binding,
            snapshot,
            tuple(entries),
            str(following) if following < len(records) else None,
        )
