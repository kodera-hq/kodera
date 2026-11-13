# ruff: noqa: S101
"""Real signed-token admission, response schemas, idempotency and revocation."""

import json
from datetime import timedelta
from uuid import uuid4

import pytest
from customer_http_fixtures import configure, http_signer as http_signer, token, trust_entry
from django.test import Client, override_settings
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock
from test_workspace_onboarding import call

from apps.workspaces.models import WorkspaceInviteLink
from workspace_safety.test_moderation import world as world

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def http(world, http_signer, frozen_clock, settings):
    org, _, _, tokens = world
    configure(settings, [trust_entry(http_signer, org.issuer)])
    settings.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"
    return Client(HTTP_HOST="127.0.0.1"), [
        token(http_signer, org.issuer, subject=item.subject, email_verified=True) for item in tokens
    ]


@override_settings(ROOT_URLCONF="apps.workspaces.api.moderation_urls")
def test_real_http_moderator_boundary_and_report_queue(world, http):
    org, _, members, _ = world
    client, credentials = http
    base = f"/api/v1/organisations/{org.id}/workspace"
    headers = {
        "HTTP_AUTHORIZATION": "Bearer " + credentials[2],
        "HTTP_IDEMPOTENCY_KEY": str(uuid4()),
    }
    response = client.post(
        base + "/moderation",
        data=json.dumps({"membershipId": str(members[0].id), "action": "ban", "reason": "Example"}),
        content_type="application/json",
        **headers,
    )
    assert response.status_code == 403
    assert response.json()["type"].endswith("/forbidden")
    headers["HTTP_AUTHORIZATION"] = "Bearer " + credentials[3]
    headers["HTTP_IDEMPOTENCY_KEY"] = str(uuid4())
    created = client.post(
        base + "/reports",
        data=json.dumps({"membershipId": str(members[2].id), "reason": "Example report"}),
        content_type="application/json",
        **headers,
    )
    call(created, "/organisations/{organisation_id}/workspace/reports", "post")
    assert created.status_code == 201
    assert (
        client.get(base + "/reports", HTTP_AUTHORIZATION="Bearer " + credentials[3]).status_code
        == 403
    )
    queue = client.get(base + "/reports", HTTP_AUTHORIZATION="Bearer " + credentials[2])
    call(queue, "/organisations/{organisation_id}/workspace/reports", "get")
    assert len(queue.json()["data"]) == 1
    resolution = client.patch(
        base + "/reports/" + created.json()["id"],
        data=json.dumps({"status": "resolved", "resolution": "Handled"}),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + credentials[2],
        HTTP_IF_MATCH=created["ETag"],
    )
    call(resolution, "/organisations/{organisation_id}/workspace/reports/{report_id}", "patch")
    assert resolution.status_code == 200


@override_settings(ROOT_URLCONF="apps.workspaces.api.moderation_urls")
def test_real_http_link_creation_is_idempotent_and_revocation_is_immediate(world, http):
    org, _, _, _ = world
    client, credentials = http
    path = f"/api/v1/organisations/{org.id}/workspace/invite-links"
    body = json.dumps(
        {"expiresAt": (timezone.now() + timedelta(hours=1)).isoformat(), "maxUses": 2}
    )
    headers = {
        "HTTP_AUTHORIZATION": "Bearer " + credentials[0],
        "HTTP_IDEMPOTENCY_KEY": str(uuid4()),
    }
    created = client.post(path, data=body, content_type="application/json", **headers)
    call(created, "/organisations/{organisation_id}/workspace/invite-links", "post")
    assert created.status_code == 201
    replay = client.post(path, data=body, content_type="application/json", **headers)
    assert replay["Idempotency-Replayed"] == "true"
    assert replay.json() == created.json()
    assert WorkspaceInviteLink.objects.count() == 1
    code = created.json()["code"]
    assert not WorkspaceInviteLink.objects.filter(code_digest=code).exists()
    response = client.delete(
        path + "/" + created.json()["link"]["id"], HTTP_AUTHORIZATION="Bearer " + credentials[0]
    )
    assert response.status_code == 204
    response = client.post(
        "/api/v1/workspace-invites/redeem",
        data=json.dumps({"code": code}),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + credentials[3],
        HTTP_IDEMPOTENCY_KEY=str(uuid4()),
    )
    assert response.status_code == 404


@override_settings(ROOT_URLCONF="apps.workspaces.api.moderation_urls")
def test_redemption_uses_the_verified_principal_mutation_bucket(world, http, settings):
    settings.KODERA_MUTATION_RATE_PER_MINUTE = 1
    client, credentials = http
    headers = {
        "HTTP_AUTHORIZATION": "Bearer " + credentials[3],
        "HTTP_IDEMPOTENCY_KEY": str(uuid4()),
    }
    body = json.dumps({"code": str(uuid4())})
    first = client.post(
        "/api/v1/workspace-invites/redeem",
        data=body,
        content_type="application/json",
        **headers,
    )
    assert first.status_code == 404
    headers["HTTP_IDEMPOTENCY_KEY"] = str(uuid4())
    second = client.post(
        "/api/v1/workspace-invites/redeem",
        data=body,
        content_type="application/json",
        **headers,
    )
    assert second.status_code == 429
    assert int(second["Retry-After"]) >= 1
