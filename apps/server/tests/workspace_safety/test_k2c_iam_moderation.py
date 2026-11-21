# ruff: noqa: S101
"""Acceptance and mutation self-tests for T-K2c IAM, moderation, invite links, and Yjs lock order."""

from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import uuid4

import pytest
from customer_http_fixtures import configure, http_signer as http_signer, token, trust_entry
from django.db import close_old_connections, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import Client
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock

from apps.audit.models import AuditEvent
from apps.docs.models import Document, DocumentSnapshot
from apps.engine_intents.models import EngineChannelSet
from apps.identity.models import Identity, User
from apps.orgs import membership_lifecycle
from apps.orgs.models import Membership
from apps.workspaces import channel_sets, governance, iam, moderation, structure
from apps.workspaces.models import (
    Channel,
    ChannelNotice,
    ResourcePolicy,
    ResourcePolicyRule,
    WorkspaceChannelRoleOverride,
    WorkspaceInviteLink,
    WorkspaceModerator,
    WorkspaceQuota,
    WorkspaceRole,
)
from core.idempotency.models import IdempotencyRecord
from services.identity.access_tokens import VerifiedAccessToken
from workspace_safety.test_moderation import world as world

pytestmark = pytest.mark.django_db(transaction=True)


def _fresh_token(org, subject: str) -> VerifiedAccessToken:
    return VerifiedAccessToken(
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


def _make_newcomer(org):
    subject = f"newcomer-{uuid4()}"
    user = User.objects.create(email=f"{subject}@example.org")
    ident = Identity.objects.create(
        user=user,
        organisation=org,
        issuer=org.issuer,
        realm=org.realm,
        subject=subject,
        email=user.email,
    )
    return user, ident, _fresh_token(org, subject)


def test_bug_0010_docs_collab_fence_lock_order_concurrent_with_moderation_and_migration_roundtrip(
    world,
):
    """BUG-0010: `docs_collab_fence` locks `User -> Organisation -> Identity -> Membership -> Workspace`,
    eliminating `40P01` deadlocks against concurrent `moderation.moderate` (`Organisation -> Workspace`),
    and `docs/0011` cleanly reverses and reapplies."""
    org, workspace, members, tokens = world
    default_pol = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    workspace.default_policy = default_pol
    workspace.save(update_fields=["default_policy", "updated_at"])

    doc = Document.objects.create(
        workspace=workspace,
        creator=members[0],
        title="Concurrent Spec",
        title_key="concurrent spec",
        visibility="workspace",
    )
    DocumentSnapshot.objects.create(document=doc, sequence=0, head_sequence=0, state=b"\x00\x00")
    owner_identity = Identity.objects.get(user=members[0].user, organisation=org)

    barrier = threading.Barrier(2)
    deadlocks: list[Exception] = []

    def collab_loop() -> None:
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            for _ in range(50):
                with transaction.atomic(), connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT docs_collab_fence(%s,%s,%s,%s,%s,%s,'editor')",
                        [
                            doc.id,
                            org.id,
                            members[0].id,
                            owner_identity.id,
                            org.issuer,
                            owner_identity.subject,
                        ],
                    )
                    assert cursor.fetchone()[0] == workspace.id
        except Exception as err:
            deadlocks.append(err)
        finally:
            close_old_connections()

    def moderation_loop() -> None:
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            for idx in range(50):
                moderation.moderate(
                    verified=tokens[0],
                    organisation_id=org.id,
                    target_id=members[3].id,
                    action="ban" if idx % 2 == 0 else "unban",
                    reason="Concurrency check",
                    expires_at=None,
                    request_id=str(uuid4()),
                )
        except Exception as err:
            deadlocks.append(err)
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        f1 = pool.submit(collab_loop)
        f2 = pool.submit(moderation_loop)
        f1.result(timeout=30)
        f2.result(timeout=30)

    assert deadlocks == []

    # Verify docs 0011 reverse -> forward roundtrip.
    try:
        MigrationExecutor(connection).migrate([("docs", "0010_locale_free_title_keys")])
        MigrationExecutor(connection).migrate([("docs", "0011_collab_lock_order_and_iam_policy")])
    finally:
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())


