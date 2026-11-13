"""Actual native transformations with PostgreSQL tree, role and journal boundaries."""

import base64
import json
import os
import secrets
import select
import shutil
import subprocess
from pathlib import Path
from uuid import uuid4

import pytest
from django.db import IntegrityError, transaction
from workspace_safety.test_moderation import world as world

from apps.docs import engine, services
from apps.docs.errors import RefusalError
from apps.docs.models import Document, DocumentGrant, DocumentLink, DocumentSnapshot, DocumentUpdate
from apps.identity.models import Identity
from apps.workspaces import moderation

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def native_engine(settings):
    root = Path(__file__).resolve().parents[2] / "yjs_collab"
    key = secrets.token_bytes(32)
    environment = {
        "PATH": os.environ["PATH"],
        "KODERA_TEST_COLLAB_KEY": base64.urlsafe_b64encode(key).decode(),
    }
    binary = shutil.which("node")
    if binary is None:
        raise RuntimeError("native document tests require Node.js")
    process = subprocess.Popen(  # noqa: S603 - resolved interpreter and owned fixed test program
        [binary, str(root / "test/http-fixture.mjs")],
        cwd=root,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        if process.stdout is None or not select.select([process.stdout], [], [], 10)[0]:
            raise RuntimeError("test-owned transform service did not start")
        line = process.stdout.readline()
        result = json.loads(line)
        if type(result.get("port")) is not int or not 1 <= result["port"] <= 65535:
            raise RuntimeError("test-owned transform service did not return its port")
        settings.KODERA_COLLAB_TICKET_KEY = key
        settings.KODERA_COLLAB_ENGINE_URL = f"http://127.0.0.1:{result['port']}/internal/transform"
        settings.KODERA_COLLAB_PUBLIC_URL = "wss://api.example.org/documents/collab"
        yield
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        if process.stdout is not None:
            process.stdout.close()
        if process.stderr is not None:
            process.stderr.close()


def create(world, name="Example", parent=None, template=None):
    org, _, _, tokens = world
    return services.create(
        verified=tokens[3],
        organisation_id=org.id,
        name=name,
        parent_id=parent,
        template_key=template,
        request_id=str(uuid4()),
    )


def patch(world, document, changes, token=3):
    org, _, _, tokens = world
    return services.patch(
        verified=tokens[token],
        organisation_id=org.id,
        document_id=Document.objects.get(pk=document["id"]).id,
        changes=changes,
        if_match=services.tag(document),
        request_id=str(uuid4()),
    )


@pytest.mark.parametrize("template", ["spec", "adr", "meeting_notes", "runbook"])
def test_all_four_templates_roundtrip_native_state(world, native_engine, template):
    created = create(world, template=template)
    row = Document.objects.get(pk=created["id"])
    stored = DocumentSnapshot.objects.get(document=row)
    transformed = engine.transform(snapshot=bytes(stored.state))
    assert transformed.markdown == row.markdown == created["markdown"]
    assert row.markdown.startswith("# ") and created["role"] == "editor"


def test_tree_moves_cycles_depth_and_nonempty_delete_follow_the_contract(world, native_engine):
    org, _, _, tokens = world
    parent = create(world, "Parent")
    child = create(world, "Child", parent=Document.objects.get(pk=parent["id"]).id)
    with pytest.raises(RefusalError) as denied:
        patch(world, parent, {"parentId": Document.objects.get(pk=child["id"]).id})
    assert denied.value.status == 422
    with pytest.raises(RefusalError) as denied:
        services.delete(
            verified=tokens[3],
            organisation_id=org.id,
            document_id=Document.objects.get(pk=parent["id"]).id,
            request_id=str(uuid4()),
        )
    assert denied.value.status == 409
    assert Document.objects.filter(deleted_at__isnull=True).count() == 2
    services.delete(
        verified=tokens[3],
        organisation_id=org.id,
        document_id=Document.objects.get(pk=child["id"]).id,
        request_id=str(uuid4()),
    )
    services.delete(
        verified=tokens[3],
        organisation_id=org.id,
        document_id=Document.objects.get(pk=parent["id"]).id,
        request_id=str(uuid4()),
    )
    assert not Document.objects.filter(deleted_at__isnull=True).exists()


def test_viewer_ticket_and_current_revocation_refuse_every_write(world, native_engine):
    org, _, members, tokens = world
    created = create(world)
    row = Document.objects.get(pk=created["id"])
    DocumentGrant.objects.create(document=row, membership=members[2], role="viewer")
    viewed = services.read(verified=tokens[2], organisation_id=org.id, document_id=row.id)
    assert viewed["role"] == "viewer"
    with pytest.raises(RefusalError) as denied:
        patch(world, viewed, {"markdown": "Forbidden"}, token=2)
    assert denied.value.status == 403
    ticket = services.collab_session(
        verified=tokens[2], organisation_id=org.id, document_id=row.id, request_id=str(uuid4())
    )
    claims = json.loads(base64.urlsafe_b64decode(ticket["token"].split(".")[0] + "==="))
    assert claims["expires"] - claims["issued"] == 300
    assert (
        claims["document"] == str(row.id)
        and claims["organisation"] == str(org.id)
        and claims["role"] == "viewer"
    )
    Identity.objects.filter(user_id=members[2].user_id).update(enabled=False)
    with pytest.raises(RefusalError) as denied:
        services.collab_session(
            verified=tokens[2], organisation_id=org.id, document_id=row.id, request_id=str(uuid4())
        )
    assert denied.value.status == 403


def test_markdown_replacement_preserves_history_across_database_compaction(world, native_engine):
    created = create(world)
    row = Document.objects.get(pk=created["id"])
    obsolete = bytes(DocumentSnapshot.objects.get(document=row).state)
    updated = patch(world, created, {"markdown": "# Current\n\nReplacement text\n"})
    snapshot = DocumentSnapshot.objects.get(document=row)
    assert snapshot.sequence == snapshot.head_sequence == 1
    assert not DocumentUpdate.objects.filter(document=row).exists()
    recovered = engine.transform(snapshot=bytes(snapshot.state), update=obsolete)
    assert recovered.markdown == updated["markdown"]
    with pytest.raises(RefusalError) as stale:
        patch(world, created, {"title": "Stale title"})
    assert stale.value.status == 412


def test_scoped_backlinks_and_prefix_search_hide_restricted_sources(world, native_engine):
    org, _, members, tokens = world
    target = create(world, "Related")
    source = create(world, "Source")
    patch(world, source, {"markdown": "Prefix searchable content and [[Related]]"})
    link = DocumentLink.objects.get()
    assert str(link.target_id) == target["id"]
    page = services.backlinks(
        verified=tokens[2],
        organisation_id=org.id,
        document_id=Document.objects.get(pk=target["id"]).id,
        cursor=None,
        limit=1,
    )
    assert page["data"] == [{"documentId": source["id"], "title": "Source"}]
    found = services.search(
        verified=tokens[2], organisation_id=org.id, query="searchab", cursor=None, limit=10
    )
    assert [entry["id"] for entry in found["data"]] == [source["id"]]
    Document.objects.filter(pk=source["id"]).update(visibility="restricted")
    assert (
        services.search(
            verified=tokens[2], organisation_id=org.id, query="searchab", cursor=None, limit=10
        )["data"]
        == []
    )
    assert (
        services.backlinks(
            verified=tokens[2],
            organisation_id=org.id,
            document_id=Document.objects.get(pk=target["id"]).id,
            cursor=None,
            limit=10,
        )["data"]
        == []
    )
    # The creator retains access; a viewer grant opens just this page again.
    DocumentGrant.objects.create(document_id=source["id"], membership=members[2], role="viewer")
    assert (
        services.search(
            verified=tokens[2], organisation_id=org.id, query="searchab", cursor=None, limit=10
        )["data"][0]["id"]
        == source["id"]
    )


def test_inherited_viewer_parent_and_ban_revoke_document_authority(world, native_engine):
    org, _, members, tokens = world
    parent = create(world, "Parent")
    child = create(world, "Child", parent=Document.objects.get(pk=parent["id"]).id)
    DocumentGrant.objects.create(document_id=parent["id"], membership=members[2], role="viewer")
    assert (
        services.read(
            verified=tokens[2],
            organisation_id=org.id,
            document_id=Document.objects.get(pk=child["id"]).id,
        )["role"]
        == "viewer"
    )
    moderation.moderate(
        verified=tokens[1],
        organisation_id=org.id,
        target_id=members[3].id,
        action="ban",
        reason="Example",
        expires_at=None,
        request_id=str(uuid4()),
    )
    with pytest.raises(RefusalError) as denied:
        services.read(
            verified=tokens[3],
            organisation_id=org.id,
            document_id=Document.objects.get(pk=child["id"]).id,
        )
    assert denied.value.status == 403


def test_native_journal_compaction_reconnect_and_viewer_refusal_are_durable(
    world, native_engine, settings
):
    from urllib.parse import quote

    from django.conf import settings as current_settings

    org, _, members, tokens = world
    created = create(world, "Collaborative")
    document = Document.objects.get(pk=created["id"])
    DocumentGrant.objects.create(document=document, membership=members[2], role="viewer")
    editor = services.collab_session(
        verified=tokens[3], organisation_id=org.id, document_id=document.id, request_id=str(uuid4())
    )
    viewer = services.collab_session(
        verified=tokens[2], organisation_id=org.id, document_id=document.id, request_id=str(uuid4())
    )
    database = current_settings.DATABASES["default"]
    url = (
        "postgresql://"
        + quote(database["USER"], safe="")
        + ":"
        + quote(database["PASSWORD"], safe="")
        + "@"
        + database["HOST"]
        + ":"
        + str(database["PORT"])
        + "/"
        + quote(database["NAME"], safe="")
    )
    root = Path(__file__).resolve().parents[2] / "yjs_collab"
    binary = shutil.which("node")
    if binary is None:
        raise RuntimeError("native document tests require Node.js")
    environment = {
        "PATH": os.environ["PATH"],
        "KODERA_TEST_DATABASE_URL": url,
        "KODERA_TEST_COLLAB_KEY": base64.urlsafe_b64encode(
            settings.KODERA_COLLAB_TICKET_KEY
        ).decode(),
    }
    result = subprocess.run(  # noqa: S603 - resolved interpreter, owned test program and generated database
        [binary, str(root / "test/store-fixture.mjs")],
        cwd=root,
        env=environment,
        input=json.dumps({"editor": editor["token"], "viewer": viewer["token"]}).encode(),
        capture_output=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr.decode()
    assert json.loads(result.stdout)["viewerRefused"] is True
    stored = DocumentSnapshot.objects.get(document=document)
    assert stored.sequence == 32 and stored.head_sequence == 33
    assert DocumentUpdate.objects.filter(document=document).count() == 1
    with pytest.raises(IntegrityError, match="document journal is immutable"), transaction.atomic():
        DocumentUpdate.objects.filter(document=document).update(state=b"changed")
    with pytest.raises(IntegrityError, match="not covered by a snapshot"), transaction.atomic():
        DocumentUpdate.objects.filter(document=document).delete()


def test_postgres_backed_sockets_converge_audit_and_recheck_current_roles(
    world, native_engine, settings
):
    from urllib.parse import quote

    from django.conf import settings as current_settings

    org, _, members, tokens = world
    created = create(world, "Socket acceptance")
    document = Document.objects.get(pk=created["id"])
    DocumentGrant.objects.create(document=document, membership=members[2], role="viewer")
    editor = services.collab_session(
        verified=tokens[3], organisation_id=org.id, document_id=document.id, request_id=str(uuid4())
    )
    viewer = services.collab_session(
        verified=tokens[2], organisation_id=org.id, document_id=document.id, request_id=str(uuid4())
    )
    database = current_settings.DATABASES["default"]
    url = (
        "postgresql://"
        + quote(database["USER"], safe="")
        + ":"
        + quote(database["PASSWORD"], safe="")
        + "@"
        + database["HOST"]
        + ":"
        + str(database["PORT"])
        + "/"
        + quote(database["NAME"], safe="")
    )
    root = Path(__file__).resolve().parents[2] / "yjs_collab"
    binary = shutil.which("node")
    if binary is None:
        raise RuntimeError("native document tests require Node.js")
    result = subprocess.run(  # noqa: S603 - owned native fixture against the generated database
        [binary, str(root / "test/socket-store-fixture.mjs")],
        cwd=root,
        env={
            "PATH": os.environ["PATH"],
            "KODERA_TEST_DATABASE_URL": url,
            "KODERA_TEST_COLLAB_KEY": base64.urlsafe_b64encode(
                settings.KODERA_COLLAB_TICKET_KEY
            ).decode(),
        },
        input=json.dumps({"editor": editor["token"], "viewer": viewer["token"]}).encode(),
        capture_output=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr.decode()
    assert json.loads(result.stdout) == {"converged": True, "viewerRefused": True, "revoked": True}
    document.refresh_from_db()
    assert "First" in document.markdown and "Second" in document.markdown
    assert "Forbidden" not in document.markdown
