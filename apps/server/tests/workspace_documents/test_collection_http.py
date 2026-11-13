"""Real signed request/contract proofs for Collections, conditional rows and quota errors."""

import json
from datetime import timedelta
from uuid import uuid4

import pytest
from django.utils import timezone
from test_workspace_onboarding import call
from workspace_safety.test_moderation import world as world

from apps.media.models import Attachment
from apps.workspaces.models import WorkspaceQuota
from workspace_documents.test_collections import PROPS, VIEWS, make_doc
from workspace_documents.test_http import auth_headers, http as http, http_signer as http_signer

pytestmark = pytest.mark.django_db(transaction=True)


def test_signed_collection_rows_obey_contract_and_conditional_creation(world, http):
    org, _, _, _ = world
    client, credentials = http
    base = f"/api/v1/organisations/{org.id}/workspace/collections"
    template = "/organisations/{organisation_id}/workspace/collections"
    created = client.post(
        base,
        data=json.dumps({"title": "Tasks", "properties": PROPS, "views": VIEWS}),
        content_type="application/json",
        **auth_headers(credentials[3], idempotency_key=str(uuid4())),
    )
    call(created, template, "post")
    assert created.status_code == 201
    listed = client.get(base, **auth_headers(credentials[3]))
    call(listed, template, "get")
    assert listed.json()["has_more"] is False
    document = make_doc(world, "HTTP row")
    row_path = base + f"/{created.json()['id']}/rows/{document.id}"
    row_template = template + "/{collection_id}/rows/{document_id}"
    body = json.dumps({"values": {"priority": {"type": "number", "value": 1}}})
    assert (
        client.put(
            row_path, data=body, content_type="application/json", **auth_headers(credentials[3])
        ).status_code
        == 428
    )
    inserted = client.put(
        row_path,
        data=body,
        content_type="application/json",
        **auth_headers(credentials[3], HTTP_IF_NONE_MATCH="*"),
    )
    call(inserted, row_template, "put")
    assert inserted.status_code == 201
    assert (
        client.put(
            row_path,
            data=body,
            content_type="application/json",
            **auth_headers(credentials[3], HTTP_IF_NONE_MATCH="*"),
        ).status_code
        == 412
    )
    fetched = client.get(row_path, **auth_headers(credentials[3]))
    call(fetched, row_template, "get")
    replaced = client.put(
        row_path,
        data=json.dumps({"values": {}}),
        content_type="application/json",
        **auth_headers(credentials[3], HTTP_IF_MATCH=fetched["ETag"]),
    )
    call(replaced, row_template, "put")
    assert replaced.status_code == 200 and replaced["ETag"] != fetched["ETag"]
    queried = client.post(
        base + f"/{created.json()['id']}/query?limit=1",
        data="{}",
        content_type="application/json",
        **auth_headers(credentials[3], idempotency_key=str(uuid4())),
    )
    call(queried, template + "/{collection_id}/query", "post")
    assert queried.json()["data"][0]["documentId"] == str(document.id)


def test_signed_upload_quota_error_rolls_back_and_usage_matches_contract(world, http, monkeypatch):
    from apps.media import services as media

    class Gateway:
        def call(self, operation, descriptor):
            assert operation == "upload"
            return {
                "url": "https://objects.example.org/synthetic-upload",
                "headers": {},
                "expiresAt": (timezone.now() + timedelta(minutes=5)).isoformat(),
            }

    monkeypatch.setattr(media, "_gateway", lambda: Gateway())
    org, workspace, _, _ = world
    client, credentials = http
    WorkspaceQuota.objects.filter(workspace=workspace).update(media_bytes=0)
    base = f"/api/v1/organisations/{org.id}/workspace"
    refused = client.post(
        base + "/attachments/uploads",
        data=json.dumps(
            {
                "filename": "fixture.txt",
                "contentType": "text/plain",
                "sizeBytes": 10,
                "sha256": "0" * 64,
            }
        ),
        content_type="application/json",
        **auth_headers(credentials[3], idempotency_key=str(uuid4())),
    )
    call(refused, "/organisations/{organisation_id}/workspace/attachments/uploads", "post")
    assert refused.status_code == 413 and refused["Cache-Control"] == "no-store"
    assert refused.json()["quota_key"] == "mediaBytes" and refused.json()["remaining"] == 0
    assert not Attachment.objects.filter(organisation=org).exists()
    for suffix in ("usage", "limits"):
        response = client.get(base + "/quotas/" + suffix, **auth_headers(credentials[3]))
        call(response, "/organisations/{organisation_id}/workspace/quotas/" + suffix, "get")
        assert response.status_code == 200