def test_bug_0030_redeem_workspace_invite_persists_terminal_402_seat_quota_in_idempotency_store(
    world, http_signer, frozen_clock, settings
):
    """BUG-0030: `redeemWorkspaceInvite` uses `quota_http.respond_once`, flushing deferred
    `membership_seat_quota` triggers inside a savepoint and storing terminal `402` replay records."""
    org, workspace, _members, tokens = world
    configure(settings, [trust_entry(http_signer, org.issuer)])
    settings.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"
    settings.ROOT_URLCONF = "apps.workspaces.api.moderation_urls"
    settings.MIDDLEWARE = [
        "django.middleware.common.CommonMiddleware",
        "apps.workspaces.quota_http.QuotaRefusalMiddleware",
    ]

    # world already has 4 active members; cap seats at 4 so a newcomer triggers membership_seat_quota.
    WorkspaceQuota.objects.update_or_create(
        workspace=workspace,
        defaults={
            "seats": 4,
            "policy_ref": "POL-SEAT-4",
        },
    )
    _, code = moderation.create_link(
        verified=tokens[0],
        organisation_id=org.id,
        expires_at=timezone.now() + timedelta(hours=1),
        max_uses=5,
        role="org_member",
        channel_id=None,
        request_id=str(uuid4()),
    )
    newcomer_user, newcomer_ident, _ = _make_newcomer(org)
    newcomer_jwt = token(
        http_signer, org.issuer, subject=newcomer_ident.subject, email_verified=True
    )

    client = Client(HTTP_HOST="127.0.0.1")
    idem_key = f"redeem-seat-full-{uuid4()}"
    body = json.dumps({"code": code})
    first = client.post(
        "/api/v1/workspace-invites/redeem",
        data=body,
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {newcomer_jwt}",
        HTTP_IDEMPOTENCY_KEY=idem_key,
    )
    assert first.status_code == 402
    assert first.json()["type"] == "https://kodera.io/problems/subscription-required"
    assert not Membership.objects.filter(organisation=org, user=newcomer_user).exists()

    stored = IdempotencyRecord.objects.filter(
        issuer=org.issuer,
        subject=newcomer_ident.subject,
        path="/api/v1/workspace-invites/redeem",
    ).first()
    assert stored is not None and stored.status == 402

    # Even if seat quota is subsequently raised, replaying the same key returns the terminal 402.
    WorkspaceQuota.objects.filter(workspace=workspace).update(seats=10)
    replay = client.post(
        "/api/v1/workspace-invites/redeem",
        data=body,
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {newcomer_jwt}",
        HTTP_IDEMPOTENCY_KEY=idem_key,
    )
    assert replay.status_code == 402
    assert not Membership.objects.filter(organisation=org, user=newcomer_user).exists()
    assert replay["Idempotency-Replayed"] == "true"

    _, second_code = moderation.create_link(
        verified=tokens[0],
        organisation_id=org.id,
        expires_at=timezone.now() + timedelta(hours=1),
        max_uses=5,
        role="org_member",
        channel_id=None,
        request_id=str(uuid4()),
    )
    reused = client.post(
        "/api/v1/workspace-invites/redeem",
        data=json.dumps({"code": second_code}),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {newcomer_jwt}",
        HTTP_IDEMPOTENCY_KEY=idem_key,
    )
    assert reused.status_code == 409


