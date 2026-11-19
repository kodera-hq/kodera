"""Granular role hierarchy and governance acceptance against PostgreSQL."""

from uuid import UUID, uuid4

import pytest

from workspace_safety.test_moderation import world as world

pytestmark = pytest.mark.django_db


def test_roles_are_listed_with_assignments_and_audited(world):
    from apps.workspaces import iam

    org, _, members, tokens = world
    arguments = {"verified": tokens[0], "organisation_id": org.id}
    role = iam.create_role(
        **arguments,
        data={"name": "Builders", "slug": "builders", "position": 10},
        request_id=str(uuid4()),
    )
    iam.assign_roles(
        **arguments,
        membership_id=members[3].id,
        role_ids=[role["id"]],
        request_id=str(uuid4()),
    )
    result = iam.list_roles(verified=tokens[3], organisation_id=org.id)
    assert result["data"][0]["member_count"] == 1
    assert result["assignments"] == [
        {"membership_id": str(members[3].id), "role_ids": [role["id"]]}
    ]


def test_admin_cannot_create_or_move_roles_at_own_ceiling(world):
    from apps.workspaces import iam
    from apps.workspaces.moderation import RefusalError

    org, _, members, tokens = world
    owner = {"verified": tokens[0], "organisation_id": org.id, "request_id": str(uuid4())}
    ceiling = iam.create_role(**owner, data={"name": "Leads", "slug": "leads", "position": 20})
    iam.assign_roles(**owner, membership_id=members[1].id, role_ids=[ceiling["id"]])
    admin = {**owner, "verified": tokens[1]}
    lower = iam.create_role(**admin, data={"name": "Builders", "slug": "builders", "position": 10})
    for position in [20, 21]:
        with pytest.raises(RefusalError) as failure:
            iam.update_role(
                **admin, role_id=UUID(lower["id"]), data={"position": position}, if_match="*"
            )
        assert failure.value.status == 403
    with pytest.raises(RefusalError) as failure:
        iam.assign_roles(**admin, membership_id=members[3].id, role_ids=[ceiling["id"]])
    assert failure.value.status == 403
    with pytest.raises(RefusalError):
        iam.delete_role(**admin, role_id=UUID(ceiling["id"]))


def test_profile_validation_pause_and_invite_auto_roles(world):
    from datetime import timedelta

    from django.utils import timezone

    from apps.identity.models import Identity, User
    from apps.orgs.models import Membership
    from apps.workspaces import governance, iam, moderation
    from apps.workspaces.models import WorkspaceMemberRole
    from services.identity.access_tokens import VerifiedAccessToken

    org, _, members, tokens = world
    owner = {"verified": tokens[0], "organisation_id": org.id, "request_id": str(uuid4())}
    role = iam.create_role(**owner, data={"name": "Guests", "slug": "guests", "kind": "tag"})
    link, code = moderation.create_link(
        **owner,
        expires_at=timezone.now() + timedelta(hours=1),
        max_uses=2,
        channel_id=None,
        role="org_member",
        auto_role_ids=[role["id"]],
    )
    governance.profile(
        **owner,
        if_match="*",
        data={
            "description": "Community",
            "invites_paused": True,
            "traits": [{"icon": "leaf", "label": "Cooperative"}],
        },
    )
    for operation in [moderation.preview_link, moderation.admit_redemption]:
        with pytest.raises(moderation.RefusalError):
            operation(verified=tokens[3], code=code)
    with pytest.raises(moderation.RefusalError):
        moderation.redeem_link(verified=tokens[3], code=code, request_id=str(uuid4()))
    with pytest.raises(moderation.RefusalError):
        moderation.create_link(
            **owner,
            expires_at=timezone.now() + timedelta(hours=1),
            max_uses=1,
            channel_id=None,
            role="org_member",
        )
    link.refresh_from_db()
    assert link.uses_count == 0
    governance.profile(**owner, if_match="*", data={"invites_paused": False})
    moderation.redeem_link(verified=tokens[3], code=code, request_id=str(uuid4()))
    assert not WorkspaceMemberRole.objects.filter(
        membership=members[3], role_id=role["id"]
    ).exists()
    subject = str(uuid4())
    newcomer_user = User.objects.create(email=f"{subject}@example.org")
    Identity.objects.create(
        user=newcomer_user,
        organisation=org,
        issuer=org.issuer,
        realm=org.realm,
        subject=subject,
        email=newcomer_user.email,
    )
    newcomer_token = VerifiedAccessToken(
        org.issuer,
        subject,
        ("kodera-server",),
        0,
        2**31,
        None,
        None,
        None,
        None,
        email_verified=True,
    )
    moderation.redeem_link(verified=newcomer_token, code=code, request_id=str(uuid4()))
    newcomer_membership = Membership.objects.get(organisation=org, user=newcomer_user)
    assert WorkspaceMemberRole.objects.filter(
        membership=newcomer_membership, role_id=role["id"]
    ).exists()
    assert link.created_by_id == members[0].id
    for invalid in [
        {"description": "x" * 501},
        {"invites_paused": 1},
        {"icon_mxc": "https://example.org/icon"},
        {"traits": [{"icon": "a", "label": "b"}] * 6},
        {"rules_channel_id": str(uuid4())},
    ]:
        with pytest.raises(moderation.RefusalError):
            governance.profile(**owner, if_match="*", data=invalid)


