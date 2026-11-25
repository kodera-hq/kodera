"""Subteam grants share Core and realtime authority, with tenant and revision fences."""

from uuid import uuid4

import pytest
from django.db import IntegrityError, connection, transaction
from workspace_safety.test_moderation import world as world

from apps.docs import role_grants, services
from apps.docs.errors import RefusalError
from apps.docs.models import Document, DocumentGrant, DocumentRoleGrant
from apps.identity.models import Identity
from apps.workspaces.models import WorkspaceMemberRole, WorkspaceRole

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def grants(world):
    org, workspace, members, tokens = world
    document = Document.objects.create(
        workspace=workspace,
        creator=members[3],
        title="Restricted specification",
        visibility="restricted",
    )
    subteam = WorkspaceRole.objects.create(
        workspace=workspace,
        organisation_id=org.id,
        name="Engineering",
        slug="engineering",
        kind="subteam",
    )
    WorkspaceMemberRole.objects.create(workspace=workspace, membership=members[2], role=subteam)
    return document, subteam


def read(world, document, actor=3):
    org, _, _, tokens = world
    return role_grants.list_grants(
        verified=tokens[actor], organisation_id=org.id, document_id=document.id
    )


def put(world, document, subteam, permission="editor", etag=None, actor=3):
    org, _, _, tokens = world
    return role_grants.put_grant(
        verified=tokens[actor],
        organisation_id=org.id,
        document_id=document.id,
        role_id=subteam.id,
        permission=permission,
        if_match=etag
        if etag is not None
        else role_grants.etag(document.id, read(world, document, actor)),
        request_id=str(uuid4()),
    )


def test_role_grants_highest_privilege_and_ancestor_rules_match_core_queries(world, grants):
    org, workspace, members, tokens = world
    document, subteam = grants
    with pytest.raises(RefusalError) as hidden:
        services.read(verified=tokens[2], organisation_id=org.id, document_id=document.id)
    assert hidden.value.status == 404
    put(world, document, subteam, "viewer")
    assert (
        services.read(verified=tokens[2], organisation_id=org.id, document_id=document.id)["role"]
        == "viewer"
    )
    DocumentGrant.objects.create(document=document, membership=members[2], role="viewer")
    put(world, document, subteam, "editor")
    assert (
        services.read(verified=tokens[2], organisation_id=org.id, document_id=document.id)["role"]
        == "editor"
    )
    child = Document.objects.create(
        workspace=workspace, creator=members[3], parent=document, title="Child"
    )
    assert (
        services.read(verified=tokens[2], organisation_id=org.id, document_id=child.id)["role"]
        == "editor"
    )
    page = services.list_documents(
        verified=tokens[2], organisation_id=org.id, cursor=None, limit=10
    )
    assert {item["id"] for item in page["data"]} == {str(document.id), str(child.id)}
    DocumentRoleGrant.objects.filter(document=document).update(role="viewer")
    assert (
        services.read(verified=tokens[2], organisation_id=org.id, document_id=child.id)["role"]
        == "viewer"
    )
    # A grant on a child does not open a restricted ancestor, just like a member grant.
    DocumentRoleGrant.objects.filter(document=document).delete()
    DocumentGrant.objects.filter(document=document).delete()
    DocumentRoleGrant.objects.create(document=child, workspace_role=subteam, role="editor")
    assert (
        services.list_documents(verified=tokens[2], organisation_id=org.id, cursor=None, limit=10)[
            "data"
        ]
        == []
    )


def test_mutations_are_conditional_editor_only_and_audited(world, grants):
    from apps.audit.models import AuditEvent

    org, _, _, tokens = world
    document, subteam = grants
    initial = read(world, document)
    for tag, status in [("", 428), ('"stale"', 412), ("*", 412)]:
        with pytest.raises(RefusalError) as refused:
            put(world, document, subteam, etag=tag)
        assert refused.value.status == status
    current = put(world, document, subteam, "viewer")
    assert current["revision"] == initial["revision"] + 1
    with pytest.raises(RefusalError) as denied:
        read(world, document, 2)
    assert denied.value.status == 403
    with pytest.raises(RefusalError) as denied:
        put(world, document, subteam, actor=2, etag=role_grants.etag(document.id, current))
    assert denied.value.status == 403
    with pytest.raises(RefusalError) as stale:
        put(world, document, subteam, etag=role_grants.etag(document.id, initial))
    assert stale.value.status == 412
    after = role_grants.revoke_grant(
        verified=tokens[3],
        organisation_id=org.id,
        document_id=document.id,
        role_id=subteam.id,
        if_match=role_grants.etag(document.id, current),
        request_id=str(uuid4()),
    )
    assert after["data"] == [] and after["revision"] == current["revision"] + 1
    assert set(
        AuditEvent.objects.filter(action__startswith="workspace.document.role_grant_").values_list(
            "action", flat=True
        )
    ) == {"workspace.document.role_grant_updated", "workspace.document.role_grant_revoked"}


@pytest.mark.parametrize("kind", ["role", "tag"])
def test_database_and_service_refuse_non_subteams(world, grants, kind):
    document, subteam = grants
    WorkspaceRole.objects.filter(pk=subteam.id).update(kind=kind)
    with pytest.raises(RefusalError) as refused:
        put(world, document, subteam)
    assert refused.value.status == 404
    with pytest.raises(IntegrityError), transaction.atomic():
        DocumentRoleGrant.objects.create(document=document, workspace_role=subteam, role="editor")


