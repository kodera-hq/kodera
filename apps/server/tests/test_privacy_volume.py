"""Real private-volume restart, expiry and named filesystem/source refusal controls."""

import fcntl
import hashlib
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

import pytest

from apps.orgs.privacy_archives import ArchiveRefusalError, Entry, Request
from apps.orgs.privacy_sources import CapturedEntry, FrozenSource
from apps.orgs.privacy_storage import MissingPrivateObjectError, PrivateVolume

REQUEST_ID = "00000000-0000-7000-8000-000000000001"
RESOURCE = "document:00000000-0000-7000-8000-000000000002"
KEY = f"privacy/{REQUEST_ID}/archive.zip"


@pytest.fixture
def volume(tmp_path):
    root = tmp_path.resolve() / "private"
    root.mkdir(mode=0o700)
    return root, PrivateVolume(root, clock=lambda: 1000)


def request():
    return Request(REQUEST_ID, REQUEST_ID, REQUEST_ID, "account", None, True, 1000, 1600)


def test_real_immutable_object_survives_new_process_adapter_and_expiry(volume):
    root, storage = volume
    storage.put_immutable(KEY, b"private bytes", 1600)
    storage.put_immutable(KEY, b"private bytes", 1600)
    restarted = PrivateVolume(root, clock=lambda: 1599)
    assert restarted.read(KEY, 13) == b"private bytes"
    with pytest.raises(ArchiveRefusalError, match="still live"):
        restarted.collect(KEY)
    expired = PrivateVolume(root, clock=lambda: 1600)
    with pytest.raises(ArchiveRefusalError, match="expired"):
        expired.read(KEY, 13)
    assert expired.collect(KEY)
    with pytest.raises(MissingPrivateObjectError, match="absent"):
        expired.read(KEY, 13)


@pytest.mark.parametrize(
    "mutation",
    [
        "bytes",
        "expiry",
        "size",
        "root_mode",
        "file_mode",
        "hardlink",
        "symlink",
        "directory",
        "fifo",
    ],
)
def test_named_real_storage_mutations_refuse(volume, mutation):
    root, storage = volume
    storage.put_immutable(KEY, b"original", 1600)
    path = root / KEY
    expected = "ownership or mode"
    if mutation == "bytes":
        with pytest.raises(ArchiveRefusalError, match="immutable replacement"):
            storage.put_immutable(KEY, b"different", 1600)
        return
    if mutation == "expiry":
        with pytest.raises(ArchiveRefusalError, match="immutable replacement"):
            storage.put_immutable(KEY, b"original", 1700)
        return
    if mutation == "size":
        expected = "size"
    elif mutation == "root_mode":
        root.chmod(0o755)
    elif mutation == "file_mode":
        path.chmod(0o644)
    elif mutation == "hardlink":
        os.link(path, root / "foreign")
    else:
        path.unlink()
        if mutation == "symlink":
            path.symlink_to(root / "missing")
            expected = "unavailable"
        elif mutation == "directory":
            path.mkdir(mode=0o700)
        else:
            os.mkfifo(path, 0o600)
    with pytest.raises(ArchiveRefusalError, match=expected):
        storage.read(KEY, 1 if mutation == "size" else 50)


@pytest.mark.parametrize(
    "key",
    [
        "/privacy/a/b",
        "privacy/../secret",
        "privacy/a/./x",
        "privacy/a//x",
        "privacy/a/UPPER",
        "privacy/a/evil\\name",
        "other/a/b",
    ],
)
def test_unsafe_object_keys_refuse(volume, key):
    _, storage = volume
    with pytest.raises(ArchiveRefusalError, match="object key"):
        storage.put_immutable(key, b"private", 1600)


def test_changed_ancestor_and_private_child_symlinks_refuse(volume, tmp_path):
    root, storage = volume
    moved = root.with_name("moved")
    root.rename(moved)
    root.symlink_to(moved, target_is_directory=True)
    with pytest.raises(ArchiveRefusalError, match="root unavailable"):
        storage.put_immutable(KEY, b"private", 1600)
    root.unlink()
    moved.rename(root)
    (root / "privacy").symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ArchiveRefusalError, match="unavailable"):
        storage.put_immutable(KEY, b"private", 1600)


