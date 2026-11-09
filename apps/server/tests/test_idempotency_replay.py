"""Acceptance for the Idempotency-Key replay store: docs/specs/IDEMPOTENCY_REPLAY.md §4.

Every check is a function that raises an AssertionError with a fixed first line. Each runs once
unmutated, and each mutant of MUTANTS patches one part of the mechanism — a function or constant of
core.idempotency or core.api.idempotency, or a constraint of the table inside a rolled-back
transaction — and requires its owning check to fail with exactly that line. A check without a mutant
fails the inventory test, so no check here has passed without having been seen to fail.

The store owns its transaction, so the database checks run under `transactional_db`. The in-flight
checks use real second connections: a second Django connection in a thread, and a raw psycopg
session holding the scope's advisory lock.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg
import pytest
from django.db import DatabaseError, IntegrityError, connection, transaction
from django.http import HttpRequest, HttpResponse
from django.test import RequestFactory

from core.api import idempotency as adapter
from core.idempotency import fingerprint, store
from core.idempotency.models import MAX_BODY_BYTES, IdempotencyRecord
from core.idempotency.store import (
    DISCARD,
    STORE,
    Executed,
    InFlight,
    KeyReused,
    Replayed,
    Scope,
    StoredResponse,
)

ISSUER = "https://id.customer.test/realms/org-acme"
SUBJECT = "subject-0001"
PATH = "/api/v1/organisations"
KEY = "00000000-0000-4000-8000-000000000001"
SECOND_KEY = "00000000-0000-4000-8000-000000000002"
REQUEST_ID = "test-request-0001"
# What §8 and the spec say, written here rather than read from the store, so a mutant of the
# store's own constant cannot move the expectation with it.
RETENTION = timedelta(hours=24)
RETRY_AFTER_S = 1

BODY = hashlib.sha256(b"first body").hexdigest()
OTHER_BODY = hashlib.sha256(b"second body").hexdigest()
CREATED = StoredResponse(
    status=201,
    body=b'{"id":"0190a000-0000-7000-8000-000000000001","name":"Acme"}',
    content_type="application/json",
    location="/api/v1/organisations/0190a000-0000-7000-8000-000000000001",
    etag='"0000000000000000000000000000000000000000000000000000000000000001"',
    job_id="0190a000-0000-7000-8000-0000000000aa",
)
OTHER = StoredResponse(status=201, body=b'{"other":true}', content_type="application/json")
REFUSAL = StoredResponse(
    status=403,
    body=b'{"type":"https://kodera.io/problems/mfa-required","status":403}',
    content_type="application/problem+json",
)
FAILURE = StoredResponse(
    status=503,
    body=b'{"type":"https://kodera.io/problems/service-unavailable","status":503}',
    content_type="application/problem+json",
)
PROBLEMS = "https://kodera.io/problems/"
FACTORY = RequestFactory()
MARKER_SUBJECT = "effect-marker"
OPERATION_REF = "X-Operation-Ref"
REFERENCE = "a" * 64


def scope(**changes: str) -> Scope:
    values = {"issuer": ISSUER, "subject": SUBJECT, "method": "POST", "path": PATH, "key": KEY}
    return Scope(**{**values, **changes})


def effect(calls: list[str], response: StoredResponse) -> Callable[[], StoredResponse]:
    def handler() -> StoredResponse:
        calls.append(response.content_type)
        return response

    return handler


class _UnitCursor:
    def __init__(self, seen):
        self.seen = seen

    def __enter__(self):
        return self

    def __exit__(self, *arguments):
        return False

    def execute(self, sql):
        self.seen.append(sql)


def _authority_unit(monkeypatch, *, record=None, locked=True):
    """Call-order unit controls only; actual transactions/races remain PostgreSQL tests."""
    from types import SimpleNamespace

    seen = []
    monkeypatch.setattr(store, "connection", SimpleNamespace(cursor=lambda: _UnitCursor(seen)))
    monkeypatch.setattr(store, "try_lock", lambda scope: seen.append("key-lock") or locked)
    monkeypatch.setattr(store, "lookup", lambda scope: seen.append("lookup") or record)
    created = []
    deleted = []
    manager = SimpleNamespace(
        create=lambda **values: created.append(values),
        filter=lambda **values: SimpleNamespace(delete=lambda: deleted.append(values)),
    )
    monkeypatch.setattr(store, "IdempotencyRecord", SimpleNamespace(objects=manager))
    return seen, created, deleted


def _unit_receipt(status=200, *, expired=False):
    from types import SimpleNamespace

    return SimpleNamespace(
        status=status,
        expired=expired,
        pk="receipt",
        body_sha256=BODY,
        body=b"private-cached-response",
        content_type="application/json",
        location=None,
        etag=None,
        job_id=None,
        created_at="held-first-seen",
    )


@pytest.mark.parametrize("status", [200, 403, 404, 409, 410])
def test_optional_authority_precedes_cached_bytes_and_exposes_only_status(monkeypatch, status):
    receipt = _unit_receipt(status)
    seen, created, deleted = _authority_unit(monkeypatch, record=receipt)
    original = store._response
    monkeypatch.setattr(store, "_response", lambda record: seen.append("bytes") or original(record))
    events = []

    def authority(event):
        events.append(event)
        seen.append(type(event).__name__)

    outcome = store._execute(
        scope(), BODY, lambda: pytest.fail("cached handler"), authority=authority
    )
    assert seen == [
        store.PIN_ISOLATION,
        "EnterAuthority",
        "key-lock",
        "lookup",
        "ReplayAuthority",
        "bytes",
    ]
    assert isinstance(outcome, Replayed) and outcome.response.body == receipt.body
    assert vars(events[0]) == {} and vars(events[1]) == {"status": status}
    assert not created and not deleted


@pytest.mark.parametrize("branch", ["fresh", "replay", "key_reused", "in_flight"])
def test_optional_authority_refusal_precedes_every_guarded_output(monkeypatch, branch):
    receipt = None if branch == "fresh" else _unit_receipt()
    seen, created, deleted = _authority_unit(
        monkeypatch, record=receipt, locked=branch != "in_flight"
    )
    calls = []

    class DeniedError(Exception):
        pass

    def authority(event):
        seen.append(type(event).__name__)
        if type(event).__name__ != "EnterAuthority":
            raise DeniedError()

    monkeypatch.setattr(store, "_response", lambda record: pytest.fail("denied cached bytes"))
    with pytest.raises(DeniedError):
        store._execute(
            scope(),
            OTHER_BODY if branch == "key_reused" else BODY,
            lambda: calls.append("effect") or CREATED,
            authority=authority,
        )
    assert not calls and not created and not deleted
    assert seen[0] == store.PIN_ISOLATION


@pytest.mark.parametrize("branch", ["key_reused", "in_flight"])
def test_optional_authority_metadata_is_closed_before_timestamp_or_retry(monkeypatch, branch):
    seen, created, deleted = _authority_unit(
        monkeypatch, record=_unit_receipt(), locked=branch != "in_flight"
    )
    events = []
    outcome = store._execute(
        scope(), OTHER_BODY, lambda: pytest.fail("metadata handler"), authority=events.append
    )
    assert type(events[0]).__name__ == "EnterAuthority"
    assert type(events[1]).__name__ == "MetadataAuthority"
    assert vars(events[1]) == {"kind": branch}
    assert isinstance(outcome, KeyReused if branch == "key_reused" else InFlight)
    assert not created and not deleted


def test_optional_authority_fresh_denial_is_stored_by_unchanged_disposition(monkeypatch):
    seen, created, deleted = _authority_unit(monkeypatch)
    events = []
    outcome = store._execute(scope(), BODY, lambda: REFUSAL, authority=events.append)
    assert outcome == Executed(response=REFUSAL, stored=True)
    assert [type(event).__name__ for event in events] == ["EnterAuthority", "FreshAuthority"]
    assert created[0]["status"] == 403 and created[0]["body"] == REFUSAL.body
    assert store.disposition(401) == STORE
    assert not deleted


def test_optional_authority_omission_mutation_releases_a_forbidden_cached_result(monkeypatch):
    _authority_unit(monkeypatch, record=_unit_receipt())

    def authority(event):
        if type(event).__name__ == "ReplayAuthority":
            raise PermissionError("closed-refusal")

    with pytest.raises(PermissionError):
        store._execute(scope(), BODY, lambda: CREATED, authority=authority)
    monkeypatch.setattr(store, "_invoke_authority", lambda callback, event: None)
    assert isinstance(store._execute(scope(), BODY, lambda: CREATED, authority=authority), Replayed)


def test_optional_authority_event_types_are_immutable_and_bounded():
    from dataclasses import FrozenInstanceError

    event = store.ReplayAuthority(200)
    with pytest.raises(FrozenInstanceError):
        event.status = 403
    for status in (True, "200", 199, 300, 408, 429, 503):
        with pytest.raises(ValueError):
            store.ReplayAuthority(status)
    for kind in ("fresh", "unknown", 1, None):
        with pytest.raises(ValueError):
            store.MetadataAuthority(kind)


def test_optional_authority_adapter_passes_callback_to_the_actual_store_boundary(monkeypatch):
    events = []

    def actual_call(**arguments):
        assert arguments["authority"] is events.append or arguments["authority"] == events.append
        return Executed(response=REFUSAL, stored=True)

    callback = events.append
    monkeypatch.setattr(store, "run_once", actual_call)
    request = FACTORY.post(
        PATH, b"{}", content_type="application/json", headers={"Idempotency-Key": KEY}
    )
    assert (
        adapter.respond_once(
            request,
            issuer=ISSUER,
            subject=SUBJECT,
            request_id=REQUEST_ID,
            handler=lambda: REFUSAL,
            authority=callback,
        ).status_code
        == 403
    )


@pytest.mark.parametrize(
    ("outcome", "expected", "replayed"),
    [
        (Executed(response=CREATED, stored=True), REFERENCE, False),
        (Replayed(response=CREATED, first_seen_at=datetime.now(UTC)), REFERENCE, True),
        (InFlight(retry_after_s=RETRY_AFTER_S), REFERENCE, False),
        (Executed(response=REFUSAL, stored=True), None, False),
        (Replayed(response=REFUSAL, first_seen_at=datetime.now(UTC)), None, True),
        (KeyReused(first_seen_at=datetime.now(UTC)), None, False),
    ],
    ids=["created", "created-replay", "in-flight", "refusal", "refusal-replay", "reuse"],
)
def test_optional_operation_reference_is_emitted_only_for_the_bounded_outcomes(
    monkeypatch, outcome, expected, replayed
):
    calls = []
    monkeypatch.setattr(store, "run_once", lambda **arguments: calls.append(arguments) or outcome)
    request = FACTORY.post(
        PATH, b"{}", content_type="application/json", headers={"Idempotency-Key": KEY}
    )
    response = adapter.respond_once(
        request,
        issuer=ISSUER,
        subject=SUBJECT,
        request_id=REQUEST_ID,
        handler=lambda: CREATED,
        operation_ref=REFERENCE,
    )
    assert response.headers.get(OPERATION_REF) == expected
    assert (response.headers.get(adapter.REPLAYED_HEADER) == "true") is replayed
    assert len(calls) == 1


@pytest.mark.parametrize("reference", ["", "A" * 64, "g" * 64, "a" * 63, "a" * 65, "a" * 64 + "\n"])
def test_malformed_optional_operation_reference_is_refused_before_the_effect(
    monkeypatch, reference
):
    monkeypatch.setattr(store, "run_once", lambda **arguments: pytest.fail("store reached"))
    request = FACTORY.post(
        PATH, b"{}", content_type="application/json", headers={"Idempotency-Key": KEY}
    )
    with pytest.raises(ValueError, match="operation reference"):
        adapter.respond_once(
            request,
            issuer=ISSUER,
            subject=SUBJECT,
            request_id=REQUEST_ID,
            handler=lambda: pytest.fail("effect reached"),
            operation_ref=reference,
        )


def test_adapter_without_a_route_reference_remains_domain_neutral(monkeypatch):
    monkeypatch.setattr(
        store, "run_once", lambda **arguments: Executed(response=CREATED, stored=True)
    )
    request = FACTORY.post(
        PATH, b"{}", content_type="application/json", headers={"Idempotency-Key": KEY}
    )
    response = adapter.respond_once(
        request,
        issuer=ISSUER,
        subject=SUBJECT,
        request_id=REQUEST_ID,
        handler=lambda: CREATED,
    )
    assert OPERATION_REF not in response.headers


def test_optional_authority_enter_denial_precedes_key_or_receipt_access(monkeypatch):
    seen, created, deleted = _authority_unit(monkeypatch, record=_unit_receipt())

    def authority(event):
        assert type(event).__name__ == "EnterAuthority"
        raise PermissionError("closed-current-identity-refusal")

    with pytest.raises(PermissionError):
        store._execute(scope(), BODY, lambda: CREATED, authority=authority)
    assert seen == [store.PIN_ISOLATION] and not created and not deleted


def test_optional_authority_none_keeps_default_fresh_and_cached_outcomes(monkeypatch):
    seen, created, deleted = _authority_unit(monkeypatch)
    assert store._execute(scope(), BODY, lambda: REFUSAL) == Executed(response=REFUSAL, stored=True)
    assert seen == [store.PIN_ISOLATION, "key-lock", "lookup"]
    assert created[0]["body"] == REFUSAL.body and not deleted
    seen, created, deleted = _authority_unit(monkeypatch, record=_unit_receipt(403))
    assert isinstance(
        store._execute(scope(), BODY, lambda: pytest.fail("cached handler")), Replayed
    )
    assert seen == [store.PIN_ISOLATION, "key-lock", "lookup"]
    assert not created and not deleted


@pytest.mark.django_db(transaction=True)
def test_optional_authority_database_replay_denial_preserves_the_actual_receipt():
    store.run_once(scope=scope(), body_sha256=BODY, handler=lambda: REFUSAL)
    before = list(IdempotencyRecord.objects.values())

    def authority(event):
        assert connection.in_atomic_block
        if isinstance(event, store.ReplayAuthority):
            write_marker("/effects/refused-replay")
            raise PermissionError("closed-current-authority-refusal")

    with pytest.raises(PermissionError):
        store.run_once(
            scope=scope(), body_sha256=BODY, handler=lambda: CREATED, authority=authority
        )
    assert not connection.in_atomic_block
    assert list(IdempotencyRecord.objects.values()) == before
    assert not marker_exists("/effects/refused-replay")


@pytest.mark.django_db(transaction=True)
def test_optional_authority_database_fresh_guard_rolls_back_expired_receipt_deletion():
    store.run_once(scope=scope(), body_sha256=BODY, handler=lambda: REFUSAL)
    backdate(scope(), RETENTION + timedelta(seconds=1))
    before = list(IdempotencyRecord.objects.values())

    def authority(event):
        if isinstance(event, store.FreshAuthority):
            write_marker("/effects/refused-fresh")
            raise PermissionError("closed-fresh-refusal")

    with pytest.raises(PermissionError):
        store.run_once(
            scope=scope(), body_sha256=BODY, handler=lambda: CREATED, authority=authority
        )
    assert list(IdempotencyRecord.objects.values()) == before
    assert not marker_exists("/effects/refused-fresh")


@pytest.mark.django_db(transaction=True)
def test_optional_authority_database_keeps_business_refusal_storage_after_fact_change():
    allowed = False

    def handler():
        return CREATED if allowed else REFUSAL

    store.run_once(scope=scope(), body_sha256=BODY, handler=handler, authority=lambda event: None)
    allowed = True
    replayed = store.run_once(
        scope=scope(), body_sha256=BODY, handler=handler, authority=lambda event: None
    )
    assert isinstance(replayed, Replayed) and replayed.response == REFUSAL
    assert store.run_once(
        scope=scope(key=SECOND_KEY),
        body_sha256=BODY,
        handler=handler,
        authority=lambda event: None,
    ) == Executed(response=CREATED, stored=True)


def write_marker(label: str) -> None:
    """A row the handler writes as its effect, so a test can see whether the effect committed."""
    IdempotencyRecord.objects.create(
        issuer=ISSUER,
        subject=MARKER_SUBJECT,
        method="POST",
        path=label,
        key_sha256="0" * 64,
        body_sha256="0" * 64,
        status=200,
        content_type="text/plain",
        body=b"",
    )


def marker_exists(label: str) -> bool:
    return IdempotencyRecord.objects.filter(subject=MARKER_SUBJECT, path=label).exists()


def entries(of: Scope) -> int:
    return IdempotencyRecord.objects.filter(
        issuer=of.issuer, subject=of.subject, path=of.path, key_sha256=of.key_sha256
    ).count()


def backdate(of: Scope, age: timedelta) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE idempotency_record SET created_at = now() - %s * interval '1 second' "
            "WHERE issuer = %s AND subject = %s AND path = %s AND key_sha256 = %s",
            [age.total_seconds(), of.issuer, of.subject, of.path, of.key_sha256],
        )
        assert cursor.rowcount == 1, "the entry to backdate does not exist"


def run(of: Scope, body: str, handler: Callable[[], StoredResponse]) -> Any:
    """The outcome, or None when the store raised a database error."""
    try:
        return store.run_once(scope=of, body_sha256=body, handler=handler)
    except DatabaseError:
        return None


def raw_session() -> psycopg.Connection[Any]:
    assert str(connection.settings_dict["NAME"]).startswith("test_"), "owned test database only"
    return psycopg.connect(**connection.get_connection_params(), autocommit=True)


def make_view(
    handler: Callable[[], StoredResponse], *, issuer: str = ISSUER, subject: str = SUBJECT
) -> Callable[[HttpRequest], HttpResponse]:
    """A test-only POST view, shaped like the repository's views: no route reaches it."""

    def view(request: HttpRequest) -> HttpResponse:
        try:
            response = adapter.respond_once(
                request, issuer=issuer, subject=subject, request_id=REQUEST_ID, handler=handler
            )
        except Exception:
            response = HttpResponse(
                json.dumps({"type": PROBLEMS + "internal-error", "request_id": REQUEST_ID}),
                status=500,
                content_type="application/problem+json",
            )
        response["Cache-Control"] = "no-store"
        response["X-Request-Id"] = REQUEST_ID
        return response

    return view


