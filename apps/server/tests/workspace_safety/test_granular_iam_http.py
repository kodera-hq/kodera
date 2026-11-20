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
    duplicate = client.post(
        base + "/roles",
        data=json.dumps({"name": "Duplicate", "slug": "builders"}),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + credentials[0],
        HTTP_IDEMPOTENCY_KEY=str(uuid4()),
    )
    call(duplicate, ROOT + "/roles", "post")
    assert duplicate.status_code == 409
    role_id = created.json()["id"]
    detail = base + "/roles/" + role_id
    missing_if_match = client.patch(
        detail,
        data=json.dumps({"is_mentionable": True}),
        content_type="application/json",
        **headers,
    )
    call(missing_if_match, ROOT + "/roles/{role_id}", "patch")
    assert missing_if_match.status_code == 428
    stale_if_match = client.patch(
        detail,
        data=json.dumps({"is_mentionable": True}),
        content_type="application/json",
        HTTP_IF_MATCH='"stale"',
        **headers,
    )
    call(stale_if_match, ROOT + "/roles/{role_id}", "patch")
    assert stale_if_match.status_code == 412
    assert stale_if_match["ETag"] == created["ETag"]
    patched = client.patch(
        detail,
        data=json.dumps({"is_mentionable": True}),
        content_type="application/json",
        HTTP_IF_MATCH=created["ETag"],
        **headers,
    )
    call(patched, ROOT + "/roles/{role_id}", "patch")
    assert patched.status_code == 200
    assert patched["ETag"] != created["ETag"]
    headers["HTTP_IDEMPOTENCY_KEY"] = str(uuid4())
    second = client.post(
        base + "/roles",
        data=json.dumps({"name": "Expert", "slug": "expert", "kind": "tag", "position": 1}),
        content_type="application/json",
        **headers,
    )
    assert second.status_code == 201
    slug_conflict = client.patch(
        base + "/roles/" + second.json()["id"],
        data=json.dumps({"slug": "builders"}),
        content_type="application/json",
        HTTP_IF_MATCH=second["ETag"],
        **headers,
    )
    call(slug_conflict, ROOT + "/roles/{role_id}", "patch")
    assert slug_conflict.status_code == 409
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
        HTTP_IF_MATCH='"probe"',
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
    from apps.workspaces import iam
    from apps.workspaces.models import ResourcePolicy

    org, workspace, members, tokens = world
    policy = ResourcePolicy.objects.create(
        workspace=workspace, visibility=ResourcePolicy.Visibility.ORGANISATION
    )
    workspace.default_policy = policy
    workspace.save(update_fields=["default_policy", "updated_at"])
    restricted = ResourcePolicy.objects.create(
        workspace=workspace, visibility=ResourcePolicy.Visibility.RESTRICTED
    )
    manager_role = iam.create_role(
        verified=tokens[0],
        organisation_id=org.id,
        data={
            "name": "Managers",
            "slug": "managers",
            "position": 50,
            "permissions": ["manage_roles"],
        },
        request_id=str(uuid4()),
    )
    iam.assign_roles(
        verified=tokens[0],
        organisation_id=org.id,
        membership_id=members[2].id,
        role_ids=[manager_role["id"]],
        request_id=str(uuid4()),
    )
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
    secret = Channel.objects.create(
        workspace=workspace,
        name="Secret",
        kind="text",
        position=1,
        policy_mode=Channel.PolicyMode.EXPLICIT,
        explicit_policy=restricted,
    )
    path = base + f"/channels/{channel.id}/overrides"
    secret_path = base + f"/channels/{secret.id}/overrides"
    entry = {"role_id": role_id, "allow": ["channel.view"], "deny": ["message.post"]}
    updated = client.put(
        path, data=json.dumps({"overrides": [entry]}), content_type="application/json", **headers
    )
    call(updated, ROOT + "/channels/{channel_id}/overrides", "put")
    assert updated.status_code == 200
    read = client.get(path, HTTP_AUTHORIZATION="Bearer " + credentials[3])
    call(read, ROOT + "/channels/{channel_id}/overrides", "get")
    assert read.json()["data"] == [entry]
    hidden_get = client.get(secret_path, HTTP_AUTHORIZATION="Bearer " + credentials[3])
    call(hidden_get, ROOT + "/channels/{channel_id}/overrides", "get")
    assert hidden_get.status_code == 404
    unprivileged_put = client.put(
        secret_path,
        data=json.dumps({"overrides": []}),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + credentials[3],
    )
    call(unprivileged_put, ROOT + "/channels/{channel_id}/overrides", "put")
    assert unprivileged_put.status_code == 403
    hidden_put = client.put(
        secret_path,
        data=json.dumps({"overrides": []}),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + credentials[2],
    )
    call(hidden_put, ROOT + "/channels/{channel_id}/overrides", "put")
    assert hidden_put.status_code == 404
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
    initial_profile = client.get(base + "/profile", **headers)
    call(initial_profile, ROOT + "/profile", "get")
    assert initial_profile.status_code == 200
    missing_profile_tag = client.patch(
        base + "/profile",
        data=json.dumps({"description": "Welcome"}),
        content_type="application/json",
        **headers,
    )
    call(missing_profile_tag, ROOT + "/profile", "patch")
    assert missing_profile_tag.status_code == 428
    stale_profile_tag = client.patch(
        base + "/profile",
        data=json.dumps({"description": "Welcome"}),
        content_type="application/json",
        HTTP_IF_MATCH='"stale"',
        **headers,
    )
    call(stale_profile_tag, ROOT + "/profile", "patch")
    assert stale_profile_tag.status_code == 412
    assert stale_profile_tag["ETag"] == initial_profile["ETag"]
    profile = client.patch(
        base + "/profile",
        data=json.dumps(
            {"rules_channel_id": str(channel.id), "description": "Welcome", "invites_paused": True}
        ),
        content_type="application/json",
        HTTP_IF_MATCH=initial_profile["ETag"],
        **headers,
    )
    call(profile, ROOT + "/profile", "patch")
    assert profile.status_code == 200
    assert profile["ETag"] != initial_profile["ETag"]
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
    null_auto_roles = client.post(
        path,
        data=json.dumps(
            {
                "expiresAt": (timezone.now() + timedelta(hours=1)).isoformat(),
                "maxUses": 2,
                "auto_role_ids": None,
            }
        ),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + credentials[0],
        HTTP_IDEMPOTENCY_KEY=str(uuid4()),
    )
    call(null_auto_roles, ROOT + "/invite-links", "post")
    assert null_auto_roles.status_code == 422
    assert (
        client.post(path, data=body, content_type="application/json", **headers).status_code == 201
    )
    governance.profile(
        verified=tokens[0],
        organisation_id=org.id,
        data={"invites_paused": True},
        if_match="*",
        request_id=str(uuid4()),
    )
    assert (
        client.post(path, data=body, content_type="application/json", **headers).status_code == 403
    )


