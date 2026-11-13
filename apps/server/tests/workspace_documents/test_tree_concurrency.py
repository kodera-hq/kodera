"""Opposing moves cannot create a cycle from individually valid stale tree snapshots."""

import threading
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4

import pytest
from django.db import close_old_connections
from workspace_safety.test_moderation import world as world

from apps.docs import services
from apps.docs.errors import RefusalError
from apps.docs.models import Document
from workspace_documents.test_services import native_engine as native_engine

pytestmark = pytest.mark.django_db(transaction=True)


def test_opposing_concurrent_parent_moves_keep_the_tree_acyclic(world, native_engine, monkeypatch):
    org, _, _, tokens = world
    documents = [
        services.create(
            verified=tokens[3],
            organisation_id=org.id,
            name=name,
            parent_id=None,
            template_key=None,
            request_id=str(uuid4()),
        )
        for name in ("Concurrent first", "Concurrent second")
    ]
    identifiers = [UUID(document["id"]) for document in documents]
    start = threading.Barrier(2)
    read_snapshots = threading.Barrier(2)
    actual_parents = services.parents

    def overlapping_parents(workspace_id):
        result = actual_parents(workspace_id)
        # Serialized transactions cannot both reach this point at once. Without
        # the domain lock, both readers retain an acyclic snapshot before writing.
        try:
            read_snapshots.wait(timeout=0.25)
        except threading.BrokenBarrierError:
            pass
        return result

    monkeypatch.setattr(services, "parents", overlapping_parents)

    def move(pair):
        close_old_connections()
        try:
            start.wait(timeout=5)
            try:
                services.patch(
                    verified=tokens[3],
                    organisation_id=org.id,
                    document_id=pair[0],
                    changes={"parentId": pair[1]},
                    if_match="*",
                    request_id=str(uuid4()),
                )
                return "accepted"
            except RefusalError as error:
                return error.status
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(move, (identifiers, list(reversed(identifiers)))))
    assert sorted(results, key=str) == [422, "accepted"]
    services.validate_tree(dict(Document.objects.values_list("id", "parent_id")))