def post(
    view: Callable[[HttpRequest], HttpResponse], key: str | None, body: bytes, path: str = PATH
) -> HttpResponse:
    headers = {} if key is None else {"Idempotency-Key": key}
    return view(FACTORY.post(path, data=body, content_type="application/json", headers=headers))


def problem_type(response: HttpResponse) -> str | None:
    if response["Content-Type"] != "application/problem+json":
        return None
    return str(json.loads(response.content).get("type"))


# The constraint probes run inside a transaction that is always rolled back; a database mutant
# drops a constraint, or adds a column, inside that same transaction and nowhere else.
DROPPED: list[str] = []
ADDED: list[str] = []


def valid_row(**changes: Any) -> dict[str, Any]:
    row = {
        "issuer": ISSUER,
        "subject": SUBJECT,
        "method": "POST",
        "path": PATH,
        "key_sha256": "a" * 64,
        "body_sha256": "b" * 64,
        "status": 201,
        "content_type": "application/json",
        "body": b"{}",
    }
    return {**row, **changes}


def _mutate_schema(cursor: Any) -> None:
    for name in DROPPED:
        cursor.execute(f"ALTER TABLE idempotency_record DROP CONSTRAINT {name}")
    for column in ADDED:
        cursor.execute(f"ALTER TABLE idempotency_record ADD COLUMN {column} bytea")