def test_erasure_cutoff_blocks_iam_mutations_and_purge_scrubs_iam_state(world):
    from datetime import timedelta

    from django.db import IntegrityError, transaction
    from django.utils import timezone

    from apps.identity.models import Identity, StaffRole, User
    from apps.orgs.erasure_services import advance_erasure, begin_erasure, database_now
    from apps.workspaces import governance, iam, moderation
    from apps.workspaces.models import WorkspaceChannelRoleOverride

    org, workspace, members, tokens = world
    owner = {"verified": tokens[0], "organisation_id": org.id, "request_id": str(uuid4())}
    channel = Channel.objects.create(workspace=workspace, name="General", kind="text", position=0)
    second_channel = Channel.objects.create(
        workspace=workspace, name="Second", kind="text", position=1
    )
    role = iam.create_role(**owner, data={"name": "Custom Builders", "slug": "custom-builders"})
    iam.assign_roles(**owner, membership_id=members[3].id, role_ids=[role["id"]])
    governance.overrides(
        **owner,
        channel_id=channel.id,
        data=[{"role_id": role["id"], "allow": ["channel.view"], "deny": []}],
    )
    governance.profile(
        **owner,
        if_match="*",
        data={
            "description": "Sensitive workspace description",
            "banner_preset": "aurora",
            "icon_mxc": "mxc://kodera.test/icon1",
            "traits": [{"icon": "leaf", "label": "Private badge"}],
        },
    )
    link, _ = moderation.create_link(
        **owner,
        expires_at=timezone.now() + timedelta(hours=1),
        max_uses=2,
        channel_id=None,
        role="org_member",
        auto_role_ids=[role["id"]],
    )

    staff_user = User.objects.create(email=f"{uuid4()}@staff.test")
    staff_identity = Identity.objects.create(
        user=staff_user,
        realm="kodera-staff",
        issuer="https://identity.staff.test/realms/kodera-staff",
        subject=str(uuid4()),
        email=staff_user.email,
    )
    StaffRole.objects.create(identity=staff_identity, realm="kodera-staff", role="staff_operator")
    erasure = begin_erasure(
        organisation_id=org.id,
        instruction_ref="DELIAM-100",
        instruction_sha256="1" * 64,
        purge_not_before=database_now(),
        actor_identity_id=staff_identity.id,
    )

    stored_role = WorkspaceRole.objects.get(pk=role["id"])
    stored_assignment = WorkspaceMemberRole.objects.get(membership=members[3], role=stored_role)
    stored_override = WorkspaceChannelRoleOverride.objects.get(channel=channel, role=stored_role)

    for action in [
        lambda: WorkspaceRole.objects.create(
            workspace=workspace, organisation_id=org.id, name="PostCutoff", slug="post-cutoff"
        ),
        lambda: WorkspaceRole.objects.filter(pk=stored_role.pk).update(name="Mutated"),
        lambda: WorkspaceMemberRole.objects.create(
            workspace=workspace, membership=members[2], role=stored_role
        ),
        lambda: WorkspaceMemberRole.objects.filter(pk=stored_assignment.pk).delete(),
        lambda: WorkspaceChannelRoleOverride.objects.create(
            workspace=workspace,
            channel=second_channel,
            role=stored_role,
            allow=["channel.view"],
        ),
        lambda: WorkspaceChannelRoleOverride.objects.filter(pk=stored_override.pk).delete(),
        lambda: WorkspaceRole.objects.filter(pk=stored_role.pk).delete(),
    ]:
        with (
            pytest.raises(IntegrityError, match="durable erasure cutoff refuses write"),
            transaction.atomic(),
        ):
            action()

    result = advance_erasure(erasure.id, {})
    assert result["core_purged"]
    assert not WorkspaceRole.objects.filter(workspace=workspace).exists()
    assert not WorkspaceMemberRole.objects.filter(workspace=workspace).exists()
    assert not WorkspaceChannelRoleOverride.objects.filter(workspace=workspace).exists()
    link.refresh_from_db()
    assert link.auto_role_ids == []
    workspace.refresh_from_db()
    assert workspace.description == ""
    assert workspace.banner_preset == ""
    assert workspace.icon_mxc == ""
    assert workspace.traits == []


