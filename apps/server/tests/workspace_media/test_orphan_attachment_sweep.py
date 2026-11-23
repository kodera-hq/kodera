"""End-to-end tests for bounded, resumable S3 orphan attachment sweep (`kodera#253`)."""

from __future__ import annotations

import hashlib
import io
import json
import secrets
import tempfile
import threading
from contextlib import contextmanager
from datetime import UTC, timedelta
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
from uuid import UUID, uuid4

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.utils import timezone
from workspace_safety.test_moderation import world as world

from apps.media import outbound, services as media_service, storage_gateway, storage_worker
from apps.media.models import Attachment
from apps.media.storage import ObjectKey, StorageRefusedError
from apps.orgs.erasure_services import database_now
from apps.orgs.models import Organisation, SlugReservation

pytestmark = pytest.mark.django_db


def _list_xml(
    org_id: UUID,
    entries: list[tuple[str, str]],
    *,
    is_truncated: bool = False,
    next_token: str | None = None,
    prefix_override: str | None = None,
) -> bytes:
    prefix = prefix_override or f"organisations/{org_id}/attachments/"
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
        f"<Prefix>{prefix}</Prefix>",
        f"<IsTruncated>{'true' if is_truncated else 'false'}</IsTruncated>",
    ]
    if next_token is not None:
        parts.append(f"<NextContinuationToken>{next_token}</NextContinuationToken>")
    for key, last_mod in entries:
        last_mod_xml = f"<LastModified>{last_mod}</LastModified>" if last_mod else ""
        parts.append(f"<Contents><Key>{key}</Key>{last_mod_xml}</Contents>")
    parts.append("</ListBucketResult>")
    return "".join(parts).encode("utf-8")


@contextmanager
def _worker_socket(org_ids: list[UUID], responder):
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="k-swp-") as raw_dir:
        base = Path(raw_dir)
        secrets_dir = base / "secrets"
        secrets_dir.mkdir()
        for oid in org_ids:
            (secrets_dir / str(oid)).write_text(
                json.dumps(
                    {
                        "endpoint": "https://storage.example.org",
                        "bucket": "example-bucket",
                        "region": "fr-par",
                        "accessKey": secrets.token_hex(12),
                        "secretKey": secrets.token_urlsafe(32),
                    }
                ),
                encoding="utf-8",
            )
        sock_path = base / "media.sock"
        orig_request = outbound.request
        outbound.request = responder
        server = storage_worker.bind(sock_path, storage_worker.DirectorySource(secrets_dir))
        thread = threading.Thread(
            target=lambda: server.serve_forever(poll_interval=0.01),
            daemon=True,
        )
        thread.start()
        try:
            yield str(sock_path)
        finally:
            outbound.request = orig_request
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


def test_worker_attachment_prefix_objects_parses_utc_timestamps_and_preserves_legacy_prefix_shape():
    org_id = uuid4()
    att_1 = uuid4()
    att_2 = uuid4()
    key_1 = ObjectKey(org_id, att_1).key
    key_2 = ObjectKey(org_id, att_2).key

    xml_payload = _list_xml(
        org_id,
        [
            (key_1, "2026-11-23T00:00:00Z"),
            (key_2, "2026-11-23T02:30:00+02:00"),
        ],
        is_truncated=True,
        next_token="tok-2",
    )

    def responder(destination, **kwargs):
        return SimpleNamespace(close=lambda: None), SimpleNamespace(
            status=200,
            read=lambda n: xml_payload[:n],
            close=lambda: None,
        )

    with _worker_socket([org_id], responder) as sock:
        # Existing `attachment_prefix` shape (`{"keys", "continuation"}`) stays intact.
        legacy = storage_gateway.attachment_prefix(org_id, socket_path=sock)
        assert legacy == {"keys": [key_1, key_2], "continuation": "tok-2"}

        # New `attachment_prefix_objects` returns normalized UTC timestamps.
        modern = storage_gateway.attachment_prefix_objects(org_id, socket_path=sock)
        assert modern == {
            "objects": [
                {"key": key_1, "last_modified": "2026-11-23T00:00:00Z"},
                {"key": key_2, "last_modified": "2026-11-23T00:30:00Z"},
            ],
            "continuation": "tok-2",
        }


