"""Confidential document boundaries, epoch-bound collab tickets, SQL fence, and search exclusion."""

import base64
import json
import os
from dataclasses import replace
from uuid import UUID, uuid4

import pytest
from django.db import IntegrityError, connection, transaction
from test_e2ee_relay import admit_peer, relay as relay
from test_intake_writer_role import acting_as
from workspace_safety.test_moderation import world as world

from apps.docs import services
from apps.docs.errors import RefusalError
from apps.docs.models import DocumentLink
from apps.e2ee.models import Device, Room
from apps.identity.models import Identity
from workspace_documents.test_collab_role import collab_role as collab_role
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
    tokens = relay[3]
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

    # Member 3 is NOT an E2EE room participant -> collab_session refuses with 403!
    with pytest.raises(RefusalError) as non_participant:
        services.collab_session(
            verified=tokens[3],
            organisation_id=org.id,
            document_id=doc_id,
            request_id=str(uuid4()),
        )
    assert non_participant.value.status == 403

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

        # 9-arg fence with exact (True, room.epoch) succeeds!
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(
                "SELECT docs_collab_fence(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                [*base_args, True, room.epoch],
            )
            assert cursor.fetchone() == (workspace.id,)

        # Wrong epoch fails closed -> NULL!
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(
                "SELECT docs_collab_fence(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                [*base_args, True, room.epoch + 1],
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
    assert replay_auth_refused.value.status == 403
    with acting_as(collab_role), transaction.atomic(), connection.cursor() as cursor:
        cursor.execute(
            "SELECT docs_collab_fence(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            [*base_args, True, room.epoch],
        )
        assert cursor.fetchone() == (None,)

    # Room-bound confidential documents are excluded from server search and export as kde1-v1!
    search_res = services.search(
        verified=tokens[0],
        organisation_id=org.id,
        query="Encrypted",
        cursor=None,
        limit=20,
    )
    assert all(item["id"] != str(doc_id) for item in search_res["data"])

    from apps.docs.privacy_selectors import document_export_parts

    with transaction.atomic():
        parts = [
            part
            for part in document_export_parts(
                scope="organisation",
                user_id=str(members[0].user_id),
                workspace_ids=(workspace.id,),
                permitted=lambda candidate_id: candidate_id == doc_id,
                max_journal_entries=256,
            )
            if isinstance(part.value, dict)
        ]
    assert len(parts) == 1
    assert parts[0].value["format"] == "kde1-v1"
    assert parts[0].value["markdownProjection"] == ""
