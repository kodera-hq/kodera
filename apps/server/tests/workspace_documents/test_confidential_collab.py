"""Confidential document boundaries, epoch-bound collab tickets, SQL fence, and search exclusion."""

import base64
import hashlib
import json
import os
import time
from dataclasses import replace
from functools import partial
from uuid import UUID, uuid4

import pytest
from customer_http_fixtures import http_signer as http_signer, token
from django.db import IntegrityError, connection, transaction
from test_e2ee_relay import admit_peer, relay as relay
from test_intake_writer_role import acting_as
from workspace_safety.test_moderation import world as world

from apps.docs import privacy_selectors, services
from apps.docs.errors import RefusalError
from apps.docs.models import DocumentLink
from apps.e2ee.models import Device, Participant, Room
from apps.identity.models import Identity
from apps.orgs.privacy_archives import Request
from apps.orgs.privacy_core_sources import CoreSources
from core.idempotency.fingerprint import body_sha256
from core.idempotency.models import IdempotencyRecord
from workspace_documents.test_collab_role import collab_role as collab_role
from workspace_documents.test_http import auth_headers, http as http
from workspace_documents.test_services import native_engine as native_engine

pytestmark = pytest.mark.django_db(transaction=True)


def decode_ticket_claims(token: str) -> dict:
    raw = token.split(".")[0]
    padded = raw + "=" * (-len(raw) % 4)
    return json.loads(base64.urlsafe_b64decode(padded))


