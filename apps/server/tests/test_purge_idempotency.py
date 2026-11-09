"""The batched purge of the replay store and its command: docs/specs/IDEMPOTENCY_REPLAY.md §2.7.

`purge_idempotency --once [--batch N]` deletes the entries older than the retention, at most N per
`DELETE`, each batch committed before the next, skipping rows another transaction holds, and prints
counts only. The purge owns its transactions, so these tests run under `transactional_db`.
"""

from __future__ import annotations

import hashlib
from datetime import timedelta
from io import StringIO
from typing import Any

import psycopg
import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection, transaction

from core.idempotency import store
from core.idempotency.models import IdempotencyRecord

pytestmark = pytest.mark.django_db(transaction=True)

ISSUER = "https://id.customer.test/realms/org-acme"
SUBJECT = "subject-purge-0001"
# What the spec says, written here rather than read from the store.
RETENTION = timedelta(hours=24)
EXPIRED = RETENTION + timedelta(seconds=1)
LIVE = RETENTION - timedelta(minutes=1)


def digest(label: str) -> str:
    return hashlib.sha256(label.encode()).hexdigest()


def entry(label: str, age: timedelta) -> str:
    """One stored entry of key `label`, created `age` ago by the database clock."""
    IdempotencyRecord.objects.create(
        issuer=ISSUER,
        subject=SUBJECT,
        method="POST",
        path="/api/v1/organisations",
        key_sha256=digest(label),
        body_sha256=digest("body"),
        status=201,
        content_type="application/json",
        body=b"{}",
    )
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE idempotency_record SET created_at = now() - %s * interval '1 second' "
            "WHERE key_sha256 = %s",
            [age.total_seconds(), digest(label)],
        )
        assert cursor.rowcount == 1
    return label


def remaining() -> set[str]:
    stored = set(IdempotencyRecord.objects.values_list("key_sha256", flat=True))
    return {label for label in LABELS if digest(label) in stored}


LABELS = [f"expired-{n}" for n in range(5)] + ["live-0", "live-1"]


def seed() -> None:
    for label in LABELS:
        entry(label, EXPIRED if label.startswith("expired") else LIVE)


def recorded_batches(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    counts: list[int] = []
    real = store.purge_batch

    def recording(cutoff: Any, limit: int) -> int:
        count = real(cutoff, limit)
        counts.append(count)
        return count

    monkeypatch.setattr(store, "purge_batch", recording)
    return counts


def purge(*args: str) -> str:
    out = StringIO()
    call_command("purge_idempotency", *args, stdout=out)
    return out.getvalue().strip()


def test_the_command_deletes_only_expired_entries_in_bounded_batches(monkeypatch):
    assert connection.vendor == "postgresql" and not connection.in_atomic_block
    seed()
    batches = recorded_batches(monkeypatch)
    said = purge("--once", "--batch", "2")
    assert said == "idempotency purge: deleted 5 expired entries in 3 batches"
    assert batches == [2, 2, 1], "a DELETE removed more entries than its batch"
    assert remaining() == {"live-0", "live-1"}, "the purge removed a live entry or kept one expired"


def test_an_exact_multiple_ends_on_an_empty_batch(monkeypatch):
    for n in range(4):
        entry(f"expired-{n}", EXPIRED)
    batches = recorded_batches(monkeypatch)
    assert purge("--once", "--batch", "2") == (
        "idempotency purge: deleted 4 expired entries in 2 batches"
    )
    assert batches == [2, 2, 0]
    assert purge("--once") == "idempotency purge: deleted 0 expired entries in 0 batches"


def test_each_batch_is_committed_before_the_next(monkeypatch):
    seed()
    real = store.purge_batch
    calls: list[int] = []

    def failing_second(cutoff: Any, limit: int) -> int:
        calls.append(limit)
        if len(calls) == 2:
            raise RuntimeError("synthetic failure in the second batch")
        return real(cutoff, limit)

    monkeypatch.setattr(store, "purge_batch", failing_second)
    with pytest.raises(RuntimeError, match="^synthetic failure in the second batch$"):
        store.purge_expired(batch=2)
    # The first batch's two deletions committed on their own; the second batch's did not run.
    assert len(remaining() & {f"expired-{n}" for n in range(5)}) == 3
    assert {"live-0", "live-1"} <= remaining()


def test_a_row_another_transaction_holds_is_skipped_not_waited_on():
    seed()
    assert str(connection.settings_dict["NAME"]).startswith("test_"), "owned test database only"
    holder = psycopg.connect(**connection.get_connection_params(), autocommit=False)
    try:
        with holder.cursor() as cursor:
            cursor.execute(
                "SELECT id FROM idempotency_record WHERE key_sha256 = %s FOR UPDATE",
                [digest("expired-0")],
            )
            assert cursor.fetchone() is not None
        purged = store.purge_expired(batch=10)
        assert purged == store.Purged(deleted=4, batches=1)
        assert remaining() == {"expired-0", "live-0", "live-1"}
    finally:
        holder.rollback()
        holder.close()
    assert store.purge_expired(batch=10) == store.Purged(deleted=1, batches=1)
    assert remaining() == {"live-0", "live-1"}


@pytest.mark.parametrize(
    ("args", "message"),
    [
        ((), "purge_idempotency runs only with --once"),
        (("--batch", "2"), "purge_idempotency runs only with --once"),
        (("--once", "--batch", "0"), "--batch must be 1 to 10000"),
        (("--once", "--batch", "10001"), "--batch must be 1 to 10000"),
    ],
)
def test_the_command_refuses_and_deletes_nothing(args, message):
    seed()
    with pytest.raises(CommandError) as refused:
        purge(*args)
    assert str(refused.value) == message
    assert remaining() == set(LABELS)


def test_the_purge_refuses_a_callers_transaction():
    seed()
    with transaction.atomic(), pytest.raises(CommandError) as refused:
        purge("--once")
    assert str(refused.value) == "the replay store runs in its own transaction, never a caller's"
    assert remaining() == set(LABELS)


@pytest.mark.parametrize("batch", [0, -1, 10_001])
def test_the_store_refuses_an_unbounded_batch(batch):
    with pytest.raises(ValueError, match="^a purge batch is 1 to 10000 entries$"):
        store.purge_expired(batch=batch)