def refused_by(rows: list[dict[str, Any]]) -> str | None:
    """The constraint that refused inserting `rows`, in a rolled-back transaction, or None."""
    refused = None
    with transaction.atomic():
        with connection.cursor() as cursor:
            _mutate_schema(cursor)
        try:
            with transaction.atomic():
                for row in rows:
                    IdempotencyRecord.objects.create(**row)
        except IntegrityError as error:
            refused = getattr(getattr(error.__cause__, "diag", None), "constraint_name", None)
        transaction.set_rollback(True)
    return refused


# --------------------------------------------------------------------------------- checks ----


def check_executes_once_then_replays() -> None:
    calls: list[str] = []
    first = run(scope(), BODY, effect(calls, CREATED))
    assert first == Executed(response=CREATED, stored=True) and len(calls) == 1, (
        "the first request was not executed and stored"
    )
    second = run(scope(), BODY, effect(calls, OTHER))
    assert len(calls) == 1, "a replay ran the side effect again"
    assert isinstance(second, Replayed) and second.response == CREATED, (
        "a replay did not return the stored response byte for byte"
    )
    assert entries(scope()) == 1, "a replay stored a second entry"


def check_refusal_is_replayed() -> None:
    calls: list[str] = []
    first = run(scope(), BODY, effect(calls, REFUSAL))
    second = run(scope(), BODY, effect(calls, CREATED))
    assert (
        first == Executed(response=REFUSAL, stored=True)
        and isinstance(second, Replayed)
        and second.response == REFUSAL
        and len(calls) == 1
    ), "a refusal was not stored for replay"
    redirect = StoredResponse(status=302, body=b"", content_type="text/plain")
    try:
        store.run_once(scope=scope(key=SECOND_KEY), body_sha256=BODY, handler=lambda: redirect)
    except ValueError:
        pass
    except DatabaseError:
        raise AssertionError("a 3xx answer was accepted") from None
    else:
        raise AssertionError("a 3xx answer was accepted")
    assert entries(scope(key=SECOND_KEY)) == 0, "a 3xx answer was stored"


def check_reuse_is_refused() -> None:
    calls: list[str] = []
    run(scope(), BODY, effect(calls, CREATED))
    first_seen_at = IdempotencyRecord.objects.get().created_at
    outcome = run(scope(), OTHER_BODY, effect(calls, OTHER))
    assert outcome == KeyReused(first_seen_at=first_seen_at) and len(calls) == 1, (
        "a different body under the same key was not refused as reuse"
    )


def check_transient_refusal_is_not_stored() -> None:
    calls: list[str] = []
    for status, key in ((408, KEY), (429, SECOND_KEY)):
        transient = StoredResponse(status=status, body=b"{}", content_type="application/json")

        def refusing(label: str = f"/effects/{status}", answer: StoredResponse = transient) -> Any:
            calls.append(label)
            write_marker(label)
            return answer

        outcome = run(scope(key=key), BODY, refusing)
        assert (
            outcome == Executed(response=transient, stored=False)
            and entries(scope(key=key)) == 0
            and not marker_exists(f"/effects/{status}")
        ), "a transient refusal was stored"
        again = run(scope(key=key), BODY, effect(calls, CREATED))
        assert again == Executed(response=CREATED, stored=True), (
            "a retry after a transient refusal did not run again"
        )


def check_scoped_per_key() -> None:
    calls: list[str] = []
    run(scope(), BODY, effect(calls, CREATED))
    outcome = run(scope(key=SECOND_KEY), OTHER_BODY, effect(calls, OTHER))
    assert (
        outcome == Executed(response=OTHER, stored=True)
        and len(calls) == 2
        and IdempotencyRecord.objects.count() == 2
    ), "two keys of one scope shared one replay entry"


def check_scoped_per_principal() -> None:
    calls: list[str] = []
    run(scope(), BODY, effect(calls, CREATED))
    for other in (scope(subject="subject-0002"), scope(issuer=ISSUER + "-other")):
        outcome = run(other, OTHER_BODY, effect(calls, OTHER))
        assert outcome == Executed(response=OTHER, stored=True), (
            "two principals shared one replay entry"
        )
    assert len(calls) == 3 and IdempotencyRecord.objects.count() == 3, (
        "two principals shared one replay entry"
    )


def check_scoped_per_path() -> None:
    calls: list[str] = []
    run(scope(), BODY, effect(calls, CREATED))
    outcome = run(scope(path=PATH + "/other"), OTHER_BODY, effect(calls, OTHER))
    assert outcome == Executed(response=OTHER, stored=True) and len(calls) == 2, (
        "two paths shared one replay entry"
    )


def check_whitespace_is_insignificant() -> None:
    compact = b'{"name":"Acme Two","tags":["a b"],"q":"x\\"y"}'
    spaced = b' {\n\t"name" : "Acme Two" ,\r\n "tags": [ "a b" ] , "q" : "x\\"y" }\n'
    assert fingerprint.body_sha256(spaced) == fingerprint.body_sha256(compact), (
        "insignificant whitespace changed the fingerprint"
    )
    for inner in (
        b'{"name":"Acme  Two","tags":["a b"],"q":"x\\"y"}',
        b'{"name":"Acme Two","tags":["ab"],"q":"x\\"y"}',
        b'{"name":"Acme Two","tags":["a b"],"q":"x\\" y"}',
    ):
        assert fingerprint.body_sha256(inner) != fingerprint.body_sha256(compact), (
            "whitespace inside a string did not change the fingerprint"
        )
    assert fingerprint.body_sha256(compact) == hashlib.sha256(compact).hexdigest(), (
        "the fingerprint is not the SHA-256 of the canonical bytes"
    )


def race(first_scope: Scope, second_scope: Scope) -> tuple[dict[str, Any], list[str]]:
    """Two real connections: the first request holds its transaction open inside its handler
    while the second one runs. The outcomes by name, and the second handler's calls."""
    entered, release, second_progressed = threading.Event(), threading.Event(), threading.Event()
    second_calls: list[str] = []
    results: dict[str, Any] = {}

    def first_handler() -> StoredResponse:
        entered.set()
        if not release.wait(8):
            raise RuntimeError("the first request was never released")
        return CREATED

    def second_handler() -> StoredResponse:
        second_calls.append("second")
        second_progressed.set()
        return OTHER

    def request(name: str, of: Scope, handler: Callable[[], StoredResponse]) -> None:
        try:
            results[name] = store.run_once(scope=of, body_sha256=BODY, handler=handler)
        except Exception as error:
            results[name] = type(error).__name__
        finally:
            connection.close()
            if name == "second":
                second_progressed.set()

    first = threading.Thread(target=request, args=("first", first_scope, first_handler))
    second = threading.Thread(target=request, args=("second", second_scope, second_handler))
    first.start()
    try:
        assert entered.wait(5), "the first request never reached its handler"
        second.start()
        assert second_progressed.wait(5), "the second request neither finished nor ran its handler"
    finally:
        release.set()
        first.join(10)
        if second.ident is not None:
            second.join(10)
    assert not first.is_alive() and not second.is_alive(), "a request thread did not finish"
    return results, second_calls