def test_expired_inventory_collects_orphans_and_holds_mixed_lifetimes(volume):
    root, storage = volume
    storage.put_immutable(KEY, b"archive", 1600)
    orphan = f"privacy/{REQUEST_ID}/sources/documents/00000.bin"
    storage.put_immutable(orphan, b"orphan", 1500)
    assert storage.inventory(REQUEST_ID) == tuple(sorted((KEY, orphan)))
    partially_expired = PrivateVolume(root, clock=lambda: 1550)
    with pytest.raises(ArchiveRefusalError, match="still live"):
        partially_expired.collect_request(REQUEST_ID)
    assert partially_expired.inventory(REQUEST_ID) == tuple(sorted((KEY, orphan)))
    assert PrivateVolume(root, clock=lambda: 1600).collect_request(REQUEST_ID) == 2
    assert storage.inventory(REQUEST_ID) == ()


def test_inventory_refuses_symlink_instead_of_reporting_complete_erasure(volume):
    root, storage = volume
    storage.put_immutable(KEY, b"private", 1600)
    (root / f"privacy/{REQUEST_ID}/foreign").symlink_to(root)
    with pytest.raises(ArchiveRefusalError, match="inventory entry"):
        storage.inventory(REQUEST_ID)


def test_source_manifest_survives_restart_without_recapturing_and_rechecks_resources(volume):
    _, storage = volume
    source = FrozenSource(
        "documents",
        storage,
        lambda _: (CapturedEntry(RESOURCE, Entry("documents/page.md", b"frozen")),),
        lambda *_: True,
    )
    snapshot = source.snapshot(request())

    def must_not_capture(_):
        raise AssertionError("committed source was recaptured")

    restarted = FrozenSource("documents", storage, must_not_capture, lambda *_: True)
    assert restarted.snapshot(request()) == snapshot
    assert restarted.page(request(), snapshot, None).entries == (
        Entry("documents/page.md", b"frozen"),
    )
    revoked = FrozenSource("documents", storage, must_not_capture, lambda *_: False)
    assert not revoked.authorize(request(), snapshot)
    with pytest.raises(ArchiveRefusalError, match="authority revoked"):
        revoked.page(request(), snapshot, None)
    with pytest.raises(ArchiveRefusalError, match="manifest binding"):
        restarted.snapshot(replace(request(), include_media=False))
    with pytest.raises(ArchiveRefusalError, match="snapshot binding"):
        restarted.page(request(), "0" * 64, None)


@pytest.mark.parametrize(
    "mutation", ["section", "path", "resource", "duplicate", "content", "cursor"]
)
def test_frozen_source_refusals_have_expected_diagnostics(volume, mutation):
    root, storage = volume
    entry = CapturedEntry(RESOURCE, Entry("documents/page.md", b"frozen"))
    expected = "entry binding"
    if mutation == "section":
        entry = replace(entry, entry=Entry("billing/page.md", b"private"))
    elif mutation == "path":
        entry = replace(entry, entry=Entry("documents/../page.md", b"private"))
    elif mutation == "resource":
        entry = replace(entry, resource="forged")
    source = FrozenSource(
        "documents",
        storage,
        lambda _: (entry, entry) if mutation == "duplicate" else (entry,),
        lambda *_: True,
    )
    if mutation in {"content", "cursor"}:
        snapshot = source.snapshot(request())
        if mutation == "content":
            path = (
                root
                / f"privacy/{REQUEST_ID}/sources/documents/{hashlib.sha256(b'frozen').hexdigest()}.bin"
            )
            path.write_bytes((1600).to_bytes(8, "big") + b"forged")
            expected = "entry integrity"
        else:
            expected = "cursor"
        with pytest.raises(ArchiveRefusalError, match=expected):
            source.page(request(), snapshot, "1" if mutation == "cursor" else None)
    else:
        with pytest.raises(ArchiveRefusalError, match=expected):
            source.snapshot(request())