def test_bug_0031_moderator_revocation_endpoint_and_lifecycle_cleanup_with_mutation_self_test(
    world, http_signer, frozen_clock, settings, monkeypatch
):
    """BUG-0031: `DELETE /organisations/{id}/workspace/moderators/{membership_id}` revokes
    `WorkspaceModerator` with audit + channel set, and suspension/demotion/removal/kick/ban clear
    moderator standing so suspend->reactivate never resurrects privileges."""
    org, workspace, members, tokens = world
    default_pol = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    workspace.default_policy = default_pol
    workspace.save(update_fields=["default_policy", "updated_at"])

    configure(settings, [trust_entry(http_signer, org.issuer)])
    settings.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"
    settings.ROOT_URLCONF = "apps.workspaces.api.moderation_urls"
    client = Client(HTTP_HOST="127.0.0.1")
    creds = [
        token(http_signer, org.issuer, subject=item.subject, email_verified=True) for item in tokens
    ]
    mod_url = f"/api/v1/organisations/{org.id}/workspace/moderators/{members[2].id}"

    assert WorkspaceModerator.objects.filter(workspace=workspace, membership=members[2]).exists()
    # Non-admin (including moderator self or ordinary member) is refused 403.
    for idx in (2, 3):
        denied = client.delete(mod_url, HTTP_AUTHORIZATION=f"Bearer {creds[idx]}")
        assert denied.status_code == 403
    assert WorkspaceModerator.objects.filter(workspace=workspace, membership=members[2]).exists()

    # Admin revokes member moderator -> 204 + audit + channel set.
    before_sets = EngineChannelSet.objects.filter(organisation_id=org.id).count()
    revoked = client.delete(mod_url, HTTP_AUTHORIZATION=f"Bearer {creds[1]}")
    assert revoked.status_code == 204
    assert not WorkspaceModerator.objects.filter(
        workspace=workspace, membership=members[2]
    ).exists()
    assert AuditEvent.objects.filter(
        organisation_id=org.id,
        action="workspace.moderator.revoked",
        target_urn=f"urn:kodera:workspace-resource:{members[2].id}",
    ).exists()
    assert EngineChannelSet.objects.filter(organisation_id=org.id).count() == before_sets + 1

    # Suspend -> reactivate clears WorkspaceModerator.
    WorkspaceModerator.objects.create(workspace=workspace, membership=members[3])
    detail, current_etag = membership_lifecycle.read_membership(
        verified=tokens[0], organisation_id=org.id, membership_id=members[3].id
    )
    _, suspended_etag = membership_lifecycle.change_membership(
        verified=tokens[0],
        organisation_id=org.id,
        membership_id=detail.membership.id,
        patch={"state": "suspended"},
        if_match=current_etag,
        request_id=str(uuid4()),
    )
    assert not WorkspaceModerator.objects.filter(
        workspace=workspace, membership=members[3]
    ).exists()
    membership_lifecycle.change_membership(
        verified=tokens[0],
        organisation_id=org.id,
        membership_id=detail.membership.id,
        patch={"state": "active"},
        if_match=suspended_etag,
        request_id=str(uuid4()),
    )
    assert not WorkspaceModerator.objects.filter(
        workspace=workspace, membership=members[3]
    ).exists()

    # Demotion org_admin -> org_member clears WorkspaceModerator too.
    WorkspaceModerator.objects.create(workspace=workspace, membership=members[1])
    _, admin_etag = membership_lifecycle.read_membership(
        verified=tokens[0], organisation_id=org.id, membership_id=members[1].id
    )
    _, demoted_etag = membership_lifecycle.change_membership(
        verified=tokens[0],
        organisation_id=org.id,
        membership_id=members[1].id,
        patch={"role": "org_member"},
        if_match=admin_etag,
        request_id=str(uuid4()),
    )
    assert not WorkspaceModerator.objects.filter(
        workspace=workspace, membership=members[1]
    ).exists()
    # Restore members[1] to org_admin.
    membership_lifecycle.change_membership(
        verified=tokens[0],
        organisation_id=org.id,
        membership_id=members[1].id,
        patch={"role": "org_admin"},
        if_match=demoted_etag,
        request_id=str(uuid4()),
    )

    # Mutation self-test: if clear_member_moderation_authority is a no-op, the assertion catches it.
    WorkspaceModerator.objects.create(workspace=workspace, membership=members[3])
    monkeypatch.setattr(moderation, "clear_member_moderation_authority", lambda **kwargs: None)
    _, etag_before = membership_lifecycle.read_membership(
        verified=tokens[0], organisation_id=org.id, membership_id=members[3].id
    )
    membership_lifecycle.change_membership(
        verified=tokens[0],
        organisation_id=org.id,
        membership_id=members[3].id,
        patch={"state": "suspended"},
        if_match=etag_before,
        request_id=str(uuid4()),
    )
    assert WorkspaceModerator.objects.filter(workspace=workspace, membership=members[3]).exists(), (
        "mutant control failed to demonstrate leaked WorkspaceModerator"
    )


