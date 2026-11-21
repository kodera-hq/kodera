"""Attachment capability creation and use share current workspace admission."""

from dataclasses import replace
from uuid import uuid4

import pytest
from django.db import transaction
from django.utils import timezone
from workspace_safety.test_moderation import world as world

from apps.identity.models import Identity, User
from apps.media import services
from apps.media.context import RefusalError
from apps.orgs.models import Membership, Organisation, SlugReservation
from apps.workspaces.models import Workspace, WorkspaceMemberRestriction
from workspace_media.test_media_services import gateway as gateway, upload

pytestmark = pytest.mark.django_db


def test_foreign_workspace_and_cross_workspace_attachment_ids_never_reach_signer(world, gateway):
    org, _, _, tokens = world
    ticket = upload(world, gateway)
    identifier = ticket["attachmentId"]
    services.complete_upload(
        verified=tokens[3],
        organisation_id=org.id,
        attachment_id=identifier,
        request_id=str(uuid4()),
    )
    with transaction.atomic():
        slug = "media-" + uuid4().hex[:12]
        other = Organisation.objects.create(
            slug=slug,
            realm=slug,
            issuer=f"https://identity.example.org/realms/{slug}",
            name="Other example",
            state="active",
        )
        SlugReservation.objects.create(
            organisation=other,
            slug=slug,
            namespace="organisation",
            state="permanent",
            protected_at=timezone.now(),
        )
        Workspace.objects.create(organisation=other)
        subject = str(uuid4())
        user = User.objects.create(email=f"{subject}@example.org")
        Identity.objects.create(
            user=user,
            organisation=other,
            issuer=other.issuer,
            realm=slug,
            subject=subject,
            email=user.email,
        )
        Membership.objects.create(
            organisation=other,
            user=user,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
    foreign_token = replace(tokens[3], issuer=other.issuer, subject=subject)
    before = len(gateway.calls)
    for token in (tokens[3], foreign_token):
        with pytest.raises(RefusalError) as denied:
            services.get_attachment(
                verified=token, organisation_id=other.id, attachment_id=identifier
            )
        assert denied.value.status in {403, 404}
        with pytest.raises(RefusalError) as denied:
            services.complete_upload(
                verified=token,
                organisation_id=other.id,
                attachment_id=identifier,
                request_id=str(uuid4()),
            )
        assert denied.value.status in {403, 404}
    with pytest.raises(RefusalError) as denied:
        services.create_upload(
            verified=tokens[3], organisation_id=other.id, body={}, request_id=str(uuid4())
        )
    assert denied.value.status in {403, 404}
    assert len(gateway.calls) == before


@pytest.mark.parametrize("restriction", ["banned", "kicked"])
def test_workspace_exclusion_refuses_presign_completion_and_download(world, gateway, restriction):
    org, workspace, members, tokens = world
    ticket = upload(world, gateway)
    identifier = ticket["attachmentId"]
    services.complete_upload(
        verified=tokens[3],
        organisation_id=org.id,
        attachment_id=identifier,
        request_id=str(uuid4()),
    )
    WorkspaceMemberRestriction.objects.create(
        workspace=workspace, membership=members[3], **{restriction: True}
    )
    before = len(gateway.calls)
    for operation in (
        lambda: services.create_upload(
            verified=tokens[3], organisation_id=org.id, body={}, request_id=str(uuid4())
        ),
        lambda: services.complete_upload(
            verified=tokens[3],
            organisation_id=org.id,
            attachment_id=identifier,
            request_id=str(uuid4()),
        ),
        lambda: services.get_attachment(
            verified=tokens[3], organisation_id=org.id, attachment_id=identifier
        ),
    ):
        with pytest.raises(RefusalError) as denied:
            operation()
        assert denied.value.status == 403
    assert len(gateway.calls) == before


def test_scoped_channel_and_dm_attachments_refuse_non_participant_and_redact_audit_urn(
    world, gateway, settings
):
    import hashlib
    import secrets

    from django.db import IntegrityError

    from apps.media.models import Attachment
    from apps.workspaces import governance, iam
    from apps.workspaces.models import Channel, ResourcePolicy, ResourcePolicyRule

    org, workspace, members, tokens = world
    # Grant member[2] (`org_member`) `view_audit_log` so they can read the workspace audit table
    # without being a participant of private DM rooms or restricted channels.
    auditor_role = iam.create_role(
        verified=tokens[0],
        organisation_id=org.id,
        data={
            "name": "Auditors",
            "slug": "auditors",
            "position": 10,
            "permissions": ["view_audit_log"],
        },
        request_id=str(uuid4()),
    )
    iam.assign_roles(
        verified=tokens[0],
        organisation_id=org.id,
        membership_id=members[2].id,
        role_ids=[auditor_role["id"]],
        request_id=str(uuid4()),
    )

    policy = ResourcePolicy.objects.create(workspace=workspace, visibility="restricted")
    ResourcePolicyRule.objects.create(policy=policy, kind="allow_member", membership=members[3])
    private_channel = Channel.objects.create(
        workspace=workspace,
        name="Private board",
        kind="text",
        lifecycle="active",
        position=0,
        policy_mode="explicit",
        explicit_policy=policy,
    )

    dm_room = "!dmSecretRoom42:matrix.kodera.test"
    allowed_dm_members = {members[3].id, members[1].id}
    settings.KODERA_MEDIA_ROOM_ACCESS = lambda org_id, room_id, principal, _verified: (
        org_id == org.id and room_id == dm_room and principal.membership_id in allowed_dm_members
    )

    channel_ticket = services.create_upload(
        verified=tokens[3],
        organisation_id=org.id,
        body={
            "filename": "board-notes.pdf",
            "contentType": "application/pdf",
            "sizeBytes": 64,
            "sha256": hashlib.sha256(secrets.token_bytes(64)).hexdigest(),
            "channelId": str(private_channel.id),
        },
        request_id=str(uuid4()),
    )
    dm_ticket = services.create_upload(
        verified=tokens[3],
        organisation_id=org.id,
        body={
            "filename": "dm-contract.pdf",
            "contentType": "application/pdf",
            "sizeBytes": 64,
            "sha256": hashlib.sha256(secrets.token_bytes(64)).hexdigest(),
            "roomId": dm_room,
        },
        request_id=str(uuid4()),
    )
    services.complete_upload(
        verified=tokens[3],
        organisation_id=org.id,
        attachment_id=channel_ticket["attachmentId"],
        request_id=str(uuid4()),
    )
    services.complete_upload(
        verified=tokens[3],
        organisation_id=org.id,
        attachment_id=dm_ticket["attachmentId"],
        request_id=str(uuid4()),
    )

    # Uploader and allowed DM / channel participants succeed.
    assert (
        services.get_attachment(
            verified=tokens[3],
            organisation_id=org.id,
            attachment_id=channel_ticket["attachmentId"],
        )["id"]
        == channel_ticket["attachmentId"]
    )
    assert (
        services.get_attachment(
            verified=tokens[1],
            organisation_id=org.id,
            attachment_id=dm_ticket["attachmentId"],
        )["id"]
        == dm_ticket["attachmentId"]
    )

    # Non-participant member[2] with `view_audit_log` reads the workspace audit log:
    # capability UUIDs are HMAC-redacted in `target_urn`, and `get_attachment` refuses with 403.
    audit_page = governance.admin_page(
        verified=tokens[2], organisation_id=org.id, kind="audit", query={"limit": "50"}
    )
    attachment_events = [
        entry for entry in audit_page["data"] if entry["action"].startswith("workspace.attachment.")
    ]
    assert len(attachment_events) == 4
    for entry in attachment_events:
        assert channel_ticket["attachmentId"] not in entry["target_urn"]
        assert dm_ticket["attachmentId"] not in entry["target_urn"]
        assert entry["target_urn"].startswith("urn:kodera:workspace-attachment:redacted:")

    calls_before = len(gateway.calls)
    for target_id in (channel_ticket["attachmentId"], dm_ticket["attachmentId"]):
        with pytest.raises(RefusalError) as denied:
            services.get_attachment(
                verified=tokens[2], organisation_id=org.id, attachment_id=target_id
            )
        assert denied.value.status == 403
    # Even `org_owner` (`tokens[0]`) is refused on a private DM room they are not a participant of.
    with pytest.raises(RefusalError) as owner_dm_denied:
        services.get_attachment(
            verified=tokens[0], organisation_id=org.id, attachment_id=dm_ticket["attachmentId"]
        )
    assert owner_dm_denied.value.status == 403
    assert len(gateway.calls) == calls_before

    # Without an external Matrix verifier, DM read fails closed for everyone except the uploader.
    settings.KODERA_MEDIA_ROOM_ACCESS = None
    with pytest.raises(RefusalError) as fail_closed:
        services.get_attachment(
            verified=tokens[1], organisation_id=org.id, attachment_id=dm_ticket["attachmentId"]
        )
    assert fail_closed.value.status == 403

    # Scope binding is immutable in PostgreSQL once persisted.
    with pytest.raises(IntegrityError), transaction.atomic():
        Attachment.objects.filter(pk=channel_ticket["attachmentId"]).update(channel=None)
    with pytest.raises(IntegrityError), transaction.atomic():
        Attachment.objects.filter(pk=dm_ticket["attachmentId"]).update(
            room_id="!otherRoom:matrix.kodera.test"
        )


def test_media_0003_attachment_scope_binding_reverses_and_reapplies_cleanly(django_db_blocker):
    from django.db.migrations.executor import MigrationExecutor
    from test_customer_persistence_migrations import empty_database, schema_objects

    with django_db_blocker.unblock(), empty_database() as target:
        executor = MigrationExecutor(target)
        executor.migrate([("media", "0003_attachment_scope_binding")])
        forward_schema = schema_objects(target)
        assert ("media_attachment", "media_attachment_delete_guard") in forward_schema[2]

        executor = MigrationExecutor(target)
        executor.migrate([("media", "0002_attachment_scope")])
        reversed_schema = schema_objects(target)
        assert ("media_attachment", "media_attachment_delete_guard") not in reversed_schema[2]

        executor = MigrationExecutor(target)
        executor.migrate([("media", "0003_attachment_scope_binding")])
        assert schema_objects(target) == forward_schema