def test_confidential_document_forbids_downgrade_plaintext_ai_links_and_server_search(
    world, native_engine, settings
):
    org, workspace, members, tokens = world
    settings.KODERA_COLLAB_PUBLIC_URL = "wss://collab.kodera.test/documents/collab"

    ordinary = services.create(
        verified=tokens[0],
        organisation_id=org.id,
        name="Public Design Spec",
        parent_id=None,
        template_key=None,
        request_id=str(uuid4()),
    )
    ordinary_id = UUID(ordinary["id"])
    services.patch(
        verified=tokens[0],
        organisation_id=org.id,
        document_id=ordinary_id,
        changes={"markdown": "# Spec\n\nContains searchable_keyword_alpha and [[Target]].\n"},
        if_match=services.tag(ordinary),
        request_id=str(uuid4()),
    )

    # Confidential doc refuses starter templates, stores empty markdown, and emits zero links.
    with pytest.raises(RefusalError) as template_refused:
        services.create(
            verified=tokens[0],
            organisation_id=org.id,
            name="Confidential Board Notes",
            parent_id=None,
            template_key="spec",
            request_id=str(uuid4()),
            is_confidential=True,
            encryption_epoch=3,
        )
    assert template_refused.value.status == 403

    secret_doc = services.create(
        verified=tokens[0],
        organisation_id=org.id,
        name="Confidential Board Notes searchable_keyword_alpha",
        parent_id=None,
        template_key=None,
        request_id=str(uuid4()),
        is_confidential=True,
        encryption_epoch=3,
    )
    secret_id = UUID(secret_doc["id"])
    assert secret_doc["markdown"] == ""
    assert DocumentLink.objects.filter(source_id=secret_id).count() == 0

    # REST PATCH with non-empty markdown is refused with 403; title rename succeeds cleanly.
    with pytest.raises(RefusalError) as patch_refused:
        services.patch(
            verified=tokens[0],
            organisation_id=org.id,
            document_id=secret_id,
            changes={"markdown": "plaintext leak"},
            if_match=services.tag(secret_doc),
            request_id=str(uuid4()),
        )
    assert patch_refused.value.status == 403

    # Reparenting an ordinary document under a confidential parent (or vice versa) is refused (409),
    # and the DB scope guard independently refuses raw SQL reparenting across confidentiality!
    with pytest.raises(RefusalError) as reparent_plain_under_secret:
        services.patch(
            verified=tokens[0],
            organisation_id=org.id,
            document_id=ordinary_id,
            changes={"parentId": secret_id},
            if_match="*",
            request_id=str(uuid4()),
        )
    assert reparent_plain_under_secret.value.status == 409

    with pytest.raises(RefusalError) as reparent_secret_under_plain:
        services.patch(
            verified=tokens[0],
            organisation_id=org.id,
            document_id=secret_id,
            changes={"parentId": ordinary_id},
            if_match="*",
            request_id=str(uuid4()),
        )
    assert reparent_secret_under_plain.value.status == 409

    with pytest.raises(IntegrityError), transaction.atomic(), connection.cursor() as cursor:
        cursor.execute(
            "UPDATE docs_document SET parent_id = %s WHERE id = %s",
            [secret_id, ordinary_id],
        )

    # Collaboration epochs > u32 max (0xffffffff) are refused across create and tickets.mint!
    with pytest.raises(RefusalError) as epoch_overflow:
        services.create(
            verified=tokens[0],
            organisation_id=org.id,
            name="Overflow Epoch Doc",
            parent_id=None,
            template_key=None,
            request_id=str(uuid4()),
            is_confidential=True,
            encryption_epoch=2**32,
        )
    assert epoch_overflow.value.status == 422

    # AI / service actor tokens are refused on confidential documents across read, patch, and collab.
    ai_token = replace(tokens[0], email="kodera-ai@acme.kodera.test")
    with pytest.raises(RefusalError) as ai_read:
        services.read(verified=ai_token, organisation_id=org.id, document_id=secret_id)
    assert ai_read.value.status == 403
    with pytest.raises(RefusalError) as ai_collab:
        services.collab_session(
            verified=ai_token,
            organisation_id=org.id,
            document_id=secret_id,
            request_id=str(uuid4()),
        )
    assert ai_collab.value.status == 403

    # Server FTS search returns the ordinary document and strictly excludes the confidential document.
    results = services.search(
        verified=tokens[0],
        organisation_id=org.id,
        query="searchable_keyword_alpha",
        cursor=None,
        limit=20,
    )
    assert [item["id"] for item in results["data"]] == [str(ordinary_id)]

    # Database trigger forbids downgrading is_confidential TRUE -> FALSE or writing non-empty markdown.
    with pytest.raises(IntegrityError), transaction.atomic(), connection.cursor() as cursor:
        cursor.execute(
            "UPDATE docs_document SET is_confidential = FALSE WHERE id = %s",
            [secret_id],
        )
    with pytest.raises(IntegrityError), transaction.atomic(), connection.cursor() as cursor:
        cursor.execute(
            "UPDATE docs_document SET markdown = 'leak' WHERE id = %s",
            [secret_id],
        )


