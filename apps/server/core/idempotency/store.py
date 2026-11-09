"""Run a POST's effect once per key, or replay or refuse: docs/specs/IDEMPOTENCY_REPLAY.md §2.2.

One transaction per call, owned here: the isolation is pinned, the scope's advisory lock is tried,
the entry is read, and only then does the handler run, so the effect and the stored response commit
or roll back together. The names below are module attributes on purpose: the acceptance tests patch
each one to prove the check that owns it can fail.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal

from django.db import connection, transaction
from django.db.models import BooleanField, ExpressionWrapper, Q
from django.db.models.functions import Now

from .models import MAX_BODY_BYTES, MAX_ISSUER, MAX_PATH, MAX_SUBJECT, IdempotencyRecord

RETENTION = timedelta(hours=24)
RETRY_AFTER_S = 1
# A timeout and a rate limit say "not now", not "no": a retry must reach the handler again.
TRANSIENT = frozenset({408, 429})
METHOD = "POST"
KEY = re.compile(r"[\x21-\x7e]{16,255}\Z")
_HEADER_VALUE = re.compile(r"[\x20-\x7e]*\Z")
DIGEST_HEX = re.compile(r"[0-9a-f]{64}\Z")

PIN_ISOLATION = "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
_TRY_LOCK = "SELECT pg_try_advisory_xact_lock(%s)"


@dataclass(frozen=True)
class Scope:
    """The principal, the operation and the client's key: what one entry is stored under."""

    issuer: str
    subject: str
    method: str
    path: str
    key: str

    def __post_init__(self) -> None:
        if self.method != METHOD:
            raise ValueError("the replay store serves POST only")
        if not KEY.fullmatch(self.key):
            raise ValueError("an Idempotency-Key is 16 to 255 visible ASCII characters")
        if not 1 <= len(self.issuer) <= MAX_ISSUER or "\x00" in self.issuer:
            raise ValueError("the issuer is out of bounds")
        subject = self.subject
        if not 1 <= len(subject) <= MAX_SUBJECT or not subject.isascii() or "\x00" in subject:
            raise ValueError("the subject is out of bounds")
        if not 1 <= len(self.path) <= MAX_PATH or not self.path.startswith("/"):
            raise ValueError("the path is out of bounds")

    @property
    def key_sha256(self) -> str:
        return hashlib.sha256(self.key.encode("ascii")).hexdigest()


@dataclass(frozen=True)
class StoredResponse:
    """What the first answer sends and every replay repeats: status, body and three headers."""

    status: int
    body: bytes
    content_type: str
    location: str | None = None
    etag: str | None = None
    job_id: str | None = None

    def __post_init__(self) -> None:
        if len(self.body) > MAX_BODY_BYTES:
            raise ValueError("a stored response body is at most 1 MiB")
        if not self.content_type:
            raise ValueError("a stored response names its content type")
        for value in (self.content_type, self.location, self.etag, self.job_id):
            if value is not None and not _HEADER_VALUE.fullmatch(value):
                raise ValueError("a stored header value is printable ASCII on one line")


@dataclass(frozen=True)
class Executed:
    """The handler ran. `stored` is False for a 5xx, whose effect was rolled back."""

    response: StoredResponse
    stored: bool


@dataclass(frozen=True)
class Replayed:
    response: StoredResponse
    first_seen_at: datetime


@dataclass(frozen=True)
class KeyReused:
    first_seen_at: datetime


@dataclass(frozen=True)
class InFlight:
    retry_after_s: int


Outcome = Executed | Replayed | KeyReused | InFlight
STORE = "store"
DISCARD = "discard"


@dataclass(frozen=True)
class EnterAuthority:
    """Hold current route authority before any receipt or key output is accessed."""


@dataclass(frozen=True)
class FreshAuthority:
    """A new handler will run; eligible business denials belong inside that handler."""


@dataclass(frozen=True)
class ReplayAuthority:
    """Authorize release before cached bytes, exposing only their stored status."""

    status: int

    def __post_init__(self) -> None:
        if type(self.status) is not int or not (
            200 <= self.status <= 299
            or (400 <= self.status <= 499 and self.status not in TRANSIENT)
        ):
            raise ValueError("authority replay status must be an eligible stored answer")


@dataclass(frozen=True)
class MetadataAuthority:
    """Authorize key-conflict/in-flight metadata without any receipt body or timestamp."""

    kind: Literal["key_reused", "in_flight"]

    def __post_init__(self) -> None:
        if type(self.kind) is not str or self.kind not in {"key_reused", "in_flight"}:
            raise ValueError("authority metadata kind must name a closed outcome")


