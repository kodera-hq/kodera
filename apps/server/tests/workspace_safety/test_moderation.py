"""Stored privilege and capacity boundaries against disposable PostgreSQL."""

from datetime import timedelta
from uuid import uuid4

import pytest
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.audit.models import AuditEvent
from apps.identity.models import Identity, User
from apps.orgs.models import Membership, Organisation, SlugReservation
from apps.workspaces import moderation
from apps.workspaces.models import Workspace, WorkspaceInviteLink, WorkspaceModerator
from services.identity.access_tokens import VerifiedAccessToken

pytestmark = pytest.mark.django_db


@pytest.fixture
def world():
    with transaction.atomic():
        slug = "mod-" + uuid4().hex[:12]
        org = Organisation.objects.create(
            slug=slug,
            realm=slug,
            name="Example",
            issuer=f"https://identity.example.org/realms/{slug}",
            state="active",
        )
        SlugReservation.objects.create(
            organisation=org,
            slug=slug,
            namespace="organisation",
            state="permanent",
            protected_at=timezone.now(),
        )
        workspace = Workspace.objects.create(organisation=org)
        members = []
        tokens = []
        for role in ["org_owner", "org_admin", "org_member", "org_member"]:
            subject = str(uuid4())
            user = User.objects.create(email=f"{subject}@example.org")
            Identity.objects.create(
                user=user,
                organisation=org,
                issuer=org.issuer,
                realm=slug,
                subject=subject,
                email=user.email,
            )
            member = Membership.objects.create(
                user=user,
                organisation=org,
                role=role,
                state="active",
                accepted_at=timezone.now(),
            )
            members.append(member)
            tokens.append(
                VerifiedAccessToken(
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
            )
        WorkspaceModerator.objects.create(workspace=workspace, membership=members[2])
        return org, workspace, members, tokens


@pytest.mark.parametrize("action", ["kick", "ban", "mute"])
@pytest.mark.parametrize("target", [0, 1])
def test_moderator_cannot_target_owner_or_admin(world, action, target):
    org, _, members, tokens = world
    with pytest.raises(moderation.RefusalError) as failure:
        moderation.moderate(
            verified=tokens[2],
            organisation_id=org.id,
            target_id=members[target].id,
            action=action,
            reason="Example",
            expires_at=timezone.now() + timedelta(hours=1)
            if action == "mute"
            else None,
            request_id=str(uuid4()),
        )
    assert failure.value.status == 403
    assert not AuditEvent.objects.filter(action="workspace.member." + action).exists()


def test_ban_mute_expiry_and_audit(world):
    org, workspace, members, tokens = world
    expires = timezone.now() + timedelta(minutes=1)
    moderation.moderate(
        verified=tokens[2],
        organisation_id=org.id,
        target_id=members[3].id,
        action="mute",
        reason="Example",
        expires_at=expires,
        request_id=str(uuid4()),
    )
    assert moderation.member_restrictions(
        workspace.id, members[3].id, now=expires - timedelta(seconds=1)
    ) == (False, True)
    assert moderation.member_restrictions(workspace.id, members[3].id, now=expires) == (
        False,
        False,
    )
    assert AuditEvent.objects.filter(action="workspace.member.mute").count() == 1
    moderation.moderate(
        verified=tokens[2],
        organisation_id=org.id,
        target_id=members[3].id,
        action="ban",
        reason="Example",
        expires_at=None,
        request_id=str(uuid4()),
    )
    assert moderation.member_restrictions(workspace.id, members[3].id)[0]


def test_revoked_expired_and_exhausted_invites_refuse(world):
    org, _, _, tokens = world
    link, code = moderation.create_link(
        verified=tokens[0],
        organisation_id=org.id,
        expires_at=timezone.now() + timedelta(hours=1),
        max_uses=1,
        role="org_member",
        channel_id=None,
        request_id=str(uuid4()),
    )
    WorkspaceInviteLink.objects.filter(pk=link.pk).update(revoked_at=timezone.now())
    with pytest.raises(moderation.RefusalError) as failure:
        moderation.preview_link(verified=tokens[3], code=code)
    assert failure.value.status == 404
    WorkspaceInviteLink.objects.filter(pk=link.pk).update(
        revoked_at=None, expires_at=timezone.now() - timedelta(seconds=1)
    )
    with pytest.raises(moderation.RefusalError):
        moderation.preview_link(verified=tokens[3], code=code)
    WorkspaceInviteLink.objects.filter(pk=link.pk).update(
        expires_at=timezone.now() + timedelta(hours=1), uses_count=1
    )
    with pytest.raises(moderation.RefusalError):
        moderation.preview_link(verified=tokens[3], code=code)


@pytest.mark.parametrize("max_uses,uses_count", [(0, 0), (1, -1), (1, 2)])
def test_database_refuses_invalid_invite_counters(world, max_uses, uses_count):
    _, workspace, _, _ = world
    with pytest.raises(IntegrityError), transaction.atomic():
        WorkspaceInviteLink.objects.create(
            workspace=workspace,
            code_digest=__import__("hashlib").sha256(uuid4().bytes).hexdigest(),
            expires_at=timezone.now() + timedelta(hours=1),
            max_uses=max_uses,
            uses_count=uses_count,
            role="org_member",
        )


@pytest.mark.django_db(transaction=True)
def test_concurrent_redemptions_never_exceed_capacity(world):
    import threading
    from concurrent.futures import ThreadPoolExecutor

    from django.db import close_old_connections

    org, _, _, tokens = world
    link, code = moderation.create_link(
        verified=tokens[0],
        organisation_id=org.id,
        expires_at=timezone.now() + timedelta(hours=1),
        max_uses=1,
        role="org_member",
        channel_id=None,
        request_id=str(uuid4()),
    )
    newcomers = []
    for _ in range(4):
        subject = str(uuid4())
        user = User.objects.create(email=f"{subject}@example.org")
        Identity.objects.create(
            user=user,
            organisation=org,
            issuer=org.issuer,
            realm=org.realm,
            subject=subject,
            email=user.email,
        )
        newcomers.append(
            VerifiedAccessToken(
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
        )
    barrier = threading.Barrier(len(newcomers))

    def redeem(token):
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            try:
                moderation.redeem_link(
                    verified=token, code=code, request_id=str(uuid4())
                )
                return "accepted"
            except moderation.RefusalError as error:
                return error.status
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=4) as workers:
        results = list(workers.map(redeem, newcomers))
    assert results.count("accepted") == 1
    assert results.count(404) == 3
    link.refresh_from_db()
    assert link.uses_count == 1


def test_report_queue_is_moderator_only_and_resolution_is_final(world):
    from apps.workspaces.moderation_wire import page, report_wire, tag

    org, _, members, tokens = world
    report = moderation.report(
        verified=tokens[3],
        organisation_id=org.id,
        target_id=members[2].id,
        reason="Example report",
        channel_id=None,
        event_id="",
        request_id=str(uuid4()),
    )
    with pytest.raises(moderation.RefusalError) as failure:
        page(
            verified=tokens[3],
            organisation_id=org.id,
            kind="reports",
            cursor=None,
            limit=10,
        )
    assert failure.value.status == 403
    queue = page(
        verified=tokens[2],
        organisation_id=org.id,
        kind="reports",
        cursor=None,
        limit=10,
    )
    assert [row["id"] for row in queue["data"]] == [str(report.id)]
    moderation.resolve_report(
        verified=tokens[2],
        organisation_id=org.id,
        report_id=report.id,
        status="resolved",
        resolution="Handled",
        if_match=tag(report_wire(report)),
        request_id=str(uuid4()),
    )
    with pytest.raises(moderation.RefusalError) as failure:
        moderation.resolve_report(
            verified=tokens[2],
            organisation_id=org.id,
            report_id=report.id,
            status="dismissed",
            resolution="Other decision",
            if_match="*",
            request_id=str(uuid4()),
        )
    assert failure.value.status == 409


def test_database_refuses_a_moderator_grant_from_another_organisation(world):
    _, _, members, _ = world
    slug = "other-" + uuid4().hex[:10]
    org = Organisation.objects.create(
        slug=slug,
        realm=slug,
        issuer=f"https://identity.example.org/realms/{slug}",
        name="Other example",
        state="prospect",
    )
    SlugReservation.objects.create(
        organisation=org, slug=slug, namespace="organisation", state="provisional"
    )
    workspace = Workspace.objects.create(organisation=org)
    with pytest.raises(IntegrityError), transaction.atomic():
        WorkspaceModerator.objects.create(workspace=workspace, membership=members[2])


def test_protected_target_refusal_detects_its_source_mutation(world, monkeypatch):
    import inspect

    from apps.workspaces import moderation_policy

    org, _, members, tokens = world

    def assert_boundary():
        with transaction.atomic():
            try:
                moderation.moderate(
                    verified=tokens[2],
                    organisation_id=org.id,
                    target_id=members[1].id,
                    action="ban",
                    reason="Example",
                    expires_at=None,
                    request_id=str(uuid4()),
                )
            except moderation.RefusalError as error:
                assert error.status == 403
                return
            raise AssertionError("protected target admitted")

    assert_boundary()
    source = inspect.getsource(moderation_policy.target_allowed)
    # Formatting is immaterial to the mutation; replace the complete return expression.
    lines = source.splitlines()
    returns = [
        index for index, line in enumerate(lines) if line.strip().startswith("return ")
    ]
    assert len(returns) == 1
    lines[returns[0]] = "    return True"
    namespace = {}
    exec(compile("\n".join(lines), "<protected-target-mutant>", "exec"), namespace)  # noqa: S102 - owned refusal mutation
    monkeypatch.setattr(moderation, "target_allowed", namespace["target_allowed"])
    with pytest.raises(AssertionError, match="protected target admitted"):
        assert_boundary()


def test_scoped_invite_grants_only_its_restricted_channel_and_moderator_role(world):
    from apps.workspaces.models import Channel, ResourcePolicy, ResourcePolicyRule

    org, workspace, _, tokens = world
    policy = ResourcePolicy.objects.create(workspace=workspace, visibility="restricted")
    channel = Channel.objects.create(
        workspace=workspace,
        name="Private example",
        kind="text",
        position=0,
        policy_mode="explicit",
        explicit_policy=policy,
    )
    _, code = moderation.create_link(
        verified=tokens[0],
        organisation_id=org.id,
        expires_at=timezone.now() + timedelta(hours=1),
        max_uses=1,
        role="moderator",
        channel_id=channel.id,
        request_id=str(uuid4()),
    )
    subject = str(uuid4())
    user = User.objects.create(email=f"{subject}@example.org")
    Identity.objects.create(
        user=user,
        organisation=org,
        issuer=org.issuer,
        realm=org.realm,
        subject=subject,
        email=user.email,
    )
    verified = VerifiedAccessToken(
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
    member = moderation.redeem_link(
        verified=verified, code=code, request_id=str(uuid4())
    )
    assert member.role == "org_member"
    assert WorkspaceModerator.objects.filter(
        workspace=workspace, membership_id=member.id
    ).exists()
    assert list(
        ResourcePolicyRule.objects.filter(
            membership_id=member.id, kind="allow_member"
        ).values_list("policy_id", flat=True)
    ) == [policy.id]


def test_kicked_member_can_be_readmitted_but_banned_member_cannot(world):
    org, workspace, members, tokens = world
    moderation.moderate(
        verified=tokens[2],
        organisation_id=org.id,
        target_id=members[3].id,
        action="kick",
        reason="Example",
        expires_at=None,
        request_id=str(uuid4()),
    )
    assert tokens[3].subject in moderation.projection(workspace.id)["banned_subjects"]
    Identity.objects.filter(user_id=members[3].user_id).update(enabled=False)
    assert tokens[3].subject in moderation.projection(workspace.id)["banned_subjects"]
    Identity.objects.filter(user_id=members[3].user_id).update(enabled=True)
    link, code = moderation.create_link(
        verified=tokens[0],
        organisation_id=org.id,
        expires_at=timezone.now() + timedelta(hours=1),
        max_uses=1,
        role="org_member",
        channel_id=None,
        request_id=str(uuid4()),
    )
    assert (
        moderation.redeem_link(
            verified=tokens[3], code=code, request_id=str(uuid4())
        ).id
        == members[3].id
    )
    assert moderation.member_restrictions(workspace.id, members[3].id)[0] is False
    assert (
        tokens[3].subject not in moderation.projection(workspace.id)["banned_subjects"]
    )
    link.refresh_from_db()
    assert link.uses_count == 1
    moderation.moderate(
        verified=tokens[2],
        organisation_id=org.id,
        target_id=members[3].id,
        action="ban",
        reason="Example",
        expires_at=None,
        request_id=str(uuid4()),
    )
    other, code = moderation.create_link(
        verified=tokens[0],
        organisation_id=org.id,
        expires_at=timezone.now() + timedelta(hours=1),
        max_uses=1,
        role="org_member",
        channel_id=None,
        request_id=str(uuid4()),
    )
    with pytest.raises(moderation.RefusalError) as failure:
        moderation.redeem_link(verified=tokens[3], code=code, request_id=str(uuid4()))
    assert failure.value.status == 403
    other.refresh_from_db()
    assert other.uses_count == 0


def test_existing_member_receives_scoped_role_once_and_old_link_cannot_reverse_kick(
    world,
):
    org, workspace, members, tokens = world
    link, code = moderation.create_link(
        verified=tokens[0],
        organisation_id=org.id,
        expires_at=timezone.now() + timedelta(hours=1),
        max_uses=1,
        role="moderator",
        channel_id=None,
        request_id=str(uuid4()),
    )
    for _ in range(2):
        assert (
            moderation.redeem_link(
                verified=tokens[3],
                code=code,
                request_id=str(uuid4()),
            ).id
            == members[3].id
        )
    link.refresh_from_db()
    assert link.uses_count == 1
    assert WorkspaceModerator.objects.filter(
        workspace=workspace, membership=members[3]
    ).exists()
    members[3].refresh_from_db()
    assert members[3].role == "org_member"
    moderation.moderate(
        verified=tokens[0],
        organisation_id=org.id,
        target_id=members[3].id,
        action="kick",
        reason="Example",
        expires_at=None,
        request_id=str(uuid4()),
    )
    for operation in (moderation.admit_redemption,):
        with pytest.raises(moderation.RefusalError) as failure:
            operation(verified=tokens[3], code=code)
        assert failure.value.status == 403
    with pytest.raises(moderation.RefusalError) as failure:
        moderation.redeem_link(verified=tokens[3], code=code, request_id=str(uuid4()))
    assert failure.value.status == 403
    assert moderation.member_restrictions(workspace.id, members[3].id)[0]


@pytest.mark.parametrize("invalid", ["contains\x00null", "unpaired\ud800surrogate"])
def test_unstorable_moderation_and_report_text_refuses_before_any_effect(
    world, invalid
):
    org, _, members, tokens = world
    before = AuditEvent.objects.count()
    with pytest.raises(moderation.RefusalError) as denied:
        moderation.moderate(
            verified=tokens[2],
            organisation_id=org.id,
            target_id=members[3].id,
            action="ban",
            reason=invalid,
            expires_at=None,
            request_id=str(uuid4()),
        )
    assert denied.value.status == 422
    for reason, event in [(invalid, ""), ("Example", invalid)]:
        with pytest.raises(moderation.RefusalError) as denied:
            moderation.report(
                verified=tokens[3],
                organisation_id=org.id,
                target_id=members[2].id,
                reason=reason,
                channel_id=None,
                event_id=event,
                request_id=str(uuid4()),
            )
        assert denied.value.status == 422
    assert AuditEvent.objects.count() == before