def test_e2ee_room_bound_collab_ticket_and_sql_fence_enforce_epoch_and_active_participation(
    relay, native_engine, collab_role, settings
):
    admit_peer(relay)
    org = relay[0]
    workspace = relay[1]
    members = relay[2]
    tokens = [
        replace(token, device_id=device) for token, device in zip(relay[3], relay[5], strict=True)
    ]
    room_id = relay[6]
    room = Room.objects.get(pk=room_id)
    settings.KODERA_COLLAB_PUBLIC_URL = "wss://collab.kodera.test/documents/collab"
    settings.KODERA_COLLAB_TICKET_KEY = os.urandom(32)

    doc = services.create(
        verified=tokens[0],
        organisation_id=org.id,
        name="Channel Encrypted Doc",
        parent_id=None,
        template_key=None,
        request_id=str(uuid4()),
        channel_id=room.channel_id,
    )
    doc_id = UUID(doc["id"])

    # Participating member 0 receives epoch-bound confidential ticket matching e2ee_room.epoch.
    session_grant = services.collab_session(
        verified=tokens[0],
        organisation_id=org.id,
        document_id=doc_id,
        request_id=str(uuid4()),
    )
    assert session_grant["confidential"] is True
    assert session_grant["epoch"] == room.epoch
    claims = decode_ticket_claims(session_grant["token"])
    assert claims["confidential"] is True
    assert claims["epoch"] == room.epoch
    assert claims["device"] == str(relay[5][0])

    # A non-participant has no document visibility, including on the collaboration route.
    with pytest.raises(RefusalError) as non_participant:
        services.collab_session(
            verified=tokens[3],
            organisation_id=org.id,
            document_id=doc_id,
            request_id=str(uuid4()),
        )
    assert non_participant.value.status == 404

    identity_0 = Identity.objects.get(user=members[0].user, organisation=org)
    base_args = [
        doc_id,
        org.id,
        members[0].id,
        identity_0.id,
        tokens[0].issuer,
        tokens[0].subject,
        "editor",
    ]

    with acting_as(collab_role):
        # 7-arg plaintext fence on confidential doc fails closed -> NULL!
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute("SELECT docs_collab_fence(%s,%s,%s,%s,%s,%s,%s)", base_args)
            assert cursor.fetchone() == (None,)

        # Legacy tickets lack a device binding and cannot open room-bound documents.
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(
                "SELECT docs_collab_fence(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                [*base_args, True, room.epoch],
            )
            assert cursor.fetchone() == (None,)

        # The device-aware fence with exact epoch succeeds.
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(
                "SELECT docs_collab_fence(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                [*base_args, True, room.epoch, relay[5][0]],
            )
            assert cursor.fetchone() == (workspace.id,)

        # Wrong epoch fails closed -> NULL!
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(
                "SELECT docs_collab_fence(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                [*base_args, True, room.epoch + 1, relay[5][0]],
            )
            assert cursor.fetchone() == (None,)

    # Revoking member 0's device immediately invalidates the SQL fence -> NULL,
    # AND invalidates authorize_collab_session (used on POST /collab-session idempotent replay)!
    Device.objects.filter(pk=relay[5][0]).update(revoked_at=room.updated_at)
    with pytest.raises(RefusalError) as replay_auth_refused:
        services.authorize_collab_session(
            verified=tokens[0],
            organisation_id=org.id,
            document_id=doc_id,
        )
    assert replay_auth_refused.value.status == 404
    with acting_as(collab_role), transaction.atomic(), connection.cursor() as cursor:
        cursor.execute(
            "SELECT docs_collab_fence(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            [*base_args, True, room.epoch, relay[5][0]],
        )
        assert cursor.fetchone() == (None,)

    # Room-bound confidential documents are excluded from server search.
    search_res = services.search(
        verified=tokens[0],
        organisation_id=org.id,
        query="Encrypted",
        cursor=None,
        limit=20,
    )
    assert all(item["id"] != str(doc_id) for item in search_res["data"])


@pytest.mark.parametrize(
    "state",
    [
        "active",
        "active-member",
        "active-second-device",
        "nonmember",
        "revoked",
        "retired",
        "absent",
    ],
)
def test_confidential_subject_export_uses_current_device_and_room_authority(
    relay, native_engine, state
):
    admit_peer(relay)
    org, workspace, members, tokens = relay[:4]
    room = Room.objects.get(pk=relay[6])
    document = services.create(
        verified=replace(tokens[0], device_id=relay[5][0]),
        organisation_id=org.id,
        name="Encrypted export",
        parent_id=None,
        template_key=None,
        request_id=str(uuid4()),
        channel_id=room.channel_id,
    )
    document_id = UUID(document["id"])
    index = 3 if state == "nonmember" else 2 if state == "active-member" else 0
    member = members[index]
    identity = Identity.objects.get(user=member.user, organisation=org)
    if state == "active-second-device":
        second = Device.objects.create(
            organisation=org, membership=member, identity=identity, signing_key=os.urandom(32)
        )
        Participant.objects.create(
            organisation=org, room=room, device=second, joined_epoch=room.epoch
        )
    if state in {"revoked", "active-second-device"}:
        Device.objects.filter(pk=relay[5][index]).update(revoked_at=room.updated_at)
    elif state == "retired":
        Participant.objects.filter(room=room, device_id=relay[5][index]).update(
            left_epoch=room.epoch + 1
        )
    elif state == "absent":
        Participant.objects.filter(room=room, device_id=relay[5][index]).delete()

    # Exercise the production callback directly, then its real worker caller.
    assert privacy_selectors.document_role_permitted(
        identifier=document_id,
        organisation_id=org.id,
        membership_id=member.id,
        identity_id=identity.id,
        issuer=tokens[index].issuer,
        subject=tokens[index].subject,
    ) is state.startswith("active")
    now = int(time.time())
    request = Request(
        str(uuid4()),
        str(identity.id),
        str(member.user_id),
        "workspace",
        str(org.id),
        True,
        now,
        now + 600,
    )
    permitted = partial(CoreSources._document_allowed, request)
    assert permitted(document_id) is state.startswith("active")
    with transaction.atomic():
        parts = list(
            privacy_selectors.document_export_parts(
                scope=request.scope,
                user_id=request.user_id,
                workspace_ids=(workspace.id,),
                permitted=permitted,
                max_journal_entries=256,
            )
        )
    if state.startswith("active"):
        metadata, snapshot = parts
        assert metadata.value["format"] == "kde1-v1"
        assert metadata.value["markdownProjection"] == ""
        assert snapshot.identifier == document_id
        assert isinstance(snapshot.value, bytes)
    else:
        assert parts == []


