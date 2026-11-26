"""Signed subteam sharing HTTP requests conform to the contract and revision fences."""

import json
import time

import pytest
from customer_http_fixtures import http_signer as http_signer, token
from test_workspace_onboarding import call
from workspace_safety.test_moderation import world as world

from apps.docs.models import DocumentRoleGrant
from workspace_documents.test_http import auth_headers, http as http
from workspace_documents.test_role_grants import grants as grants
from workspace_documents.test_services import native_engine as native_engine

pytestmark = pytest.mark.django_db(transaction=True)


def test_signed_grant_endpoints_and_picker_access(world, grants, http):
    org, _, _, _ = world
    document, subteam = grants
    client, credentials = http
    base = f"/api/v1/organisations/{org.id}/workspace"
    path = base + f"/documents/{document.id}/role-grants"
    template = "/organisations/{organisation_id}/workspace/documents/{document_id}/role-grants"
    roles = client.get(base + "/roles", **auth_headers(credentials[3]))
    assert roles.status_code == 200
    assert roles.json()["data"][0]["kind"] == "subteam"
    listed = client.get(path, **auth_headers(credentials[3]))
    call(listed, template, "get")
    assert listed.status_code == 200 and listed["Cache-Control"] == "no-store"
    current = listed["ETag"]
    missing = client.put(
        path + f"/{subteam.id}",
        data=json.dumps({"role": "viewer"}),
        content_type="application/json",
        **auth_headers(credentials[3]),
    )
    call(missing, template + "/{role_id}", "put")
    assert missing.status_code == 428
    saved = client.put(
        path + f"/{subteam.id}",
        data=json.dumps({"role": "viewer"}),
        content_type="application/json",
        **auth_headers(credentials[3], HTTP_IF_MATCH=current),
    )
    call(saved, template + "/{role_id}", "put")
    assert saved.status_code == 200 and saved["ETag"] != current
    assert saved["Cache-Control"] == "no-store"
    assert saved.json()["data"][0]["workspaceRoleId"] == str(subteam.id)
    viewer = client.get(path, **auth_headers(credentials[2]))
    assert viewer.status_code == 403 and viewer["Cache-Control"] == "no-store"
    stale = client.delete(
        path + f"/{subteam.id}", **auth_headers(credentials[3], HTTP_IF_MATCH=current)
    )
    call(stale, template + "/{role_id}", "delete")
    assert stale.status_code == 412 and DocumentRoleGrant.objects.exists()
    assert stale["ETag"] == saved["ETag"]
    assert stale.json()["current_etag"] == stale["ETag"]
    revoked = client.delete(
        path + f"/{subteam.id}", **auth_headers(credentials[3], HTTP_IF_MATCH=saved["ETag"])
    )
    call(revoked, template + "/{role_id}", "delete")
    assert revoked.status_code == 200 and revoked.json()["data"] == []
    assert revoked["Cache-Control"] == "no-store"
    denied = client.get(path)
    assert denied.status_code == 401 and denied["Cache-Control"] == "no-store"


@pytest.mark.parametrize(
    "body", [{"role": "owner"}, {"role": ["editor"]}, {"role": "editor", "workspaceId": "other"}]
)
def test_invalid_permission_requests_are_refused_without_writes(world, grants, http, body):
    org, _, _, _ = world
    document, subteam = grants
    client, credentials = http
    path = f"/api/v1/organisations/{org.id}/workspace/documents/{document.id}/role-grants"
    listed = client.get(path, **auth_headers(credentials[3]))
    result = client.put(
        path + f"/{subteam.id}",
        data=json.dumps(body),
        content_type="application/json",
        **auth_headers(credentials[3], HTTP_IF_MATCH=listed["ETag"]),
    )
    assert result.status_code == 422 and not DocumentRoleGrant.objects.exists()