def test_bug_0033_and_0034_invite_creator_standing_self_redemption_and_restricted_channel_view(
    world,
):
    """BUG-0033 & BUG-0034:
    1. Invite links verify `may_view` at creation (`404` if hidden) and at redemption (`403` if creator lost view).
    2. Demoting/kicking/removing creator revokes links AND `_verify_link_creator` refuses both newcomer and
       existing-member redemptions even when `auto_role_ids` is empty and `revoked_at` is cleared.
    3. Self-redemption on `role='moderator'` or while `kicked` is refused (`403`).
    4. Admin redeeming another admin's restricted-channel link records `ChannelNotice` + `self_grant=True`."""
    org, workspace, members, tokens = world
    default_pol = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    workspace.default_policy = default_pol
    workspace.save(update_fields=["default_policy", "updated_at"])

    secret_pol = ResourcePolicy.objects.create(workspace=workspace, visibility="restricted")
    secret_chan = Channel.objects.create(
        workspace=workspace,
        name="Boardroom",
        kind="text",
        position=0,
        lifecycle="active",
        policy_mode="explicit",
        explicit_policy=secret_pol,
    )

    # BUG-0034: Admin (`tokens[1]`) without `may_view` on `secret_chan` cannot create a link targeting it (404).
    with pytest.raises(moderation.RefusalError) as hidden_err:
        moderation.create_link(
            verified=tokens[1],
            organisation_id=org.id,
            expires_at=timezone.now() + timedelta(hours=1),
            max_uses=5,
            role="org_member",
            channel_id=secret_chan.id,
            request_id=str(uuid4()),
        )
    assert hidden_err.value.status == 404

    # Grant `members[0]` (owner) view on `secret_chan`, create link, then have `members[1]` (admin, not yet viewer) redeem it -> ChannelNotice + self_grant!
    ResourcePolicyRule.objects.create(policy=secret_pol, kind="allow_member", membership=members[0])
    owner_chan_link, owner_chan_code = moderation.create_link(
        verified=tokens[0],
        organisation_id=org.id,
        expires_at=timezone.now() + timedelta(hours=1),
        max_uses=5,
        role="org_member",
        channel_id=secret_chan.id,
        request_id=str(uuid4()),
    )
    grant_req_id = str(uuid4())
    moderation.redeem_link(verified=tokens[1], code=owner_chan_code, request_id=grant_req_id)
    assert ChannelNotice.objects.filter(
        channel=secret_chan, membership=members[1], acknowledged_at__isnull=True
    ).exists()
    audit_row = AuditEvent.objects.get(
        organisation_id=org.id,
        action="workspace.invite_link.channel_granted",
        request_id=grant_req_id,
    )
    assert audit_row.metadata == {"self_grant": True}

    # If owner loses view access on `secret_chan`, redemption by `members[3]` fails closed with 403!
    ResourcePolicyRule.objects.filter(policy=secret_pol, membership=members[0]).delete()
    for op in (
        lambda: moderation.admit_redemption(verified=tokens[3], code=owner_chan_code),
        lambda: moderation.redeem_link(
            verified=tokens[3], code=owner_chan_code, request_id=str(uuid4())
        ),
    ):
        with pytest.raises(moderation.RefusalError) as lost_view:
            op()
        assert lost_view.value.status == 403

    # BUG-0033: Admin (`tokens[1]`) creates `role='moderator'` link (`auto_role_ids=[]`).
    mod_link, mod_code = moderation.create_link(
        verified=tokens[1],
        organisation_id=org.id,
        expires_at=timezone.now() + timedelta(hours=1),
        max_uses=5,
        role="moderator",
        channel_id=None,
        request_id=str(uuid4()),
    )
    # Self-redemption of moderator link by active admin creator is refused 403.
    with pytest.raises(moderation.RefusalError) as self_mod:
        moderation.redeem_link(verified=tokens[1], code=mod_code, request_id=str(uuid4()))
    assert self_mod.value.status == 403

    # Demote `members[1]` to `org_member`: link is automatically revoked!
    _, etag_1 = membership_lifecycle.read_membership(
        verified=tokens[0], organisation_id=org.id, membership_id=members[1].id
    )
    membership_lifecycle.change_membership(
        verified=tokens[0],
        organisation_id=org.id,
        membership_id=members[1].id,
        patch={"role": "org_member"},
        if_match=etag_1,
        request_id=str(uuid4()),
    )
    mod_link.refresh_from_db()
    assert mod_link.revoked_at is not None

    # Even if `revoked_at` were cleared, creator standing check blocks existing-member, self, and newcomer redemption!
    WorkspaceInviteLink.objects.filter(pk=mod_link.pk).update(revoked_at=None)
    _, _, newcomer_tok = _make_newcomer(org)
    for tok in (tokens[1], tokens[3], newcomer_tok):
        with pytest.raises(moderation.RefusalError) as demoted_admit:
            moderation.admit_redemption(verified=tok, code=mod_code)
        assert demoted_admit.value.status == 403
        with pytest.raises(moderation.RefusalError) as demoted_redeem:
            moderation.redeem_link(verified=tok, code=mod_code, request_id=str(uuid4()))
        assert demoted_redeem.value.status == 403