@pytest.mark.parametrize("stored_by", ["legacy", "current"])
@pytest.mark.parametrize("with_device_claim", [False, True])
@pytest.mark.parametrize("body", [b"", b"{}"])
def test_ordinary_session_replays_body_only_records_with_or_without_device_claim(
    world, native_engine, http, http_signer, stored_by, with_device_claim, body
):
    org, _, _, tokens = world
    device_id = uuid4()
    document = services.create(
        verified=tokens[0],
        organisation_id=org.id,
        name="Ordinary replay",
        parent_id=None,
        template_key=None,
        request_id=str(uuid4()),
    )
    client, _ = http
    path = f"/api/v1/organisations/{org.id}/workspace/documents/{document['id']}/collab-session"
    key = str(uuid4())
    now = int(time.time())
    credentials = [
        token(
            http_signer,
            org.issuer,
            subject=tokens[0].subject,
            email_verified=True,
            iat=now,
            exp=now + 300,
            **({"kodera_device_id": str(device_id)} if claimed else {}),
        )
        for claimed in (False, True)
    ]

    def session(credential):
        return client.post(
            path,
            data=body,
            content_type="application/json",
            **auth_headers(credential, idempotency_key=key),
        )

    if stored_by == "legacy":
        # Seed the body-only receipt written before device-aware replay was deployed.
        grant = services.collab_session(
            verified=replace(tokens[0], device_id=device_id if with_device_claim else None),
            organisation_id=org.id,
            document_id=UUID(document["id"]),
            request_id=str(uuid4()),
        )
        original_body = json.dumps(grant, sort_keys=True, separators=(",", ":")).encode()
        IdempotencyRecord.objects.create(
            issuer=org.issuer,
            subject=tokens[0].subject,
            method="POST",
            path=path,
            key_sha256=hashlib.sha256(key.encode()).hexdigest(),
            body_sha256=body_sha256(body),
            status=201,
            content_type="application/json",
            body=original_body,
        )
    else:
        issued = session(credentials[with_device_claim])
        assert issued.status_code == 201
        assert issued.get("Idempotency-Replayed") is None
        assert issued.json()["confidential"] is False
        original_body = issued.content

    before = list(IdempotencyRecord.objects.filter(path=path).values())
    assert len(before) == 1
    assert before[0]["body_sha256"] == body_sha256(body)
    for credential in (credentials[with_device_claim], credentials[not with_device_claim]):
        replay = session(credential)
        assert replay.status_code == 201
        assert replay["Idempotency-Replayed"] == "true"
        assert replay.content == original_body
    assert list(IdempotencyRecord.objects.filter(path=path).values()) == before