def test_bans_and_audit_filters_are_tenant_scoped(world):
    from apps.audit.models import AuditEvent
    from apps.workspaces import governance, moderation

    org, _, members, tokens = world
    owner = {"verified": tokens[0], "organisation_id": org.id, "request_id": str(uuid4())}
    moderation.moderate(
        **owner, target_id=members[3].id, action="ban", reason="Example", expires_at=None
    )
    query = {"q": members[3].user.email[:12]}
    page = governance.admin_page(
        verified=tokens[1], organisation_id=org.id, kind="bans", query=query
    )
    assert page["data"][0]["membership_id"] == str(members[3].id)
    assert (
        governance.admin_page(
            verified=tokens[1], organisation_id=org.id, kind="bans", query={"q": "missing"}
        )["data"]
        == []
    )
    identity = AuditEvent.objects.get(action="workspace.member.ban").actor_id
    foreign = AuditEvent.objects.create(
        organisation_id=uuid4(),
        action="workspace.member.ban",
        actor_type="system",
        actor_label="system",
        target_urn="urn:kodera:example",
        retention_class="standard",
    )
    result = governance.admin_page(
        verified=tokens[1],
        organisation_id=org.id,
        kind="audit",
        query={"actor_id": str(identity), "action": "workspace.member.ban"},
    )
    assert len(result["data"]) == 1
    assert all(row["id"] != str(foreign.id) for row in result["data"])
    for kind in ["audit", "bans"]:
        with pytest.raises(moderation.RefusalError) as failure:
            governance.admin_page(verified=tokens[2], organisation_id=org.id, kind=kind, query={})
        assert failure.value.status == 403
    moderation.moderate(
        **owner, target_id=members[3].id, action="unban", reason="Reviewed", expires_at=None
    )
    assert (
        governance.admin_page(verified=tokens[1], organisation_id=org.id, kind="bans", query={})[
            "data"
        ]
        == []
    )


def test_iam_inventory_preserves_unknown_shared_objects_and_refuses_missing_guard():
    from workspace_safety.iam_schema_inventory import FUNCTIONS, SHARED, TABLES, without_iam

    objects = dict.fromkeys(SHARED, ())
    objects.update({("function", *value): () for value in FUNCTIONS})
    objects.update({("relation", table, table): () for table in TABLES})
    unknown = ("trigger", "workspaces_workspace", "unknown_profile_guard")
    objects[unknown] = ("unexpected",)
    assert without_iam(objects) == {unknown: ("unexpected",)}
    del objects[("function", "workspace_iam_scope", "")]
    with pytest.raises(AssertionError, match="inventory is incomplete"):
        without_iam(objects)


