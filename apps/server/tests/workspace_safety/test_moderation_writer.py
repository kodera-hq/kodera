# ruff: noqa: S101
"""Moderation works with the provisioned API role and retains immutable evidence."""

from datetime import timedelta
from uuid import uuid4

import pytest
from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, refused
from test_workspace_writer_role import _role

from apps.workspaces import moderation
from workspace_safety.test_moderation import world as world

pytestmark = pytest.mark.django_db


@pytest.fixture
def writer(world):
    yield from _role()


def test_writer_moderates_resolves_redeems_and_cannot_rewrite_evidence(world, writer):
    from django.utils import timezone

    org, _, members, tokens = world
    request_id = str(uuid4())
    with acting_as(writer):
        moderation.moderate(
            verified=tokens[2],
            organisation_id=org.id,
            target_id=members[3].id,
            action="kick",
            reason="Example",
            expires_at=None,
            request_id=request_id,
        )
        link, code = moderation.create_link(
            verified=tokens[0],
            organisation_id=org.id,
            expires_at=timezone.now() + timedelta(hours=1),
            max_uses=1,
            role="org_member",
            channel_id=None,
            request_id=request_id,
        )
        assert (
            moderation.redeem_link(
                verified=tokens[3],
                code=code,
                request_id=request_id,
            ).id
            == members[3].id
        )
        report = moderation.report(
            verified=tokens[3],
            organisation_id=org.id,
            target_id=members[2].id,
            reason="Example report",
            channel_id=None,
            event_id="",
            request_id=request_id,
        )
        assert (
            moderation.resolve_report(
                verified=tokens[0],
                organisation_id=org.id,
                report_id=report.id,
                status="resolved",
                resolution="Handled",
                if_match="*",
                request_id=request_id,
            ).status
            == "resolved"
        )
        moderation.revoke_link(
            verified=tokens[0],
            organisation_id=org.id,
            link_id=link.id,
            request_id=request_id,
        )
        assert (
            refused("UPDATE workspaces_workspaceinvitelink SET max_uses = max_uses + 1")
            == INSUFFICIENT_PRIVILEGE
        )
        assert (
            refused("UPDATE workspaces_workspaceabusereport SET reason = 'Replacement'")
            == INSUFFICIENT_PRIVILEGE
        )
        assert refused("DELETE FROM workspaces_workspaceinviteredemption") == INSUFFICIENT_PRIVILEGE
