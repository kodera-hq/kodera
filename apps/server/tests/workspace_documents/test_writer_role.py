"""Workspace document paths run under the restricted API writer role and refuse tampering."""

from uuid import UUID, uuid4

import pytest
from django.db import connection, transaction
from test_intake_writer_role import (
    CHECK_VIOLATION,
    INSUFFICIENT_PRIVILEGE,
    acting_as,
    current_user,
    refused,
)
from test_workspace_writer_role import _role
from workspace_safety.test_moderation import world as world

from apps.docs import services
from apps.docs.models import DocumentGrant, DocumentSnapshot
from workspace_documents.test_services import native_engine as native_engine

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def writer(world):
    yield from _role()


def test_writer_role_serves_document_operations_and_refuses_tampering(
    world, writer, native_engine
):
    org, _, members, tokens = world
    # Schema owner seeds a restricted document grant later read by docs_document_role.
    with acting_as(writer):
        assert current_user() == writer
        root_doc = services.create(
            verified=tokens[3],
            organisation_id=org.id,
            name="Writer Root",
            parent_id=None,
            template_key="spec",
            request_id=str(uuid4()),
        )
        root_id = UUID(root_doc["id"])
        child_doc = services.create(
            verified=tokens[3],
            organisation_id=org.id,
            name="Writer Child",
            parent_id=root_id,
            template_key=None,
            request_id=str(uuid4()),
        )
        child_id = UUID(child_doc["id"])

    DocumentGrant.objects.create(document_id=root_id, membership=members[2], role="viewer")

    with acting_as(writer):
        viewed = services.read(verified=tokens[2], organisation_id=org.id, document_id=child_id)
        assert viewed["role"] == "viewer"

        updated = services.patch(
            verified=tokens[3],
            organisation_id=org.id,
            document_id=child_id,
            changes={"markdown": "# Child\n\nReferences [[Writer Root]] and writer_token_check.\n"},
            if_match=services.tag(child_doc),
            request_id=str(uuid4()),
        )
        assert "Writer Root" in updated["markdown"]

        listed = services.list_documents(
            verified=tokens[2], organisation_id=org.id, cursor=None, limit=10, parent_id=root_id
        )
        assert [row["id"] for row in listed["data"]] == [str(child_id)]

        links_page = services.backlinks(
            verified=tokens[2], organisation_id=org.id, document_id=root_id, cursor=None, limit=10
        )
        assert links_page["data"] == [{"documentId": str(child_id), "title": "Writer Child"}]

        found = services.search(
            verified=tokens[2],
            organisation_id=org.id,
            query="writer_token_check",
            cursor=None,
            limit=10,
        )
        assert [row["id"] for row in found["data"]] == [str(child_id)]

        grant = services.collab_session(
            verified=tokens[3],
            organisation_id=org.id,
            document_id=child_id,
            request_id=str(uuid4()),
        )
        assert grant["role"] == "editor"

        services.delete(
            verified=tokens[3],
            organisation_id=org.id,
            document_id=child_id,
            request_id=str(uuid4()),
        )

        # Uncovered journal updates cannot be deleted even though DELETE is granted for compaction.
        snapshot = DocumentSnapshot.objects.get(document_id=root_id)
        next_seq = snapshot.head_sequence + 1
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO docs_documentupdate "
                "(id, created_at, updated_at, sequence, state, actor_id, document_id) "
                "SELECT %s, clock_timestamp(), clock_timestamp(), %s, %s, i.id, %s "
                "FROM identity_identity i WHERE i.user_id = %s AND i.organisation_id = %s",
                [uuid4(), next_seq, b"\x01", root_id, members[3].user_id, org.id],
            )
        assert refused("DELETE FROM docs_documentupdate") == CHECK_VIOLATION

        assert refused("DELETE FROM docs_document") == INSUFFICIENT_PRIVILEGE
        assert refused("TRUNCATE docs_document CASCADE") == INSUFFICIENT_PRIVILEGE
        assert refused("DELETE FROM docs_documentsnapshot") == INSUFFICIENT_PRIVILEGE
        assert (
            refused("UPDATE docs_document SET visibility = 'restricted'")
            == INSUFFICIENT_PRIVILEGE
        )
        assert (
            refused("UPDATE docs_document SET workspace_id = workspace_id")
            == INSUFFICIENT_PRIVILEGE
        )
        assert (
            refused("UPDATE docs_document SET creator_id = creator_id")
            == INSUFFICIENT_PRIVILEGE
        )
        assert (
            refused(
                "INSERT INTO docs_documentgrant "
                "(id, created_at, updated_at, role, document_id, membership_id) "
                "SELECT gen_random_uuid(), now(), now(), 'viewer', document_id, membership_id "
                "FROM docs_documentgrant"
            )
            == INSUFFICIENT_PRIVILEGE
        )
        assert refused("DELETE FROM docs_documentgrant") == INSUFFICIENT_PRIVILEGE
        assert (
            refused("UPDATE docs_documentupdate SET state = state")
            == INSUFFICIENT_PRIVILEGE
        )
        assert (
            refused(
                "UPDATE audit_auditevent SET action = 'workspace.document.deleted' "
                "WHERE action = 'workspace.document.created'"
            )
            == INSUFFICIENT_PRIVILEGE
        )
        assert refused("DELETE FROM audit_auditevent") == INSUFFICIENT_PRIVILEGE