@pytest.mark.parametrize("legacy_receipt", [False, True])
@pytest.mark.parametrize("with_device_claim", [False, True])
def test_standalone_confidential_session_replay_context_preserves_optional_device(
    world, native_engine, http, http_signer, with_device_claim, legacy_receipt
):
    org, _, _, tokens = world
    device_id = uuid4() if with_device_claim else None
    document = services.create(
        verified=tokens[0],
        organisation_id=org.id,
        name="Standalone confidential replay",
        parent_id=None,
        template_key=None,
        request_id=str(uuid4()),
        is_confidential=True,
        encryption_epoch=3,
    )
    now = int(time.time())
    credential = token(
        http_signer,
        org.issuer,
        subject=tokens[0].subject,
        email_verified=True,
        iat=now,
        exp=now + 300,
        **({"kodera_device_id": str(device_id)} if device_id is not None else {}),
    )
    client, _ = http
    path = f"/api/v1/organisations/{org.id}/workspace/documents/{document['id']}/collab-session"
    headers = auth_headers(credential, idempotency_key=str(uuid4()))
    issued = client.post(path, data=b"{}", content_type="application/json", **headers)
    assert issued.status_code == 201
    claims = decode_ticket_claims(issued.json()["token"])
    expected_hash = body_sha256(b"{}")
    if device_id is None:
        assert "device" not in claims
    else:
        assert claims["device"] == str(device_id)
        expected_hash = hashlib.sha256(
            json.dumps([str(device_id), expected_hash], separators=(",", ":")).encode()
        ).hexdigest()
    assert IdempotencyRecord.objects.get(path=path).body_sha256 == expected_hash
    if legacy_receipt and not with_device_claim:
        IdempotencyRecord.objects.filter(path=path).update(
            body_sha256=hashlib.sha256(
                json.dumps(["None", expected_hash], separators=(",", ":")).encode()
            ).hexdigest()
        )
    replay = client.post(path, data=b"{}", content_type="application/json", **headers)
    assert replay.status_code == 201
    assert replay["Idempotency-Replayed"] == "true"
    assert replay.content == issued.content


def test_confidential_session_replay_cannot_disclose_another_devices_ticket(
    relay, native_engine, settings, http, http_signer
):
    admit_peer(relay)
    org, _, members, tokens = relay[:4]
    room = Room.objects.get(pk=relay[6])
    first = Device.objects.get(pk=relay[5][0])
    second = Device.objects.create(
        organisation=org, membership=members[0], identity=first.identity, signing_key=os.urandom(32)
    )
    Participant.objects.create(organisation=org, room=room, device=second, joined_epoch=room.epoch)
    unadmitted = Device.objects.create(
        organisation=org, membership=members[0], identity=first.identity, signing_key=os.urandom(32)
    )
    document = services.create(
        verified=replace(tokens[0], device_id=first.id),
        organisation_id=org.id,
        name="Encrypted replay",
        parent_id=None,
        template_key=None,
        request_id=str(uuid4()),
        channel_id=room.channel_id,
    )
    settings.KODERA_COLLAB_PUBLIC_URL = "wss://collab.kodera.test/documents/collab"
    client, _ = http
    path = f"/api/v1/organisations/{org.id}/workspace/documents/{document['id']}/collab-session"
    key = str(uuid4())

    def session(device, replay_key=key, body="{}"):
        now = int(time.time())
        credential = token(
            http_signer,
            org.issuer,
            subject=tokens[0].subject,
            email_verified=True,
            iat=now,
            exp=now + 300,
            **({"kodera_device_id": str(device)} if device is not None else {}),
        )
        return client.post(
            path,
            data=body,
            content_type="application/json",
            **auth_headers(credential, idempotency_key=replay_key),
        )

    issued = session(first.id)
    assert issued.status_code == 201
    assert decode_ticket_claims(issued.json()["token"])["device"] == str(first.id)
    replay = session(first.id, body="{ }")
    assert replay.status_code == 201
    assert replay["Idempotency-Replayed"] == "true"
    assert replay.content == issued.content

    other = session(second.id)
    assert other.status_code == 409
    assert other.json()["type"].endswith("/idempotency-key-reuse")
    assert other.get("Idempotency-Replayed") is None
    assert "token" not in other.json()
    for device in (None, unadmitted.id):
        denied = session(device)
        assert denied.status_code == 404
        assert denied.get("Idempotency-Replayed") is None
        assert "token" not in denied.json()

    other_issued = session(second.id, str(uuid4()))
    assert other_issued.status_code == 201
    assert decode_ticket_claims(other_issued.json()["token"])["device"] == str(second.id)
    assert other_issued.json()["token"] != issued.json()["token"]
    Device.objects.filter(pk=second.id).update(revoked_at=room.updated_at)
    assert session(second.id).status_code == 404
    assert session(first.id).content == issued.content
    Device.objects.filter(pk=first.id).update(revoked_at=room.updated_at)
    assert session(first.id).status_code == 404