@pytest.mark.parametrize("published", [False, True])
def test_real_process_death_before_or_after_atomic_publication_recovers(volume, published):
    root, storage = volume
    child = os.fork()
    if child == 0:
        original = os.rename

        def stop(source, target, **kwargs):
            if published:
                original(source, target, **kwargs)
            os._exit(72)

        os.rename = stop
        storage.put_immutable(KEY, b"crash-proof", 1600)
        os._exit(73)
    _, status = os.waitpid(child, 0)
    assert os.waitstatus_to_exitcode(status) == 72
    reopened = PrivateVolume(root, clock=lambda: 1000)
    reopened.put_immutable(KEY, b"crash-proof", 1600)
    assert reopened.read(KEY, 12) == b"crash-proof"
    expected_count = 1 if published else 2
    assert len(reopened.inventory(REQUEST_ID)) == expected_count
    assert PrivateVolume(root, clock=lambda: 1600).collect_request(REQUEST_ID) == expected_count


def test_partial_header_stage_is_held_for_maximum_lifetime_then_collects(volume):
    root, storage = volume
    storage.put_immutable(KEY, b"archive", 1600)
    staged = root / f"privacy/{REQUEST_ID}/pending-{'0' * 32}"
    staged.write_bytes(b"\x00")
    staged.chmod(0o600)
    os.utime(staged, (1000, 1000))
    with pytest.raises(ArchiveRefusalError, match="still live"):
        PrivateVolume(root, clock=lambda: 87400).collect_request(REQUEST_ID)
    assert PrivateVolume(root, clock=lambda: 87401).collect_request(REQUEST_ID) == 2


def test_bounded_expiry_pages_progress_past_orphans_without_claiming_completion(volume):
    root, storage = volume
    for index in range(5):
        storage.put_immutable(f"privacy/{REQUEST_ID}/orphan_{index}.bin", b"orphan", 1600)
    page = storage.inventory_page(REQUEST_ID, 2)
    assert len(page.keys) == 2 and not page.complete
    expired = PrivateVolume(root, clock=lambda: 1600)
    first = expired.collect_expired_page(REQUEST_ID, 2)
    assert first.removed == 2 and not first.inventory_complete
    second = expired.collect_expired_page(REQUEST_ID, 2)
    assert second.removed == 2 and not second.inventory_complete
    last = expired.collect_expired_page(REQUEST_ID, 2)
    assert last.removed == 1 and last.inventory_complete
    assert expired.inventory(REQUEST_ID) == ()


def test_supplement_cannot_override_revoked_core_resource_authority(volume, monkeypatch):
    from apps.orgs.privacy_core_sources import CoreSources
    from apps.orgs.privacy_services import CurrentAuthority

    _, storage = volume
    core = CoreSources(storage)
    monkeypatch.setattr(core, "permitted", lambda *_: False)
    monkeypatch.setattr(CurrentAuthority, "authorize", lambda *_: True)

    class Supplement:
        def permitted(self, *_):
            return True

        def capture(self, _):
            return (CapturedEntry(RESOURCE, Entry("documents/stolen.md", b"forbidden")),)

    assert not core._complete_permitted(Supplement(), request(), RESOURCE)
    with pytest.raises(ArchiveRefusalError, match="resource provenance"):
        core._complete_capture("documents", Supplement(), request())
    monkeypatch.setattr(CurrentAuthority, "authorize", lambda *_: False)
    assert not core._complete_permitted(
        Supplement(), request(), RESOURCE.replace("document:", "contribution:")
    )