def test_delegation_cannot_grant_unknown_capabilities_or_change_self(world):
    from apps.workspaces import iam
    from apps.workspaces.moderation import RefusalError

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
    delegate = {**owner, "verified": tokens[2]}
    low = iam.create_role(**delegate, data={"name": "Helpers", "slug": "helpers", "position": 1})
    for permissions in [["view_audit_log"], ["message.delete_any"]]:
        with pytest.raises(RefusalError) as failure:
            iam.update_role(
                **delegate,
                role_id=UUID(low["id"]),
                data={"permissions": permissions},
                if_match="*",
            )
        assert failure.value.status == 403
    with pytest.raises(RefusalError):
        iam.assign_roles(**delegate, membership_id=members[2].id, role_ids=[])
    iam.assign_roles(**delegate, membership_id=members[3].id, role_ids=[low["id"]])


def test_roles_check_authority_again_after_workspace_lock(world, monkeypatch):
    from apps.workspaces import iam
    from apps.workspaces.models import WorkspaceMemberRole
    from apps.workspaces.moderation import RefusalError

    org, _, members, tokens = world
    owner = {"verified": tokens[0], "organisation_id": org.id, "request_id": str(uuid4())}
    role = iam.create_role(
        **owner,
        data={
            "name": "Managers",
            "slug": "managers",
            "position": 50,
            "permissions": ["manage_roles"],
        },
    )
    iam.assign_roles(**owner, membership_id=members[2].id, role_ids=[role["id"]])
    original = iam.lock_workspace
    locked = []

    def revoke_then_lock(*, workspace_id):
        locked.append(workspace_id)
        WorkspaceMemberRole.objects.filter(membership=members[2]).delete()
        original(workspace_id=workspace_id)

    monkeypatch.setattr(iam, "lock_workspace", revoke_then_lock)
    with pytest.raises(RefusalError) as failure:
        iam.create_role(
            **{**owner, "verified": tokens[2]},
            data={"name": "No longer allowed", "slug": "refused"},
        )
    assert locked and failure.value.status == 403


@pytest.mark.parametrize(
    "data",
    [
        {"permissions": ["root"]},
        {"permissions": "manage_roles"},
        {"permissions": ["manage_roles", "manage_roles"]},
        {"position": True},
        {"color": "blue"},
        {"icon": "x" * 33},
        {"slug": "Invalid Slug"},
    ],
)
def test_invalid_role_shapes_refused_without_writes(world, data):
    from apps.workspaces import iam
    from apps.workspaces.models import WorkspaceRole
    from apps.workspaces.moderation import RefusalError

    org, _, _, tokens = world
    with pytest.raises(RefusalError) as failure:
        iam.create_role(
            verified=tokens[0],
            organisation_id=org.id,
            data={"name": "Example", "slug": "example", **data},
            request_id=str(uuid4()),
        )
    assert failure.value.status == 422
    assert not WorkspaceRole.objects.exists()


@pytest.fixture
def other_world():
    from workspace_safety.test_moderation import world as build_world

    return build_world.__wrapped__()


def test_cross_tenant_roles_members_channels_and_profiles_are_refused(world, other_world):
    from django.db import IntegrityError, transaction

    from apps.workspaces import governance, iam
    from apps.workspaces.models import (
        Channel,
        WorkspaceChannelRoleOverride,
        WorkspaceMemberRole,
        WorkspaceRole,
    )
    from apps.workspaces.moderation import RefusalError

    org, workspace, members, tokens = world
    other_org, other_workspace, other_members, _ = other_world
    owner = {"verified": tokens[0], "organisation_id": org.id, "request_id": str(uuid4())}
    role = iam.create_role(**owner, data={"name": "Builders", "slug": "builders"})
    channel = Channel.objects.create(
        workspace=other_workspace, name="Other", kind="text", position=0
    )
    for target in [members[3].id, other_members[3].id]:
        if target == members[3].id:
            foreign_role = WorkspaceRole.objects.create(
                workspace=other_workspace, organisation_id=other_org.id, name="Other", slug="other"
            )
            ids = [str(foreign_role.id)]
        else:
            ids = [role["id"]]
        with pytest.raises(RefusalError) as failure:
            iam.assign_roles(**owner, membership_id=target, role_ids=ids)
        assert failure.value.status == 404
    with pytest.raises(RefusalError) as failure:
        governance.profile(**owner, if_match="*", data={"rules_channel_id": str(channel.id)})
    assert failure.value.status == 404
    with pytest.raises(RefusalError):
        governance.overrides(**owner, channel_id=channel.id, data=[])
    with pytest.raises(RefusalError):
        iam.list_roles(verified=tokens[0], organisation_id=other_org.id)
    bad_rows = [
        WorkspaceRole(
            workspace=workspace, organisation_id=other_org.id, name="Invalid", slug="invalid"
        ),
        WorkspaceRole(
            workspace=workspace,
            organisation_id=org.id,
            name="Invalid",
            slug="invalid",
            permissions=["root"],
        ),
        WorkspaceMemberRole(workspace=workspace, membership=other_members[3], role_id=role["id"]),
        WorkspaceMemberRole(
            workspace=other_workspace, membership=other_members[3], role_id=role["id"]
        ),
        WorkspaceChannelRoleOverride(workspace=workspace, channel=channel, role_id=role["id"]),
    ]
    for row in bad_rows:
        with pytest.raises(IntegrityError), transaction.atomic():
            row.save(force_insert=True)