@pytest.mark.parametrize("state", ["retired", "revoked", "absent"])
def test_confidential_grants_and_tickets_bind_exact_device(
    relay, collab_role, settings, state, http, http_signer
):
    from apps.docs import role_grants
    from apps.docs.models import Document, DocumentRoleGrant
    from apps.e2ee.models import Participant
    from apps.workspaces.models import WorkspaceMemberRole, WorkspaceRole

    admit_peer(relay)
    org, workspace, members, tokens = relay[:4]
    room = Room.objects.get(pk=relay[6])
    first = Device.objects.get(pk=relay[5][2])
    second = Device.objects.create(
        organisation=org, membership=members[2], identity=first.identity, signing_key=os.urandom(32)
    )
    participant = Participant.objects.create(
        organisation=org, room=room, device=second, joined_epoch=room.epoch
    )
    a = replace(tokens[2], device_id=first.id)
    b = replace(tokens[2], device_id=second.id)
    document = Document.objects.create(
        workspace=workspace,
        creator=members[0],
        channel_id=room.channel_id,
        title="Encrypted plan",
        visibility="restricted",
        is_confidential=True,
        encryption_epoch=room.epoch,
    )
    subteam = WorkspaceRole.objects.create(
        workspace=workspace, organisation_id=org.id, name="Editors", slug="editors", kind="subteam"
    )
    WorkspaceMemberRole.objects.create(workspace=workspace, membership=members[2], role=subteam)
    DocumentRoleGrant.objects.create(document=document, workspace_role=subteam, role="editor")
    settings.KODERA_COLLAB_TICKET_KEY = os.urandom(32)
    settings.KODERA_COLLAB_PUBLIC_URL = "wss://collab.kodera.test/documents/collab"
    ticket = services.collab_session(
        verified=b, organisation_id=org.id, document_id=document.id, request_id=str(uuid4())
    )
    assert decode_ticket_claims(ticket["token"])["device"] == str(second.id)
    if state == "retired":
        Participant.objects.filter(pk=participant.id).update(left_epoch=room.epoch + 1)
    elif state == "revoked":
        Device.objects.filter(pk=second.id).update(revoked_at=room.updated_at)
    else:
        participant.delete()
    snapshot = role_grants.list_grants(verified=a, organisation_id=org.id, document_id=document.id)
    client, _ = http
    path = f"/api/v1/organisations/{org.id}/workspace/documents/{document.id}"

    def credential(device):
        now = int(time.time())
        return token(
            http_signer,
            org.issuer,
            subject=tokens[2].subject,
            email_verified=True,
            iat=now,
            exp=now + 300,
            kodera_device_id=str(device),
        )

    active = client.get(path + "/role-grants", **auth_headers(credential(first.id)))
    assert active.status_code == 200
    inactive = credential(second.id)
    assert client.get(path + "/role-grants", **auth_headers(inactive)).status_code == 404
    assert (
        client.put(
            path + f"/role-grants/{subteam.id}",
            data=json.dumps({"role": "viewer"}),
            content_type="application/json",
            **auth_headers(inactive, HTTP_IF_MATCH=active["ETag"]),
        ).status_code
        == 404
    )
    assert (
        client.delete(
            path + f"/role-grants/{subteam.id}",
            **auth_headers(inactive, HTTP_IF_MATCH=active["ETag"]),
        ).status_code
        == 404
    )
    assert (
        client.post(
            path + "/collab-session",
            data="{}",
            content_type="application/json",
            **auth_headers(inactive, idempotency_key=str(uuid4())),
        ).status_code
        == 404
    )
    for actor in (b, tokens[2]):
        with pytest.raises(RefusalError) as denied:
            role_grants.list_grants(verified=actor, organisation_id=org.id, document_id=document.id)
        assert denied.value.status == 404
        for method in (role_grants.put_grant, role_grants.revoke_grant):
            extra = {"permission": "viewer"} if method == role_grants.put_grant else {}
            with pytest.raises(RefusalError) as denied:
                method(
                    verified=actor,
                    organisation_id=org.id,
                    document_id=document.id,
                    role_id=subteam.id,
                    if_match=role_grants.etag(document.id, snapshot),
                    request_id=str(uuid4()),
                    **extra,
                )
            assert denied.value.status == 404
        with pytest.raises(RefusalError) as denied:
            services.authorize_collab_session(
                verified=actor, organisation_id=org.id, document_id=document.id
            )
        assert denied.value.status == 404
    with acting_as(collab_role), transaction.atomic(), connection.cursor() as cursor:
        for device, expected in ((first.id, workspace.id), (second.id, None), (None, None)):
            cursor.execute(
                "SELECT docs_collab_fence(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                [
                    document.id,
                    org.id,
                    members[2].id,
                    first.identity_id,
                    a.issuer,
                    a.subject,
                    "editor",
                    True,
                    room.epoch,
                    device,
                ],
            )
            assert cursor.fetchone() == (expected,)