@pytest.mark.parametrize(
    "bad_xml_builder",
    [
        # Missing LastModified
        lambda oid: _list_xml(oid, [(ObjectKey(oid, uuid4()).key, "")]),
        # Naive timestamp without timezone
        lambda oid: _list_xml(oid, [(ObjectKey(oid, uuid4()).key, "2026-11-23T00:00:00")]),
        # > 10 objects on a max-keys=10 page
        lambda oid: _list_xml(
            oid, [(ObjectKey(oid, uuid4()).key, "2026-11-23T00:00:00Z") for _ in range(11)]
        ),
        # Cross-tenant key inside XML
        lambda oid: _list_xml(oid, [(ObjectKey(uuid4(), uuid4()).key, "2026-11-23T00:00:00Z")]),
        # Repeating continuation token loop
        lambda oid: _list_xml(
            oid,
            [(ObjectKey(oid, uuid4()).key, "2026-11-23T00:00:00Z")],
            is_truncated=True,
            next_token="same-tok",
        ),
        # XML entity declaration refused
        lambda _oid: b'<!DOCTYPE foo [<!ENTITY xxe "bad">]><ListBucketResult/>',
    ],
)
def test_worker_attachment_prefix_objects_refuses_malformed_or_unsafe_s3_pages(bad_xml_builder):
    org_id = uuid4()
    payload = bad_xml_builder(org_id)

    def responder(destination, **kwargs):
        return SimpleNamespace(close=lambda: None), SimpleNamespace(
            status=200,
            read=lambda n: payload[:n],
            close=lambda: None,
        )

    with _worker_socket([org_id], responder) as sock:
        with pytest.raises(StorageRefusedError):
            storage_gateway.attachment_prefix_objects(
                org_id, continuation="same-tok", socket_path=sock
            )


def test_sweep_deletes_only_aged_rowless_orphans_and_never_touches_tracked_or_recent_objects(world):
    org, _ws, members, _tokens = world
    # Ensure no other orgs complicate the single-org assertion; isolate via after_org predecessor.
    now_db = database_now()
    aged_iso = (now_db - timedelta(seconds=605)).astimezone(UTC).isoformat().replace("+00:00", "Z")
    recent_iso = (
        (now_db - timedelta(seconds=590)).astimezone(UTC).isoformat().replace("+00:00", "Z")
    )

    # Create 3 Attachment rows in PostgreSQL: pending, completed, and cancelled tombstone.
    digest = hashlib.sha256(b"tracked").hexdigest()
    pending_row = Attachment.objects.create(
        organisation=org,
        uploader=members[3],
        room_id="!sweep:matrix.kodera.test",
        filename="pending.txt",
        content_type="text/plain",
        size_bytes=7,
        sha256=digest,
        upload_expires_at=now_db + timedelta(seconds=120),
    )
    completed_row = Attachment.objects.create(
        organisation=org,
        uploader=members[3],
        room_id="!sweep:matrix.kodera.test",
        filename="completed.txt",
        content_type="text/plain",
        size_bytes=7,
        sha256=digest,
        upload_expires_at=now_db - timedelta(hours=3),
        completed_at=now_db - timedelta(hours=3),
    )
    cancelled_row = Attachment.objects.create(
        organisation=org,
        uploader=members[3],
        room_id="!sweep:matrix.kodera.test",
        filename="cancelled.txt",
        content_type="text/plain",
        size_bytes=7,
        sha256=digest,
        upload_expires_at=now_db + timedelta(seconds=120),
        cancelled_at=now_db - timedelta(seconds=30),
    )

    recent_orphan_id = uuid4()
    aged_orphan_id = uuid4()

    s3_objects: dict[str, str] = {
        ObjectKey(org.id, pending_row.id).key: aged_iso,
        ObjectKey(org.id, completed_row.id).key: aged_iso,
        ObjectKey(org.id, cancelled_row.id).key: aged_iso,
        ObjectKey(org.id, recent_orphan_id).key: recent_iso,
        ObjectKey(org.id, aged_orphan_id).key: aged_iso,
    }
    other_org_ids = list(
        Organisation.objects.filter(deleted_at__isnull=True)
        .exclude(realm="kodera-staff")
        .exclude(id=org.id)
        .values_list("id", flat=True)
    )
    delete_calls: list[str] = []
    head_calls: list[str] = []

    def s3_responder(destination, **kwargs):
        method = kwargs["method"]
        parsed_url = urlsplit(destination.url)
        # Path is /example-bucket/<key> or /example-bucket
        rel = parsed_url.path.removeprefix("/example-bucket").lstrip("/")
        if method == "GET":
            qs = parse_qs(parsed_url.query)
            prefix = qs["prefix"][0]
            target_org = UUID(prefix.split("/")[1])
            entries = [(k, ts) for k, ts in sorted(s3_objects.items()) if k.startswith(prefix)]
            body = _list_xml(target_org, entries)
            return SimpleNamespace(close=lambda: None), SimpleNamespace(
                status=200, read=lambda n: body[:n], close=lambda: None
            )
        if method == "DELETE":
            delete_calls.append(rel)
            s3_objects.pop(rel, None)
            return SimpleNamespace(close=lambda: None), SimpleNamespace(
                status=204, close=lambda: None
            )
        if method == "HEAD":
            head_calls.append(rel)
            status = 200 if rel in s3_objects else 404
            return SimpleNamespace(close=lambda: None), SimpleNamespace(
                status=status, close=lambda: None
            )
        raise AssertionError(f"Unexpected method {method}")

    with _worker_socket([org.id, *other_org_ids], s3_responder) as sock:
        report = media_service.sweep_orphan_attachments(socket_path=sock)

    aged_key = ObjectKey(org.id, aged_orphan_id).key
    assert delete_calls == [aged_key]
    assert head_calls == [aged_key]
    assert report["deleted"] == 1
    assert report["skippedRecent"] == 1
    assert report["skippedTracked"] == 3
    assert report["hasMore"] is False
    assert aged_key not in s3_objects
    assert len(s3_objects) == 4