def test_bug_0050_granular_iam_role_overrides_enforced_end_to_end(world):
    """BUG-0050 (`#244`): `WorkspaceMemberRole` and `WorkspaceChannelRoleOverride` are enforced
    across `structure.read_workspace`, `channel_access.{may_view,may_perform}`,
    `channel_sets.channel_set_input` (with emitted channel sets), and `docs_document_role` SQL."""
    org, workspace, members, tokens = world
    default_pol = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    workspace.default_policy = default_pol
    workspace.save(update_fields=["default_policy", "updated_at"])

    open_text = Channel.objects.create(
        workspace=workspace,
        name="General",
        kind="text",
        position=0,
        lifecycle="active",
        policy_mode="inherit",
    )
    secret_pol = ResourcePolicy.objects.create(workspace=workspace, visibility="restricted")
    secret_text = Channel.objects.create(
        workspace=workspace,
        name="Core Security",
        kind="text",
        position=1,
        lifecycle="active",
        policy_mode="explicit",
        explicit_policy=secret_pol,
    )
    audio_chan = Channel.objects.create(
        workspace=workspace,
        name="Townhall Audio",
        kind="audio",
        position=2,
        lifecycle="active",
        policy_mode="inherit",
    )
    chan_doc = Document.objects.create(
        workspace=workspace,
        channel=secret_text,
        creator=members[0],
        title="Security Runbook",
        title_key="security runbook",
        visibility="workspace",
    )
    DocumentSnapshot.objects.create(
        document=chan_doc, sequence=0, head_sequence=0, state=b"\x00\x00"
    )

    owner_args = {"verified": tokens[0], "organisation_id": org.id}
    sec_role = iam.create_role(
        **owner_args,
        data={
            "name": "Security",
            "slug": "security",
            "position": 30,
            "permissions": ["channel.view"],
        },
        request_id=str(uuid4()),
    )
    muted_role = iam.create_role(
        **owner_args,
        data={"name": "Listeners", "slug": "listeners", "position": 10, "permissions": []},
        request_id=str(uuid4()),
    )

    # Admin capabilities (`manage_roles`, `view_audit_log`) are refused on channel overrides (422).
    with pytest.raises(moderation.RefusalError) as invalid_cap:
        governance.overrides(
            **owner_args,
            channel_id=open_text.id,
            data=[{"role_id": sec_role["id"], "allow": ["manage_roles"], "deny": []}],
            request_id=str(uuid4()),
        )
    assert invalid_cap.value.status == 422

    # Initially `members[3]` cannot see `secret_text` or read `chan_doc`.
    initial_view = structure.read_workspace(verified=tokens[3], organisation_id=org.id)
    assert [c.id for c in initial_view.uncategorised_channels] == [open_text.id, audio_chan.id]
    m3_ident = Identity.objects.get(user=members[3].user, organisation=org)
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT docs_document_role(%s,%s,%s,%s,%s,%s)",
            [chan_doc.id, org.id, members[3].id, m3_ident.id, org.issuer, m3_ident.subject],
        )
        assert cursor.fetchone()[0] is None

    # Assign `sec_role` + `muted_role` to `members[3]` and configure overrides:
    # - `secret_text`: allow `channel.view` to `sec_role`, deny `message.post` to `muted_role` -> viewer!
    # - `open_text`: deny `channel.view` to `muted_role` -> hidden even though organisation-wide!
    # - `audio_chan`: deny `media.speak` to `muted_role` -> `listen_only=True`, `members[3]` excluded from `exempt`!
    sets_before = EngineChannelSet.objects.filter(organisation_id=org.id).count()
    iam.assign_roles(
        **owner_args,
        membership_id=members[3].id,
        role_ids=[sec_role["id"], muted_role["id"]],
        request_id=str(uuid4()),
    )
    sets_after_assign = EngineChannelSet.objects.filter(organisation_id=org.id).count()
    assert sets_after_assign == sets_before + 1

    governance.overrides(
        **owner_args,
        channel_id=secret_text.id,
        data=[
            {"role_id": sec_role["id"], "allow": ["channel.view"], "deny": []},
            {"role_id": muted_role["id"], "allow": [], "deny": ["message.post"]},
        ],
        request_id=str(uuid4()),
    )
    governance.overrides(
        **owner_args,
        channel_id=open_text.id,
        data=[{"role_id": muted_role["id"], "allow": [], "deny": ["channel.view"]}],
        request_id=str(uuid4()),
    )
    governance.overrides(
        **owner_args,
        channel_id=audio_chan.id,
        data=[{"role_id": muted_role["id"], "allow": [], "deny": ["media.speak"]}],
        request_id=str(uuid4()),
    )
    assert EngineChannelSet.objects.filter(organisation_id=org.id).count() == sets_after_assign + 3

    # 1. `structure.read_workspace` shows `secret_text` and `audio_chan`, hides `open_text`!
    after_view = structure.read_workspace(verified=tokens[3], organisation_id=org.id)
    assert [c.id for c in after_view.uncategorised_channels] == [secret_text.id, audio_chan.id]

    # 2. `docs_document_role` admits `members[3]` on `chan_doc` as `'viewer'` (because `message.post` is denied)!
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT docs_document_role(%s,%s,%s,%s,%s,%s)",
            [chan_doc.id, org.id, members[3].id, m3_ident.id, org.issuer, m3_ident.subject],
        )
        assert cursor.fetchone()[0] == "viewer"

    # 3. Latest `EngineChannelSet` reflects role-admitted `members`, role-denied `denied`, and `read_only`/`listen_only` `exempt`!
    latest_set = (
        EngineChannelSet.objects.filter(organisation_id=org.id).order_by("-revision").first()
    )
    assert latest_set is not None
    by_channel = {entry["channel_id"]: entry for entry in latest_set.channels}

    assert by_channel[str(open_text.id)]["audience"] == "all"
    assert m3_ident.subject in by_channel[str(open_text.id)]["denied"]

    assert by_channel[str(secret_text.id)]["audience"] == "listed"
    assert by_channel[str(secret_text.id)]["members"] == [m3_ident.subject]
    assert by_channel[str(secret_text.id)]["read_only"] is True
    assert m3_ident.subject not in by_channel[str(secret_text.id)]["exempt"]

    assert by_channel[str(audio_chan.id)]["listen_only"] is True
    assert m3_ident.subject not in by_channel[str(audio_chan.id)]["exempt"]


