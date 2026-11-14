"""Actual PostgreSQL, native Yjs, private-volume and signing integration."""

import io
import json
import secrets
import time
import zipfile
from dataclasses import replace

import pytest
from workspace_documents.test_services import native_engine as native_engine
from workspace_safety.test_moderation import world as world

from apps.docs import services
from apps.docs.models import Document, DocumentSnapshot
from apps.identity.models import Identity
from apps.orgs.models import Membership
from apps.orgs.privacy_archives import ArchiveRefusalError, Request
from apps.orgs.privacy_core_sources import CoreSources
from apps.orgs.privacy_models import PrivacyExport
from apps.orgs.privacy_runtime import ExportRuntime
from apps.orgs.privacy_sources import ExportSigner, FrozenSource
from apps.orgs.privacy_storage import PrivateVolume
from core.db.ids import new_uuid7

pytestmark = pytest.mark.django_db(transaction=True)


class ControlledSupplement:
    # This fixture deliberately contains no additional domain records. It certifies only
    # its synthetic test world; no production completeness provider is installed.
    def capture(self, request):
        return ()

    def permitted(self, request, resource):
        return False


def controlled_adapters(core):
    return core.adapters(
        {
            section: ControlledSupplement()
            for section in ("identity", "memberships", "documents", "collections", "billing")
        }
    )


def configured(world, tmp_path, index=0, scope="workspace"):
    org, _, members, _ = world
    identity = Identity.objects.get(user=members[index].user, organisation=org)
    now = int(time.time())
    request = Request(
        str(new_uuid7()),
        str(identity.id),
        str(identity.user_id),
        scope,
        str(org.id) if scope == "workspace" else None,
        True,
        now,
        now + 600,
    )
    root = tmp_path.resolve() / "private"
    root.mkdir(mode=0o700)
    storage = PrivateVolume(root)
    return request, storage, CoreSources(storage), now


def test_personal_scope_exports_own_identity_and_memberships_only(world, tmp_path):
    request, _, core, _ = configured(world, tmp_path, 3, "account")
    identities = core.capture("identity", request)
    memberships = core.capture("memberships", request)
    assert len(identities) == 2 and len(memberships) == 1
    assert {
        json.loads(item.entry.content)["user_id"]
        for item in identities
        if item.resource.startswith("identity:")
    } == {request.user_id}
    other_identity = Identity.objects.exclude(user_id=request.user_id).first()
    assert not core.permitted(request, f"identity:{other_identity.id}")
    assert not core.permitted(request, f"membership:{world[2][0].id}")
    with pytest.raises(ArchiveRefusalError, match="Core export completeness providers unavailable"):
        core.adapters()
    assert set(controlled_adapters(core)) == {
        "identity",
        "memberships",
        "documents",
        "collections",
        "billing",
    }


def test_native_state_is_exported_and_revoked_resource_stops_frozen_source(
    world, native_engine, tmp_path
):
    org, _, members, tokens = world
    document = services.create(
        verified=tokens[3],
        organisation_id=org.id,
        name="Private export",
        parent_id=None,
        template_key=None,
        request_id=str(new_uuid7()),
    )
    request, storage, core, _ = configured(world, tmp_path, 3, "account")
    source = controlled_adapters(core)["documents"]
    snapshot = source.snapshot(request)
    page = source.page(request, snapshot, None)
    native = next(item for item in page.entries if item.name.endswith("snapshot.bin"))
    assert native.content == bytes(DocumentSnapshot.objects.get(document_id=document["id"]).state)
    assert any(item.name.endswith(".json") for item in page.entries)
    Document.objects.filter(pk=document["id"]).update(visibility="restricted")
    # The creator retains its real SQL role; a workspace owner is not an arbitrary grant.
    assert core.permitted(request, f"document:{document['id']}")
    Membership.objects.filter(id=members[3].id).update(state="suspended")
    assert not source.authorize(request, snapshot)
    with pytest.raises(ArchiveRefusalError, match="authority revoked"):
        FrozenSource("documents", storage, lambda _: (), core.permitted).page(
            request, snapshot, None
        )


def test_actual_private_signed_archive_resumes_from_database_and_new_volume_instances(
    world, native_engine, tmp_path
):
    org, _, _, tokens = world
    services.create(
        verified=tokens[0],
        organisation_id=org.id,
        name="Archive",
        parent_id=None,
        template_key=None,
        request_id=str(new_uuid7()),
    )
    request, storage, core, now = configured(world, tmp_path)
    private_key = secrets.token_bytes(32)
    signer = ExportSigner("synthetic-export-test", private_key)
    sources = controlled_adapters(core)
    # These explicit empty external fixtures certify only this controlled database world.
    # Production must provide complete Matrix/media scope sources and current resource checks.
    sources.update(
        {
            section: FrozenSource(section, storage, lambda _: (), lambda *_: True)
            for section in ("messages", "media")
        }
    )
    runtime = ExportRuntime(sources, storage, signer)
    runtime.start(request, now)
    for _ in range(8):
        reopened = PrivateVolume(storage.root)
        runtime = ExportRuntime(
            sources, reopened, ExportSigner("synthetic-export-test", private_key)
        )
        runtime.advance(request.id, now)
    assert PrivacyExport.objects.get(id=request.id).status == "ready"
    raw = runtime.artifact(request.id, now)
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        assert any(name.endswith("snapshot.bin") for name in archive.namelist())
        assert "manifest.json" in archive.namelist()
    assert runtime.artifact(request.id, now) == raw
    with pytest.raises(ArchiveRefusalError, match="incomplete export sources"):
        ExportRuntime(controlled_adapters(core), storage, signer).start(
            replace(request, id=str(new_uuid7())), now
        )
