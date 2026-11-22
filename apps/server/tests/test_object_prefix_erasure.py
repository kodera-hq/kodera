"""Organisation object erasure includes rowless keys and fails closed on a late object."""

from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest

from apps.media import storage_gateway
from apps.media.storage import StorageRefusedError
from apps.orgs import object_erasure


def test_prefix_sweep_paginates_orphans_and_requires_fresh_empty_listing(monkeypatch):
    org = uuid4()
    prefix = f"organisations/{org}/attachments/"
    orphans = [prefix + str(uuid4()), prefix + "rowless-key"]
    calls = []
    pages = iter(
        [
            {"keys": orphans[:1], "continuation": "page-two"},
            {"keys": orphans[1:], "continuation": None},
            {"keys": [], "continuation": None},
        ]
    )

    def gateway(organisation_id, *, continuation=None, key=None, socket_path=None):
        assert organisation_id == org
        calls.append((continuation, key))
        return {"deleted": True} if key else next(pages)

    monkeypatch.setattr(storage_gateway, "attachment_prefix", gateway)
    object_erasure.sweep_attachment_prefix(org)
    assert calls == [
        (None, None),
        (None, orphans[0]),
        ("page-two", None),
        (None, orphans[1]),
        (None, None),
    ]


@pytest.mark.parametrize(
    "last_page",
    [
        {"keys": ["late-object"], "continuation": None},
        {"keys": [], "continuation": "unexpected-page"},
    ],
)
def test_prefix_sweep_refuses_nonempty_post_delete_listing(monkeypatch, last_page):
    gateway = Mock(side_effect=[{"keys": [], "continuation": None}, last_page])
    monkeypatch.setattr(storage_gateway, "attachment_prefix", gateway)
    with pytest.raises(StorageRefusedError):
        object_erasure.sweep_attachment_prefix(uuid4())


def test_organisation_adapter_sweeps_after_tracked_deletes(monkeypatch):
    org = uuid4()
    scope = SimpleNamespace(
        organisation_id=org, request_id=uuid4(), cutoff_at=object(), inventory_sha256="0" * 64
    )
    calls = []
    monkeypatch.setattr(
        object_erasure.ObjectWorkspaceErasureAdapter,
        "_authoritative",
        lambda *args: (("tracked",), None, None),
    )
    monkeypatch.setattr(object_erasure, "_check_upload_drain", lambda *args: None)
    monkeypatch.setattr(object_erasure, "database_now", lambda: None)
    monkeypatch.setattr(
        object_erasure.ObjectWorkspaceErasureAdapter, "_evidence", lambda *a, **k: "0" * 64
    )
    monkeypatch.setattr(
        object_erasure, "sweep_attachment_prefix", lambda *a, **k: calls.append("prefix")
    )
    adapter = object_erasure.ObjectWorkspaceErasureAdapter(
        deleter=lambda key: calls.append(key) or {"deleted": True}
    )
    # Exercise the body; transaction behavior is covered by the database erasure scenarios.
    adapter.erase_and_verify.__wrapped__(adapter, scope)
    assert calls == ["tracked", "prefix"]


def test_upload_drain_constant_matches_migration_and_reaper(settings):
    import importlib

    from apps.media.services import _upload_purge_before
    from config.upload_limits import UPLOAD_STREAM_DRAIN_SECONDS

    migration = importlib.import_module("apps.workspaces.migrations.0016_upload_tombstone_quota")
    assert UPLOAD_STREAM_DRAIN_SECONDS == 300
    assert f"make_interval(secs => {UPLOAD_STREAM_DRAIN_SECONDS})" in migration.FORWARD
    assert migration.REVERSE != migration.FORWARD
    settings.KODERA_MEDIA_MAX_UPLOAD_STREAM_S = 301
    with pytest.raises(RuntimeError, match="must be 300"):
        _upload_purge_before()


def test_prefix_sweep_caps_even_unique_continuation_tokens(monkeypatch):
    monkeypatch.setattr(object_erasure, "MAX_PREFIX_PAGES", 3)
    calls = []

    def gateway(*args, **kwargs):
        calls.append(kwargs)
        return {"keys": [], "continuation": str(len(calls))}

    monkeypatch.setattr(storage_gateway, "attachment_prefix", gateway)
    with pytest.raises(StorageRefusedError):
        object_erasure.sweep_attachment_prefix(uuid4())
    assert len(calls) == 3