def test_bug_0050_unsupported_channel_overrides_refused_and_stored_media_caps_folded(world):
    """BUG-0050 Round-2: `governance.overrides()` rejects unsupported per-channel override
    capabilities with `422` (only `channel.view`/`message.post` on text and
    `channel.view`/`media.connect`/`media.speak` on audio are accepted), while any pre-existing
    stored `media.video`/`media.share`/`file.upload` denial still folds into `EngineChannelSet`
    (`listen_only`/`read_only` enabled and `exempt` excludes the denied user)."""
    org, workspace, members, tokens = world
    default_pol = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    workspace.default_policy = default_pol
    workspace.save(update_fields=["default_policy", "updated_at"])

    text_chan = Channel.objects.create(
        workspace=workspace,
        name="Announcements",
        kind="text",
        position=0,
        lifecycle="active",
        policy_mode="inherit",
    )
    audio_chan = Channel.objects.create(
        workspace=workspace,
        name="Stage Audio",
        kind="audio",
        position=1,
        lifecycle="active",
        policy_mode="inherit",
    )

    owner_args = {"verified": tokens[0], "organisation_id": org.id}
    stage_role = iam.create_role(
        **owner_args,
        data={"name": "StageGuest", "slug": "stage-guest", "position": 15, "permissions": []},
        request_id=str(uuid4()),
    )
    iam.assign_roles(
        **owner_args,
        membership_id=members[3].id,
        role_ids=[stage_role["id"]],
        request_id=str(uuid4()),
    )

    for unimplemented_text_cap in (
        "message.reply",
        "message.react",
        "message.edit_own",
        "message.delete_any",
        "file.upload",
        "media.connect",
    ):
        with pytest.raises(moderation.RefusalError) as text_err:
            governance.overrides(
                **owner_args,
                channel_id=text_chan.id,
                data=[
                    {
                        "role_id": stage_role["id"],
                        "allow": [],
                        "deny": [unimplemented_text_cap],
                    }
                ],
                request_id=str(uuid4()),
            )
        assert text_err.value.status == 422

    for unimplemented_audio_cap in (
        "media.video",
        "media.share",
        "media.moderate",
        "message.post",
    ):
        with pytest.raises(moderation.RefusalError) as audio_err:
            governance.overrides(
                **owner_args,
                channel_id=audio_chan.id,
                data=[
                    {
                        "role_id": stage_role["id"],
                        "allow": [],
                        "deny": [unimplemented_audio_cap],
                    }
                ],
                request_id=str(uuid4()),
            )
        assert audio_err.value.status == 422

    # Pre-existing stored `media.video` / `file.upload` denials in DB still fold into `EngineChannelSet`.
    role_obj = WorkspaceRole.objects.get(pk=stage_role["id"])
    WorkspaceChannelRoleOverride.objects.create(
        workspace=workspace,
        channel=audio_chan,
        role=role_obj,
        allow=[],
        deny=["media.video"],
    )
    WorkspaceChannelRoleOverride.objects.create(
        workspace=workspace,
        channel=text_chan,
        role=role_obj,
        allow=[],
        deny=["file.upload"],
    )
    m3_ident = Identity.objects.get(user=members[3].user, organisation=org)
    with transaction.atomic():
        _, raw_channels = channel_sets.channel_set_input(workspace.id)
    emitted = {entry["channel_id"]: entry for entry in raw_channels}
    assert emitted[str(audio_chan.id)]["listen_only"] is True
    assert m3_ident.subject not in emitted[str(audio_chan.id)]["exempt"]
    assert emitted[str(text_chan.id)]["read_only"] is True
    assert m3_ident.subject not in emitted[str(text_chan.id)]["exempt"]


