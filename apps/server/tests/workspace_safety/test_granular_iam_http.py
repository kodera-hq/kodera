"""Signed HTTP calls, schema parity, replay and atomic channel override updates."""

import json
from uuid import UUID, uuid4

import pytest
from customer_http_fixtures import http_signer as http_signer
from django.test import override_settings
from test_access_tokens import frozen_clock as frozen_clock
from test_workspace_onboarding import call

from apps.audit.models import AuditEvent
from apps.workspaces.models import Channel, WorkspaceMemberRole, WorkspaceRole
from workspace_safety.test_moderation import world as world
from workspace_safety.test_moderation_http import http as http

pytestmark = pytest.mark.django_db(transaction=True)
ROOT = "/organisations/{organisation_id}/workspace"


@override_settings(ROOT_URLCONF="apps.workspaces.api.moderation_urls")
def test_role_crud_assignments_and_schema_conformance(world, http):
    org, _, members, _ = world
    client, credentials = http
    base = f"/api/v1/organisations/{org.id}/workspace"
    headers = {
        "HTTP_AUTHORIZATION": "Bearer " + credentials[0],
        "HTTP_IDEMPOTENCY_KEY": str(uuid4()),
    }
    data = {
        "name": "Builders",
        "slug": "builders",
        "kind": "subteam",
        "position": 10,
        "color": "#123abc",
    }
    created = client.post(
        base + "/roles", data=json.dumps(data), content_type="application/json", **headers
    )
    call(created, ROOT + "/roles", "post")
    assert created.status_code == 201
    replay = client.post(
        base + "/roles", data=json.dumps(data), content_type="application/json", **headers
    )
    assert replay.json() == created.json()
    assert replay["Idempotency-Replayed"] == "true"
    assert WorkspaceRole.objects.count() == 1
    role_id = created.json()["id"]
    detail = base + "/roles/" + role_id
    patched = client.patch(
        detail,
        data=json.dumps({"is_mentionable": True}),
        content_type="application/json",
        **headers,
    )
    call(patched, ROOT + "/roles/{role_id}", "patch")
    assert patched.status_code == 200
    headers["HTTP_IDEMPOTENCY_KEY"] = str(uuid4())
    second = client.post(
        base + "/roles",
        data=json.dumps({"name": "Expert", "slug": "expert", "kind": "tag", "position": 1}),
        content_type="application/json",
        **headers,
    )
    assert second.status_code == 201
    assign = client.put(
        base + f"/members/{members[3].id}/roles",
        data=json.dumps({"role_ids": [role_id, second.json()["id"]]}),
        content_type="application/json",
        **headers,
    )
    call(assign, ROOT + "/members/{membership_id}/roles", "put")
    assert assign.status_code == 200
    read = client.get(base + "/roles", HTTP_AUTHORIZATION="Bearer " + credentials[3])
    call(read, ROOT + "/roles", "get")
    assert len(read.json()["assignments"][0]["role_ids"]) == 2
    refused = client.patch(
        detail,
        data=json.dumps({"name": "Elevated"}),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + credentials[3],
    )
    call(refused, ROOT + "/roles/{role_id}", "patch")
    assert refused.status_code == 403
    removed = client.delete(detail, **headers)
    call(removed, ROOT + "/roles/{role_id}", "delete")
    assert removed.status_code == 204
    assert WorkspaceMemberRole.objects.count() == 1
    assert AuditEvent.objects.filter(action="workspace.role.created").count() == 2