@override_settings(ROOT_URLCONF="apps.workspaces.api.moderation_urls")
def test_member_departure_and_erasure_clear_workspace_roles_and_redact_invite_creator(world, http):
    from datetime import timedelta

    from django.utils import timezone

    from apps.orgs import membership_lifecycle
    from apps.workspaces import iam, moderation

    org, workspace, members, tokens = world
    client, credentials = http
    members[1].user.display_name = "Departing Admin"
    members[1].user.save(update_fields=["display_name", "updated_at"])

    owner = {"verified": tokens[0], "organisation_id": org.id, "request_id": str(uuid4())}
    ceiling = iam.create_role(**owner, data={"name": "Leads", "slug": "leads", "position": 20})
    builder = iam.create_role(
        **owner, data={"name": "Builders", "slug": "builders", "position": 10}
    )
    iam.assign_roles(**owner, membership_id=members[1].id, role_ids=[ceiling["id"]])
    iam.assign_roles(**owner, membership_id=members[2].id, role_ids=[builder["id"]])
    iam.assign_roles(**owner, membership_id=members[3].id, role_ids=[builder["id"]])

    link, _ = moderation.create_link(
        verified=tokens[1],
        organisation_id=org.id,
        expires_at=timezone.now() + timedelta(hours=1),
        max_uses=5,
        channel_id=None,
        role="org_member",
        auto_role_ids=[builder["id"]],
        request_id=str(uuid4()),
    )
    links_path = f"/api/v1/organisations/{org.id}/workspace/invite-links"
    before = client.get(links_path, HTTP_AUTHORIZATION="Bearer " + credentials[0])
    call(before, ROOT + "/invite-links", "get")
    assert before.status_code == 200
    assert before.json()["data"] == [
        {
            **before.json()["data"][0],
            "id": str(link.id),
            "createdBy": {
                "membershipId": str(members[1].id),
                "displayName": "Departing Admin",
            },
        }
    ]

    membership_lifecycle.remove_membership(
        verified=tokens[0],
        organisation_id=org.id,
        membership_id=members[3].id,
        if_match=None,
        request_id=str(uuid4()),
    )
    assert not WorkspaceMemberRole.objects.filter(
        workspace=workspace, membership_id=members[3].id
    ).exists()

    _, suspended_tag = membership_lifecycle.read_membership(
        verified=tokens[0], organisation_id=org.id, membership_id=members[2].id
    )
    membership_lifecycle.change_membership(
        verified=tokens[0],
        organisation_id=org.id,
        membership_id=members[2].id,
        patch={"state": "suspended"},
        if_match=suspended_tag,
        request_id=str(uuid4()),
    )
    membership_lifecycle.remove_membership(
        verified=tokens[0],
        organisation_id=org.id,
        membership_id=members[2].id,
        if_match=None,
        request_id=str(uuid4()),
    )
    assert not WorkspaceMemberRole.objects.filter(
        workspace=workspace, membership_id=members[2].id
    ).exists()

    membership_lifecycle.erase_member(organisation_id=org.id, membership_id=members[1].id)
    assert not WorkspaceMemberRole.objects.filter(
        workspace=workspace, membership_id=members[1].id
    ).exists()

    after = client.get(links_path, HTTP_AUTHORIZATION="Bearer " + credentials[0])
    call(after, ROOT + "/invite-links", "get")
    assert after.status_code == 200
    assert after.json()["data"][0]["createdBy"] == {
        "membershipId": str(members[1].id),
        "displayName": None,
    }


