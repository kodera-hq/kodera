"""Whole-fetch admission across PostgreSQL sessions and normalized origin timeout caching."""

import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
from types import SimpleNamespace
from uuid import uuid4

import pytest
from django.core.cache import cache
from django.db import close_old_connections, connection
from django.utils import timezone

from apps.media import outbound, preview_guard, services, unfurl
from apps.media.context import RefusalError
from apps.media.models import PreviewAdmission
from apps.notifications import push

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def previews(monkeypatch):
    cache.clear()
    principal = SimpleNamespace(identity_id=uuid4())
    monkeypatch.setattr(services, "read_caller", lambda *args: principal)
    org = uuid4()

    def preview(url="https://public.example.org/page", *, identity=None):
        if identity is not None:
            principal.identity_id = identity
        return services.prepare_preview(verified=None, organisation_id=org, url=url)

    yield preview
    cache.clear()


def test_whole_fetch_lane_refuses_concurrent_requests_without_waiting(previews, monkeypatch):
    entered, release = Event(), Event()
    calls = []

    def hold(*args, **kwargs):
        calls.append(1)
        entered.set()
        assert release.wait(3)
        raise outbound.FetchError("timeout")

    def first_preview():
        try:
            return previews()
        finally:
            close_old_connections()

    monkeypatch.setattr(unfurl, "request", hold)
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(first_preview)
        try:
            assert entered.wait(2)
            for i in range(8):
                start = time.monotonic()
                with pytest.raises(RefusalError) as failure:
                    previews(f"https://public.example.org/{i}")
                assert time.monotonic() - start < 0.2
                assert (failure.value.status, failure.value.reason) == (503, "resolver-busy")
            assert len(calls) == 1
        finally:
            release.set()
        with pytest.raises(RefusalError):
            first.result(3)
    with pytest.raises(RefusalError):
        previews("https://other.example.org/new")
    assert len(calls) == 2


def test_timeout_cache_is_origin_keyed_across_paths_queries_and_principals(previews, monkeypatch):
    calls = []

    def timeout(*args, **kwargs):
        calls.append(1)
        raise TimeoutError()

    monkeypatch.setattr(unfurl, "request", timeout)
    for url in [
        "https://PUBLIC.example.org.:443/tarpit1?a=1",
        "https://public.example.org/tarpit2?a=2",
    ]:
        with pytest.raises(RefusalError) as failure:
            previews(url, identity=uuid4())
        assert (failure.value.status, failure.value.reason) == (503, "timeout")
    assert len(calls) == 1
    host = PreviewAdmission.objects.get(key__startswith="host:")
    assert timezone.now() < host.expires_at <= timezone.now() + timedelta(seconds=10)
    # Different scheme/port does not poison a separate origin.
    with pytest.raises(RefusalError):
        previews("http://public.example.org/tarpit3")
    assert len(calls) == 2
    PreviewAdmission.objects.filter(key__startswith="host:").update(
        expires_at=timezone.now() - timedelta(seconds=1)
    )
    with pytest.raises(RefusalError):
        previews()
    assert len(calls) == 3


def test_principal_budget_counts_cache_hits_and_recovers_after_expiry(previews, monkeypatch):
    calls = []
    monkeypatch.setattr(unfurl, "unfurl", lambda url: calls.append(url) or {"url": url})
    for _ in range(preview_guard.PREVIEW_RATE):
        previews()
    with pytest.raises(RefusalError) as failure:
        previews("https://other.example.org/new")
    assert (failure.value.status, failure.value.reason) == (429, "unfurl-rate-limited")
    assert len(calls) == 1
    PreviewAdmission.objects.filter(key__startswith="principal:").update(
        expires_at=timezone.now() - timedelta(seconds=1)
    )
    previews()
    previews(identity=uuid4())


def test_postgres_lease_refuses_a_separate_connection_and_releases_on_error(monkeypatch):
    peer = connection.copy(alias="peer_unfurl")
    try:
        peer.set_autocommit(True)
        with peer.cursor() as cursor:
            cursor.execute("SELECT pg_try_advisory_lock(%s)", [preview_guard.UNFURL_LOCK])
            assert cursor.fetchone() == (True,)
        monkeypatch.setattr(unfurl, "request", lambda *a, **k: pytest.fail("busy lease fetched"))
        started = time.monotonic()
        with pytest.raises(outbound.FetchError) as failure:
            unfurl.unfurl("https://public.example.org")
        assert failure.value.reason == "resolver-busy"
        assert time.monotonic() - started < 0.2
    finally:
        peer.close()
    with pytest.raises(RuntimeError), preview_guard.cluster_lane():
        raise RuntimeError("fetch failed")
    with preview_guard.cluster_lane():
        pass