def check_in_flight_is_refused() -> None:
    results, second_calls = race(scope(), scope())
    assert not second_calls, "a concurrent first request ran the side effect"
    assert results.get("second") == InFlight(retry_after_s=RETRY_AFTER_S), (
        "a concurrent first request was not refused in flight"
    )
    assert results.get("first") == Executed(response=CREATED, stored=True), (
        "the first request did not complete once released"
    )
    third = run(scope(), BODY, effect(second_calls, OTHER))
    assert isinstance(third, Replayed) and third.response == CREATED and not second_calls, (
        "the key did not replay after the first request committed"
    )


COLLIDING_LOCK_KEY = 4242


def check_colliding_lock_keys_answer_in_flight() -> None:
    other = scope(key=SECOND_KEY)
    with pytest.MonkeyPatch.context() as patch:
        # Two scopes forced onto one advisory key: a collision may delay, never cross-replay.
        patch.setattr(store, "lock_key", lambda of: COLLIDING_LOCK_KEY)
        results, second_calls = race(scope(), other)
        assert not isinstance(results.get("second"), Replayed), (
            "a colliding lock key replayed another scope's response"
        )
        assert (
            results.get("second") == InFlight(retry_after_s=RETRY_AFTER_S) and not second_calls
        ), "a colliding lock key did not answer in flight"
        after = run(other, BODY, effect(second_calls, OTHER))
    assert after == Executed(response=OTHER, stored=True), (
        "the second scope did not run its own effect once the lock was free"
    )


def spec_lock_key(issuer: str, subject: str, path: str, key: str) -> int:
    """§2.2 of the spec, written out independently of store.lock_key."""
    array = json.dumps([issuer, subject, "POST", path, key], separators=(",", ":"))
    return int.from_bytes(hashlib.sha256(array.encode()).digest()[:8], "big", signed=True)


def check_in_flight_over_http() -> None:
    calls: list[str] = []
    view = make_view(effect(calls, CREATED))
    holder = raw_session()
    try:
        holder.execute("SELECT pg_advisory_lock(%s)", [spec_lock_key(ISSUER, SUBJECT, PATH, KEY)])
        response = post(view, KEY, b'{"name":"Acme"}')
    finally:
        holder.close()
    body = json.loads(response.content)
    assert (
        response.status_code == 409
        and body.get("type") == PROBLEMS + "idempotency-key-in-flight"
        and body.get("retry_after_s") == RETRY_AFTER_S
        and not calls
    ), "a held scope lock did not make the request in flight"
    assert post(view, KEY, b'{"name":"Acme"}').status_code == 201, (
        "the request did not run once the lock was released"
    )


def check_expired_entry_is_replaced() -> None:
    calls: list[str] = []
    run(scope(), BODY, effect(calls, CREATED))
    backdate(scope(), RETENTION + timedelta(seconds=1))
    outcome = run(scope(), OTHER_BODY, effect(calls, OTHER))
    assert outcome == Executed(response=OTHER, stored=True), "an expired entry was still honoured"
    replaced = IdempotencyRecord.objects.get()
    assert replaced.body_sha256 == OTHER_BODY, "an expired entry was not replaced"
    stored = run(scope(key=SECOND_KEY), BODY, effect(calls, CREATED))
    assert stored == Executed(response=CREATED, stored=True), (
        "the second key was not executed and stored"
    )
    backdate(scope(key=SECOND_KEY), RETENTION - timedelta(minutes=1))
    outcome = run(scope(key=SECOND_KEY), OTHER_BODY, effect(calls, OTHER))
    assert isinstance(outcome, KeyReused), "a live entry was treated as expired"


def check_purge_removes_only_expired() -> None:
    calls: list[str] = []
    expired, live = scope(), scope(key=SECOND_KEY)
    run(expired, BODY, effect(calls, CREATED))
    run(live, BODY, effect(calls, CREATED))
    backdate(expired, RETENTION + timedelta(seconds=1))
    backdate(live, RETENTION - timedelta(minutes=1))
    deleted = store.purge_expired().deleted
    assert entries(expired) == 0, "purge kept an expired entry"
    assert entries(live) == 1, "purge removed a live entry"
    assert deleted == 1, "purge miscounted what it deleted"


def check_server_failure_is_not_stored() -> None:
    calls: list[str] = []

    def failing() -> StoredResponse:
        calls.append("failing")
        write_marker("/effects/failed")
        return FAILURE

    outcome = run(scope(), BODY, failing)
    assert outcome == Executed(response=FAILURE, stored=False), (
        "a 5xx response was not handed back unstored"
    )
    assert not marker_exists("/effects/failed"), "a 5xx response committed its effect"
    assert entries(scope()) == 0, "a 5xx response was stored"

    def raising() -> StoredResponse:
        write_marker("/effects/raised")
        raise RuntimeError("synthetic handler failure")

    try:
        store.run_once(scope=scope(key=SECOND_KEY), body_sha256=BODY, handler=raising)
    except RuntimeError:
        pass
    else:
        raise AssertionError("a raising handler was swallowed")
    assert not marker_exists("/effects/raised") and entries(scope(key=SECOND_KEY)) == 0, (
        "a raising handler left its effect or an entry"
    )
    again = run(scope(), BODY, effect(calls, CREATED))
    assert again == Executed(response=CREATED, stored=True) and len(calls) == 2, (
        "a retry after a 5xx did not run again"
    )


def check_own_transaction_required() -> None:
    refused = False
    with transaction.atomic():
        try:
            store.run_once(scope=scope(), body_sha256=BODY, handler=lambda: CREATED)
        except RuntimeError:
            refused = True
        except DatabaseError:
            refused = False
        transaction.set_rollback(True)
    assert refused, "the store joined a caller's transaction"


def check_isolation_is_pinned() -> None:
    seen: dict[str, str] = {}

    def observing() -> StoredResponse:
        with connection.cursor() as cursor:
            cursor.execute("SHOW transaction_isolation")
            seen["level"] = cursor.fetchone()[0]
        return CREATED

    with connection.cursor() as cursor:
        cursor.execute("SET default_transaction_isolation = 'repeatable read'")
    try:
        run(scope(), BODY, observing)
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET default_transaction_isolation")
    assert seen.get("level") == "read committed", "the handler ran at another isolation level"


def check_header_is_validated() -> None:
    calls: list[str] = []
    view = make_view(effect(calls, CREATED))
    body = b'{"name":"Acme"}'
    for key in (None, ""):
        assert problem_type(post(view, key, body)) == PROBLEMS + "idempotency-key-missing", (
            "a request without a key was not refused as missing"
        )
    for key in ("k" * 15, "k" * 256, "key with spaces 0001", "é" * 16):
        assert problem_type(post(view, key, body)) == PROBLEMS + "malformed-request", (
            "an out-of-range key was not refused as malformed"
        )
    assert not calls, "a refused request reached the handler"
    for key in ("k" * 16, "k" * 255):
        assert post(view, key, body).status_code == 201, "a key of 16 or 255 characters was refused"


def check_invalid_scope_is_malformed() -> None:
    calls: list[str] = []
    body = b'{"name":"Acme"}'
    for response in (
        post(make_view(effect(calls, CREATED)), KEY, body, path="/" + "p" * 2100),
        post(make_view(effect(calls, CREATED), issuer="i" * 1025), KEY, body),
        post(make_view(effect(calls, CREATED), subject=""), KEY, body),
        post(make_view(effect(calls, CREATED), subject="sujet-\u00e9"), KEY, body),
    ):
        assert (
            response.status_code == 400 and problem_type(response) == PROBLEMS + "malformed-request"
        ), "an out-of-bounds scope was not refused as malformed"
    assert not calls, "an out-of-bounds scope reached the handler"


def check_replay_is_marked() -> None:
    calls: list[str] = []
    view = make_view(effect(calls, CREATED))
    first = post(view, KEY, b'{"name":"Acme","tags":["a b"]}')
    second = post(view, KEY, b'{ "name" : "Acme",\n "tags" : [ "a b" ] }')
    assert adapter.REPLAYED_HEADER not in first and second.get(adapter.REPLAYED_HEADER) == "true", (
        "a replay did not say so"
    )

    def shape(response: HttpResponse) -> tuple[Any, ...]:
        headers = ("Content-Type", "Location", "ETag", "X-Job-Id")
        return (response.status_code, response.content, *(response.get(h) for h in headers))

    assert (
        shape(first)
        == shape(second)
        == (
            201,
            CREATED.body,
            "application/json",
            CREATED.location,
            CREATED.etag,
            CREATED.job_id,
        )
    ), "a replay over HTTP differed from the first answer"
    assert len(calls) == 1, "a replay over HTTP ran the side effect again"