@override_settings(ROOT_URLCONF="apps.workspaces.api.moderation_urls")
def test_http_idempotent_writes_never_lock_membership_after_workspace(
    world, http, http_signer, monkeypatch
):
    from datetime import timedelta

    from customer_http_fixtures import token
    from django.utils import timezone

    from apps.identity.models import Identity, User
    from apps.workspaces import iam, moderation

    org, workspace, members, _ = world
    client, credentials = http
    base = f"/api/v1/organisations/{org.id}/workspace"

    role = client.post(
        base + "/roles",
        data=json.dumps({"name": "Guests", "slug": "guests"}),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + credentials[0],
        HTTP_IDEMPOTENCY_KEY=str(uuid4()),
    )
    call(role, ROOT + "/roles", "post")
    assert role.status_code == 201
    role_id = role.json()["id"]

    link = client.post(
        base + "/invite-links",
        data=json.dumps(
            {
                "expiresAt": (timezone.now() + timedelta(hours=1)).isoformat(),
                "maxUses": 5,
                "auto_role_ids": [role_id],
            }
        ),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + credentials[0],
        HTTP_IDEMPOTENCY_KEY=str(uuid4()),
    )
    call(link, ROOT + "/invite-links", "post")
    assert link.status_code == 201
    code = link.json()["code"]

    events: list[str] = []
    real_iam_lock_workspace = iam.lock_workspace
    real_for_workspace = moderation.for_workspace
    real_for_user = moderation.for_user
    real_create_from_link = moderation.create_from_workspace_link
    real_mod_lock_workspace = moderation.lock_workspace

    def tracked_iam_lock(*, workspace_id):
        events.append("workspace")
        return real_iam_lock_workspace(workspace_id=workspace_id)

    def tracked_for_workspace(*, organisation_id, membership_id, lock=True):
        if lock:
            events.append("membership")
        return real_for_workspace(
            organisation_id=organisation_id, membership_id=membership_id, lock=lock
        )

    def tracked_for_user(*, organisation_id, user_id, lock=False):
        if lock:
            events.append("membership")
        return real_for_user(organisation_id=organisation_id, user_id=user_id, lock=lock)

    def tracked_create_from_link(*, organisation_id, user_id):
        events.append("membership_create")
        return real_create_from_link(organisation_id=organisation_id, user_id=user_id)

    def tracked_mod_lock(*, workspace_id):
        events.append("workspace")
        return real_mod_lock_workspace(workspace_id=workspace_id)

    monkeypatch.setattr(iam, "lock_workspace", tracked_iam_lock)
    monkeypatch.setattr(moderation, "for_workspace", tracked_for_workspace)
    monkeypatch.setattr(moderation, "for_user", tracked_for_user)
    monkeypatch.setattr(moderation, "create_from_workspace_link", tracked_create_from_link)
    monkeypatch.setattr(moderation, "lock_workspace", tracked_mod_lock)

    assigned = client.put(
        base + f"/members/{members[2].id}/roles",
        data=json.dumps({"role_ids": [role_id]}),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + credentials[0],
        HTTP_IDEMPOTENCY_KEY=str(uuid4()),
    )
    call(assigned, ROOT + "/members/{membership_id}/roles", "put")
    assert assigned.status_code == 200
    assert events == ["membership", "workspace"]

    events.clear()
    mod_key = str(uuid4())
    mod_payload = json.dumps(
        {"membershipId": str(members[3].id), "action": "kick", "reason": "HTTP lock order"}
    )
    moderated = client.post(
        base + "/moderation",
        data=mod_payload,
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + credentials[0],
        HTTP_IDEMPOTENCY_KEY=mod_key,
    )
    call(moderated, ROOT + "/moderation", "post")
    assert moderated.status_code == 200
    assert events == ["membership", "workspace"]

    events.clear()
    mod_replay = client.post(
        base + "/moderation",
        data=mod_payload,
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + credentials[0],
        HTTP_IDEMPOTENCY_KEY=mod_key,
    )
    assert mod_replay.status_code == 200
    assert mod_replay["Idempotency-Replayed"] == "true"
    assert events == []

    events.clear()
    reported = client.post(
        base + "/reports",
        data=json.dumps({"membershipId": str(members[1].id), "reason": "HTTP lock order"}),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + credentials[2],
        HTTP_IDEMPOTENCY_KEY=str(uuid4()),
    )
    call(reported, ROOT + "/reports", "post")
    assert reported.status_code == 201
    assert events == ["membership", "workspace"]

    newcomer_subject = str(uuid4())
    newcomer_user = User.objects.create(email=f"{newcomer_subject}@example.org")
    Identity.objects.create(
        user=newcomer_user,
        organisation=org,
        issuer=org.issuer,
        realm=org.realm,
        subject=newcomer_subject,
        email=newcomer_user.email,
    )
    newcomer_jwt = token(http_signer, org.issuer, subject=newcomer_subject, email_verified=True)
    redeem_key = str(uuid4())
    events.clear()
    redeemed = client.post(
        "/api/v1/workspace-invites/redeem",
        data=json.dumps({"code": code}),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + newcomer_jwt,
        HTTP_IDEMPOTENCY_KEY=redeem_key,
    )
    call(redeemed, "/workspace-invites/redeem", "post")
    assert redeemed.status_code == 200
    assert events == ["membership", "membership", "membership_create", "workspace"]
    assert WorkspaceMemberRole.objects.filter(
        workspace=workspace, membership_id=UUID(redeemed.json()["membershipId"]), role_id=role_id
    ).exists()

    events.clear()
    redeem_replay = client.post(
        "/api/v1/workspace-invites/redeem",
        data=json.dumps({"code": code}),
        content_type="application/json",
        HTTP_AUTHORIZATION="Bearer " + newcomer_jwt,
        HTTP_IDEMPOTENCY_KEY=redeem_key,
    )
    assert redeem_replay.status_code == 200
    assert redeem_replay["Idempotency-Replayed"] == "true"
    assert events == []