@override_settings(ROOT_URLCONF="apps.workspaces.api.moderation_urls")
def test_profile_overrides_bans_and_audit_contracts(world, http):
    org, workspace, _, _ = world
    client, credentials = http
    base = f"/api/v1/organisations/{org.id}/workspace"
    headers = {
        "HTTP_AUTHORIZATION": "Bearer " + credentials[0],
        "HTTP_IDEMPOTENCY_KEY": str(uuid4()),
    }
    created = client.post(
        base + "/roles",
        data=json.dumps({"name": "Readers", "slug": "readers"}),
        content_type="application/json",
        **headers,
    )
    assert created.status_code == 201
    role_id = created.json()["id"]
    channel = Channel.objects.create(workspace=workspace, name="General", kind="text", position=0)
    path = base + f"/channels/{channel.id}/overrides"
    entry = {"role_id": role_id, "allow": ["channel.view"], "deny": ["message.post"]}
    updated = client.put(
        path, data=json.dumps({"overrides": [entry]}), content_type="application/json", **headers
    )
    call(updated, ROOT + "/channels/{channel_id}/overrides", "put")
    assert updated.status_code == 200
    read = client.get(path, HTTP_AUTHORIZATION="Bearer " + credentials[3])
    call(read, ROOT + "/channels/{channel_id}/overrides", "get")
    assert read.json()["data"] == [entry]
    for invalid in [
        None,
        [{**entry, "deny": ["channel.view"]}],
        [entry, entry],
        [{**entry, "role_id": str(uuid4())}],
    ]:
        refused = client.put(
            path,
            data=json.dumps({"overrides": invalid}),
            content_type="application/json",
            **headers,
        )
        assert refused.status_code in {404, 422}
    assert client.get(path, **headers).json() == read.json()
    profile = client.patch(
        base + "/profile",
        data=json.dumps(
            {"rules_channel_id": str(channel.id), "description": "Welcome", "invites_paused": True}
        ),
        content_type="application/json",
        **headers,
    )
    call(profile, ROOT + "/profile", "patch")
    assert profile.status_code == 200
    for suffix in ["profile", "bans", "audit-logs"]:
        response = client.get(base + "/" + suffix, **headers)
        call(response, ROOT + "/" + suffix, "get")
        assert response.status_code == 200
    assert (
        client.get(base + "/audit-logs", HTTP_AUTHORIZATION="Bearer " + credentials[3]).status_code
        == 403
    )
    # Deleting a role removes its channel overrides in the same transaction.
    assert client.delete(base + "/roles/" + role_id, **headers).status_code == 204
    assert client.get(path, **headers).json() == {"data": []}


@override_settings(ROOT_URLCONF="apps.workspaces.api.moderation_urls")
def test_post_replay_rechecks_revoked_role_authority(world, http):
    from apps.workspaces import iam

    org, _, members, tokens = world
    owner = {"verified": tokens[0], "organisation_id": org.id, "request_id": str(uuid4())}
    manager = iam.create_role(
        **owner,
        data={
            "name": "Managers",
            "slug": "managers",
            "position": 50,
            "permissions": ["manage_roles"],
        },
    )
    iam.assign_roles(**owner, membership_id=members[2].id, role_ids=[manager["id"]])
    client, credentials = http
    path = f"/api/v1/organisations/{org.id}/workspace/roles"
    headers = {
        "HTTP_AUTHORIZATION": "Bearer " + credentials[2],
        "HTTP_IDEMPOTENCY_KEY": str(uuid4()),
    }
    body = json.dumps({"name": "Helpers", "slug": "helpers"})
    assert (
        client.post(path, data=body, content_type="application/json", **headers).status_code == 201
    )
    iam.assign_roles(**owner, membership_id=members[2].id, role_ids=[])
    assert (
        client.post(path, data=body, content_type="application/json", **headers).status_code == 403
    )
    assert WorkspaceRole.objects.filter(slug="helpers").count() == 1
    assert WorkspaceRole.objects.get(id=UUID(manager["id"])).permissions == ["manage_roles"]


@override_settings(ROOT_URLCONF="apps.workspaces.api.moderation_urls")
def test_paused_invites_refuse_creation_replay(world, http):
    from datetime import timedelta

    from django.utils import timezone

    from apps.workspaces import governance

    org, _, _, tokens = world
    client, credentials = http
    path = f"/api/v1/organisations/{org.id}/workspace/invite-links"
    body = json.dumps(
        {"expiresAt": (timezone.now() + timedelta(hours=1)).isoformat(), "maxUses": 2}
    )
    headers = {
        "HTTP_AUTHORIZATION": "Bearer " + credentials[0],
        "HTTP_IDEMPOTENCY_KEY": str(uuid4()),
    }
    assert (
        client.post(path, data=body, content_type="application/json", **headers).status_code == 201
    )
    governance.profile(
        verified=tokens[0],
        organisation_id=org.id,
        data={"invites_paused": True},
        request_id=str(uuid4()),
    )
    assert (
        client.post(path, data=body, content_type="application/json", **headers).status_code == 403
    )