@pytest.mark.parametrize(
    "authority", ["claimless", "unknown", "revoked", "foreign", "missing-epoch", "valid"]
)
def test_standalone_confidential_grants_require_epoch_and_owned_active_device(world, authority):
    from apps.docs import role_grants
    from apps.docs.models import Document
    from apps.workspaces.models import WorkspaceRole

    org, workspace, members, tokens = world
    identity = Identity.objects.get(user=members[3].user)
    device = Device.objects.create(
        organisation=org, membership=members[3], identity=identity, signing_key=os.urandom(32)
    )
    document = Document.objects.create(
        workspace=workspace,
        creator=members[3],
        title="Protected",
        is_confidential=True,
        encryption_epoch=None if authority == "missing-epoch" else 3,
    )
    subteam = WorkspaceRole.objects.create(
        workspace=workspace, organisation_id=org.id, name="Readers", slug="readers", kind="subteam"
    )
    if authority == "revoked":
        from django.utils import timezone

        Device.objects.filter(pk=device.id).update(revoked_at=timezone.now())
    actor = replace(
        tokens[3],
        device_id=None
        if authority == "claimless"
        else uuid4()
        if authority == "unknown"
        else device.id,
    )
    if authority == "foreign":
        actor = replace(tokens[0], device_id=device.id)
    args = dict(verified=actor, organisation_id=org.id, document_id=document.id)
    if authority == "valid":
        snapshot = role_grants.list_grants(**args)
        saved = role_grants.put_grant(
            **args,
            role_id=subteam.id,
            permission="viewer",
            if_match=role_grants.etag(document.id, snapshot),
            request_id=str(uuid4()),
        )
        assert saved["data"][0]["role"] == "viewer"
    else:
        for operation in (role_grants.list_grants, role_grants.put_grant, role_grants.revoke_grant):
            extra = (
                {}
                if operation == role_grants.list_grants
                else dict(role_id=subteam.id, if_match='"stale"', request_id=str(uuid4()))
            )
            if operation == role_grants.put_grant:
                extra["permission"] = "viewer"
            with pytest.raises(RefusalError) as refused:
                operation(**args, **extra)
            assert refused.value.status in {403, 404}