def test_push_resolution_shares_the_nonblocking_local_lane(monkeypatch):
    from cryptography.hazmat.primitives.asymmetric import ec

    key = push.public_key(ec.generate_private_key(ec.SECP256R1()))
    monkeypatch.setattr(outbound, "addresses", lambda *args: pytest.fail("busy lane resolved DNS"))
    with outbound.request_lane(), pytest.raises(outbound.FetchError) as failure:
        push.subscription("https://push.example.org/wake", key, push.encode(bytes(16)))
    assert failure.value.reason == "resolver-busy"


def test_principal_budget_is_atomic_across_database_sessions():
    key = "principal:" + uuid4().hex

    def charge(_):
        try:
            return preview_guard.charge(key)
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sum(pool.map(charge, range(20))) == preview_guard.PREVIEW_RATE


def test_push_dns_lease_is_cluster_wide_and_independent_of_unfurl(monkeypatch):
    destination = outbound.target("https://push.example.org/wake", https_only=True)
    calls = []
    monkeypatch.setattr(outbound, "addresses", lambda *args: calls.append(args))
    peer = connection.copy(alias="peer_push")
    try:
        peer.set_autocommit(True)
        with peer.cursor() as cursor:
            cursor.execute("SELECT pg_try_advisory_lock(%s)", [preview_guard.PUSH_LOCK])
            assert cursor.fetchone() == (True,)
        start = time.monotonic()
        with pytest.raises(outbound.FetchError) as failure:
            push._resolve(destination)
        assert failure.value.reason == "resolver-busy"
        assert time.monotonic() - start < 0.2
        assert not calls
        with preview_guard.cluster_lane():
            pass  # Push and unfurl must not hold each other's lease.
    finally:
        peer.close()
    with preview_guard.cluster_lane():
        push._resolve(destination)
    assert len(calls) == 1


def test_non_postgres_lane_falls_back_without_opening_a_lease(monkeypatch):
    monkeypatch.setattr(connection, "vendor", "sqlite")
    monkeypatch.setattr(connection, "copy", lambda **kwargs: pytest.fail("opened a lease"))
    with preview_guard.cluster_lane(preview_guard.PUSH_LOCK):
        pass


def test_transaction_pooler_lease_uses_transaction_lock_and_releases(settings):
    settings.KODERA_DATABASE_TRANSACTION_POOLER = True
    peer = connection.copy(alias="pooler_peer")
    try:
        peer.set_autocommit(True)
        with preview_guard.cluster_lane(preview_guard.PUSH_LOCK):
            with peer.cursor() as cursor:
                cursor.execute("SELECT pg_try_advisory_lock(%s)", [preview_guard.PUSH_LOCK])
                assert cursor.fetchone() == (False,)
            # Transaction locks (unlike session locks) appear under a virtual transaction ID.
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted AND objid=%s AND classid=%s AND virtualtransaction IS NOT NULL",
                    [preview_guard.PUSH_LOCK & 0xFFFFFFFF, preview_guard.PUSH_LOCK >> 32],
                )
                assert cursor.fetchone()[0] == 1
        with peer.cursor() as cursor:
            cursor.execute("SELECT pg_try_advisory_lock(%s)", [preview_guard.PUSH_LOCK])
            assert cursor.fetchone() == (True,)
    finally:
        peer.close()


def test_preview_admission_migration_reverses_and_reapplies():
    from django.db.migrations.executor import MigrationExecutor

    executor = MigrationExecutor(connection)
    leaves = executor.loader.graph.leaf_nodes()
    try:
        executor.migrate([("media", "0003_attachment_scope_binding")])
        assert "media_previewadmission" not in connection.introspection.table_names()
        MigrationExecutor(connection).migrate([("media", "0004_preview_admission")])
        assert preview_guard.charge("principal:migration-roundtrip")
        assert PreviewAdmission.objects.get(pk="principal:migration-roundtrip").hits == 1
    finally:
        MigrationExecutor(connection).migrate(leaves)