def test_admin_audit_capability_signed_pagination_and_cursor_filter_binding(world):
    from apps.workspaces import governance, iam
    from apps.workspaces.moderation import RefusalError

    org, _, members, tokens = world
    owner = {"verified": tokens[0], "organisation_id": org.id, "request_id": str(uuid4())}
    role = iam.create_role(
        **owner, data={"name": "Auditors", "slug": "auditors", "permissions": ["view_audit_log"]}
    )
    iam.assign_roles(**owner, membership_id=members[3].id, role_ids=[role["id"]])
    first = governance.admin_page(
        verified=tokens[3], organisation_id=org.id, kind="audit", query={"limit": "1"}
    )
    assert len(first["data"]) == 1 and first["has_more"]
    cursor = first["next_cursor"]
    next_page = governance.admin_page(
        verified=tokens[3],
        organisation_id=org.id,
        kind="audit",
        query={"limit": "1", "cursor": cursor},
    )
    assert next_page["data"] and first["data"][0]["id"] != next_page["data"][0]["id"]
    for query in [
        {"limit": "0"},
        {"actor_id": "invalid"},
        {"action": "invalid action"},
        {"cursor": cursor + "tampered"},
        {"action": "workspace.role.created", "cursor": cursor},
    ]:
        with pytest.raises(RefusalError) as failure:
            governance.admin_page(
                verified=tokens[3], organisation_id=org.id, kind="audit", query=query
            )
        assert failure.value.status == 400
    with pytest.raises(RefusalError):
        governance.admin_page(
            verified=tokens[0], organisation_id=org.id, kind="audit", query={"cursor": cursor}
        )


def test_runtime_writer_can_administer_roles_profile_and_channel_overrides(world):
    from test_intake_writer_role import acting_as
    from test_workspace_writer_role import _role

    from apps.workspaces import governance, iam
    from apps.workspaces.models import Channel

    org, workspace, members, tokens = world
    channel = Channel.objects.create(workspace=workspace, name="General", kind="text", position=0)
    owner = {"verified": tokens[0], "organisation_id": org.id, "request_id": str(uuid4())}
    for writer in _role():
        with acting_as(writer):
            role = iam.create_role(**owner, data={"name": "Builders", "slug": "builders"})
            iam.update_role(
                **owner, role_id=UUID(role["id"]), data={"color": "#123456"}, if_match="*"
            )
            iam.assign_roles(**owner, membership_id=members[3].id, role_ids=[role["id"]])
            governance.overrides(
                **owner,
                channel_id=channel.id,
                data=[{"role_id": role["id"], "allow": ["channel.view"], "deny": []}],
            )
            governance.profile(
                **owner,
                if_match="*",
                data={"description": "Example", "rules_channel_id": str(channel.id)},
            )
            assert governance.admin_page(
                verified=tokens[0], organisation_id=org.id, kind="audit", query={}
            )["data"]
            iam.delete_role(**owner, role_id=UUID(role["id"]))