def test_sweep_resumes_losslessly_across_max_orgs_max_pages_and_mid_page_max_deletes(world):
    _base_org, _ws, _members, _tokens = world
    # Create two additional undeleted customer organisations in UUID order.
    extra_orgs = []
    for idx in range(2):
        slug = f"sweeporg{secrets.token_hex(3)}{idx}"[:18]
        created_org = Organisation.objects.create(
            slug=slug,
            realm=slug,
            issuer=f"https://id.kodera.test/realms/{slug}",
            name=f"Sweep Org {idx}",
            state=Organisation.State.PROSPECT,
        )
        SlugReservation.objects.create(
            namespace="organisation",
            slug=slug,
            organisation=created_org,
            state="provisional",
        )
        extra_orgs.append(created_org)

    all_orgs = list(
        Organisation.objects.filter(deleted_at__isnull=True)
        .exclude(realm="kodera-staff")
        .order_by("id")
    )
    assert len(all_orgs) >= 3

    aged_iso = (
        (database_now() - timedelta(seconds=900)).astimezone(UTC).isoformat().replace("+00:00", "Z")
    )
    # Place 15 aged orphans in all_orgs[0] (2 S3 pages of max-keys=10), 3 in all_orgs[1], 4 in all_orgs[2].
    counts_by_org = {all_orgs[0].id: 15, all_orgs[1].id: 3, all_orgs[2].id: 4}
    bucket: dict[UUID, list[tuple[str, str]]] = {o.id: [] for o in all_orgs}
    expected_total = 0
    for oid, count in counts_by_org.items():
        expected_total += count
        bucket[oid] = sorted((ObjectKey(oid, uuid4()).key, aged_iso) for _ in range(count))

    deleted_keys: list[str] = []

    def paginated_s3_responder(destination, **kwargs):
        method = kwargs["method"]
        parsed_url = urlsplit(destination.url)
        rel = parsed_url.path.removeprefix("/example-bucket").lstrip("/")
        if method == "GET":
            qs = parse_qs(parsed_url.query)
            prefix = qs["prefix"][0]
            target_org = UUID(prefix.split("/")[1])
            start_after_key = qs.get("continuation-token", [None])[0]
            items = bucket[target_org]
            if start_after_key is not None:
                items = [pair for pair in items if pair[0] > start_after_key]
            page = items[:10]
            truncated = len(items) > 10
            next_tok = page[-1][0] if truncated else None
            body = _list_xml(target_org, page, is_truncated=truncated, next_token=next_tok)
            return SimpleNamespace(close=lambda: None), SimpleNamespace(
                status=200, read=lambda n: body[:n], close=lambda: None
            )
        if method == "DELETE":
            target_org = UUID(rel.split("/")[1])
            bucket[target_org] = [p for p in bucket[target_org] if p[0] != rel]
            deleted_keys.append(rel)
            return SimpleNamespace(close=lambda: None), SimpleNamespace(
                status=204, close=lambda: None
            )
        if method == "HEAD":
            target_org = UUID(rel.split("/")[1])
            exists = any(p[0] == rel for p in bucket[target_org])
            return SimpleNamespace(close=lambda: None), SimpleNamespace(
                status=200 if exists else 404, close=lambda: None
            )
        raise AssertionError(f"Unexpected method {method}")

    with _worker_socket([o.id for o in all_orgs], paginated_s3_responder) as sock:
        after_org: str | None = None
        continuation: str | None = None
        total_deleted = 0
        iterations = 0
        while True:
            iterations += 1
            assert iterations <= 25, "Sweep pagination did not converge"
            step = media_service.sweep_orphan_attachments(
                max_orgs=1,
                max_pages=1,
                max_deletes=2,
                after_org=after_org,
                continuation=continuation,
                socket_path=sock,
            )
            assert step["organisationsScanned"] <= 1
            assert step["pagesScanned"] <= 1
            assert step["deleted"] <= 2
            total_deleted += step["deleted"]
            if not step["hasMore"]:
                assert step["nextAfterOrg"] is None
                assert step["nextContinuation"] is None
                break
            after_org = step["nextAfterOrg"]
            continuation = step["nextContinuation"]

    assert total_deleted == expected_total
    assert len(deleted_keys) == expected_total
    assert all(len(items) == 0 for items in bucket.values())


