"""Real tenant fences and arrival precedence for workspace profile administration."""

from uuid import uuid4

import pytest
from django.db import transaction

from workspace_safety.test_moderation import world as world

pytestmark = pytest.mark.django_db(transaction=True)


def test_profile_logo_name_defaults_and_member_refusal(world):
    from test_workspace_ux import raster

    from apps.workspaces import governance
    from apps.workspaces.models import Channel, Workspace
    from apps.workspaces.moderation import RefusalError

    org, _, members, tokens = world
    workspace = Workspace.objects.get(organisation=org)
    from apps.workspaces.models import ResourcePolicy

    policy = ResourcePolicy.objects.create(
        workspace=workspace, visibility="organisation", revision=1
    )
    workspace.default_policy = policy
    workspace.save(update_fields=["default_policy"])
    channel = Channel.objects.create(
        workspace=workspace,
        name="arrivals",
        template_key="arrivals",
        kind="text",
        lifecycle="active",
        room_state="ready",
        position=0,
        policy_mode="inherit",
    )
    owner = {"verified": tokens[0], "organisation_id": org.id}
    _, etag = governance.profile_with_etag(**owner)
    saved, updated = governance.profile_with_etag(
        **owner,
        if_match=etag,
        data={
            "display_name": "  Workshop  ",
            "logo_url": raster(),
            "default_ui_mode": "messages",
            "default_channel_id": str(channel.id),
            "allow_member_channel_creation": True,
            "allow_member_invites": False,
            "allow_link_previews": False,
        },
    )
    assert saved["display_name"] == "Workshop" and updated != etag
    workspace.refresh_from_db()
    assert workspace.logo_url == raster() and not workspace.allow_member_invites
    with pytest.raises(RefusalError) as stale:
        governance.profile(**owner, if_match=etag, data={"logo_url": ""})
    assert stale.value.status == 412
    member = next(i for i, value in enumerate(members) if value.role == "org_member")
    with pytest.raises(RefusalError) as denied:
        governance.profile(
            verified=tokens[member], organisation_id=org.id, if_match=updated, data={"logo_url": ""}
        )
    assert denied.value.status == 403
    governance.profile(**owner, if_match=updated, data={"logo_url": ""})
    workspace.refresh_from_db()
    assert workspace.logo_url == ""
    with pytest.raises(RefusalError) as foreign:
        governance.profile(**owner, if_match="*", data={"default_channel_id": str(uuid4())})
    assert foreign.value.status == 404


def test_member_creation_requires_current_opt_in_and_cannot_choose_a_category(world):
    from apps.workspaces import administration
    from apps.workspaces.models import Workspace

    org, _, members, tokens = world
    member = next(i for i, value in enumerate(members) if value.role == "org_member")
    arguments = {"verified": tokens[member], "organisation_id": org.id}
    with pytest.raises(administration.AdministrationForbiddenError):
        administration.authorise(**arguments, channel_creation=True)
    from apps.workspaces.models import ResourcePolicy

    workspace = Workspace.objects.get(organisation=org)
    policy = ResourcePolicy.objects.create(
        workspace=workspace, visibility="organisation", revision=1
    )
    Workspace.objects.filter(organisation=org).update(
        allow_member_channel_creation=True, default_policy=policy
    )
    administration.authorise(**arguments, channel_creation=True)
    with transaction.atomic():
        write = administration.begin(
            **arguments, request_id=str(uuid4()), creating=True, channel_creation=True
        )
        row = administration.create_channel(
            write=write, body={"category_id": None, "name": "Member space", "kind": "text"}
        )
    assert row.name == "Member space"
    Workspace.objects.filter(organisation=org).update(allow_member_channel_creation=False)
    with pytest.raises(administration.AdministrationForbiddenError):
        administration.authorise(**arguments, channel_creation=True)


def test_bootstrap_preferences_never_disclose_a_hidden_landing_channel(world):
    from apps.workspaces.models import Channel, ResourcePolicy, Workspace
    from apps.workspaces.structure import read_workspace

    org, workspace, _, tokens = world
    public = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    private = ResourcePolicy.objects.create(workspace=workspace, visibility="restricted")
    hidden = Channel.objects.create(
        workspace=workspace,
        name="arrivals",
        kind="text",
        lifecycle="active",
        room_state="ready",
        position=0,
        policy_mode="explicit",
        explicit_policy=private,
    )
    Workspace.objects.filter(id=workspace.id).update(
        default_policy=public,
        arrivals_channel_id=hidden.id,
        default_channel_id=hidden.id,
    )
    view = read_workspace(verified=tokens[3], organisation_id=org.id)
    assert not view.uncategorised_channels and not view.categories
    assert view.default_channel_id is None and view.arrivals_channel_id is None
