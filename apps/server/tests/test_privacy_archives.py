"""Real signed ZIPs and named restart, authority, completeness and integrity refusals."""

import base64
import copy
import io
import json
import zipfile
from dataclasses import replace
from uuid import uuid4

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from apps.orgs import privacy_archives as archive
from apps.orgs.privacy_services import deletion_hold


class Storage:
    def __init__(self):
        self.objects, self.expiries = {}, {}
        self.after_put = None

    def put_immutable(self, key, content, expires_at):
        if key in self.objects:
            archive.require(self.objects[key] == content, "immutable export object changed")
        self.objects[key], self.expiries[key] = content, expires_at
        if self.after_put:
            self.after_put(key)

    def read(self, key, limit):
        return self.objects[key][:limit]


class Signer:
    key_id = "test-export-key"

    def __init__(self):
        self.key = Ed25519PrivateKey.generate()
        self.public_key = self.key.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )

    def sign(self, value):
        return self.key.sign(value)


class Authority:
    allowed = True

    def authorize(self, request):
        return self.allowed


class Source:
    allowed = True

    def __init__(self, section):
        self.section, self.calls = section, 0
        self.transform = lambda page: page

    def snapshot(self, request):
        return "snapshot-" + self.section

    def authorize(self, request, snapshot):
        return self.allowed

    def page(self, request, snapshot, cursor):
        self.calls += 1
        number = 1 if cursor is None else 2
        return self.transform(
            archive.Page(
                request.binding,
                snapshot,
                (archive.Entry(f"{self.section}/{number:05d}.json", b'{"synthetic":true}'),),
                "second" if cursor is None else None,
            )
        )


class Journal:
    def __init__(self, state):
        self.state, self.conflict = state, False

    def load(self, request_id):
        assert self.state.request.id == request_id
        return copy.deepcopy(self.state)

    def save(self, state, expected_revision):
        if self.conflict or self.state.revision != expected_revision:
            return False
        self.state = copy.deepcopy(state)
        return True


@pytest.fixture
def setup():
    request = archive.Request(
        str(uuid4()), str(uuid4()), str(uuid4()), "workspace", str(uuid4()), True, 100, 1000
    )
    sources = {section: Source(section) for section in archive.SECTIONS}
    storage, signer, authority = Storage(), Signer(), Authority()
    journal = Journal(archive.begin(request, sources, storage, signer, authority, 101))
    return request, journal, sources, storage, signer, authority


def step(setup):
    request, journal, sources, storage, signer, authority = setup
    return archive.step(request, journal, sources, storage, signer, authority, 102)


def finish(setup):
    for _ in range(2 * len(archive.SECTIONS) + 1):
        state = step(setup)
    assert state.artifact_key
    return state


def refused(reason, function, status=503):
    with pytest.raises(archive.ArchiveRefusalError) as error:
        function()
    assert str(error.value) == reason
    assert error.value.status == status


def test_real_zip_signature_checksums_restart_and_identical_ready_replay(setup):
    request, journal, sources, storage, signer, authority = setup
    step(setup)
    resumed = (request, Journal(copy.deepcopy(journal.state)), sources, storage, signer, authority)
    state = step(resumed)
    assert state.complete == ("identity",)
    for _ in range(2 * len(archive.SECTIONS) - 1):
        state = step(resumed)
    value = archive.ready_bytes(state, sources, storage, signer, authority, 103)
    assert all(expiry == request.expires_at for expiry in storage.expiries.values())
    with zipfile.ZipFile(io.BytesIO(value)) as zipped:
        document = json.loads(zipped.read("manifest.json"))
        assert document["algorithm"] == "Ed25519"
        Ed25519PublicKey.from_public_bytes(signer.public_key).verify(
            base64.b64decode(document["signature"], validate=True),
            b"kodera-privacy-export:v1\n" + archive.canonical(document["manifest"]),
        )
        assert document["manifest"]["binding"] == request.binding
        assert set(document["manifest"]["sections"]) == set(archive.SECTIONS)
        for entry in document["manifest"]["entries"]:
            content = zipped.read(entry["name"])
            assert archive.digest(content) == entry["sha256"]
            assert len(content) == entry["size"]
    calls = sum(source.calls for source in sources.values())
    assert step(resumed) == state
    assert sum(source.calls for source in sources.values()) == calls
    assert archive.ready_bytes(state, sources, storage, signer, authority, 104) == value


@pytest.mark.parametrize("missing", archive.SECTIONS)
def test_missing_source_never_admits_a_partial_gdpr_export(setup, missing):
    request, _, sources, storage, signer, authority = setup
    sources.pop(missing)
    refused(
        "incomplete export sources",
        lambda: archive.begin(request, sources, storage, signer, authority, 102),
    )
    assert storage.objects == {}


@pytest.mark.parametrize("missing", ["storage", "signer", "authority"])
def test_missing_private_ports_refuse_without_writes(setup, missing):
    request, _, sources, storage, signer, authority = setup
    ports = {"storage": storage, "signer": signer, "authority": authority}
    ports[missing] = None
    refused(
        "private export ports unavailable",
        lambda: archive.begin(request, sources, **ports, now=102),
    )
    assert storage.objects == {}