def test_bug_0010_update_orgs_membership_vs_docs_collab_fence_nowait_no_deadlock(world):
    """BUG-0010 Round-2: When `UPDATE orgs_membership` holds a tuple lock on `orgs_membership`
    before firing its `BEFORE UPDATE` trigger (which locks `identity_user`), a concurrent
    `docs_collab_fence` holding `identity_user FOR SHARE` fails fast with `55P03`
    (`LockNotAvailable`) via `FOR SHARE NOWAIT` instead of deadlocking (`40P01`)."""
    from django.db import DatabaseError

    org, workspace, members, _ = world
    default_pol = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    workspace.default_policy = default_pol
    workspace.save(update_fields=["default_policy", "updated_at"])
    doc = Document.objects.create(
        workspace=workspace,
        creator=members[0],
        title="Nowait Lock Spec",
        title_key="nowait lock spec",
        visibility="workspace",
    )
    DocumentSnapshot.objects.create(document=doc, sequence=0, head_sequence=0, state=b"\x00\x00")
    ident = Identity.objects.get(user=members[3].user, organisation=org)

    barrier = threading.Barrier(2, timeout=10)
    b_released = threading.Event()

    def membership_updater() -> str:
        close_old_connections()
        try:
            with transaction.atomic(), connection.cursor() as cursor:
                cursor.execute("SET LOCAL lock_timeout = '5s'")
                cursor.execute(
                    "SELECT id FROM orgs_membership WHERE id = %s FOR UPDATE",
                    [members[3].id],
                )
                barrier.wait()
                # Wait briefly or block until Connection B's NOWAIT rollback releases `identity_user`.
                cursor.execute(
                    "SELECT id FROM identity_user WHERE id = %s FOR UPDATE",
                    [members[3].user_id],
                )
                cursor.execute(
                    "UPDATE orgs_membership SET updated_at = clock_timestamp() WHERE id = %s",
                    [members[3].id],
                )
                return "updated"
        finally:
            close_old_connections()

    def collab_fencer() -> str:
        close_old_connections()
        try:
            with transaction.atomic(), connection.cursor() as cursor:
                cursor.execute("SET LOCAL lock_timeout = '5s'")
                cursor.execute(
                    "SELECT id FROM identity_user WHERE id = %s FOR SHARE",
                    [members[3].user_id],
                )
                barrier.wait()
                try:
                    cursor.execute(
                        "SELECT docs_collab_fence(%s,%s,%s,%s,%s,%s,%s)",
                        [
                            doc.id,
                            org.id,
                            members[3].id,
                            ident.id,
                            org.issuer,
                            ident.subject,
                            "editor",
                        ],
                    )
                except DatabaseError as exc:
                    cause = exc.__cause__
                    pgcode = getattr(cause, "sqlstate", None) or getattr(cause, "pgcode", None)
                    return str(pgcode)
                return "unexpected_ok"
        finally:
            b_released.set()
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        fut_a = pool.submit(membership_updater)
        fut_b = pool.submit(collab_fencer)
        code_b = fut_b.result(timeout=10)
        res_a = fut_a.result(timeout=10)

    assert b_released.is_set()
    assert code_b == "55P03", f"expected immediate 55P03 LockNotAvailable, got {code_b}"
    assert res_a == "updated"