def test_role_and_profile_conditional_updates_and_active_member_count(world):
    from apps.orgs.models import Membership
    from apps.workspaces import governance, iam
    from apps.workspaces.moderation import RefusalError

    org, _, members, tokens = world
    owner = {"verified": tokens[0], "organisation_id": org.id, "request_id": str(uuid4())}
    role = iam.create_role(**owner, data={"name": "Builders", "slug": "builders", "position": 10})
    assert role["etag"].startswith('"') and role["etag"].endswith('"')
    with pytest.raises(RefusalError) as missing:
        iam.update_role(**owner, role_id=UUID(role["id"]), data={"name": "Updated"}, if_match="")
    assert missing.value.status == 428
    with pytest.raises(RefusalError) as stale:
        iam.update_role(
            **owner, role_id=UUID(role["id"]), data={"name": "Updated"}, if_match='"stale"'
        )
    assert stale.value.status == 412 and stale.value.current_etag == role["etag"]
    iam.assign_roles(**owner, membership_id=members[2].id, role_ids=[role["id"]])
    iam.assign_roles(**owner, membership_id=members[3].id, role_ids=[role["id"]])
    Membership.objects.filter(pk=members[2].id).update(state="suspended")
    updated = iam.update_role(
        **owner, role_id=UUID(role["id"]), data={"name": "Updated"}, if_match=role["etag"]
    )
    assert updated["etag"] != role["etag"]
    assert updated["member_count"] == 1
    assert (
        iam.list_roles(verified=tokens[0], organisation_id=org.id)["data"][0]["member_count"] == 1
    )

    _, etag = governance.profile_with_etag(verified=tokens[0], organisation_id=org.id)
    with pytest.raises(RefusalError) as profile_missing:
        governance.profile_with_etag(
            **owner, data={"description": "Missing precondition"}, if_match=""
        )
    assert profile_missing.value.status == 428
    with pytest.raises(RefusalError) as profile_stale:
        governance.profile_with_etag(
            **owner, data={"description": "Stale precondition"}, if_match='"stale"'
        )
    assert profile_stale.value.status == 412 and profile_stale.value.current_etag == etag
    body, rotated = governance.profile_with_etag(
        **owner, data={"description": "Conditional update"}, if_match=etag
    )
    assert body["description"] == "Conditional update" and rotated != etag


def test_delegated_role_manager_cannot_strip_unheld_override_capabilities_or_delete_role(world):
    from apps.workspaces import governance, iam
    from apps.workspaces.models import Channel, ResourcePolicy, WorkspaceChannelRoleOverride
    from apps.workspaces.moderation import RefusalError

    org, workspace, members, tokens = world
    policy = ResourcePolicy.objects.create(
        workspace=workspace, visibility=ResourcePolicy.Visibility.ORGANISATION
    )
    workspace.default_policy = policy
    workspace.save(update_fields=["default_policy", "updated_at"])
    channel = Channel.objects.create(workspace=workspace, name="General", kind="text", position=0)
    owner = {"verified": tokens[0], "organisation_id": org.id, "request_id": str(uuid4())}
    manager = iam.create_role(
        **owner,
        data={
            "name": "Managers",
            "slug": "managers",
            "position": 50,
            "permissions": ["manage_roles", "channel.view"],
        },
    )
    target = iam.create_role(
        **owner,
        data={
            "name": "Moderated",
            "slug": "moderated",
            "position": 10,
            "permissions": ["channel.view"],
        },
    )
    iam.assign_roles(**owner, membership_id=members[2].id, role_ids=[manager["id"]])
    governance.overrides(
        **owner,
        channel_id=channel.id,
        data=[
            {
                "role_id": target["id"],
                "allow": ["channel.view"],
                "deny": ["message.delete_any"],
            }
        ],
    )
    delegate = {**owner, "verified": tokens[2]}
    with pytest.raises(RefusalError) as clear_refused:
        governance.overrides(**delegate, channel_id=channel.id, data=[])
    assert clear_refused.value.status == 403
    assert WorkspaceChannelRoleOverride.objects.filter(channel=channel).count() == 1
    with pytest.raises(RefusalError) as delete_refused:
        iam.delete_role(**delegate, role_id=UUID(target["id"]))
    assert delete_refused.value.status == 403
    assert WorkspaceChannelRoleOverride.objects.filter(channel=channel).count() == 1