def check_reuse_problem_over_http() -> None:
    calls: list[str] = []
    view = make_view(effect(calls, CREATED))
    post(view, KEY, b'{"name":"Acme"}')
    created_at = IdempotencyRecord.objects.get().created_at.astimezone(UTC)
    first_seen_at = (
        created_at.strftime("%Y-%m-%dT%H:%M:%S.") + f"{created_at.microsecond // 1000:03d}Z"
    )
    refused = post(view, KEY, b'{"name":"Bravo"}')
    assert (
        refused.status_code == 409
        and refused["Content-Type"] == "application/problem+json"
        and json.loads(refused.content)
        == {
            "type": PROBLEMS + "idempotency-key-reuse",
            "title": "Idempotency key reused with a different body",
            "status": 409,
            "request_id": REQUEST_ID,
            "first_seen_at": first_seen_at,
        }
        and len(calls) == 1
    ), "the reuse problem was not a 409 naming first_seen_at in RFC 3339 Z"


def check_scope_is_unique() -> None:
    assert refused_by([valid_row(), valid_row()]) == "idempotency_record_scope_unique", (
        "two entries of one scope were stored"
    )


TABLE_GUARDS = (
    ("idempotency_record_status_stored", {"status": 503}),
    ("idempotency_record_method_post", {"method": "PUT"}),
    ("idempotency_record_digests_valid", {"key_sha256": "A" * 64}),
    ("idempotency_record_body_bounded", {"body": b"x" * (MAX_BODY_BYTES + 1)}),
    ("idempotency_record_scope_bounded", {"path": "api/v1/organisations"}),
    ("idempotency_record_scope_bounded", {"subject": ""}),
)


def check_table_guards_refuse() -> None:
    assert refused_by([valid_row()]) is None, "the table refused a valid row"
    for constraint, change in TABLE_GUARDS:
        assert refused_by([valid_row(**change)]) == constraint, (
            f"the table accepted a row {constraint} refuses"
        )


STORED_COLUMNS = {
    "id",
    "issuer",
    "subject",
    "method",
    "path",
    "key_sha256",
    "body_sha256",
    "status",
    "content_type",
    "body",
    "location",
    "etag",
    "job_id",
    "created_at",
}


def check_table_holds_only_the_response() -> None:
    calls: list[str] = []
    marker = b"request-body-marker-7f3a"
    post(make_view(effect(calls, CREATED)), KEY, b'{"secret":"' + marker + b'"}')
    with connection.cursor() as cursor:
        cursor.execute("SELECT row_to_json(r)::text FROM idempotency_record r")
        stored = [row[0] for row in cursor.fetchall()]
    assert len(stored) == 1 and marker.decode() not in stored[0], (
        "a stored entry holds bytes of the request body"
    )
    with transaction.atomic():
        with connection.cursor() as cursor:
            _mutate_schema(cursor)
            cursor.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'idempotency_record'"
            )
            columns = {row[0] for row in cursor.fetchall()}
        transaction.set_rollback(True)
    assert columns == STORED_COLUMNS, "the replay table holds a column outside the stored response"


CHECKS: dict[str, Callable[[], None]] = {
    name.removeprefix("check_"): function
    for name, function in dict(globals()).items()
    if name.startswith("check_") and callable(function)
}
WITHOUT_DATABASE = {"whitespace_is_insignificant"}


# -------------------------------------------------------------------------------- mutants ----

ORIGINAL_SCOPE_COLUMNS = store.scope_columns
ORIGINAL_DISPOSITION = store.disposition


def _without(column: str) -> Callable[[Scope], dict[str, str]]:
    def columns(of: Scope) -> dict[str, str]:
        return {k: v for k, v in ORIGINAL_SCOPE_COLUMNS(of).items() if k != column}

    return columns


def _discard_refusals(status: int) -> str:
    return DISCARD if 400 <= status <= 499 else ORIGINAL_DISPOSITION(status)


def _store_transient(status: int) -> str:
    return STORE if status in (408, 429) else ORIGINAL_DISPOSITION(status)


def _store_redirects(status: int) -> str:
    return STORE if 300 <= status <= 399 else ORIGINAL_DISPOSITION(status)


def _scope_unchecked(request: HttpRequest, *, issuer: str, subject: str, key: str) -> Scope:
    return Scope(issuer=issuer, subject=subject, method="POST", path=request.path, key=key)


def _lock_key_without_subject(of: Scope) -> int:
    array = json.dumps([of.issuer, of.method, of.path, of.key], separators=(",", ":"))
    return int.from_bytes(hashlib.sha256(array.encode()).digest()[:8], "big", signed=True)


def _strip_every_whitespace(raw: bytes) -> bytes:
    return bytes(byte for byte in raw if byte not in b" \t\n\r")


def _ignore_escapes(raw: bytes) -> bytes:
    kept, in_string = bytearray(), False
    for byte in raw:
        if in_string or byte not in b" \t\n\r":
            kept.append(byte)
        if byte == 0x22:
            in_string = not in_string
    return bytes(kept)


def _isoformat(value: Any) -> str:
    return str(value.isoformat())


@dataclass(frozen=True)
class Mutant:
    name: str
    target: Any
    attribute: str
    value: Any
    check: str
    message: str


MUTANTS = (
    Mutant(
        "lookup-never-finds",
        store,
        "lookup",
        lambda of: None,
        "executes_once_then_replays",
        "a replay ran the side effect again",
    ),
    Mutant(
        "refusals-discarded",
        store,
        "disposition",
        _discard_refusals,
        "refusal_is_replayed",
        "a refusal was not stored for replay",
    ),
    Mutant(
        "redirects-stored",
        store,
        "disposition",
        _store_redirects,
        "refusal_is_replayed",
        "a 3xx answer was accepted",
    ),
    Mutant(
        "transient-refusals-stored",
        store,
        "disposition",
        _store_transient,
        "transient_refusal_is_not_stored",
        "a transient refusal was stored",
    ),
    Mutant(
        "scope-without-key",
        store,
        "scope_columns",
        _without("key_sha256"),
        "scoped_per_key",
        "two keys of one scope shared one replay entry",
    ),
    Mutant(
        "collision-lock-bypassed",
        store,
        "try_lock",
        lambda of: True,
        "colliding_lock_keys_answer_in_flight",
        "a colliding lock key did not answer in flight",
    ),
    Mutant(
        "invalid-scope-unhandled",
        adapter,
        "scope_for",
        _scope_unchecked,
        "invalid_scope_is_malformed",
        "an out-of-bounds scope was not refused as malformed",
    ),
    Mutant(
        "body-not-compared",
        store,
        "same_body",
        lambda record, body: True,
        "reuse_is_refused",
        "a different body under the same key was not refused as reuse",
    ),
    Mutant(
        "scope-without-subject",
        store,
        "scope_columns",
        _without("subject"),
        "scoped_per_principal",
        "two principals shared one replay entry",
    ),
    Mutant(
        "scope-without-issuer",
        store,
        "scope_columns",
        _without("issuer"),
        "scoped_per_principal",
        "two principals shared one replay entry",
    ),
    Mutant(
        "scope-without-path",
        store,
        "scope_columns",
        _without("path"),
        "scoped_per_path",
        "two paths shared one replay entry",
    ),
    Mutant(
        "raw-bytes-hashed",
        fingerprint,
        "canonical_body",
        lambda raw: raw,
        "whitespace_is_insignificant",
        "insignificant whitespace changed the fingerprint",
    ),
    Mutant(
        "whitespace-stripped-inside-strings",
        fingerprint,
        "canonical_body",
        _strip_every_whitespace,
        "whitespace_is_insignificant",
        "whitespace inside a string did not change the fingerprint",
    ),
    Mutant(
        "escapes-ignored",
        fingerprint,
        "canonical_body",
        _ignore_escapes,
        "whitespace_is_insignificant",
        "insignificant whitespace changed the fingerprint",
    ),
    Mutant(
        "lock-bypassed",
        store,
        "try_lock",
        lambda of: True,
        "in_flight_is_refused",
        "a concurrent first request ran the side effect",
    ),
    Mutant(
        "lock-key-without-subject",
        store,
        "lock_key",
        _lock_key_without_subject,
        "in_flight_over_http",
        "a held scope lock did not make the request in flight",
    ),
    Mutant(
        "retention-widened",
        store,
        "RETENTION",
        timedelta(days=3650),
        "expired_entry_is_replaced",
        "an expired entry was still honoured",
    ),
    Mutant(
        "retention-zero",
        store,
        "RETENTION",
        timedelta(0),
        "expired_entry_is_replaced",
        "a live entry was treated as expired",
    ),
    Mutant(
        "purge-retention-widened",
        store,
        "RETENTION",
        timedelta(days=3650),
        "purge_removes_only_expired",
        "purge kept an expired entry",
    ),
    Mutant(
        "purge-retention-zero",
        store,
        "RETENTION",
        timedelta(0),
        "purge_removes_only_expired",
        "purge removed a live entry",
    ),
    Mutant(
        "server-failure-stored",
        store,
        "disposition",
        lambda status: STORE,
        "server_failure_is_not_stored",
        "a 5xx response was not handed back unstored",
    ),
    Mutant(
        "server-failure-committed",
        store,
        "roll_back",
        lambda response: None,
        "server_failure_is_not_stored",
        "a 5xx response committed its effect",
    ),
    Mutant(
        "caller-transaction-joined",
        store,
        "require_own_transaction",
        lambda: None,
        "own_transaction_required",
        "the store joined a caller's transaction",
    ),
    Mutant(
        "isolation-not-pinned",
        store,
        "PIN_ISOLATION",
        "SELECT 1",
        "isolation_is_pinned",
        "the handler ran at another isolation level",
    ),
    Mutant(
        "missing-key-not-refused",
        adapter,
        "is_missing",
        lambda value: False,
        "header_is_validated",
        "a request without a key was not refused as missing",
    ),
    Mutant(
        "key-length-unbounded",
        store,
        "KEY",
        re.compile(r"[\x21-\x7e]+\Z"),
        "header_is_validated",
        "an out-of-range key was not refused as malformed",
    ),
    Mutant(
        "replay-unmarked",
        adapter,
        "mark_replayed",
        lambda response: None,
        "replay_is_marked",
        "a replay did not say so",
    ),
    Mutant(
        "first-seen-at-not-rfc3339-z",
        adapter,
        "timestamp",
        _isoformat,
        "reuse_problem_over_http",
        "the reuse problem was not a 409 naming first_seen_at in RFC 3339 Z",
    ),
    Mutant(
        "scope-unique-dropped",
        DROPPED,
        "",
        "idempotency_record_scope_unique",
        "scope_is_unique",
        "two entries of one scope were stored",
    ),
    *(
        Mutant(
            f"{constraint}-dropped",
            DROPPED,
            "",
            constraint,
            "table_guards_refuse",
            f"the table accepted a row {constraint} refuses",
        )
        for constraint in dict(TABLE_GUARDS)
    ),
    Mutant(
        "request-body-column-added",
        ADDED,
        "",
        "request_body",
        "table_holds_only_the_response",
        "the replay table holds a column outside the stored response",
    ),
)


