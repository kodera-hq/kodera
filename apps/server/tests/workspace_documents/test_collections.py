"""Typed query refusals and persisted tenant/ETag fences against real PostgreSQL."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import UUID, uuid4

import pytest
from django.db import IntegrityError, close_old_connections, connection, transaction
from django.utils import timezone
from workspace_safety.test_moderation import world as world

from apps.docs import collection_schema as schema, collections, services
from apps.docs.errors import RefusalError
from apps.docs.models import Collection, Document, DocumentGrant, DocumentSnapshot
from apps.media.models import Attachment
from apps.workspaces import quotas
from apps.workspaces.models import WorkspaceQuota
from workspace_documents.test_collab_role import collab_role as collab_role
from workspace_documents.test_services import native_engine as native_engine

PROPS = [
    {"id": "title", "name": "Title", "type": "text"},
    {"id": "priority", "name": "Priority", "type": "number"},
    {
        "id": "status",
        "name": "Status",
        "type": "select",
        "options": [{"id": "todo", "label": "To do"}],
    },
]
VIEWS = [
    {"id": "table", "name": "Table", "type": "table", "columns": ["title", "status"]},
    {
        "id": "board",
        "name": "Board",
        "type": "board",
        "groupByPropertyId": "status",
        "showEmptyGroups": True,
    },
    {"id": "list", "name": "List", "type": "list", "titlePropertyId": "title"},
]


@pytest.mark.parametrize(
    "kind,raw",
    [
        ("number", True),
        ("number", float("nan")),
        ("number", float("inf")),
        ("number", 10**1000),
        ("number", "1"),
        ("checkbox", 1),
        ("checkbox", None),
        ("date", "2026-02-30"),
        ("date", "20260101"),
        ("date", []),
        ("url", "javascript:alert(1)"),
        ("url", "https://user:pass@example.org"),
        ("url", "https://example.org:invalid"),
        ("person", "wrong"),
        ("text", "bad\x00value"),
        ("text", "x" * 10001),
    ],
)
def test_typed_values_refuse_invalid_wire_values(kind, raw):
    with pytest.raises(RefusalError, match="document operation refused") as failure:
        schema.value({"type": kind}, {"type": kind, "value": raw})
    assert failure.value.status == 422


@pytest.mark.parametrize(
    "mutant",
    [
        [],
        [{"id": "title", "name": "Title", "type": []}],
        [*PROPS, PROPS[0]],
        [{"id": "p", "name": "P", "type": "select", "options": [{"id": "a", "label": "A"}] * 2}],
    ],
)
def test_schema_refusal_controls(mutant):
    if mutant == []:
        schema.definitions(mutant)
    else:
        with pytest.raises(RefusalError):
            schema.definitions(mutant)


@pytest.mark.parametrize(
    "filters,sorts",
    [
        (
            [
                {
                    "propertyId": "title__password",
                    "operator": "eq",
                    "value": {"type": "text", "value": "x"},
                }
            ],
            [],
        ),
        ([{"propertyId": [], "operator": "eq"}], []),
        ([{"propertyId": "title", "operator": []}], []),
        (
            [
                {
                    "propertyId": "priority",
                    "operator": "regex",
                    "value": {"type": "number", "value": 1},
                }
            ],
            [],
        ),
        (
            [
                {
                    "propertyId": "priority",
                    "operator": "gt",
                    "value": {"type": "number", "value": None},
                }
            ],
            [],
        ),
        (
            [
                {
                    "propertyId": "status",
                    "operator": "contains",
                    "value": {"type": "select", "value": "todo"},
                }
            ],
            [],
        ),
        (
            [
                {
                    "propertyId": "title",
                    "operator": "is_empty",
                    "value": {"type": "text", "value": ""},
                }
            ],
            [],
        ),
        ([], [{"propertyId": "title", "direction": []}]),
        ([], [{"propertyId": "title", "direction": "asc; DROP TABLE docs_document"}]),
    ],
)
def test_query_refuses_syntax_type_and_operator_mutations(filters, sorts):
    with pytest.raises(RefusalError):
        schema.query(PROPS, filters, sorts)


@pytest.mark.parametrize(
    "view",
    [
        {"id": "x", "name": "X", "type": []},
        {"id": "x", "name": "X", "type": "table", "columns": ["unknown"]},
        {"id": "x", "name": "X", "type": "table", "columns": ["title", "title"]},
        {
            "id": "x",
            "name": "X",
            "type": "board",
            "groupByPropertyId": "title",
            "showEmptyGroups": True,
        },
        {"id": "x", "name": "X", "type": "list", "titlePropertyId": "priority"},
    ],
)
def test_views_refuse_invalid_cross_references(view):
    with pytest.raises(RefusalError):
        schema.views(PROPS, [view])


def test_property_identifiers_remain_bound_json_keys():
    from apps.docs.models import CollectionRow

    untrusted = "title__password'); DROP TABLE docs_document; --"
    query = CollectionRow.objects.annotate(selected=collections.expression(untrusted)).filter(
        selected="value"
    )
    sql, parameters = query.query.sql_with_params()
    assert untrusted not in sql
    assert any(isinstance(parameter, list) and untrusted in parameter for parameter in parameters)


def make_collection(world):
    org, _, _, tokens = world
    return collections.create(
        verified=tokens[3],
        organisation_id=org.id,
        body={"title": "Tasks", "properties": PROPS, "views": VIEWS},
        request_id=str(uuid4()),
    )


def make_doc(world, title):
    _, workspace, members, _ = world
    row = Document.objects.create(workspace=workspace, creator=members[3], title=title)
    DocumentSnapshot.objects.create(document=row, state=b"state")
    return row


def set_row(world, collection, document, number, name="Task"):
    org, _, _, tokens = world
    return collections.put_row(
        verified=tokens[3],
        organisation_id=org.id,
        collection_id=UUID(collection["id"]),
        document_id=document.id,
        body={
            "values": {
                "priority": {"type": "number", "value": number},
                "title": {"type": "text", "value": name},
            }
        },
        if_match="",
        if_none_match="*",
        request_id=str(uuid4()),
    )


@pytest.mark.django_db(transaction=True)
def test_collection_crud_rows_and_bound_cursor(world):
    org, _, _, tokens = world
    collection = make_collection(world)
    first, second = make_doc(world, "First"), make_doc(world, "Second")
    set_row(world, collection, first, 10, "Ten")
    original = set_row(world, collection, second, 2, "Two")
    query = {"sorts": [{"propertyId": "priority", "direction": "asc"}]}
    page = collections.query(
        verified=tokens[3],
        organisation_id=org.id,
        collection_id=UUID(collection["id"]),
        body=query,
        cursor=None,
        limit=1,
    )
    assert page["data"][0]["documentId"] == str(second.id)
    next_page = collections.query(
        verified=tokens[3],
        organisation_id=org.id,
        collection_id=UUID(collection["id"]),
        body=query,
        cursor=page["next_cursor"],
        limit=1,
    )
    assert next_page["data"][0]["documentId"] == str(first.id)
    for token, body, cursor in [
        (tokens[2], query, page["next_cursor"]),
        (tokens[3], {}, page["next_cursor"]),
        (tokens[3], query, page["next_cursor"] + "x"),
    ]:
        with pytest.raises(RefusalError) as failure:
            collections.query(
                verified=token,
                organisation_id=org.id,
                collection_id=UUID(collection["id"]),
                body=body,
                cursor=cursor,
                limit=1,
            )
        assert failure.value.status == 400
    updated = collections.put_row(
        verified=tokens[3],
        organisation_id=org.id,
        collection_id=UUID(collection["id"]),
        document_id=second.id,
        body={"values": {"priority": {"type": "number", "value": 3}}},
        if_match=services.tag(original),
        request_id=str(uuid4()),
    )
    with pytest.raises(RefusalError) as stale:
        collections.delete_row(
            verified=tokens[3],
            organisation_id=org.id,
            collection_id=UUID(collection["id"]),
            document_id=second.id,
            if_match=services.tag(original),
            request_id=str(uuid4()),
        )
    assert stale.value.status == 412
    assert (
        collections.read_row(
            verified=tokens[3],
            organisation_id=org.id,
            collection_id=UUID(collection["id"]),
            document_id=second.id,
        )
        == updated
    )
    with pytest.raises(RefusalError) as failure:
        collections.query(
            verified=tokens[3],
            organisation_id=org.id,
            collection_id=UUID(collection["id"]),
            body=query,
            cursor=page["next_cursor"],
            limit=1,
        )
    assert failure.value.status == 400


@pytest.mark.django_db(transaction=True)
def test_collection_scope_editor_visibility_and_schema_fences(world):
    org, _, members, tokens = world
    collection = make_collection(world)
    document = make_doc(world, "Restricted")
    set_row(world, collection, document, 1)
    Document.objects.filter(pk=document.id).update(visibility="restricted")
    DocumentGrant.objects.create(document=document, membership=members[2], role="viewer")
    assert (
        len(
            collections.query(
                verified=tokens[2],
                organisation_id=org.id,
                collection_id=UUID(collection["id"]),
                body={},
                cursor=None,
                limit=50,
            )["data"]
        )
        == 1
    )
    DocumentGrant.objects.all().delete()
    assert not collections.query(
        verified=tokens[2],
        organisation_id=org.id,
        collection_id=UUID(collection["id"]),
        body={},
        cursor=None,
        limit=50,
    )["data"]
    current = collections.read(
        verified=tokens[3], organisation_id=org.id, collection_id=UUID(collection["id"])
    )
    with pytest.raises(RefusalError) as denied:
        collections.patch(
            verified=tokens[3],
            organisation_id=org.id,
            collection_id=UUID(collection["id"]),
            body={"properties": []},
            if_match=services.tag(current),
            request_id=str(uuid4()),
        )
    # Resulting views must validate before changing a populated schema.
    assert denied.value.status == 422
    with pytest.raises(RefusalError) as denied:
        collections.patch(
            verified=tokens[3],
            organisation_id=org.id,
            collection_id=UUID(collection["id"]),
            body={"properties": [], "views": []},
            if_match=services.tag(current),
            request_id=str(uuid4()),
        )
    assert denied.value.status == 409
    with pytest.raises(RefusalError) as denied:
        collections.put_row(
            verified=tokens[2],
            organisation_id=org.id,
            collection_id=UUID(collection["id"]),
            document_id=document.id,
            body={"values": {}},
            if_match="",
            if_none_match="*",
            request_id=str(uuid4()),
        )
    assert denied.value.status == 403
    with (
        transaction.atomic(),
        pytest.raises(IntegrityError, match="collection ownership is immutable"),
    ):
        Collection.objects.filter(id=collection["id"]).update(creator=members[0])


def attachment(world, size=80):
    org, _, members, _ = world
    return Attachment.objects.create(
        organisation=org,
        uploader=members[3],
        filename="fixture.txt",
        content_type="text/plain",
        size_bytes=size,
        sha256="0" * 64,
        upload_expires_at=timezone.now() + timedelta(minutes=5),
    )


@pytest.mark.django_db(transaction=True)
def test_explicit_quota_policy_and_resource_refusal_vectors(world):
    org, workspace, _, tokens = world
    policy = WorkspaceQuota.objects.get(workspace=workspace)
    assert policy.policy_ref == "community-unlimited-v1" and policy.pages is None
    WorkspaceQuota.objects.filter(pk=policy.pk).update(pages=1, media_bytes=100, snapshot_bytes=10)
    document = make_doc(world, "One")
    with (
        transaction.atomic(),
        pytest.raises(IntegrityError, match="workspace quota exceeded") as failure,
    ):
        make_doc(world, "Two")
    assert quotas.violation(failure.value)["quota_key"] == "pages"
    attachment(world)
    with (
        transaction.atomic(),
        pytest.raises(IntegrityError, match="workspace quota exceeded") as failure,
    ):
        attachment(world)
    assert quotas.violation(failure.value)["remaining"] == 20
    with transaction.atomic(), pytest.raises(IntegrityError, match="workspace quota exceeded"):
        DocumentSnapshot.objects.filter(document=document).update(state=b"x" * 11)
    usage = quotas.read(verified=tokens[3], organisation_id=org.id)
    assert usage["usage"] == {"seats": 4, "mediaBytes": 80, "pages": 1}


@pytest.mark.django_db(transaction=True)
def test_concurrent_upload_reservations_cannot_overbook(world):
    _, workspace, _, _ = world
    WorkspaceQuota.objects.filter(workspace=workspace).update(media_bytes=100)

    def reserve(_):
        close_old_connections()
        try:
            with transaction.atomic():
                attachment(world)
            return "admitted"
        except IntegrityError as error:
            assert quotas.violation(error)["quota_key"] == "mediaBytes"
            return "refused"
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(reserve, range(2))) == ["admitted", "refused"]


@pytest.mark.django_db(transaction=True)
def test_missing_quota_is_not_unlimited_and_trigger_mutation_is_observable(world):
    _, workspace, _, _ = world
    WorkspaceQuota.objects.filter(workspace=workspace).delete()
    with (
        transaction.atomic(),
        pytest.raises(IntegrityError, match="workspace quota configuration missing"),
    ):
        make_doc(world, "Missing policy")
    # Mutation control: disabling the guard changes the same prohibited write to success.
    with transaction.atomic(), connection.cursor() as cursor:
        cursor.execute("ALTER TABLE docs_document DISABLE TRIGGER docs_page_quota")
        Document.objects.create(workspace=workspace, creator=world[2][3], title="Mutation control")
        # PostgreSQL rolls back the trigger mutation together with this synthetic write.
        transaction.set_rollback(True)
    with (
        transaction.atomic(),
        pytest.raises(IntegrityError, match="workspace quota configuration missing"),
    ):
        make_doc(world, "Restored guard")


@pytest.mark.django_db(transaction=True)
def test_restricted_writer_uses_collections_without_quota_policy_authority(world):
    from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, refused
    from test_workspace_writer_role import _role

    org, _, _, tokens = world
    roles = _role()
    writer = next(roles)
    try:
        with acting_as(writer):
            collection = make_collection(world)
            document = make_doc(world, "Restricted SQL writer")
            set_row(world, collection, document, 7)
            result = collections.query(
                verified=tokens[3],
                organisation_id=org.id,
                collection_id=UUID(collection["id"]),
                body={},
                cursor=None,
                limit=50,
            )
            assert len(result["data"]) == 1
            assert (
                refused("UPDATE workspaces_workspacequota SET pages=NULL") == INSUFFICIENT_PRIVILEGE
            )
            assert refused("DELETE FROM workspaces_workspacequota") == INSUFFICIENT_PRIVILEGE
            assert (
                refused("UPDATE docs_collection SET creator_id=creator_id")
                == INSUFFICIENT_PRIVILEGE
            )
    finally:
        next(roles, None)


@pytest.mark.django_db(transaction=True)
def test_database_refuses_incompatible_typed_values(world):
    from apps.docs.models import CollectionRow

    collection = make_collection(world)
    document = make_doc(world, "Typed storage")
    with (
        transaction.atomic(),
        pytest.raises(IntegrityError, match="collection property type refused"),
    ):
        CollectionRow.objects.create(
            collection_id=collection["id"],
            document=document,
            values={"priority": {"type": "number", "value": "not a number"}},
        )


@pytest.mark.django_db(transaction=True)
def test_native_collaboration_snapshot_limit_preserves_quota_table_isolation(world, collab_role):
    from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, refused

    _, workspace, _, _ = world
    document = make_doc(world, "Native quota")
    WorkspaceQuota.objects.filter(workspace=workspace).update(snapshot_bytes=10)
    with acting_as(collab_role):
        assert refused("SELECT * FROM workspaces_workspacequota") == INSUFFICIENT_PRIVILEGE
        with transaction.atomic(), pytest.raises(IntegrityError, match="workspace quota exceeded"):
            DocumentSnapshot.objects.filter(document=document).update(state=b"x" * 11)


@pytest.mark.django_db(transaction=True)
def test_concurrent_seat_activation_is_checked_at_commit(world):
    from apps.orgs.models import Membership

    _, workspace, members, _ = world
    ids = [members[2].id, members[3].id]
    Membership.objects.filter(id__in=ids).update(state="suspended")
    WorkspaceQuota.objects.filter(workspace=workspace).update(seats=3)

    def activate(member_id):
        close_old_connections()
        try:
            with transaction.atomic():
                Membership.objects.filter(id=member_id).update(state="active")
            return "admitted"
        except IntegrityError as error:
            assert quotas.violation(error)["quota_key"] == "seats"
            return "refused"
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(activate, ids)) == ["admitted", "refused"]


@pytest.mark.django_db(transaction=True)
def test_repeated_small_native_updates_cannot_exceed_materialized_snapshot_quota(
    world, native_engine, collab_role, settings
):
    import base64
    import json
    import os
    import shutil
    import subprocess
    from pathlib import Path
    from urllib.parse import quote

    org, workspace, _, tokens = world
    documents = []
    for name in ("Quota control", "Quota mutation"):
        created = services.create(
            verified=tokens[3],
            organisation_id=org.id,
            name=name,
            parent_id=None,
            template_key="adr",
            request_id=str(uuid4()),
        )
        documents.append(Document.objects.get(pk=created["id"]))
    maximum = max(len(DocumentSnapshot.objects.get(document=doc).state) for doc in documents) + 64
    WorkspaceQuota.objects.filter(workspace=workspace).update(snapshot_bytes=maximum)
    database = settings.DATABASES["default"]
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
    node = shutil.which("node")
    assert node is not None
    for document, skip in zip(documents, (False, True), strict=True):
        session = services.collab_session(
            verified=tokens[3],
            organisation_id=org.id,
            document_id=document.id,
            request_id=str(uuid4()),
        )
        result = subprocess.run(  # noqa: S603 - owned fixture, synthetic isolated database
            [node, str(root / "test/quota-store-fixture.mjs")],
            cwd=root,
            env={
                "PATH": os.environ["PATH"],
                "KODERA_TEST_DATABASE_URL": url,
                "KODERA_TEST_COLLAB_KEY": base64.urlsafe_b64encode(
                    settings.KODERA_COLLAB_TICKET_KEY
                ).decode(),
            },
            input=json.dumps(
                {
                    "ticket": session["token"],
                    "role": collab_role,
                    "limit": maximum,
                    "skipAdmission": skip,
                }
            ).encode(),
            capture_output=True,
            timeout=60,
        )
        if skip:
            assert result.returncode != 0
            assert "materialized snapshot quota was bypassed" in result.stderr.decode()
        else:
            assert result.returncode == 0, result.stderr.decode()
            assert json.loads(result.stdout)["refused"] is True


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("operation", ["accept", "invite"])
def test_seat_predicates_stay_closed_with_legacy_invalid_acceptance(world, operation):
    from apps.identity.models import Identity
    from apps.orgs.models import Invitation, Membership

    org, workspace, members, _ = world
    # Production already refuses this state. Waive only that constraint inside
    # a rolled-back test to exercise the independent quota admission predicates.
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "ALTER TABLE orgs_membership DROP CONSTRAINT membership_acceptance_valid"
            )
        Membership.objects.filter(id=members[3].id).update(accepted_at=None)
        with connection.cursor() as cursor:
            cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
        WorkspaceQuota.objects.filter(workspace=workspace).update(seats=3)
        with pytest.raises(IntegrityError, match="workspace quota exceeded"), transaction.atomic():
            if operation == "accept":
                Membership.objects.filter(id=members[3].id).update(accepted_at=timezone.now())
            else:
                identity = Identity.objects.get(user=members[0].user, organisation=org)
                now = timezone.now()
                Invitation.objects.create(
                    organisation=org,
                    email=members[3].user.email,
                    role="org_member",
                    state="pending",
                    token_digest=b"t" * 32,
                    token_sealed=b"synthetic",
                    invited_by_user=members[0].user,
                    invited_by_identity=identity,
                    issued_at=now,
                    expires_at=now + timedelta(hours=1),
                )
        transaction.set_rollback(True)