def test_database_guards_kind_unique_role_and_cascade_deletion(world, grants):
    document, subteam = grants
    put(world, document, subteam)
    with pytest.raises(IntegrityError), transaction.atomic():
        WorkspaceRole.objects.filter(pk=subteam.id).update(kind="tag")
    with pytest.raises(IntegrityError), transaction.atomic():
        DocumentRoleGrant.objects.create(document=document, workspace_role=subteam, role="viewer")
    with pytest.raises(IntegrityError), transaction.atomic():
        DocumentRoleGrant.objects.filter(document=document).update(role="owner")
    # SQL erasure deletes must cascade too, rather than only Django's Collector.
    with connection.cursor() as cursor:
        cursor.execute("DELETE FROM workspaces_workspacememberrole WHERE role_id=%s", [subteam.id])
        cursor.execute("DELETE FROM workspaces_workspacerole WHERE id=%s", [subteam.id])
    assert not DocumentRoleGrant.objects.filter(document=document).exists()


def test_assignment_and_active_membership_revocation_close_current_access(world, grants):
    org, _, members, tokens = world
    document, subteam = grants
    put(world, document, subteam)
    WorkspaceMemberRole.objects.filter(role=subteam).delete()
    with pytest.raises(RefusalError) as hidden:
        services.read(verified=tokens[2], organisation_id=org.id, document_id=document.id)
    assert hidden.value.status == 404
    Identity.objects.filter(user=members[3].user).update(enabled=False)
    with pytest.raises(RefusalError) as denied:
        read(world, document)
    assert denied.value.status == 403


def test_cross_workspace_scope_and_document_cascade_are_enforced_in_sql(world, grants):
    from apps.orgs.models import Organisation, SlugReservation
    from apps.workspaces.models import Workspace

    document, subteam = grants
    slug = "other-" + uuid4().hex[:12]
    with transaction.atomic():
        org = Organisation.objects.create(
            slug=slug,
            realm=slug,
            name="Other",
            issuer=f"https://identity.example.org/realms/{slug}",
            state="prospect",
        )
        workspace = Workspace.objects.create(organisation=org)
        SlugReservation.objects.create(
            organisation=org, slug=slug, namespace="organisation", state="provisional"
        )
    foreign = WorkspaceRole.objects.create(
        workspace=workspace, organisation_id=org.id, name="Other", slug="other", kind="subteam"
    )
    with pytest.raises(RefusalError) as refused:
        put(world, document, foreign)
    assert refused.value.status == 404
    with pytest.raises(IntegrityError), transaction.atomic():
        DocumentRoleGrant.objects.create(document=document, workspace_role=foreign, role="editor")
    put(world, document, subteam)
    with connection.cursor() as cursor:
        cursor.execute("DELETE FROM docs_document WHERE id=%s", [document.id])
    assert not DocumentRoleGrant.objects.filter(workspace_role=subteam).exists()


def test_subteam_orm_deletion_and_document_soft_deletion_preserve_lifecycle(world, grants):
    org, _, _, tokens = world
    document, subteam = grants
    put(world, document, subteam)
    services.delete(
        verified=tokens[3], organisation_id=org.id, document_id=document.id, request_id=str(uuid4())
    )
    assert DocumentRoleGrant.objects.filter(document=document).exists()
    with pytest.raises(RefusalError) as hidden:
        services.read(verified=tokens[2], organisation_id=org.id, document_id=document.id)
    assert hidden.value.status == 404
    subteam.delete()
    assert not DocumentRoleGrant.objects.exists()


def test_noop_mutations_preserve_revision_etag_audit_and_notifications(world, grants):
    from apps.audit.models import AuditEvent

    org, _, _, tokens = world
    document, subteam = grants
    saved = put(world, document, subteam)
    audits = AuditEvent.objects.count()
    statements = []

    def capture(execute, sql, params, many, context):
        statements.append(sql)
        return execute(sql, params, many, context)

    with connection.execute_wrapper(capture):
        assert put(world, document, subteam) == saved
    assert AuditEvent.objects.count() == audits
    assert not any("pg_notify" in sql for sql in statements)
    removed = role_grants.revoke_grant(
        verified=tokens[3],
        organisation_id=org.id,
        document_id=document.id,
        role_id=subteam.id,
        if_match=role_grants.etag(document.id, saved),
        request_id=str(uuid4()),
    )
    audits = AuditEvent.objects.count()
    statements.clear()
    with connection.execute_wrapper(capture):
        assert (
            role_grants.revoke_grant(
                verified=tokens[3],
                organisation_id=org.id,
                document_id=document.id,
                role_id=subteam.id,
                if_match=role_grants.etag(document.id, removed),
                request_id=str(uuid4()),
            )
            == removed
        )
    assert AuditEvent.objects.count() == audits
    assert not any("pg_notify" in sql for sql in statements)


def test_database_refuses_rebinding_existing_grants(world, grants):
    document, subteam = grants
    put(world, document, subteam)
    other = Document.objects.create(
        workspace=document.workspace, creator=document.creator, title="Other"
    )
    with pytest.raises(IntegrityError) as refused, transaction.atomic():
        DocumentRoleGrant.objects.filter(document=document).update(document=other)
    assert refused.value.__cause__.diag.constraint_name == "docs_role_grant_binding"
