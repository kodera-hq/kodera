"""Real signed HTTP admission, contract conformance, ETag preconditions and replay."""

import json
import time
from uuid import UUID, uuid4

import pytest
from customer_http_fixtures import configure, http_signer as http_signer, token, trust_entry
from django.db import transaction
from django.test import Client
from test_workspace_onboarding import call
from workspace_safety.test_moderation import world as world

from apps.docs.models import Document
from apps.notifications import services as notifications
from workspace_documents.test_services import native_engine as native_engine

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def http(world, http_signer, settings):
    now = int(time.time())
    org, _, _, tokens = world
    configure(settings, [trust_entry(http_signer, org.issuer, expires_at=now + 3600)])
    settings.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"
    return Client(HTTP_HOST="127.0.0.1"), [
        token(
            http_signer,
            org.issuer,
            subject=item.subject,
            email_verified=True,
            iat=now,
            exp=now + 300,
        )
        for item in tokens
    ]


def auth_headers(credential: str, *, idempotency_key: str | None = None, **extra: str) -> dict[str, str]:
    headers = {"HTTP_AUTHORIZATION": "Bearer " + credential, **extra}
    if idempotency_key is not None:
        headers["HTTP_IDEMPOTENCY_KEY"] = idempotency_key
    return headers


def test_workspace_documents_http_contract_preconditions_and_replay(world, http, native_engine):
    org, _, _, _ = world
    client, credentials = http
    base = f"/api/v1/organisations/{org.id}/workspace"
    docs_template = "/organisations/{organisation_id}/workspace/documents"
    doc_template = docs_template + "/{document_id}"

    create_key = str(uuid4())
    created = client.post(
        base + "/documents",
        data=json.dumps({"title": "Architecture Target", "templateKey": "adr"}),
        content_type="application/json",
        **auth_headers(credentials[3], idempotency_key=create_key),
    )
    call(created, docs_template, "post")
    assert created.status_code == 201
    assert created["Cache-Control"] == "no-store"
    assert created.get("ETag")
    target_id = created.json()["id"]

    replayed = client.post(
        base + "/documents",
        data=json.dumps({"title": "Architecture Target", "templateKey": "adr"}),
        content_type="application/json",
        **auth_headers(credentials[3], idempotency_key=create_key),
    )
    call(replayed, docs_template, "post")
    assert replayed.status_code == 201
    assert replayed["Idempotency-Replayed"] == "true"
    assert replayed.get("ETag") == created.get("ETag")
    assert replayed.json() == created.json()

    child = client.post(
        base + "/documents",
        data=json.dumps({"title": "Child Runbook", "parentId": target_id}),
        content_type="application/json",
        **auth_headers(credentials[3], idempotency_key=str(uuid4())),
    )
    call(child, docs_template, "post")
    assert child.status_code == 201
    child_id = child.json()["id"]

    listed = client.get(
        base + f"/documents?parentId={target_id}&limit=10",
        **auth_headers(credentials[2]),
    )
    call(listed, docs_template, "get")
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()["data"]] == [child_id]

    fetched = client.get(
        base + f"/documents/{child_id}",
        **auth_headers(credentials[3]),
    )
    call(fetched, doc_template, "get")
    assert fetched.status_code == 200
    child_etag = fetched["ETag"]

    missing_precondition = client.patch(
        base + f"/documents/{child_id}",
        data=json.dumps({"title": "Updated Runbook"}),
        content_type="application/json",
        **auth_headers(credentials[3]),
    )
    assert missing_precondition.status_code == 428

    patched = client.patch(
        base + f"/documents/{child_id}",
        data=json.dumps(
            {
                "title": "Updated Runbook",
                "markdown": "# Runbook\n\nLinked to [[Architecture Target]] with unique_token_xyz.\n",
            }
        ),
        content_type="application/json",
        **auth_headers(credentials[3], HTTP_IF_MATCH=child_etag),
    )
    call(patched, doc_template, "patch")
    assert patched.status_code == 200
    assert patched["ETag"] != child_etag

    stale = client.patch(
        base + f"/documents/{child_id}",
        data=json.dumps({"title": "Stale Attempt"}),
        content_type="application/json",
        **auth_headers(credentials[3], HTTP_IF_MATCH=child_etag),
    )
    assert stale.status_code == 412

    backlinks = client.get(
        base + f"/documents/{target_id}/backlinks",
        **auth_headers(credentials[2]),
    )
    call(backlinks, doc_template + "/backlinks", "get")
    assert backlinks.status_code == 200
    assert backlinks.json()["data"] == [{"documentId": child_id, "title": "Updated Runbook"}]

    searched = client.get(
        base + "/search?q=unique_token_xyz",
        **auth_headers(credentials[2]),
    )
    call(searched, "/organisations/{organisation_id}/workspace/search", "get")
    assert searched.status_code == 200
    assert [item["id"] for item in searched.json()["data"]] == [child_id]

    session_key = str(uuid4())
    session = client.post(
        base + f"/documents/{child_id}/collab-session",
        data=b"",
        content_type="application/json",
        **auth_headers(credentials[3], idempotency_key=session_key),
    )
    call(session, doc_template + "/collab-session", "post")
    assert session.status_code == 201
    assert session.json()["wsUrl"] == "wss://api.example.org/documents/collab"
    assert session.json()["role"] == "editor"

    non_empty_delete = client.delete(
        base + f"/documents/{target_id}",
        **auth_headers(credentials[3]),
    )
    call(non_empty_delete, doc_template, "delete")
    assert non_empty_delete.status_code == 409

    leaf_delete = client.delete(
        base + f"/documents/{child_id}",
        **auth_headers(credentials[3]),
    )
    call(leaf_delete, doc_template, "delete")
    assert leaf_delete.status_code == 204


def test_document_inbox_visibility_tracks_access_and_deletion(world, http, native_engine):
    org, _, members, _ = world
    client, credentials = http
    base = f"/api/v1/organisations/{org.id}/workspace"

    created = client.post(
        base + "/documents",
        data=json.dumps({"title": "Inbox Visible Page"}),
        content_type="application/json",
        **auth_headers(credentials[3], idempotency_key=str(uuid4())),
    )
    assert created.status_code == 201
    doc_id = UUID(created.json()["id"])

    with transaction.atomic():
        entry = notifications.record(
            organisation_id=org.id,
            membership_id=members[2].id,
            kind="document",
            resource_id=doc_id,
        )

    inbox = client.get("/api/v1/notifications", **auth_headers(credentials[2]))
    assert inbox.status_code == 200
    assert [row["id"] for row in inbox.json()["data"]] == [str(entry.id)]

    Document.objects.filter(pk=doc_id).update(visibility="restricted")
    hidden = client.get("/api/v1/notifications", **auth_headers(credentials[2]))
    assert hidden.status_code == 200
    assert hidden.json()["data"] == []
