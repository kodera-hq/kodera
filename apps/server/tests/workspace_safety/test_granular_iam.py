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
            iam.update_role(**admin, role_id=UUID(lower["id"]), data={"position": position})
        assert failure.value.status == 403
    with pytest.raises(RefusalError) as failure:
        iam.assign_roles(**admin, membership_id=members[3].id, role_ids=[ceiling["id"]])
    assert failure.value.status == 403
    with pytest.raises(RefusalError):
        iam.delete_role(**admin, role_id=UUID(ceiling["id"]))


def test_profile_validation_pause_and_invite_auto_roles(world):
    from datetime import timedelta

    from django.utils import timezone

    from apps.workspaces import governance, iam, moderation
    from apps.workspaces.models import WorkspaceMemberRole

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
    governance.profile(**owner, data={"invites_paused": False})
    moderation.redeem_link(verified=tokens[3], code=code, request_id=str(uuid4()))
    assert WorkspaceMemberRole.objects.filter(membership=members[3], role_id=role["id"]).exists()
    assert link.created_by_id == members[0].id
    for invalid in [
        {"description": "x" * 501},
        {"invites_paused": 1},
        {"icon_mxc": "https://example.org/icon"},
        {"traits": [{"icon": "a", "label": "b"}] * 6},
        {"rules_channel_id": str(uuid4())},
    ]:
        with pytest.raises(moderation.RefusalError):
            governance.profile(**owner, data=invalid)


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
            iam.update_role(**delegate, role_id=UUID(low["id"]), data={"permissions": permissions})
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
        governance.profile(**owner, data={"rules_channel_id": str(channel.id)})
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
            iam.update_role(**owner, role_id=UUID(role["id"]), data={"color": "#123456"})
            iam.assign_roles(**owner, membership_id=members[3].id, role_ids=[role["id"]])
            governance.overrides(
                **owner,
                channel_id=channel.id,
                data=[{"role_id": role["id"], "allow": ["channel.view"], "deny": []}],
            )
            governance.profile(
                **owner, data={"description": "Example", "rules_channel_id": str(channel.id)}
            )
            assert governance.admin_page(
                verified=tokens[0], organisation_id=org.id, kind="audit", query={}
            )["data"]
            iam.delete_role(**owner, role_id=UUID(role["id"]))
