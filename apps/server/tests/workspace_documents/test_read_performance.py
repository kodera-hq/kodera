"""Read-only transactions and bounded link maintenance against disposable PostgreSQL."""

from uuid import uuid4

import pytest
from django.db import IntegrityError, connection, transaction
from django.test.utils import CaptureQueriesContext
from workspace_safety.test_moderation import world as world

from apps.docs import collections, engine, services
from apps.docs.errors import RefusalError
from apps.docs.models import Collection, Document, DocumentLink
from apps.identity.models import Identity
from apps.workspaces import quotas
from apps.workspaces.models import WorkspaceQuota

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def document(world, monkeypatch):
    org, _, _, tokens = world
    monkeypatch.setattr(
        engine, "transform", lambda **kwargs: engine.State(b"snapshot", b"update", "", ())
    )
    created = services.create(
        verified=tokens[3],
        organisation_id=org.id,
        name="Example",
        parent_id=None,
        template_key=None,
        request_id=str(uuid4()),
    )
    return Document.objects.get(pk=created["id"])


@pytest.mark.parametrize(
    "operation",
    [
        "context",
        "authorize",
        "authorize_document",
        "list",
        "get",
        "backlinks",
        "search",
        "collections",
        "collection",
        "query",
        "quotas",
    ],
)
def test_reads_work_in_a_read_only_transaction_without_update_locks(world, document, operation):
    org, workspace, members, tokens = world
    collection = Collection.objects.create(
        workspace=workspace, creator=members[3], title="Collection", properties=[], views=[]
    )
    common = {"verified": tokens[3], "organisation_id": org.id}
    calls = {
        "context": lambda: services.read_context(tokens[3], org.id),
        "authorize": lambda: services.authorize(tokens[3], org.id),
        "authorize_document": lambda: services.authorize_document(
            **common, document_id=document.id
        ),
        "list": lambda: services.list_documents(**common, cursor=None, limit=10),
        "get": lambda: services.read(**common, document_id=document.id),
        "backlinks": lambda: services.backlinks(
            **common, document_id=document.id, cursor=None, limit=10
        ),
        "search": lambda: services.search(**common, query="Example", cursor=None, limit=10),
        "collections": lambda: collections.list_collections(**common, cursor=None, limit=10),
        "collection": lambda: collections.read(**common, collection_id=collection.id),
        "query": lambda: collections.query(
            **common, collection_id=collection.id, body={}, cursor=None, limit=10
        ),
        "quotas": lambda: quotas.read(**common),
    }
    with CaptureQueriesContext(connection) as captured, transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION READ ONLY")
        calls[operation]()
    assert not any("FOR UPDATE" in query["sql"].upper() for query in captured)


def test_create_keeps_atomic_quota_lock_and_rolls_back_excess(world, document):
    org, workspace, _, tokens = world
    WorkspaceQuota.objects.filter(workspace=workspace).update(pages=1)
    with CaptureQueriesContext(connection) as captured, pytest.raises(IntegrityError) as refused:
        services.create(
            verified=tokens[3],
            organisation_id=org.id,
            name="Excess",
            parent_id=None,
            template_key=None,
            request_id=str(uuid4()),
        )
    assert quotas.is_guard(refused.value)
    assert any("FOR UPDATE" in query["sql"].upper() for query in captured)
    assert list(Document.objects.values_list("id", flat=True)) == [document.id]


def test_refused_writer_never_locks_workspace(world, document):
    org, _, members, tokens = world
    Identity.objects.filter(user_id=members[3].user_id).update(enabled=False)
    with CaptureQueriesContext(connection) as captured, pytest.raises(RefusalError):
        services.create(
            verified=tokens[3],
            organisation_id=org.id,
            name="Refused",
            parent_id=None,
            template_key=None,
            request_id=str(uuid4()),
        )
    assert not any("FOR UPDATE" in query["sql"].upper() for query in captured)


def patch(world, document, changes):
    org, _, _, tokens = world
    return services.patch(
        verified=tokens[3],
        organisation_id=org.id,
        document_id=document.id,
        changes=changes,
        if_match="*",
        request_id=str(uuid4()),
    )


@pytest.mark.parametrize("changes", [{"parentId": None}, {"title": "Example"}, {"markdown": ""}])
def test_unchanged_content_never_reads_or_rewrites_links(world, document, changes):
    services.links(document, ("Missing",))
    before = list(DocumentLink.objects.values_list("id", "updated_at"))
    with CaptureQueriesContext(connection) as captured:
        patch(world, document, changes)
    assert not any("docs_documentlink" in query["sql"] for query in captured)
    assert list(DocumentLink.objects.values_list("id", "updated_at")) == before


@pytest.mark.parametrize("size", [1, 40])
def test_link_resolution_batches_and_deduplicates_database_case(world, document, size):
    names = tuple(f"Target {index}" for index in range(size))
    with CaptureQueriesContext(connection) as captured, transaction.atomic():
        services.links(document, (*names, "EXAMPLE", "Example", "E\u0301", "É"))
    # BEGIN/COMMIT, one delete, two batched selects, and one bulk insert, independent of K.
    assert len(captured) <= 6
    links = dict(DocumentLink.objects.values_list("target_title", "target_id"))
    assert len(links) == size + 2
    assert links["example"] == document.id and links["é"] is None


def test_rename_only_reresolves_old_and_new_title_buckets(world, document):
    org, workspace, members, _ = world
    source = Document.objects.create(workspace=workspace, creator=members[3], title="Source")
    other = Document.objects.create(workspace=workspace, creator=members[3], title="Unrelated")
    services.links(source, ("EXAMPLE", "New title", "Unrelated"))
    services.links(document, ("Unrelated",))
    untouched = list(DocumentLink.objects.filter(target=other).values_list("id", "updated_at"))
    with CaptureQueriesContext(connection) as captured:
        patch(world, document, {"title": "New title"})
    resolved = dict(
        DocumentLink.objects.filter(source=source).values_list("target_title", "target_id")
    )
    assert resolved == {"example": None, "new title": document.id, "unrelated": other.id}
    assert (
        list(DocumentLink.objects.filter(target=other).values_list("id", "updated_at")) == untouched
    )
    statements = [query["sql"] for query in captured if "docs_documentlink" in query["sql"]]
    assert len(statements) == 1 and "target_title IN" in statements[0]


def test_creation_resolves_previously_missing_title(world, document):
    org, _, _, tokens = world
    services.links(document, ("Future",))
    future = services.create(
        verified=tokens[3],
        organisation_id=org.id,
        name="FUTURE",
        parent_id=None,
        template_key=None,
        request_id=str(uuid4()),
    )
    assert str(DocumentLink.objects.get(source=document).target_id) == future["id"]


def test_changed_markdown_rebuilds_outgoing_links_only(world, document, monkeypatch):
    services.links(document, ("Old",))
    monkeypatch.setattr(
        engine,
        "transform",
        lambda **kwargs: engine.State(b"snapshot", b"update", "[[New]]", ("New",)),
    )
    with CaptureQueriesContext(connection) as captured:
        patch(world, document, {"markdown": "[[New]]"})
    assert list(DocumentLink.objects.values_list("target_title", flat=True)) == ["new"]
    assert not any("UPDATE docs_documentlink" in query["sql"] for query in captured)