# The marker, not a fixture requested from the test body: pytest-django decides whether a test is
# transactional from its marker and its declared fixtures, and a `transactional_db` requested at run
# time still wraps the test in a transaction, inside which the store refuses to run.
TRANSACTIONAL = pytest.mark.django_db(transaction=True)


def _database(name: str) -> tuple[pytest.MarkDecorator, ...]:
    return () if name in WITHOUT_DATABASE else (TRANSACTIONAL,)


@pytest.mark.parametrize(
    "name", [pytest.param(name, marks=_database(name), id=name) for name in sorted(CHECKS)]
)
def test_check_holds(name: str) -> None:
    if name not in WITHOUT_DATABASE:
        assert connection.vendor == "postgresql", "the replay store needs PostgreSQL"
        assert not connection.in_atomic_block, "the check runs outside any test transaction"
    CHECKS[name]()


@pytest.mark.parametrize(
    "mutant",
    [pytest.param(mutant, marks=_database(mutant.check), id=mutant.name) for mutant in MUTANTS],
)
def test_each_mutant_is_caught_by_its_owning_check(
    mutant: Mutant, monkeypatch: pytest.MonkeyPatch
) -> None:
    try:
        if isinstance(mutant.target, list):
            mutant.target.append(mutant.value)
        else:
            monkeypatch.setattr(mutant.target, mutant.attribute, mutant.value)
        with pytest.raises(AssertionError) as caught:
            CHECKS[mutant.check]()
    finally:
        DROPPED.clear()
        ADDED.clear()
        monkeypatch.undo()
    first_line = str(caught.value).split("\n")[0]
    assert first_line == mutant.message, (
        f"{mutant.name} was caught by another failure than its own: {first_line}"
    )


def test_every_check_has_a_mutant_and_every_mutant_a_check() -> None:
    owned = {mutant.check for mutant in MUTANTS}
    assert owned == set(CHECKS), (
        f"checks never seen to fail: {sorted(set(CHECKS) - owned)}; "
        f"mutants of no check: {sorted(owned - set(CHECKS))}"
    )
    assert len({mutant.name for mutant in MUTANTS}) == len(MUTANTS), "two mutants share a name"


class _FinalDeniedError(PermissionError):
    pass


def _final_snapshot():
    return list(IdempotencyRecord.objects.order_by("pk").values())


def _final_assert_events(events, expected):
    kinds = []
    for event in events:
        assert type(event) is store.FinalAuthority, "FINAL_EVENT_SHAPE"
        fields = vars(event)
        assert set(fields) == {"kind"}, "FINAL_EVENT_SHAPE"
        kind = fields["kind"]
        assert type(kind) is str and kind in {
            "fresh_success",
            "successful_replay",
            "key_reused",
            "in_flight",
        }, "FINAL_EVENT_SHAPE"
        kinds.append(kind)
    assert tuple(kinds) == expected, "FINAL_EVENT_SEQUENCE"


def _final_unit_probe(monkeypatch, branch, mode):
    receipt = (
        _unit_receipt(403 if branch == "negative_replay" else 200)
        if branch in {"successful_replay", "negative_replay", "key_reused"}
        else None
    )
    seen, created, deleted = _authority_unit(
        monkeypatch, record=receipt, locked=branch != "in_flight"
    )
    original_response = store._response
    original_create = store.IdempotencyRecord.objects.create
    legacy_events = []
    final_events = []
    legacy = mode in {"legacy", "combined"}
    opted_in = mode in {"final", "combined"}

    def response(record):
        seen.append("bytes")
        return original_response(record)

    def create(**values):
        seen.append("receipt")
        return original_create(**values)

    def handler():
        seen.append("handler")
        return REFUSAL if branch == "fresh_negative" else CREATED

    def authority(event):
        legacy_events.append(event)
        seen.append(type(event).__name__)

    def final(event):
        final_events.append(event)
        seen.append("final:" + event.kind)

    monkeypatch.setattr(store, "_response", response)
    monkeypatch.setattr(store.IdempotencyRecord.objects, "create", create)
    if opted_in:
        outcome_name = (
            "Replayed"
            if branch in {"successful_replay", "negative_replay"}
            else "KeyReused"
            if branch == "key_reused"
            else "InFlight"
            if branch == "in_flight"
            else "Executed"
        )
        original_outcome = getattr(store, outcome_name)

        def outcome(*arguments, **keywords):
            seen.append("outcome")
            return original_outcome(*arguments, **keywords)

        monkeypatch.setattr(store, outcome_name, outcome)
    else:

        def unexpected_final(callback, event):
            pytest.fail("legacy call invoked the new final boundary")

        def unexpected_final_construction(*arguments, **keywords):
            pytest.fail("legacy call constructed a final event")

        monkeypatch.setattr(store, "_invoke_final_authority", unexpected_final)
        monkeypatch.setattr(store, "FinalAuthority", unexpected_final_construction)
    arguments = {}
    if mode == "none":
        arguments["final_authority"] = None
    if legacy:
        arguments["authority"] = authority
    if opted_in:
        arguments["final_authority"] = final
    result = store._execute(
        scope(),
        OTHER_BODY if branch == "key_reused" else BODY,
        handler,
        **arguments,
    )
    expected = [store.PIN_ISOLATION]
    if legacy:
        expected.append("EnterAuthority")
    expected.append("key-lock")
    if branch != "in_flight":
        expected.append("lookup")
    if legacy:
        expected.append(
            "FreshAuthority"
            if branch.startswith("fresh_")
            else "ReplayAuthority"
            if branch.endswith("replay")
            else "MetadataAuthority"
        )
    if branch.startswith("fresh_"):
        expected.extend(["handler", "receipt"])
    elif branch.endswith("replay"):
        expected.append("bytes")
    if opted_in:
        expected.append("outcome")
    kinds = () if branch in {"fresh_negative", "negative_replay"} else (branch,)
    if opted_in and kinds:
        expected.append("final:" + branch)
    assert seen == expected, "FINAL_EXACT_CHECKPOINT_ORDER"
    _final_assert_events(final_events, kinds if opted_in else ())
    assert not deleted
    if branch.startswith("fresh_"):
        wanted = REFUSAL if branch == "fresh_negative" else CREATED
        assert result == Executed(response=wanted, stored=True)
        assert len(created) == 1
        assert created[0] == {
            **store.scope_columns(scope()),
            "body_sha256": BODY,
            "status": wanted.status,
            "content_type": wanted.content_type,
            "body": wanted.body,
            "location": wanted.location,
            "etag": wanted.etag,
            "job_id": wanted.job_id,
        }
    elif branch.endswith("replay"):
        assert isinstance(result, Replayed)
        assert result.response == original_response(receipt)
        assert result.first_seen_at == receipt.created_at
        assert not created
    else:
        assert isinstance(result, KeyReused if branch == "key_reused" else InFlight)
        assert not created
        assert vars(result) == (
            {"first_seen_at": receipt.created_at}
            if branch == "key_reused"
            else {"retry_after_s": 1}
        )
    if legacy:
        assert vars(legacy_events[0]) == {}
        assert vars(legacy_events[1]) == (
            {"status": 403 if branch == "negative_replay" else 200}
            if branch.endswith("replay")
            else {"kind": branch}
            if branch in {"key_reused", "in_flight"}
            else {}
        )
    else:
        assert legacy_events == []


