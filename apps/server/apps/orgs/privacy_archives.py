"""Bounded, resumable private archives; missing completeness or authority ports refuse.

Providers must freeze complete scope-specific snapshots and recheck every included resource's
current disclosure permission. No default provider, storage, signing key or authority is inferred.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import zipfile
from dataclasses import asdict, dataclass, replace
from typing import Any, Protocol
from uuid import UUID

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

MAX_PAGE_ENTRIES = 100
MAX_ENTRIES = 10000
MAX_ENTRY_BYTES = 2 * 1024 * 1024
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
SECTIONS = ("identity", "memberships", "documents", "collections", "messages", "media", "billing")
NAME = re.compile(r"[a-z0-9][a-z0-9_/-]{0,180}\.(?:json|md|csv|bin)\Z")
OPAQUE = re.compile(r"[A-Za-z0-9_.:-]{1,512}\Z")


class ArchiveRefusalError(ValueError):
    def __init__(self, reason: str, status: int = 503) -> None:
        super().__init__(reason)
        self.reason, self.status = reason, status


def require(condition: bool, reason: str, status: int = 503) -> None:
    if not condition:
        raise ArchiveRefusalError(reason, status)


def canonical(value: Any) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False
    ).encode()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass(frozen=True)
class Request:
    id: str
    identity_id: str
    user_id: str
    scope: str
    organisation_id: str | None
    include_media: bool
    created_at: int
    expires_at: int

    def validate(self) -> None:
        for value in (self.id, self.identity_id, self.user_id):
            require(str(UUID(value)) == value, "request identity binding")
        require(self.scope in {"account", "workspace"}, "request scope binding")
        require(
            (self.organisation_id is not None) == (self.scope == "workspace"),
            "request organisation binding",
        )
        if self.organisation_id is not None:
            require(
                str(UUID(self.organisation_id)) == self.organisation_id,
                "request organisation binding",
            )
        require(type(self.include_media) is bool, "request media policy")
        require(
            type(self.created_at) is int
            and type(self.expires_at) is int
            and 0 < self.expires_at - self.created_at <= 86400,
            "request expiry bound",
        )

    @property
    def binding(self) -> str:
        self.validate()
        return digest(canonical(asdict(self)))


@dataclass(frozen=True)
class Entry:
    name: str
    content: bytes


@dataclass(frozen=True)
class Page:
    binding: str
    snapshot: str
    entries: tuple[Entry, ...]
    next_cursor: str | None


class Source(Protocol):
    def snapshot(self, request: Request) -> str: ...
    def authorize(self, request: Request, snapshot: str) -> bool:
        """Recheck all captured resource grants; membership alone is insufficient."""
        ...

    def page(self, request: Request, snapshot: str, cursor: str | None) -> Page: ...


class PrivateStorage(Protocol):
    def put_immutable(self, key: str, content: bytes, expires_at: int) -> None:
        """Create privately, or verify identical existing bytes; never overwrite or publish."""
        ...

    def read(self, key: str, limit: int) -> bytes: ...


class Signer(Protocol):
    key_id: str
    public_key: bytes

    def sign(self, content: bytes) -> bytes: ...


class Authority(Protocol):
    def authorize(self, request: Request) -> bool:
        """Current enabled customer identity/person; current owner for workspace scope."""
        ...


@dataclass(frozen=True)
class Chunk:
    section: str
    snapshot: str
    cursor: str | None
    next_cursor: str | None
    key: str
    sha256: str
    size: int
    entries: tuple[tuple[str, str, int], ...]


@dataclass(frozen=True)
class State:
    request: Request
    revision: int
    snapshots: dict[str, str]
    chunks: tuple[Chunk, ...] = ()
    complete: tuple[str, ...] = ()
    artifact_key: str | None = None
    artifact_sha256: str | None = None
    artifact_size: int | None = None


class Journal(Protocol):
    def load(self, request_id: str) -> State: ...
    def save(self, state: State, expected_revision: int) -> bool:
        """Durable compare-and-swap; False means another worker committed first."""
        ...


def configured(
    sources: dict[str, Source],
    storage: PrivateStorage | None,
    signer: Signer | None,
    authority: Authority | None,
) -> tuple[PrivateStorage, Signer, Authority]:
    require(set(sources) == set(SECTIONS), "incomplete export sources")
    if storage is None or signer is None or authority is None:
        raise ArchiveRefusalError("private export ports unavailable")
    require(all(source is not None for source in sources.values()), "incomplete export sources")
    require(
        bool(signer and OPAQUE.fullmatch(signer.key_id))
        and signer is not None
        and len(signer.public_key) == 32,
        "export signing identity unavailable",
    )

    return storage, signer, authority


def authorize(state: State, sources: dict[str, Source], authority: Authority, now: int) -> None:
    state.request.validate()
    require(state.request.created_at <= now < state.request.expires_at, "export expired", 409)
    require(authority.authorize(state.request) is True, "export authority revoked", 403)
    require(set(state.snapshots) == set(SECTIONS), "incomplete export snapshots")
    for section in SECTIONS:
        require(
            isinstance(state.snapshots[section], str)
            and bool(OPAQUE.fullmatch(state.snapshots[section])),
            "invalid export snapshot",
        )
        require(
            sources[section].authorize(state.request, state.snapshots[section]) is True,
            "export resource authority revoked",
            403,
        )


def begin(
    request: Request,
    sources: dict[str, Source],
    storage: PrivateStorage | None,
    signer: Signer | None,
    authority: Authority | None,
    now: int,
) -> State:
    request.validate()
    storage, signer, authority = configured(sources, storage, signer, authority)
    require(authority.authorize(request) is True, "export authority revoked", 403)
    snapshots = {section: sources[section].snapshot(request) for section in SECTIONS}
    state = State(request, 1, snapshots)
    authorize(state, sources, authority, now)
    return state


def chunk_bytes(entries: tuple[Entry, ...]) -> bytes:
    return canonical(
        [
            {"name": item.name, "content": base64.b64encode(item.content).decode()}
            for item in entries
        ]
    )


def validate_entries(section: str, entries: tuple[Entry, ...], prior: tuple[Chunk, ...]) -> None:
    require(len(entries) <= MAX_PAGE_ENTRIES, "export page limit")
    names = {name.casefold() for chunk in prior for name, _, _ in chunk.entries}
    count = len(names)
    total = sum(size for chunk in prior for _, _, size in chunk.entries)
    for item in entries:
        require(
            isinstance(item.name, str)
            and NAME.fullmatch(item.name) is not None
            and item.name.startswith(section + "/")
            and all(part not in {"", ".", ".."} for part in item.name.split("/")),
            "unsafe export entry",
        )
        require(item.name.casefold() not in names, "duplicate export entry")
        names.add(item.name.casefold())
        require(
            isinstance(item.content, bytes) and len(item.content) <= MAX_ENTRY_BYTES,
            "export entry limit",
        )
        total += len(item.content)
    require(
        count + len(entries) <= MAX_ENTRIES and total <= MAX_ARCHIVE_BYTES, "export archive limit"
    )


def read_chunk(chunk: Chunk, storage: PrivateStorage) -> tuple[Entry, ...]:
    raw = storage.read(chunk.key, chunk.size + 1)
    require(len(raw) == chunk.size and digest(raw) == chunk.sha256, "export chunk integrity")
    try:
        decoded = json.loads(raw)
        entries = tuple(
            Entry(item["name"], base64.b64decode(item["content"], validate=True))
            for item in decoded
        )
    except (ValueError, KeyError, TypeError):
        raise ArchiveRefusalError("export chunk encoding") from None
    require(chunk_bytes(entries) == raw, "export chunk encoding")
    require(
        tuple((item.name, digest(item.content), len(item.content)) for item in entries)
        == chunk.entries,
        "export chunk manifest",
    )
    return entries


def state_integrity(state: State, storage: PrivateStorage) -> tuple[Entry, ...]:
    require(
        len(state.chunks) <= MAX_ENTRIES
        and state.revision >= 1
        and len(state.complete) == len(set(state.complete))
        and set(state.complete) <= set(SECTIONS),
        "export checkpoint integrity",
    )
    entries: tuple[Entry, ...] = ()
    previous: tuple[Chunk, ...] = ()
    finished: set[str] = set()
    cursors: dict[str, str | None] = {name: None for name in SECTIONS}
    seen_cursors: dict[str, set[str | None]] = {name: set() for name in SECTIONS}
    for ordinal, chunk in enumerate(state.chunks):
        require(
            chunk.section in SECTIONS
            and chunk.snapshot == state.snapshots[chunk.section]
            and chunk.section not in finished
            and chunk.cursor == cursors[chunk.section],
            "export checkpoint sequence",
        )
        require(
            chunk.key == f"privacy/{state.request.id}/chunks/{ordinal:05d}.json",
            "export checkpoint storage binding",
        )
        require(
            chunk.next_cursor is None
            or (
                OPAQUE.fullmatch(chunk.next_cursor) is not None
                and chunk.next_cursor != chunk.cursor
            ),
            "export cursor progression",
        )
        require(chunk.cursor not in seen_cursors[chunk.section], "export cursor progression")
        seen_cursors[chunk.section].add(chunk.cursor)
        require(
            type(chunk.size) is int
            and 0 < chunk.size <= MAX_PAGE_ENTRIES * (MAX_ENTRY_BYTES * 4 // 3 + 512) + 2,
            "export chunk size",
        )
        material = read_chunk(chunk, storage)
        validate_entries(chunk.section, material, previous)
        entries += material
        previous += (chunk,)
        cursors[chunk.section] = chunk.next_cursor
        if chunk.next_cursor is None:
            finished.add(chunk.section)
    require(finished == set(state.complete), "export checkpoint completion")
    return entries


def manifest(state: State) -> dict[str, Any]:
    return {
        "version": 1,
        "request": asdict(state.request),
        "binding": state.request.binding,
        "sections": state.snapshots,
        "entries": sorted(
            [
                {"name": name, "sha256": sha, "size": size}
                for chunk in state.chunks
                for name, sha, size in chunk.entries
            ],
            key=lambda item: item["name"],
        ),
    }


def build_zip(state: State, entries: tuple[Entry, ...], signer: Signer) -> bytes:
    body = canonical(manifest(state))
    signature = signer.sign(b"kodera-privacy-export:v1\n" + body)
    try:
        Ed25519PublicKey.from_public_bytes(signer.public_key).verify(
            signature, b"kodera-privacy-export:v1\n" + body
        )
    except (ValueError, InvalidSignature):
        raise ArchiveRefusalError("export signature verification") from None
    envelope = canonical(
        {
            "algorithm": "Ed25519",
            "key_id": signer.key_id,
            "signature": base64.b64encode(signature).decode(),
            "manifest": json.loads(body),
        }
    )
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
        for name, content in [
            ("manifest.json", envelope),
            *sorted((item.name, item.content) for item in entries),
        ]:
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100600 << 16
            archive.writestr(info, content)
    return output.getvalue()


def step(
    request: Request,
    journal: Journal,
    sources: dict[str, Source],
    storage: PrivateStorage | None,
    signer: Signer | None,
    authority: Authority | None,
    now: int,
) -> State:
    storage, signer, authority = configured(sources, storage, signer, authority)
    state = journal.load(request.id)
    require(state.request.binding == request.binding, "export request replay binding", 409)
    authorize(state, sources, authority, now)
    entries = state_integrity(state, storage)
    if state.artifact_key is not None:
        ready_bytes(state, sources, storage, signer, authority, now)
        return state
    section = next((name for name in SECTIONS if name not in state.complete), None)
    if section is not None:
        require(len(state.chunks) < MAX_ENTRIES, "export checkpoint limit")
        prior = [chunk for chunk in state.chunks if chunk.section == section]
        cursor = prior[-1].next_cursor if prior else None
        page = sources[section].page(request, state.snapshots[section], cursor)
        require(
            page.binding == request.binding and page.snapshot == state.snapshots[section],
            "export source snapshot binding",
        )
        require(
            page.next_cursor is None
            or (
                OPAQUE.fullmatch(page.next_cursor) is not None
                and page.next_cursor not in {cursor, *(chunk.cursor for chunk in prior)}
            ),
            "export cursor progression",
        )
        validate_entries(section, page.entries, state.chunks)
        raw = chunk_bytes(tuple(sorted(page.entries, key=lambda item: item.name)))
        key = f"privacy/{request.id}/chunks/{len(state.chunks):05d}.json"
        chunk = Chunk(
            section,
            page.snapshot,
            cursor,
            page.next_cursor,
            key,
            digest(raw),
            len(raw),
            tuple(
                (item.name, digest(item.content), len(item.content))
                for item in sorted(page.entries, key=lambda item: item.name)
            ),
        )
        storage.put_immutable(key, raw, request.expires_at)
        read_chunk(chunk, storage)
        updated = replace(
            state,
            revision=state.revision + 1,
            chunks=(*state.chunks, chunk),
            complete=(*state.complete, section) if page.next_cursor is None else state.complete,
        )
    else:
        authorize(state, sources, authority, now)
        raw = build_zip(state, entries, signer)
        key = f"privacy/{request.id}/archive.zip"
        storage.put_immutable(key, raw, request.expires_at)
        require(storage.read(key, len(raw) + 1) == raw, "export artifact integrity")
        authorize(state, sources, authority, now)
        updated = replace(
            state,
            revision=state.revision + 1,
            artifact_key=key,
            artifact_sha256=digest(raw),
            artifact_size=len(raw),
        )
    require(journal.save(updated, state.revision), "export checkpoint conflict", 409)
    return updated


def ready_bytes(
    state: State,
    sources: dict[str, Source],
    storage: PrivateStorage,
    signer: Signer,
    authority: Authority,
    now: int,
) -> bytes:
    configured(sources, storage, signer, authority)
    authorize(state, sources, authority, now)
    entries = state_integrity(state, storage)
    require(set(state.complete) == set(SECTIONS), "export sources incomplete", 409)
    require(
        state.artifact_key == f"privacy/{state.request.id}/archive.zip"
        and state.artifact_sha256 is not None
        and state.artifact_size is not None,
        "export not ready",
        409,
    )
    if state.artifact_key is None or state.artifact_size is None:
        raise ArchiveRefusalError("export not ready", 409)
    require(
        type(state.artifact_size) is int
        and 0 < state.artifact_size <= MAX_ARCHIVE_BYTES + 16 * 1024 * 1024,
        "export artifact size",
    )
    raw = storage.read(state.artifact_key, state.artifact_size + 1)
    require(
        len(raw) == state.artifact_size and digest(raw) == state.artifact_sha256,
        "export artifact integrity",
    )
    require(build_zip(state, entries, signer) == raw, "export signed manifest integrity")
    authorize(state, sources, authority, now)
    return raw