def test_restricted_channel_overrides_hide_existence_from_non_admin_members(world):
    from apps.workspaces import governance, iam
    from apps.workspaces.models import Channel, ResourcePolicy
    from apps.workspaces.moderation import RefusalError

    org, workspace, members, tokens = world
    restricted = ResourcePolicy.objects.create(
        workspace=workspace, visibility=ResourcePolicy.Visibility.RESTRICTED
    )
    secret = Channel.objects.create(
        workspace=workspace,
        name="Secret",
        kind="text",
        position=0,
        policy_mode=Channel.PolicyMode.EXPLICIT,
        explicit_policy=restricted,
    )
    owner = {"verified": tokens[0], "organisation_id": org.id, "request_id": str(uuid4())}
    ceiling = iam.create_role(**owner, data={"name": "Leads", "slug": "leads", "position": 40})
    iam.assign_roles(**owner, membership_id=members[1].id, role_ids=[ceiling["id"]])
    manager = iam.create_role(
        **owner,
        data={
            "name": "Managers",
            "slug": "managers",
            "position": 20,
            "permissions": ["manage_roles", "channel.view"],
        },
    )
    iam.assign_roles(**owner, membership_id=members[2].id, role_ids=[manager["id"]])
    with pytest.raises(RefusalError) as read_refused:
        governance.overrides(verified=tokens[3], organisation_id=org.id, channel_id=secret.id)
    assert read_refused.value.status == 404
    with pytest.raises(RefusalError) as write_refused:
        governance.overrides(
            verified=tokens[2],
            organisation_id=org.id,
            channel_id=secret.id,
            data=[],
            request_id=str(uuid4()),
        )
    assert write_refused.value.status == 404
    assert governance.overrides(
        verified=tokens[1], organisation_id=org.id, channel_id=secret.id
    ) == {"data": []}
    assert governance.overrides(
        verified=tokens[1],
        organisation_id=org.id,
        channel_id=secret.id,
        data=[],
        request_id=str(uuid4()),
    ) == {"data": []}


def test_invite_auto_roles_enforce_newcomer_only_and_creator_ceiling_at_redemption(world):
    from datetime import timedelta

    from django.utils import timezone

    from apps.identity.models import Identity, User
    from apps.orgs.models import Membership
    from apps.workspaces import iam, moderation
    from apps.workspaces.models import WorkspaceMemberRole
    from services.identity.access_tokens import VerifiedAccessToken

    org, _, members, tokens = world
    owner = {"verified": tokens[0], "organisation_id": org.id, "request_id": str(uuid4())}
    admin = {"verified": tokens[1], "organisation_id": org.id, "request_id": str(uuid4())}
    ceiling = iam.create_role(**owner, data={"name": "Leads", "slug": "leads", "position": 20})
    iam.assign_roles(**owner, membership_id=members[1].id, role_ids=[ceiling["id"]])
    auto_role = iam.create_role(
        **admin, data={"name": "Builders", "slug": "builders", "position": 10}
    )
    _, code = moderation.create_link(
        **admin,
        expires_at=timezone.now() + timedelta(hours=1),
        max_uses=5,
        channel_id=None,
        role="org_member",
        auto_role_ids=[auto_role["id"]],
    )
    moderation.redeem_link(verified=tokens[1], code=code, request_id=str(uuid4()))
    assert not WorkspaceMemberRole.objects.filter(
        membership=members[1], role_id=auto_role["id"]
    ).exists()

    iam.update_role(**owner, role_id=UUID(auto_role["id"]), data={"position": 25}, if_match="*")
    subject = str(uuid4())
    newcomer_user = User.objects.create(email=f"{subject}@example.org")
    Identity.objects.create(
        user=newcomer_user,
        organisation=org,
        issuer=org.issuer,
        realm=org.realm,
        subject=subject,
        email=newcomer_user.email,
    )
    newcomer_token = VerifiedAccessToken(
        org.issuer,
        subject,
        ("kodera-server",),
        0,
        2**31,
        None,
        None,
        None,
        None,
        email_verified=True,
    )
    with pytest.raises(moderation.RefusalError) as admit_refused:
        moderation.admit_redemption(verified=newcomer_token, code=code)
    assert admit_refused.value.status == 403
    with pytest.raises(moderation.RefusalError) as redeem_refused:
        moderation.redeem_link(verified=newcomer_token, code=code, request_id=str(uuid4()))
    assert redeem_refused.value.status == 403
    assert not Membership.objects.filter(organisation=org, user=newcomer_user).exists()


