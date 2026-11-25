"""Restricted runtime roles and confidential membership share the current grant decision."""

import base64
import json
from dataclasses import replace
from uuid import uuid4

import pytest
from django.db import connection, transaction
from test_e2ee_relay import admit_peer, relay as relay
from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, refused
from test_workspace_writer_role import _role
from workspace_safety.test_moderation import world as world

from apps.docs import role_grants, services
from apps.docs.collab_role import assert_unprivileged
from apps.docs.errors import RefusalError
from apps.docs.models import Document, DocumentRoleGrant
from apps.e2ee.models import Room
from apps.identity.models import Identity
from apps.workspaces.models import WorkspaceMemberRole, WorkspaceRole
from workspace_documents.test_collab_role import collab_role as collab_role
from workspace_documents.test_role_grants import grants as grants, put, read

pytestmark = pytest.mark.django_db(transaction=True)


def fence(world, document, permission, actor=2, *, confidential=False, epoch=None):
    org, _, members, tokens = world[:4]
    identity = Identity.objects.get(user=members[actor].user, organisation=org)
    return [
        document.id,
        org.id,
        members[actor].id,
        identity.id,
        tokens[actor].issuer,
        tokens[actor].subject,
        permission,
        confidential,
        epoch,
    ]


def test_restricted_writer_and_collab_grant_admission(world, grants, collab_role, settings):
    org, workspace, _, tokens = world
    document, subteam = grants
    # The writer role lifecycle helper is a generator, wrapped here without changing it.
    from contextlib import contextmanager

    with contextmanager(_role)() as writer:
        with acting_as(writer):
            current = put(world, document, subteam, "editor")
            assert (
                services.read(verified=tokens[2], organisation_id=org.id, document_id=document.id)[
                    "role"
                ]
                == "editor"
            )
            current = put(
                world, document, subteam, "viewer", etag=role_grants.etag(document.id, current)
            )
            assert current["data"][0]["role"] == "viewer"
    settings.KODERA_COLLAB_TICKET_KEY = bytes(range(32))
    settings.KODERA_COLLAB_PUBLIC_URL = "wss://collab.example.org/documents/collab"
    ticket = services.collab_session(
        verified=tokens[2], organisation_id=org.id, document_id=document.id, request_id=str(uuid4())
    )
    claims = json.loads(base64.urlsafe_b64decode(ticket["token"].split(".")[0] + "==="))
    assert ticket["role"] == claims["role"] == "viewer"
    args = fence(world, document, "viewer")
    with connection.cursor() as cursor:
        assert_unprivileged(cursor, collab_role)
    with acting_as(collab_role):
        assert refused("SELECT * FROM docs_documentrolegrant") == INSUFFICIENT_PRIVILEGE
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute("SELECT docs_collab_fence(%s,%s,%s,%s,%s,%s,%s,%s,%s)", args)
            assert cursor.fetchone() == (workspace.id,)
            cursor.execute(
                "SELECT docs_collab_fence(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                [*args[:6], "editor", *args[7:]],
            )
            assert cursor.fetchone() == (None,)
    role_grants.revoke_grant(
        verified=tokens[3],
        organisation_id=org.id,
        document_id=document.id,
        role_id=subteam.id,
        if_match=role_grants.etag(document.id, read(world, document)),
        request_id=str(uuid4()),
    )
    with acting_as(collab_role), transaction.atomic(), connection.cursor() as cursor:
        cursor.execute("SELECT docs_collab_fence(%s,%s,%s,%s,%s,%s,%s,%s,%s)", args)
        assert cursor.fetchone() == (None,)


def test_subteam_grants_never_open_confidential_channel_membership(relay, collab_role, settings):
    admit_peer(relay)
    org, workspace, members, tokens = relay[:4]
    room = Room.objects.get(pk=relay[6])
    document = Document.objects.create(
        workspace=workspace,
        creator=members[0],
        title="Encrypted subteam plan",
        visibility="restricted",
        channel_id=room.channel_id,
        is_confidential=True,
        encryption_epoch=room.epoch,
    )
    subteam = WorkspaceRole.objects.create(
        workspace=workspace,
        organisation_id=org.id,
        name="Engineering",
        slug="engineering",
        kind="subteam",
    )
    for member in (members[2], members[3]):
        WorkspaceMemberRole.objects.create(workspace=workspace, membership=member, role=subteam)
    DocumentRoleGrant.objects.create(document=document, workspace_role=subteam, role="editor")
    assert (
        services.read(
            verified=replace(tokens[2], device_id=relay[5][2]),
            organisation_id=org.id,
            document_id=document.id,
        )["role"]
        == "editor"
    )
    settings.KODERA_COLLAB_TICKET_KEY = bytes(range(32))
    settings.KODERA_COLLAB_PUBLIC_URL = "wss://collab.example.org/documents/collab"
    assert (
        services.collab_session(
            verified=replace(tokens[2], device_id=relay[5][2]),
            organisation_id=org.id,
            document_id=document.id,
            request_id=str(uuid4()),
        )["confidential"]
        is True
    )
    for method in (services.read, services.collab_session):
        extra = {"request_id": str(uuid4())} if method is services.collab_session else {}
        with pytest.raises(RefusalError) as hidden:
            method(verified=tokens[3], organisation_id=org.id, document_id=document.id, **extra)
        assert hidden.value.status == 404
    member_args = fence(relay, document, "editor", confidential=True, epoch=room.epoch)
    outsider_args = fence(relay, document, "editor", 3, confidential=True, epoch=room.epoch)
    with acting_as(collab_role), transaction.atomic(), connection.cursor() as cursor:
        cursor.execute(
            "SELECT docs_collab_fence(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)", [*member_args, relay[5][2]]
        )
        assert cursor.fetchone() == (workspace.id,)
        cursor.execute("SELECT docs_collab_fence(%s,%s,%s,%s,%s,%s,%s,%s,%s)", outsider_args)
        assert cursor.fetchone() == (None,)