@pytest.mark.parametrize("mode", ["omitted", "none", "legacy"])
@pytest.mark.parametrize(
    "branch",
    [
        "fresh_success",
        "fresh_negative",
        "successful_replay",
        "negative_replay",
        "key_reused",
        "in_flight",
    ],
)
def test_final_authority_default_and_old_collector_keep_exact_unit_parity(
    monkeypatch, branch, mode
):
    _final_unit_probe(monkeypatch, branch, mode)


@pytest.mark.parametrize("mode", ["final", "combined"])
@pytest.mark.parametrize(
    "branch",
    [
        "fresh_success",
        "fresh_negative",
        "successful_replay",
        "negative_replay",
        "key_reused",
        "in_flight",
    ],
)
def test_final_authority_opt_in_runs_after_actual_materialization(monkeypatch, branch, mode):
    _final_unit_probe(monkeypatch, branch, mode)


def test_final_authority_closed_event_and_sequence_guard_refuse_and_restore():
    from dataclasses import FrozenInstanceError

    expected = ("fresh_success", "successful_replay")

    def pristine():
        events = [store.FinalAuthority(kind) for kind in expected]
        _final_assert_events(events, expected)
        return events

    pristine()
    for kind in (None, True, 1, "", "fresh", "unknown"):
        with pytest.raises(ValueError) as caught:
            store.FinalAuthority(kind)
        assert str(caught.value) == "final authority kind must name a closed outcome"
        pristine()
    with pytest.raises(TypeError):
        store.FinalAuthority("fresh_success", status=200)
    pristine()
    immutable = store.FinalAuthority("fresh_success")
    with pytest.raises(FrozenInstanceError):
        immutable.kind = "in_flight"
    assert vars(immutable) == {"kind": "fresh_success"}
    pristine()
    for mutation, marker in (
        ("foreign", "FINAL_EVENT_SHAPE"),
        ("kind", "FINAL_EVENT_SHAPE"),
        ("extra", "FINAL_EVENT_SHAPE"),
        ("missing", "FINAL_EVENT_SEQUENCE"),
        ("duplicate", "FINAL_EVENT_SEQUENCE"),
        ("order", "FINAL_EVENT_SEQUENCE"),
    ):
        changed = pristine()
        if mutation == "foreign":
            changed[0] = object()
        elif mutation == "kind":
            object.__setattr__(changed[0], "kind", "unknown")
        elif mutation == "extra":
            object.__setattr__(changed[0], "body", b"NO_LOG")
        elif mutation == "missing":
            changed.pop()
        elif mutation == "duplicate":
            changed.insert(0, changed[0])
        else:
            changed.reverse()
        with pytest.raises(AssertionError) as caught:
            _final_assert_events(changed, expected)
        assert str(caught.value).splitlines()[0] == marker
        pristine()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("mode", ["omitted", "none", "legacy"])
def test_final_authority_default_keeps_real_database_results_and_old_sequences(monkeypatch, mode):
    legacy = []
    arguments = {}
    if mode == "none":
        arguments["final_authority"] = None
    if mode == "legacy":
        arguments["authority"] = legacy.append

    def forbidden_final(callback, event):
        pytest.fail("a default client opted into final authority")

    def forbidden_final_construction(*arguments, **keywords):
        pytest.fail("a default client constructed a final event")

    monkeypatch.setattr(store, "_invoke_final_authority", forbidden_final)
    monkeypatch.setattr(store, "FinalAuthority", forbidden_final_construction)
    first = store.run_once(scope=scope(), body_sha256=BODY, handler=lambda: CREATED, **arguments)
    assert first == Executed(response=CREATED, stored=True)
    before = _final_snapshot()
    replay = store.run_once(scope=scope(), body_sha256=BODY, handler=lambda: OTHER, **arguments)
    assert isinstance(replay, Replayed) and replay.response == CREATED
    assert _final_snapshot() == before
    negative_scope = scope(key=SECOND_KEY)
    assert store.run_once(
        scope=negative_scope, body_sha256=BODY, handler=lambda: REFUSAL, **arguments
    ) == Executed(response=REFUSAL, stored=True)
    before = _final_snapshot()
    negative = store.run_once(
        scope=negative_scope, body_sha256=BODY, handler=lambda: CREATED, **arguments
    )
    assert isinstance(negative, Replayed) and negative.response == REFUSAL
    reused = store.run_once(
        scope=scope(), body_sha256=OTHER_BODY, handler=lambda: OTHER, **arguments
    )
    assert isinstance(reused, KeyReused)
    with monkeypatch.context() as held:
        held.setattr(store, "try_lock", lambda current: False)
        flight = store.run_once(scope=scope(), body_sha256=BODY, handler=lambda: OTHER, **arguments)
    assert flight == InFlight(retry_after_s=1)
    assert _final_snapshot() == before
    assert entries(scope()) == entries(negative_scope) == 1
    assert [type(event).__name__ for event in legacy] == (
        [
            "EnterAuthority",
            "FreshAuthority",
            "EnterAuthority",
            "ReplayAuthority",
            "EnterAuthority",
            "FreshAuthority",
            "EnterAuthority",
            "ReplayAuthority",
            "EnterAuthority",
            "MetadataAuthority",
            "EnterAuthority",
            "MetadataAuthority",
        ]
        if mode == "legacy"
        else []
    )


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "branch",
    [
        "fresh_success",
        "fresh_negative",
        "successful_replay",
        "negative_replay",
        "key_reused",
        "in_flight",
        "discard_408",
        "discard_429",
        "discard_503",
    ],
)
def test_final_authority_actual_database_checkpoints_and_negative_policy(monkeypatch, branch):
    current = scope()
    if branch in {"successful_replay", "negative_replay", "key_reused"}:
        stored = REFUSAL if branch == "negative_replay" else CREATED
        store.run_once(scope=current, body_sha256=BODY, handler=lambda: stored)
    before = _final_snapshot()
    events = []
    materialized = []
    handled = []
    original_response = store._response
    effect_path = "/effects/final-policy"

    def response(record):
        result = original_response(record)
        materialized.append(result)
        return result

    def handler():
        handled.append(True)
        write_marker(effect_path)
        if branch == "fresh_negative":
            return REFUSAL
        if branch.startswith("discard_"):
            return StoredResponse(
                status=int(branch.split("_")[1]), body=b"{}", content_type="application/json"
            )
        return CREATED

    def final(event):
        assert connection.in_atomic_block
        _final_assert_events([event], (branch,))
        if branch == "fresh_success":
            assert entries(current) == 1 and marker_exists(effect_path)
            record = IdempotencyRecord.objects.get(**store.scope_columns(current))
            assert bytes(record.body) == CREATED.body and record.status == CREATED.status
        elif branch == "successful_replay":
            assert materialized == [CREATED]
        else:
            assert not materialized and not handled
        events.append(event)

    monkeypatch.setattr(store, "_response", response)
    with monkeypatch.context() as held:
        if branch == "in_flight":
            held.setattr(store, "try_lock", lambda value: False)
        result = store.run_once(
            scope=current,
            body_sha256=OTHER_BODY if branch == "key_reused" else BODY,
            handler=handler,
            final_authority=final,
        )
    wanted = (
        ()
        if branch in {"fresh_negative", "negative_replay"} or branch.startswith("discard_")
        else (branch,)
    )
    _final_assert_events(events, wanted)
    assert handled == ([True] if branch.startswith(("fresh_", "discard_")) else [])
    if branch.startswith("fresh_"):
        assert result == Executed(
            response=REFUSAL if branch == "fresh_negative" else CREATED, stored=True
        )
        assert entries(current) == 1 and marker_exists(effect_path)
    elif branch.startswith("discard_"):
        assert isinstance(result, Executed) and not result.stored
        assert result.response.status == int(branch.split("_")[1])
        assert _final_snapshot() == before and not marker_exists(effect_path)
    elif branch.endswith("replay"):
        assert isinstance(result, Replayed)
        assert result.response == (REFUSAL if branch == "negative_replay" else CREATED)
        assert _final_snapshot() == before
    else:
        assert isinstance(result, KeyReused if branch == "key_reused" else InFlight)
        assert _final_snapshot() == before
    assert not connection.in_atomic_block


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("mode", ["omitted", "none", "set"])
def test_final_authority_actual_http_store_forwarding_and_exact_default_kwargs(
    monkeypatch, legacy, mode
):
    legacy_events = []
    final_events = []
    legacy_callback = legacy_events.append
    final_callback = final_events.append
    original_run = store.run_once
    original_execute = store._execute
    run_calls = []
    execute_calls = []

    def run_boundary(**arguments):
        run_calls.append(dict(arguments))
        return original_run(**arguments)

    def execute_boundary(*arguments, **keywords):
        execute_calls.append(dict(keywords))
        return original_execute(*arguments, **keywords)

    monkeypatch.setattr(store, "run_once", run_boundary)
    monkeypatch.setattr(store, "_execute", execute_boundary)
    arguments = {}
    if legacy:
        arguments["authority"] = legacy_callback
    if mode == "none":
        arguments["final_authority"] = None
    elif mode == "set":
        arguments["final_authority"] = final_callback

    def handler():
        return CREATED

    request = FACTORY.post(
        PATH, b"{}", content_type="application/json", headers={"Idempotency-Key": KEY}
    )
    result = adapter.respond_once(
        request,
        issuer=ISSUER,
        subject=SUBJECT,
        request_id=REQUEST_ID,
        handler=handler,
        **arguments,
    )
    assert result.status_code == CREATED.status and result.content == CREATED.body
    assert result["Location"] == CREATED.location and result["ETag"] == CREATED.etag
    assert result["X-Job-Id"] == CREATED.job_id
    assert len(run_calls) == len(execute_calls) == 1
    passed = run_calls[0]
    expected_keys = {"scope", "body_sha256", "handler"}
    if legacy or mode == "set":
        expected_keys.add("authority")
    if mode == "set":
        expected_keys.add("final_authority")
    assert set(passed) == expected_keys, "FINAL_HTTP_DEFAULT_KWARGS"
    assert passed["handler"] is handler
    assert passed["scope"] == scope()
    assert passed["body_sha256"] == fingerprint.body_sha256(b"{}")
    if "authority" in passed:
        assert passed["authority"] is (legacy_callback if legacy else None)
    if mode == "set":
        assert passed["final_authority"] is final_callback, "FINAL_HTTP_CALLABLE_IDENTITY"
    inner = execute_calls[0]
    assert set(inner) == ({"authority", "final_authority"} if mode == "set" else {"authority"}), (
        "FINAL_STORE_DEFAULT_KWARGS"
    )
    assert inner["authority"] is (legacy_callback if legacy else None)
    if mode == "set":
        assert inner["final_authority"] is final_callback, "FINAL_STORE_CALLABLE_IDENTITY"
    _final_assert_events(final_events, ("fresh_success",) if mode == "set" else ())
    assert [type(event).__name__ for event in legacy_events] == (
        ["EnterAuthority", "FreshAuthority"] if legacy else []
    )
    assert entries(scope()) == 1 and not connection.in_atomic_block