def test_workspace_audit_logs_exclude_org_events_and_redact_non_tenant_actors(world):
    from apps.audit.models import AuditEvent
    from apps.identity.models import Identity
    from apps.workspaces import governance, iam

    org, _, members, tokens = world
    owner = {"verified": tokens[0], "organisation_id": org.id, "request_id": str(uuid4())}
    tenant_identity = Identity.objects.get(organisation=org, user=members[0].user)
    staff_actor_id = uuid4()
    AuditEvent.objects.create(
        organisation_id=org.id,
        action="invoice.issued",
        actor_type="tenant",
        actor_id=tenant_identity.id,
        actor_label="owner",
        target_urn=f"urn:kodera:invoice:{uuid4()}",
        retention_class="standard",
    )
    AuditEvent.objects.create(
        organisation_id=org.id,
        action="privacy.erasure_cutoff",
        actor_type="staff",
        actor_id=staff_actor_id,
        actor_label="staff",
        target_urn=f"urn:kodera:organisation:{org.id}",
        retention_class="standard",
    )
    staff_ws_event = AuditEvent.objects.create(
        organisation_id=org.id,
        action="workspace.profile.updated",
        actor_type="staff",
        actor_id=staff_actor_id,
        actor_label="staff",
        target_urn=f"urn:kodera:workspace:{org.id}",
        retention_class="standard",
    )
    auditor = iam.create_role(
        **owner, data={"name": "Auditors", "slug": "auditors", "permissions": ["view_audit_log"]}
    )
    iam.assign_roles(**owner, membership_id=members[3].id, role_ids=[auditor["id"]])
    page = governance.admin_page(
        verified=tokens[3], organisation_id=org.id, kind="audit", query={"limit": "50"}
    )
    assert all(item["action"].startswith("workspace.") for item in page["data"])
    staff_rows = [item for item in page["data"] if item["id"] == str(staff_ws_event.id)]
    assert len(staff_rows) == 1 and staff_rows[0]["actor_id"] is None
    probed = governance.admin_page(
        verified=tokens[3],
        organisation_id=org.id,
        kind="audit",
        query={"actor_id": str(staff_actor_id)},
    )
    assert probed["data"] == []


def test_duplicate_role_slug_returns_409_conflict_on_create_and_update(world):
    from apps.workspaces import iam
    from apps.workspaces.moderation import RefusalError

    org, _, _, tokens = world
    owner = {"verified": tokens[0], "organisation_id": org.id, "request_id": str(uuid4())}
    iam.create_role(**owner, data={"name": "Builders", "slug": "builders"})
    second = iam.create_role(**owner, data={"name": "Designers", "slug": "designers"})
    with pytest.raises(RefusalError) as duplicate_create:
        iam.create_role(**owner, data={"name": "Duplicate", "slug": "builders"})
    assert duplicate_create.value.status == 409
    with pytest.raises(RefusalError) as duplicate_update:
        iam.update_role(
            **owner, role_id=UUID(second["id"]), data={"slug": "builders"}, if_match="*"
        )
    assert duplicate_update.value.status == 409
    assert len(iam.list_roles(verified=tokens[0], organisation_id=org.id)["data"]) == 2


def test_unprivileged_profile_patch_refused_before_workspace_lock(world, monkeypatch):
    from apps.workspaces import governance, iam
    from apps.workspaces.moderation import RefusalError

    org, _, _, tokens = world
    locked = []
    monkeypatch.setattr(iam, "lock_workspace", lambda *, workspace_id: locked.append(workspace_id))
    with pytest.raises(RefusalError) as refused:
        governance.profile(
            verified=tokens[3],
            organisation_id=org.id,
            data={"description": "Unprivileged"},
            if_match="*",
            request_id=str(uuid4()),
        )
    assert refused.value.status == 403
    assert locked == []