ReplayAuthorityEvent = EnterAuthority | FreshAuthority | ReplayAuthority | MetadataAuthority
AuthorityCallback = Callable[[ReplayAuthorityEvent], None]


@dataclass(frozen=True)
class FinalAuthority:
    kind: Literal["fresh_success", "successful_replay", "key_reused", "in_flight"]

    def __post_init__(self) -> None:
        if type(self.kind) is not str or self.kind not in {
            "fresh_success",
            "successful_replay",
            "key_reused",
            "in_flight",
        }:
            raise ValueError("final authority kind must name a closed outcome")


FinalAuthorityCallback = Callable[[FinalAuthority], None]


def _invoke_authority(authority: AuthorityCallback | None, event: ReplayAuthorityEvent) -> None:
    if authority is not None:
        authority(event)


def _invoke_final_authority(authority: FinalAuthorityCallback, event: FinalAuthority) -> None:
    authority(event)


class _DiscardedError(Exception):
    """Raised inside the transaction to roll a 5xx answer's effect back."""

    def __init__(self, response: StoredResponse) -> None:
        super().__init__()
        self.response = response


def lock_key(scope: Scope) -> int:
    """The one-integer advisory key: the first eight bytes of SHA-256 over the scope array."""
    array = [scope.issuer, scope.subject, scope.method, scope.path, scope.key]
    digest = hashlib.sha256(
        json.dumps(array, separators=(",", ":"), ensure_ascii=True).encode()
    ).digest()
    return int.from_bytes(digest[:8], "big", signed=True)


def scope_columns(scope: Scope) -> dict[str, str]:
    """The columns an entry is looked up by: the ones the unique constraint spans."""
    return {
        "issuer": scope.issuer,
        "subject": scope.subject,
        "method": scope.method,
        "path": scope.path,
        "key_sha256": scope.key_sha256,
    }


def require_own_transaction() -> None:
    if connection.in_atomic_block:
        raise RuntimeError("the replay store runs in its own transaction, never a caller's")


def try_lock(scope: Scope) -> bool:
    with connection.cursor() as cursor:
        cursor.execute(_TRY_LOCK, [lock_key(scope)])
        row = cursor.fetchone()
    return bool(row[0])


def lookup(scope: Scope) -> IdempotencyRecord | None:
    """The scope's entry, annotated `expired` by the database clock, or None."""
    expired = ExpressionWrapper(Q(created_at__lte=Now() - RETENTION), output_field=BooleanField())
    found: IdempotencyRecord | None = (
        IdempotencyRecord.objects.filter(**scope_columns(scope)).annotate(expired=expired).first()
    )
    return found


def same_body(record: IdempotencyRecord, body_sha256: str) -> bool:
    return record.body_sha256 == body_sha256


def disposition(status: int) -> str:
    """2xx and 4xx are stored, except the transient 408 and 429; those and 5xx are rolled back and
    handed back, so a retry with the same key runs again. Anything else is a bug."""
    if status in TRANSIENT or 500 <= status <= 599:
        return DISCARD
    if 200 <= status <= 299 or 400 <= status <= 499:
        return STORE
    raise ValueError(f"a POST answer through the replay store is 2xx, 4xx or 5xx, not {status}")


def roll_back(response: StoredResponse) -> None:
    raise _DiscardedError(response)


def _response(record: IdempotencyRecord) -> StoredResponse:
    return StoredResponse(
        status=record.status,
        body=bytes(record.body),
        content_type=record.content_type,
        location=record.location,
        etag=record.etag,
        job_id=record.job_id,
    )


