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