def test_sweep_fails_closed_on_cross_tenant_key_or_unconfirmed_delete_and_enforces_operator_profile(
    world, settings, monkeypatch
):
    org, _ws, _members, _tokens = world
    aged_iso = (
        (timezone.now() - timedelta(seconds=900)).astimezone(UTC).isoformat().replace("+00:00", "Z")
    )

    # 1) Cross-tenant key returned by gateway fails closed with zero delete_object calls.
    foreign_key = ObjectKey(uuid4(), uuid4()).key
    deleter_called = False

    def fake_delete(*args, **kwargs):
        nonlocal deleter_called
        deleter_called = True
        return {"deleted": True}

    monkeypatch.setattr(
        media_service,
        "attachment_prefix_objects",
        lambda org_id, **kw: {
            "objects": [{"key": foreign_key, "last_modified": aged_iso}],
            "continuation": None,
        },
    )
    monkeypatch.setattr(media_service, "delete_object", fake_delete)
    with pytest.raises(StorageRefusedError):
        media_service.sweep_orphan_attachments()
    assert deleter_called is False

    # 2) Continuation without after_org is refused.
    with pytest.raises(ValueError, match="continuation requires after_org"):
        media_service.sweep_orphan_attachments(continuation="tok-1")

    # 3) Management command refuses non-operator profile, then succeeds under operator profile.
    from apps.orgs.management import operator as operator_guard

    orig_is_installed = operator_guard.registry.is_installed
    monkeypatch.setattr(operator_guard.registry, "is_installed", lambda app: app != "apps.outbox")
    with pytest.raises(CommandError, match="not all installed"):
        call_command("sweep_orphan_attachments")

    monkeypatch.setattr(operator_guard.registry, "is_installed", orig_is_installed)
    monkeypatch.setattr(
        media_service,
        "attachment_prefix_objects",
        lambda org_id, **kw: {"objects": [], "continuation": None},
    )
    out = io.StringIO()
    call_command("sweep_orphan_attachments", "--json", stdout=out)
    parsed = json.loads(out.getvalue())
    assert parsed["deleted"] == 0
    assert parsed["hasMore"] is False

    with pytest.raises(CommandError, match="continuation requires after_org"):
        call_command("sweep_orphan_attachments", "--continuation", "tok-orphan")