def _execute(
    scope: Scope,
    body_sha256: str,
    handler: Callable[[], StoredResponse],
    *,
    authority: AuthorityCallback | None = None,
    final_authority: FinalAuthorityCallback | None = None,
) -> Outcome:
    # SET TRANSACTION must stay the first statement inside the atomic block: PostgreSQL refuses it
    # after any other statement, and the lookup below relies on READ COMMITTED taking its snapshot
    # after the lock is granted.
    with connection.cursor() as cursor:
        cursor.execute(PIN_ISOLATION)
    _invoke_authority(authority, EnterAuthority())
    if not try_lock(scope):
        _invoke_authority(authority, MetadataAuthority("in_flight"))
        in_flight = InFlight(retry_after_s=RETRY_AFTER_S)
        if final_authority is not None:
            _invoke_final_authority(final_authority, FinalAuthority("in_flight"))
        return in_flight
    record = lookup(scope)
    if record is not None:
        annotated: Any = record
        if annotated.expired:
            IdempotencyRecord.objects.filter(pk=record.pk).delete()
        elif same_body(record, body_sha256):
            if authority is not None:
                _invoke_authority(authority, ReplayAuthority(record.status))
            if final_authority is None:
                return Replayed(response=_response(record), first_seen_at=record.created_at)
            replayed = Replayed(response=_response(record), first_seen_at=record.created_at)
            if final_authority is not None and 200 <= record.status <= 299:
                _invoke_final_authority(final_authority, FinalAuthority("successful_replay"))
            return replayed
        else:
            _invoke_authority(authority, MetadataAuthority("key_reused"))
            key_reused = KeyReused(first_seen_at=record.created_at)
            if final_authority is not None:
                _invoke_final_authority(final_authority, FinalAuthority("key_reused"))
            return key_reused
    _invoke_authority(authority, FreshAuthority())
    response = handler()
    if not isinstance(response, StoredResponse):
        raise TypeError("a replay-store handler returns a StoredResponse")
    if disposition(response.status) == DISCARD:
        roll_back(response)
        return Executed(response=response, stored=False)
    IdempotencyRecord.objects.create(
        issuer=scope.issuer,
        subject=scope.subject,
        method=scope.method,
        path=scope.path,
        key_sha256=scope.key_sha256,
        body_sha256=body_sha256,
        status=response.status,
        content_type=response.content_type,
        body=response.body,
        location=response.location,
        etag=response.etag,
        job_id=response.job_id,
    )
    executed = Executed(response=response, stored=True)
    if final_authority is not None and 200 <= response.status <= 299:
        _invoke_final_authority(final_authority, FinalAuthority("fresh_success"))
    return executed


def run_once(
    *,
    scope: Scope,
    body_sha256: str,
    handler: Callable[[], StoredResponse],
    authority: AuthorityCallback | None = None,
    final_authority: FinalAuthorityCallback | None = None,
) -> Outcome:
    """Execute `handler` at most once per live entry of `scope`, in a transaction of its own."""
    if not DIGEST_HEX.fullmatch(body_sha256):
        raise ValueError("body_sha256 is 64 lower-case hexadecimal digits")
    require_own_transaction()
    try:
        with transaction.atomic():
            if final_authority is None:
                return _execute(scope, body_sha256, handler, authority=authority)
            return _execute(
                scope, body_sha256, handler, authority=authority, final_authority=final_authority
            )
    except _DiscardedError as discarded:
        return Executed(response=discarded.response, stored=False)


PURGE_BATCH = 1000
MAX_PURGE_BATCH = 10_000
_CUTOFF = "SELECT now() - %s * interval '1 second'"


@dataclass(frozen=True)
class Purged:
    """What one purge deleted, and in how many committed batches. Counts only: no entry's scope."""

    deleted: int
    batches: int

    def line(self) -> str:
        return (
            f"idempotency purge: deleted {self.deleted} expired entries in {self.batches} batches"
        )


def purge_cutoff() -> datetime:
    """The database clock's now, less the retention, read once so one purge has an end."""
    with connection.cursor() as cursor:
        cursor.execute(_CUTOFF, [RETENTION.total_seconds()])
        row = cursor.fetchone()
    cutoff: datetime = row[0]
    return cutoff


def purge_batch(cutoff: datetime, limit: int) -> int:
    """Delete at most `limit` entries created at or before `cutoff`, oldest first, in a transaction
    of its own. Rows another transaction holds are skipped, never waited on."""
    with transaction.atomic():
        expired = IdempotencyRecord.objects.filter(created_at__lte=cutoff)
        chosen = list(
            expired.order_by("created_at", "id")
            .select_for_update(skip_locked=True)
            .values_list("id", flat=True)[:limit]
        )
        if not chosen:
            return 0
        deleted, _ = expired.filter(id__in=chosen).delete()
        return deleted


def purge_expired(*, batch: int = PURGE_BATCH) -> Purged:
    """Delete every entry older than the retention by the database clock, `batch` at most per
    `DELETE`, each batch committed before the next (docs/specs/IDEMPOTENCY_REPLAY.md §2.7)."""
    if not 1 <= batch <= MAX_PURGE_BATCH:
        raise ValueError(f"a purge batch is 1 to {MAX_PURGE_BATCH} entries")
    require_own_transaction()
    cutoff = purge_cutoff()
    deleted = batches = 0
    while True:
        count = purge_batch(cutoff, batch)
        if count:
            deleted += count
            batches += 1
        if count < batch:
            return Purged(deleted=deleted, batches=batches)