def _final_release_probe(monkeypatch, label):
    current = scope(key="final-release-" + label)
    before = _final_snapshot()
    handled = []
    receipts = []
    visited = []
    primary = _FinalDeniedError("closed-final-refusal")
    original_create = IdempotencyRecord.objects.create

    def create(**values):
        result = original_create(**values)
        if values.get("subject") == SUBJECT and values.get("key_sha256") == current.key_sha256:
            receipts.append(result.pk)
        return result

    def handler():
        handled.append(True)
        write_marker("/effects/" + current.key)
        return CREATED

    def final(event):
        assert connection.in_atomic_block
        _final_assert_events([event], ("fresh_success",))
        assert entries(current) == 1 and len(receipts) == 1
        visited.append(True)
        raise primary

    caught = None
    released = None
    with monkeypatch.context() as observe:
        observe.setattr(IdempotencyRecord.objects, "create", create)
        try:
            released = adapter.respond_once(
                FACTORY.post(
                    PATH,
                    b"{}",
                    content_type="application/json",
                    headers={"Idempotency-Key": current.key},
                ),
                issuer=ISSUER,
                subject=SUBJECT,
                request_id=REQUEST_ID,
                handler=handler,
                final_authority=final,
            )
        except _FinalDeniedError as error:
            caught = error
    assert handled == [True] and len(receipts) == 1, "FINAL_REAL_MATERIALIZATION_REQUIRED"
    assert released is None, "FINAL_FORBIDDEN_RELEASE"
    assert caught is primary and visited == [True]
    assert _final_snapshot() == before
    assert not connection.in_atomic_block


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("fault", ["http-omission", "store-omission", "final-omission"])
def test_final_authority_each_actual_forwarding_omission_exposes_release_and_restores(
    monkeypatch, fault
):
    _final_release_probe(monkeypatch, fault + "-pristine")
    original_run = store.run_once
    original_execute = store._execute
    with monkeypatch.context() as broken:
        if fault == "http-omission":

            def omit_http(**arguments):
                arguments.pop("final_authority", None)
                return original_run(**arguments)

            broken.setattr(store, "run_once", omit_http)
        elif fault == "store-omission":

            def omit_store(*arguments, **keywords):
                keywords.pop("final_authority", None)
                return original_execute(*arguments, **keywords)

            broken.setattr(store, "_execute", omit_store)
        else:
            broken.setattr(store, "_invoke_final_authority", lambda callback, event: None)
        with pytest.raises(AssertionError) as caught:
            _final_release_probe(broken, fault + "-fault")
        assert str(caught.value).splitlines()[0] == "FINAL_FORBIDDEN_RELEASE"
    _final_release_probe(monkeypatch, fault + "-restored")


def _final_rollback_probe(monkeypatch, branch, label):
    current = scope(key="final-rollback-" + label)
    if branch in {"successful_replay", "key_reused"}:
        store.run_once(scope=current, body_sha256=BODY, handler=lambda: CREATED)
    before = _final_snapshot()
    handled = []
    materialized = []
    visited = []
    original_response = store._response
    primary = _FinalDeniedError("closed-final-refusal")

    def response(record):
        value = original_response(record)
        materialized.append(value)
        return value

    def handler():
        handled.append(True)
        write_marker("/effects/" + current.key)
        return CREATED

    def final(event):
        assert connection.in_atomic_block
        _final_assert_events([event], (branch,))
        assert entries(current) == (0 if branch == "in_flight" else 1)
        if branch == "fresh_success":
            assert marker_exists("/effects/" + current.key)
        if branch == "successful_replay":
            assert materialized == [CREATED]
        visited.append(True)
        write_marker("/hook/" + current.key)
        raise primary

    caught = None
    released = None
    with monkeypatch.context() as controlled:
        controlled.setattr(store, "_response", response)
        if branch == "in_flight":
            controlled.setattr(store, "try_lock", lambda value: False)
        try:
            released = store.run_once(
                scope=current,
                body_sha256=OTHER_BODY if branch == "key_reused" else BODY,
                handler=handler,
                final_authority=final,
            )
        except _FinalDeniedError as error:
            caught = error
    assert visited == [True], "FINAL_ACTUAL_LATE_CALLBACK_REQUIRED"
    assert handled == ([True] if branch == "fresh_success" else [])
    assert materialized == ([CREATED] if branch == "successful_replay" else [])
    assert _final_snapshot() == before, "FINAL_ATOMIC_ROLLBACK"
    assert released is None and caught is primary
    assert not connection.in_atomic_block


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "branch", ["fresh_success", "successful_replay", "key_reused", "in_flight"]
)
def test_final_authority_escape_rolls_back_actual_handler_receipt_and_hook_writes(
    monkeypatch, branch
):
    _final_rollback_probe(monkeypatch, branch, branch + "-pristine")


@pytest.mark.django_db(transaction=True)
def test_final_authority_swallowed_inside_atomic_commits_effects_and_is_refused(monkeypatch):
    _final_rollback_probe(monkeypatch, "fresh_success", "catch-pristine")
    original = store._invoke_final_authority
    with monkeypatch.context() as broken:

        def swallowed(callback, event):
            try:
                original(callback, event)
            except _FinalDeniedError:
                return None

        broken.setattr(store, "_invoke_final_authority", swallowed)
        with pytest.raises(AssertionError) as caught:
            _final_rollback_probe(broken, "fresh_success", "catch-fault")
        assert str(caught.value).splitlines()[0] == "FINAL_ATOMIC_ROLLBACK"
    _final_rollback_probe(monkeypatch, "fresh_success", "catch-restored")