def test_collection_query_replay_hides_rows_after_subteam_revocation(world, grants, http):
    from uuid import uuid4

    from apps.docs.models import Collection, CollectionRow
    from workspace_documents.test_role_grants import put

    org, workspace, members, _ = world
    document, subteam = grants
    put(world, document, subteam, "viewer")
    collection = Collection.objects.create(
        workspace=workspace, creator=members[3], title="Plans", properties=[], views=[]
    )
    CollectionRow.objects.create(collection=collection, document=document, values={})
    client, credentials = http
    path = f"/api/v1/organisations/{org.id}/workspace/collections/{collection.id}/query"
    headers = auth_headers(credentials[2], idempotency_key=str(uuid4()))
    first = client.post(path, data="{}", content_type="application/json", **headers)
    assert first.status_code == 200
    assert len(first.json()["data"]) == 1
    DocumentRoleGrant.objects.filter(document=document).delete()
    replay = client.post(path, data="{}", content_type="application/json", **headers)
    assert replay.status_code == 200
    assert replay["Idempotency-Replayed"] == "true"
    assert replay.json()["data"] == []
    assert str(document.id) not in replay.content.decode()
    from apps.docs import collections

    collections.delete(
        verified=world[3][3],
        organisation_id=org.id,
        collection_id=collection.id,
        request_id=str(uuid4()),
    )
    hidden = client.post(path, data="{}", content_type="application/json", **headers)
    assert hidden.status_code == 404


def test_content_and_grant_etags_are_independent_in_both_write_orders(
    world, grants, http, native_engine
):
    from uuid import UUID, uuid4

    from apps.docs import services
    from apps.docs.models import Document

    org, _, _, tokens = world
    _, subteam = grants
    created = services.create(
        verified=tokens[3],
        organisation_id=org.id,
        name="Version isolation",
        parent_id=None,
        template_key=None,
        request_id=str(uuid4()),
    )
    document = Document.objects.get(pk=UUID(created["id"]))
    client, credentials = http
    path = f"/api/v1/organisations/{org.id}/workspace/documents/{document.id}"
    headers = auth_headers(credentials[3])
    detail = client.get(path, **headers)
    listed = client.get(path + "/role-grants", **headers)

    def patch(markdown, etag):
        return client.patch(
            path,
            data=json.dumps({"markdown": markdown}),
            content_type="application/json",
            **auth_headers(credentials[3], HTTP_IF_MATCH=etag),
        )

    def grant(permission, etag):
        return client.put(
            path + f"/role-grants/{subteam.id}",
            data=json.dumps({"role": permission}),
            content_type="application/json",
            **auth_headers(credentials[3], HTTP_IF_MATCH=etag),
        )

    # A body save while Share is open leaves its grant token usable.
    saved = patch("# New body", detail["ETag"])
    assert saved.status_code == 200
    assert client.get(path + "/role-grants", **headers)["ETag"] == listed["ETag"]
    granted = grant("viewer", listed["ETag"])
    assert granted.status_code == 200
    # Closing Share mid-write needs no detail refresh before a pending body save.
    after_grant = client.get(path, **headers)
    assert after_grant["ETag"] == saved["ETag"]
    assert after_grant.json()["updatedAt"] == saved.json()["updatedAt"]
    assert patch("# Pending body", saved["ETag"]).status_code == 200
    revoked = client.delete(
        path + f"/role-grants/{subteam.id}",
        **auth_headers(credentials[3], HTTP_IF_MATCH=granted["ETag"]),
    )
    assert revoked.status_code == 200
    assert patch("# After revoke", client.get(path, **headers)["ETag"]).status_code == 200


@pytest.mark.parametrize("method", ["get", "put", "delete"])
def test_grant_endpoints_refuse_a_signed_unknown_identity(world, grants, http, http_signer, method):
    org, _, _, _ = world
    document, subteam = grants
    client, _ = http
    now = int(time.time())
    credential = token(
        http_signer,
        org.issuer,
        subject="unknown-document-grant-actor",
        email_verified=True,
        iat=now,
        exp=now + 300,
    )
    path = f"/api/v1/organisations/{org.id}/workspace/documents/{document.id}/role-grants"
    if method != "get":
        path += f"/{subteam.id}"
    response = getattr(client, method)(
        path,
        data=json.dumps({"role": "viewer"}) if method == "put" else None,
        content_type="application/json",
        **auth_headers(credential),
    )
    assert response.status_code == 403
    assert response.json()["type"] == "https://kodera.io/problems/identity-unknown"
    assert response["Cache-Control"] == "no-store"
    assert not DocumentRoleGrant.objects.exists()