def test_interrupted_capture_can_select_changed_content_and_collect_orphans(volume, monkeypatch):
    root, storage = volume
    original = storage.put_immutable

    def stop_manifest(key, content, expires_at):
        if key.endswith("manifest.json"):
            raise OSError("synthetic interruption before source commit")
        return original(key, content, expires_at)

    monkeypatch.setattr(storage, "put_immutable", stop_manifest)
    before = FrozenSource(
        "documents",
        storage,
        lambda _: (CapturedEntry(RESOURCE, Entry("documents/page.md", b"before")),),
        lambda *_: True,
    )
    with pytest.raises(OSError, match="interruption"):
        before.snapshot(request())
    reopened = PrivateVolume(root, clock=lambda: 1000)
    after = FrozenSource(
        "documents",
        reopened,
        lambda _: (CapturedEntry(RESOURCE, Entry("documents/page.md", b"after")),),
        lambda *_: True,
    )
    snapshot = after.snapshot(request())
    assert after.page(request(), snapshot, None).entries[0].content == b"after"
    assert len(reopened.inventory(REQUEST_ID)) == 3
    assert PrivateVolume(root, clock=lambda: 1600).collect_request(REQUEST_ID) == 3


def test_concurrent_captures_reuse_first_committed_bound_manifest(volume):
    root, _ = volume
    barrier = threading.Barrier(2)

    def capture(value):
        def source(_):
            barrier.wait(timeout=5)
            return (CapturedEntry(RESOURCE, Entry("documents/page.md", value)),)

        return source

    sources = [
        FrozenSource(
            "documents", PrivateVolume(root, clock=lambda: 1000), capture(value), lambda *_: True
        )
        for value in (b"first", b"second")
    ]
    with ThreadPoolExecutor(max_workers=2) as workers:
        snapshots = list(workers.map(lambda source: source.snapshot(request()), sources))
    assert snapshots[0] == snapshots[1]
    assert sources[0].page(request(), snapshots[0], None) == sources[1].page(
        request(), snapshots[1], None
    )


def test_waiting_nested_writer_cannot_publish_after_request_expiry(volume):
    root, storage = volume
    storage.put_immutable(KEY, b"existing", 1600)
    admitted = threading.Event()
    now = [1000]
    calls = [0]

    def clock():
        value = now[0]
        calls[0] += 1
        if calls[0] == 2:
            admitted.set()
        return value

    waiting = PrivateVolume(root, clock=clock)
    request_fd = os.open(root / "privacy" / REQUEST_ID, os.O_RDONLY | os.O_DIRECTORY)
    try:
        fcntl.flock(request_fd, fcntl.LOCK_EX)
        with ThreadPoolExecutor(max_workers=1) as workers:
            future = workers.submit(
                waiting.put_immutable, f"privacy/{REQUEST_ID}/sources/late.bin", b"late", 1600
            )
            assert admitted.wait(timeout=5)
            now[0] = 1600
            fcntl.flock(request_fd, fcntl.LOCK_UN)
            with pytest.raises(ArchiveRefusalError, match="expired"):
                future.result(timeout=5)
        expired = PrivateVolume(root, clock=lambda: 1600)
        assert expired.collect_request(REQUEST_ID) == 1
        assert expired.inventory(REQUEST_ID) == ()
    finally:
        os.close(request_fd)


def test_request_inventory_waits_for_nested_publication(volume, monkeypatch):
    root, storage = volume
    publishing = threading.Event()
    release = threading.Event()
    inspecting = threading.Event()
    rename = os.rename

    def paused_rename(*args, **kwargs):
        publishing.set()
        assert release.wait(timeout=5)
        return rename(*args, **kwargs)

    def inventory():
        inspecting.set()
        return PrivateVolume(root, clock=lambda: 1000).inventory(REQUEST_ID)

    monkeypatch.setattr(os, "rename", paused_rename)
    key = f"privacy/{REQUEST_ID}/sources/body.bin"
    with ThreadPoolExecutor(max_workers=2) as workers:
        writer = workers.submit(storage.put_immutable, key, b"body", 1600)
        assert publishing.wait(timeout=5)
        reader = workers.submit(inventory)
        assert inspecting.wait(timeout=5)
        try:
            with pytest.raises(TimeoutError):
                reader.result(timeout=0.1)
        finally:
            release.set()
        writer.result(timeout=5)
        assert reader.result(timeout=5) == (key,)