@pytest.mark.parametrize(
    "field,value,reason",
    [
        ("include_media", 1, "request media policy"),
        ("expires_at", 100, "request expiry bound"),
        ("expires_at", 1000000, "request expiry bound"),
    ],
)
def test_request_input_mutations_have_precise_refusals(setup, field, value, reason):
    refused(reason, lambda: replace(setup[0], **{field: value}).validate())


@pytest.mark.parametrize(
    "field,value",
    [("user_id", str(uuid4())), ("include_media", False), ("organisation_id", str(uuid4()))],
)
def test_request_replay_cannot_change_subject_or_policy(setup, field, value):
    request, journal, sources, storage, signer, authority = setup
    refused(
        "export request replay binding",
        lambda: archive.step(
            replace(request, **{field: value}), journal, sources, storage, signer, authority, 102
        ),
        409,
    )
    assert storage.objects == {}


@pytest.mark.parametrize(
    "mutation,reason",
    [
        (lambda p: replace(p, binding="wrong"), "export source snapshot binding"),
        (lambda p: replace(p, snapshot="wrong"), "export source snapshot binding"),
        (
            lambda p: replace(p, entries=(archive.Entry("../escape.json", b"x"),)),
            "unsafe export entry",
        ),
        (
            lambda p: replace(p, entries=(archive.Entry("identity//empty.json", b"x"),)),
            "unsafe export entry",
        ),
        (
            lambda p: replace(p, entries=(archive.Entry("media/foreign.json", b"x"),)),
            "unsafe export entry",
        ),
        (
            lambda p: replace(
                p,
                entries=(
                    archive.Entry("identity/same.json", b"x"),
                    archive.Entry("identity/same.json", b"y"),
                ),
            ),
            "duplicate export entry",
        ),
        (lambda p: replace(p, entries=p.entries * 101), "export page limit"),
        (lambda p: replace(p, next_cursor="../cursor"), "export cursor progression"),
    ],
)
def test_source_mutations_fail_before_any_checkpoint_or_blob(setup, mutation, reason):
    setup[2]["identity"].transform = mutation
    refused(reason, lambda: step(setup))
    assert setup[1].state.revision == 1 and setup[3].objects == {}


def test_revocation_prevents_resume_and_ready_download(setup):
    state = finish(setup)
    setup[5].allowed = False
    refused("export authority revoked", lambda: step(setup), 403)
    setup[5].allowed = True
    setup[2]["documents"].allowed = False
    refused(
        "export resource authority revoked",
        lambda: archive.ready_bytes(state, setup[2], setup[3], setup[4], setup[5], 103),
        403,
    )


def test_revocation_during_publication_never_commits_ready(setup):
    for _ in range(2 * len(archive.SECTIONS)):
        step(setup)

    def revoke(key):
        if key.endswith("archive.zip"):
            setup[5].allowed = False

    setup[3].after_put = revoke
    refused("export authority revoked", lambda: step(setup), 403)
    assert setup[1].state.artifact_key is None


def test_expired_archive_never_downloads(setup):
    state = finish(setup)
    refused(
        "export expired",
        lambda: archive.ready_bytes(
            state, setup[2], setup[3], setup[4], setup[5], state.request.expires_at
        ),
        409,
    )


def test_failed_checkpoint_compare_and_swap_is_replayable(setup):
    setup[1].conflict = True
    refused("export checkpoint conflict", lambda: step(setup), 409)
    assert setup[1].state.revision == 1
    setup[1].conflict = False
    assert step(setup).revision == 2
    assert len(setup[3].objects) == 1


def test_chunk_tamper_refuses_before_continuing(setup):
    state = step(setup)
    setup[3].objects[state.chunks[0].key] = b"altered"
    refused("export chunk integrity", lambda: step(setup))
    assert setup[1].state.revision == 2


def test_completed_artifact_tamper_is_never_disclosed(setup):
    state = finish(setup)
    setup[3].objects[state.artifact_key] += b"appended"
    refused("export artifact integrity", lambda: step(setup))


def test_bad_signature_never_commits_ready(setup):
    for _ in range(2 * len(archive.SECTIONS)):
        step(setup)
    setup[4].sign = lambda value: b"invalid"
    refused("export signature verification", lambda: step(setup))
    assert setup[1].state.artifact_key is None


def test_incomplete_checkpoint_never_becomes_ready(setup):
    state = step(setup)
    setup[1].state = replace(state, complete=archive.SECTIONS)
    refused("export checkpoint completion", lambda: step(setup))


def test_repeated_cursor_and_duplicate_entry_refuse(setup):
    step(setup)
    setup[2]["identity"].transform = lambda page: replace(page, next_cursor="second")
    refused("export cursor progression", lambda: step(setup))
    setup[2]["identity"].transform = lambda page: replace(
        page, entries=(archive.Entry("identity/00001.json", b"same"),)
    )
    refused("duplicate export entry", lambda: step(setup))


def test_explicit_archive_limits_do_not_become_unlimited(setup, monkeypatch):
    monkeypatch.setattr(archive, "MAX_ENTRY_BYTES", 1)
    refused("export entry limit", lambda: step(setup))
    monkeypatch.setattr(archive, "MAX_ENTRY_BYTES", 100)
    monkeypatch.setattr(archive, "MAX_ARCHIVE_BYTES", 1)
    refused("export archive limit", lambda: step(setup))


def test_deletion_is_held_without_cutoff_and_retention_proofs():
    refused("deletion cutoff and statutory retention proofs unavailable", deletion_hold)
