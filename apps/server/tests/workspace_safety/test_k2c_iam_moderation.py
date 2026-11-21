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
from django.db import OperationalError, close_old_connections, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import Client
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock
from workspace_documents.test_services import native_engine as native_engine

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
                try:
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
                except OperationalError as err:
                    sqlstate = getattr(getattr(err, "__cause__", None), "sqlstate", None)
                    if sqlstate != "55P03":
                        deadlocks.append(err)
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
    # Self-redemption of moderator link by active admin creator is refused 403 with zero side effects.
    with pytest.raises(moderation.RefusalError) as self_mod:
        moderation.redeem_link(verified=tokens[1], code=mod_code, request_id=str(uuid4()))
    assert self_mod.value.status == 403
    assert not WorkspaceModerator.objects.filter(
        workspace=workspace, membership=members[1]
    ).exists()
    assert WorkspaceInviteLink.objects.get(pk=mod_link.pk).uses_count == 0

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
    m0_ident = Identity.objects.get(user=members[0].user, organisation=org)
    m1_ident = Identity.objects.get(user=members[1].user, organisation=org)
    assert m0_ident.subject in by_channel[str(audio_chan.id)]["exempt"]
    assert m1_ident.subject in by_channel[str(audio_chan.id)]["exempt"]


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
    """BUG-0010 Round-6 [Opus P2 + Codex P2-3]:
    1. Active org or account erasure advisory fences (`privacy_erasure_cutoff:<org>`,
       `privacy_account_cutoff:<person>`) make `docs_collab_fence` fail immediately with `55P03`.
    2. Routine non-erasure writes (`orgs_organisation FOR NO KEY UPDATE` + `workspaces_workspace FOR UPDATE`)
       wait under the 3s `lock_timeout` and succeed without false `55P03` disconnects.
    3. Because `docs_collab_fence` acquires both shared advisory fences BEFORE any row locks, an
       active Yjs transaction pausing between `docs_collab_fence` and `INSERT INTO docs_documentupdate`
       cannot deadlock (`40P01`) with concurrent `begin_account_erasure`."""
    import time
    from dataclasses import replace

    from django.db import DatabaseError
    from test_core_erasure import operator as make_staff_operator

    from apps.docs.models import DocumentUpdate
    from apps.orgs.account_erasure_services import begin_account_erasure
    from apps.orgs.erasure_services import database_now
    from apps.orgs.privacy_models import AccountErasure
    from core.db.ids import new_uuid7

    org, workspace, members, tokens = world
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
    fence_args = [doc.id, org.id, members[3].id, ident.id, org.issuer, ident.subject, "editor"]

    # 1. Both erasure advisory locks fail immediately with `55P03` (`LockNotAvailable`).
    for lock_key in (
        f"privacy_erasure_cutoff:{org.id}",
        f"privacy_account_cutoff:{members[3].user_id}",
    ):
        ready_ev, release_ev = threading.Event(), threading.Event()

        def hold_erasure_advisory(
            key: str = lock_key,
            ready: threading.Event = ready_ev,
            release: threading.Event = release_ev,
        ) -> None:
            close_old_connections()
            try:
                with transaction.atomic(), connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                        [key],
                    )
                    ready.set()
                    assert release.wait(timeout=5)
            finally:
                close_old_connections()

        def try_fence() -> tuple[str, float]:
            close_old_connections()
            try:
                started = time.monotonic()
                with transaction.atomic(), connection.cursor() as cursor:
                    try:
                        cursor.execute("SELECT docs_collab_fence(%s,%s,%s,%s,%s,%s,%s)", fence_args)
                    except DatabaseError as exc:
                        cause = exc.__cause__
                        pgcode = getattr(cause, "sqlstate", None) or getattr(cause, "pgcode", None)
                        return str(pgcode), time.monotonic() - started
                return "unexpected_ok", time.monotonic() - started
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            holder = pool.submit(hold_erasure_advisory)
            assert ready_ev.wait(timeout=5)
            try:
                pgcode, elapsed = pool.submit(try_fence).result(timeout=5)
            finally:
                release_ev.set()
            holder.result(timeout=5)
        assert pgcode == "55P03"
        assert elapsed < 1.0

    # 2. Routine 150ms `orgs_organisation` + `workspaces_workspace` write waits cleanly and succeeds!
    rest_ready = threading.Event()

    def routine_rest_writer() -> None:
        close_old_connections()
        try:
            with transaction.atomic(), connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id FROM orgs_organisation WHERE id = %s FOR NO KEY UPDATE",
                    [org.id],
                )
                cursor.execute(
                    "SELECT id FROM workspaces_workspace WHERE id = %s FOR UPDATE",
                    [workspace.id],
                )
                rest_ready.set()
                time.sleep(0.15)
        finally:
            close_old_connections()

    def waiting_collab_fence() -> object:
        close_old_connections()
        try:
            assert rest_ready.wait(timeout=5)
            with transaction.atomic(), connection.cursor() as cursor:
                cursor.execute("SELECT docs_collab_fence(%s,%s,%s,%s,%s,%s,%s)", fence_args)
                return cursor.fetchone()[0]
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        f_rest = pool.submit(routine_rest_writer)
        f_collab = pool.submit(waiting_collab_fence)
        assert f_collab.result(timeout=5) == workspace.id
        f_rest.result(timeout=5)

    # 3. [Codex P2-3] Active Yjs transaction holding `docs_collab_fence` before `INSERT INTO docs_documentupdate`
    #    cannot deadlock (`40P01`) with concurrent `begin_account_erasure`!
    staff_op = make_staff_operator()
    now = database_now()
    fenced_ev, release_yjs = threading.Event(), threading.Event()

    def active_yjs_writer() -> None:
        close_old_connections()
        try:
            with transaction.atomic(), connection.cursor() as cursor:
                cursor.execute("SELECT docs_collab_fence(%s,%s,%s,%s,%s,%s,%s)", fence_args)
                assert cursor.fetchone() == (workspace.id,)
                fenced_ev.set()
                assert release_yjs.wait(timeout=5)
                cursor.execute(
                    "SELECT sequence, head_sequence FROM docs_documentsnapshot"
                    " WHERE document_id = %s FOR NO KEY UPDATE",
                    [doc.id],
                )
                DocumentUpdate.objects.create(
                    id=new_uuid7(),
                    document=doc,
                    sequence=1,
                    actor=ident,
                    state=b"\x01\x02",
                )
        finally:
            close_old_connections()

    def concurrent_account_admission():
        close_old_connections()
        try:
            ver = replace(
                tokens[3],
                issuer=org.issuer,
                subject=ident.subject,
                issued_at=int(now.timestamp()),
                expires_at=int((now + timedelta(minutes=10)).timestamp()),
                auth_time=int(now.timestamp()),
            )
            return begin_account_erasure(
                verified=ver,
                confirmation="delete",
                instruction_ref="ACC-960",
                instruction_sha256="a" * 64,
                purge_not_before=database_now(),
                actor_identity_id=staff_op.id,
            ).id
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        yjs_fut = pool.submit(active_yjs_writer)
        assert fenced_ev.wait(timeout=5)
        adm_fut = pool.submit(concurrent_account_admission)
        time.sleep(0.1)
        release_yjs.set()
        yjs_fut.result(timeout=10)
        erasure_id = adm_fut.result(timeout=10)

    assert DocumentUpdate.objects.filter(document=doc, sequence=1).exists()
    assert AccountErasure.objects.get(pk=erasure_id).status == "cutoff"


def test_bug_0050_overrides_self_grant_notice_audit_and_metadata_bounds(world):
    """BUG-0050 Round-3: When an admin who cannot currently view a restricted channel grants one
    of their own roles `channel.view` via `governance.overrides()`, `ChannelNotice` is recorded
    and `workspace.channel.overrides_updated` carries `metadata={'self_grant': True}`; audit
    metadata also rejects case-folded PII keys and payloads exceeding 16 KiB."""
    from apps.audit.services import record_workspace_resource_event

    org, workspace, members, tokens = world
    default_pol = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    workspace.default_policy = default_pol
    workspace.save(update_fields=["default_policy", "updated_at"])

    vault_pol = ResourcePolicy.objects.create(workspace=workspace, visibility="restricted")
    vault_chan = Channel.objects.create(
        workspace=workspace,
        name="Executive Vault",
        kind="text",
        position=0,
        lifecycle="active",
        policy_mode="explicit",
        explicit_policy=vault_pol,
    )

    owner_args = {"verified": tokens[0], "organisation_id": org.id}
    manager_top = iam.create_role(
        **owner_args,
        data={
            "name": "VaultManager",
            "slug": "vault-manager",
            "position": 50,
            "permissions": ["manage_roles", "channel.view"],
        },
        request_id=str(uuid4()),
    )
    vault_reader = iam.create_role(
        **owner_args,
        data={
            "name": "VaultReader",
            "slug": "vault-reader",
            "position": 20,
            "permissions": ["channel.view"],
        },
        request_id=str(uuid4()),
    )
    iam.assign_roles(
        **owner_args,
        membership_id=members[1].id,
        role_ids=[manager_top["id"], vault_reader["id"]],
        request_id=str(uuid4()),
    )

    # Before override, `members[1]` (`org_admin`) is NOT in `allow_members` of `vault_chan`.
    before_view = structure.read_workspace(verified=tokens[1], organisation_id=org.id)
    assert [c.id for c in before_view.uncategorised_channels] == []

    # `members[1]` grants `channel.view` to `vault_reader` -> `self_grant=True` + `ChannelNotice`!
    self_grant_req = str(uuid4())
    governance.overrides(
        verified=tokens[1],
        organisation_id=org.id,
        channel_id=vault_chan.id,
        data=[{"role_id": vault_reader["id"], "allow": ["channel.view"], "deny": []}],
        request_id=self_grant_req,
    )
    assert ChannelNotice.objects.filter(
        channel=vault_chan, membership=members[1], acknowledged_at__isnull=True
    ).exists()
    ev = AuditEvent.objects.get(
        organisation_id=org.id,
        action="workspace.channel.overrides_updated",
        request_id=self_grant_req,
    )
    assert ev.metadata == {"self_grant": True}

    after_view = structure.read_workspace(verified=tokens[1], organisation_id=org.id)
    assert [c.id for c in after_view.uncategorised_channels] == [vault_chan.id]

    # Case-folded PII keys and >16 KiB metadata payloads are rejected by `record_workspace_resource_event`.
    m0_ident = Identity.objects.get(user=members[0].user, organisation=org)
    for bad_metadata in (
        {"Name": "MixedCaseLeak"},
        {"EMAIL": "leak@example.org"},
        {"nested": {"Topic": "secret"}},
        {"oversized": "x" * 17_000},
    ):
        with pytest.raises(ValueError):
            record_workspace_resource_event(
                action="workspace.channel.overrides_updated",
                organisation_id=org.id,
                target_id=vault_chan.id,
                actor_id=m0_ident.id,
                request_id=str(uuid4()),
                metadata=bad_metadata,
            )


def test_r5_real_postgres_yjs_concurrent_workspace_and_erasure_fence(
    world, native_engine, settings
):
    """Round-5 [Opus P1]: Two editors running concurrent `Store.update` and `Store.deliver`
    transactions on the same workspace (both same document and separate documents) against real
    PostgreSQL 16 under the restricted `collab_role` NEVER disconnect each other with `LockBusy`,
    while an active erasure lock (`orgs_organisation FOR UPDATE`) immediately raises `55P03` ->
    `LockBusy` -> WebSocket `1013 'lock-busy'`."""
    import base64
    import os
    import secrets
    import shutil
    import subprocess
    from pathlib import Path
    from urllib.parse import quote
    from uuid import UUID

    import time_machine
    from psycopg import sql

    from apps.docs import services as doc_services
    from apps.docs.collab_role import grant_statements

    org, _workspace, _members, tokens = world
    with connection.cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        real_wall_clock = cursor.fetchone()[0]

    with time_machine.travel(real_wall_clock, tick=True):
        doc1 = doc_services.create(
            verified=tokens[2],
            organisation_id=org.id,
            name="Concurrent Doc One",
            parent_id=None,
            template_key=None,
            request_id=str(uuid4()),
        )
        doc2 = doc_services.create(
            verified=tokens[2],
            organisation_id=org.id,
            name="Concurrent Doc Two",
            parent_id=None,
            template_key=None,
            request_id=str(uuid4()),
        )
        ticket_a1 = doc_services.collab_session(
            verified=tokens[2],
            organisation_id=org.id,
            document_id=UUID(doc1["id"]),
            request_id=str(uuid4()),
        )
        ticket_b1 = doc_services.collab_session(
            verified=tokens[3],
            organisation_id=org.id,
            document_id=UUID(doc1["id"]),
            request_id=str(uuid4()),
        )
        ticket_a2 = doc_services.collab_session(
            verified=tokens[2],
            organisation_id=org.id,
            document_id=UUID(doc2["id"]),
            request_id=str(uuid4()),
        )
        ticket_ws = doc_services.collab_session(
            verified=tokens[2],
            organisation_id=org.id,
            document_id=UUID(doc1["id"]),
            request_id=str(uuid4()),
        )

    collab_role = "collab_r5_" + uuid4().hex[:12]
    role_password = secrets.token_urlsafe(32)
    database = connection.settings_dict
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL(
                "CREATE ROLE {} LOGIN CONNECTION LIMIT 5 PASSWORD {}"
                " NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"
            ).format(sql.Identifier(collab_role), sql.Literal(role_password))
        )
        for stmt in grant_statements(collab_role):
            cursor.execute(stmt)
    try:
        url = (
            "postgresql://"
            + quote(database["USER"], safe="")
            + ":"
            + quote(database["PASSWORD"], safe="")
            + "@"
            + database["HOST"]
            + ":"
            + str(database["PORT"])
            + "/"
            + quote(database["NAME"], safe="")
        )
        root = Path(__file__).resolve().parents[2] / "yjs_collab"
        binary = shutil.which("node")
        assert binary is not None
        payload = json.dumps(
            {
                "role": collab_role,
                "rolePassword": role_password,
                "ticketA1": ticket_a1["token"],
                "ticketB1": ticket_b1["token"],
                "ticketA2": ticket_a2["token"],
                "ticketWs": ticket_ws["token"],
                "organisationId": str(org.id),
                "workspaceId": str(_workspace.id),
                "userId": str(_members[2].user_id),
            }
        )
        result = subprocess.run(  # noqa: S603 - fixed owned fixture and disposable test database
            [binary, str(root / "test/concurrency-fixture.mjs")],
            cwd=root,
            env={
                "PATH": os.environ["PATH"],
                "KODERA_TEST_DATABASE_URL": url,
                "KODERA_TEST_COLLAB_KEY": base64.urlsafe_b64encode(
                    settings.KODERA_COLLAB_TICKET_KEY
                ).decode(),
            },
            input=payload.encode("utf-8"),
            capture_output=True,
            timeout=60,
        )
        assert result.returncode == 0, result.stderr.decode("utf-8")
        assert json.loads(result.stdout) == {
            "concurrentWorkspaceSucceeded": True,
            "reciprocalLinksSucceeded": True,
            "restWriteWaitedWithoutDisconnect": True,
            "erasureImmediate55P03": True,
            "wsClose1013": True,
        }
        updated_doc = Document.objects.get(pk=doc1["id"])
        assert "Alpha-edit" in updated_doc.markdown
        assert "Beta-edit" in updated_doc.markdown
        assert "Survived-200ms-REST-lock" in updated_doc.markdown
    finally:
        with connection.cursor() as cursor:
            cursor.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(collab_role)))
            cursor.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(collab_role)))


def test_r5_allow_overrides_exempt_roles_on_read_only_and_listen_only_channels(world):
    """Round-5 [Opus P2-1]: Granting `allow: ['message.post']` on a `read_only=True` text channel
    lifts all 4 `READ_ONLY` capabilities across `channel_access.may_perform`, `channel_sets`, and
    SQL `docs_document_role` (`'editor'`); granting `allow: ['media.speak']` on a `listen_only=True`
    audio channel lifts all 3 `LISTEN_ONLY` capabilities; `deny` overrides still beat `allow`."""
    from apps.workspaces.channel_access import LISTEN_ONLY, READ_ONLY, may_perform, resolve

    org, workspace, members, tokens = world
    default_pol = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    workspace.default_policy = default_pol
    workspace.save(update_fields=["default_policy", "updated_at"])

    ro_pol = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    for cap in READ_ONLY:
        ResourcePolicyRule.objects.create(policy=ro_pol, kind="deny_capability", capability=cap)
    ro_text = Channel.objects.create(
        workspace=workspace,
        name="Announcements",
        kind="text",
        position=0,
        lifecycle="active",
        policy_mode="explicit",
        explicit_policy=ro_pol,
    )
    ro_doc = Document.objects.create(
        workspace=workspace,
        channel=ro_text,
        creator=members[0],
        title="Release Notes",
        title_key="release notes",
        visibility="workspace",
    )
    DocumentSnapshot.objects.create(document=ro_doc, sequence=0, head_sequence=0, state=b"\x00\x00")

    lo_pol = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    for cap in LISTEN_ONLY:
        ResourcePolicyRule.objects.create(policy=lo_pol, kind="deny_capability", capability=cap)
    lo_audio = Channel.objects.create(
        workspace=workspace,
        name="Stage Audio",
        kind="audio",
        position=1,
        lifecycle="active",
        policy_mode="explicit",
        explicit_policy=lo_pol,
    )

    owner_args = {"verified": tokens[0], "organisation_id": org.id}
    speaker_role = iam.create_role(
        **owner_args,
        data={"name": "Speakers", "slug": "speakers", "position": 20, "permissions": []},
        request_id=str(uuid4()),
    )
    muted_role = iam.create_role(
        **owner_args,
        data={"name": "Muted", "slug": "muted-override", "position": 10, "permissions": []},
        request_id=str(uuid4()),
    )
    iam.assign_roles(
        **owner_args,
        membership_id=members[3].id,
        role_ids=[speaker_role["id"]],
        request_id=str(uuid4()),
    )
    m3_ident = Identity.objects.get(user=members[3].user, organisation=org)

    def sql_doc_role() -> str | None:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT public.docs_document_role(%s, %s, %s, %s, %s, %s)",
                [
                    ro_doc.id,
                    org.id,
                    members[3].id,
                    m3_ident.id,
                    m3_ident.issuer,
                    m3_ident.subject,
                ],
            )
            return cursor.fetchone()[0]

    # 1. Baseline before overrides: `members[3]` is denied all READ_ONLY & LISTEN_ONLY capabilities,
    #    absent from `exempt_members`, and `'viewer'` on `ro_doc`.
    org.refresh_from_db()
    ro_access = resolve(ro_text.id)
    lo_access = resolve(lo_audio.id)
    assert ro_access.read_only is True
    assert lo_access.listen_only is True
    for cap in READ_ONLY:
        assert (
            may_perform(
                ro_access,
                action=cap,
                organisation_id=org.id,
                membership_id=members[3].id,
                member_org_role=members[3].role,
                authority_revision=org.authority_revision,
            )
            is False
        )
    for cap in LISTEN_ONLY:
        assert (
            may_perform(
                lo_access,
                action=cap,
                organisation_id=org.id,
                membership_id=members[3].id,
                member_org_role=members[3].role,
                authority_revision=org.authority_revision,
            )
            is False
        )
    assert sql_doc_role() == "viewer"
    with transaction.atomic():
        _, baseline_channels = channel_sets.channel_set_input(workspace.id)
    by_cid = {entry["channel_id"]: entry for entry in baseline_channels}
    assert m3_ident.subject not in by_cid[str(ro_text.id)]["exempt"]
    assert m3_ident.subject not in by_cid[str(lo_audio.id)]["exempt"]

    # 2. Grant `allow: ["message.post"]` on `ro_text` and `allow: ["media.speak"]` on `lo_audio`:
    #    `members[3]` is now exempted across ALL 4 READ_ONLY and ALL 3 LISTEN_ONLY capabilities,
    #    present in `exempt` on both channels, and `'editor'` in `docs_document_role`!
    governance.overrides(
        **owner_args,
        channel_id=ro_text.id,
        data=[{"role_id": speaker_role["id"], "allow": ["message.post"], "deny": []}],
        request_id=str(uuid4()),
    )
    governance.overrides(
        **owner_args,
        channel_id=lo_audio.id,
        data=[{"role_id": speaker_role["id"], "allow": ["media.speak"], "deny": []}],
        request_id=str(uuid4()),
    )
    ro_access = resolve(ro_text.id)
    lo_access = resolve(lo_audio.id)
    for cap in READ_ONLY:
        assert (
            may_perform(
                ro_access,
                action=cap,
                organisation_id=org.id,
                membership_id=members[3].id,
                member_org_role=members[3].role,
                authority_revision=org.authority_revision,
            )
            is True
        )
    for cap in LISTEN_ONLY:
        assert (
            may_perform(
                lo_access,
                action=cap,
                organisation_id=org.id,
                membership_id=members[3].id,
                member_org_role=members[3].role,
                authority_revision=org.authority_revision,
            )
            is True
        )
    assert sql_doc_role() == "editor"
    latest_set = (
        EngineChannelSet.objects.filter(organisation_id=org.id).order_by("-revision").first()
    )
    assert latest_set is not None
    emitted_by_cid = {entry["channel_id"]: entry for entry in latest_set.channels}
    assert emitted_by_cid[str(ro_text.id)]["read_only"] is True
    assert m3_ident.subject in emitted_by_cid[str(ro_text.id)]["exempt"]
    assert emitted_by_cid[str(lo_audio.id)]["listen_only"] is True
    assert m3_ident.subject in emitted_by_cid[str(lo_audio.id)]["exempt"]

    # 3. Assign second role `muted_role` with `deny: ["message.post"]` / `deny: ["media.speak"]`:
    #    `deny` strictly beats `allow` across all companion capabilities and SQL `docs_document_role`.
    iam.assign_roles(
        **owner_args,
        membership_id=members[3].id,
        role_ids=[speaker_role["id"], muted_role["id"]],
        request_id=str(uuid4()),
    )
    governance.overrides(
        **owner_args,
        channel_id=ro_text.id,
        data=[
            {"role_id": speaker_role["id"], "allow": ["message.post"], "deny": []},
            {"role_id": muted_role["id"], "allow": [], "deny": ["message.post"]},
        ],
        request_id=str(uuid4()),
    )
    governance.overrides(
        **owner_args,
        channel_id=lo_audio.id,
        data=[
            {"role_id": speaker_role["id"], "allow": ["media.speak"], "deny": []},
            {"role_id": muted_role["id"], "allow": [], "deny": ["media.speak"]},
        ],
        request_id=str(uuid4()),
    )
    ro_access = resolve(ro_text.id)
    lo_access = resolve(lo_audio.id)
    for cap in READ_ONLY:
        assert (
            may_perform(
                ro_access,
                action=cap,
                organisation_id=org.id,
                membership_id=members[3].id,
                member_org_role=members[3].role,
                authority_revision=org.authority_revision,
            )
            is False
        )
    for cap in LISTEN_ONLY:
        assert (
            may_perform(
                lo_access,
                action=cap,
                organisation_id=org.id,
                membership_id=members[3].id,
                member_org_role=members[3].role,
                authority_revision=org.authority_revision,
            )
            is False
        )
    assert sql_doc_role() == "viewer"
    latest_set = (
        EngineChannelSet.objects.filter(organisation_id=org.id).order_by("-revision").first()
    )
    assert latest_set is not None
    emitted_by_cid = {entry["channel_id"]: entry for entry in latest_set.channels}
    assert m3_ident.subject not in emitted_by_cid[str(ro_text.id)]["exempt"]
    assert m3_ident.subject not in emitted_by_cid[str(lo_audio.id)]["exempt"]


def test_r5_iam_channel_set_failure_aborts_write_and_returns_503(
    world, http_signer, settings, monkeypatch
):
    """Round-5 [Opus P2-2]: On a provisioned workspace (`default_policy_id` set), a failing
    `channel_sets.emit_for` (`WorkspaceUnavailableError` or `ChannelSetError`) is NEVER swallowed
    by `emit_iam_channel_set`: it rolls back the IAM/override mutation and audit event, and the
    HTTP boundary returns `503 service-unavailable` with `Retry-After: 1`."""
    from uuid import UUID

    from apps.engine_intents.channel_sets import ChannelSetError
    from apps.workspaces.models import WorkspaceMemberRole
    from apps.workspaces.structure import WorkspaceUnavailableError

    org, workspace, members, tokens = world
    default_pol = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    workspace.default_policy = default_pol
    workspace.save(update_fields=["default_policy", "updated_at"])
    chan = Channel.objects.create(
        workspace=workspace,
        name="General",
        kind="text",
        position=0,
        lifecycle="active",
        policy_mode="inherit",
    )

    owner_args = {"verified": tokens[0], "organisation_id": org.id}
    role = iam.create_role(
        **owner_args,
        data={"name": "Contractors", "slug": "contractors", "position": 15, "permissions": []},
        request_id=str(uuid4()),
    )
    role_uuid = UUID(role["id"])

    def fail_unavailable(**_kwargs):
        raise WorkspaceUnavailableError()

    monkeypatch.setattr(channel_sets, "emit_for", fail_unavailable)

    # 1. Service-level fail-closed rollback across all 4 IAM/override write paths:
    override_req = str(uuid4())
    with pytest.raises(WorkspaceUnavailableError):
        governance.overrides(
            **owner_args,
            channel_id=chan.id,
            data=[{"role_id": role["id"], "allow": [], "deny": ["channel.view"]}],
            request_id=override_req,
        )
    assert not WorkspaceChannelRoleOverride.objects.filter(channel=chan).exists()
    assert not AuditEvent.objects.filter(request_id=override_req).exists()

    assign_req = str(uuid4())
    with pytest.raises(WorkspaceUnavailableError):
        iam.assign_roles(
            **owner_args,
            membership_id=members[3].id,
            role_ids=[role["id"]],
            request_id=assign_req,
        )
    assert not WorkspaceMemberRole.objects.filter(membership=members[3]).exists()
    assert not AuditEvent.objects.filter(request_id=assign_req).exists()

    update_req = str(uuid4())
    with pytest.raises(WorkspaceUnavailableError):
        iam.update_role(
            **owner_args,
            role_id=role_uuid,
            data={"name": "RenamedWhileUnavailable"},
            if_match="*",
            request_id=update_req,
        )
    assert WorkspaceRole.objects.get(pk=role_uuid).name == "Contractors"
    assert not AuditEvent.objects.filter(request_id=update_req).exists()

    delete_req = str(uuid4())
    with pytest.raises(WorkspaceUnavailableError):
        iam.delete_role(**owner_args, role_id=role_uuid, request_id=delete_req)
    assert WorkspaceRole.objects.filter(pk=role_uuid).exists()
    assert not AuditEvent.objects.filter(request_id=delete_req).exists()

    # 2. HTTP boundary translates both `WorkspaceUnavailableError` and `ChannelSetError` into 503
    #    `service-unavailable` with `Retry-After` and zero committed DB changes!
    configure(settings, [trust_entry(http_signer, org.issuer)])
    settings.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"
    settings.ROOT_URLCONF = "apps.workspaces.api.moderation_urls"
    bearer = token(http_signer, org.issuer, subject=tokens[0].subject, email_verified=True)
    client = Client(HTTP_HOST="127.0.0.1")

    for exc_cls in (WorkspaceUnavailableError, ChannelSetError):
        monkeypatch.setattr(
            channel_sets,
            "emit_for",
            lambda _cls=exc_cls, **_kw: (_ for _ in ()).throw(_cls("engine unavailable")),
        )
        http_req_id = f"req-r5-{uuid4().hex[:12]}"
        resp = client.put(
            f"/api/v1/organisations/{org.id}/workspace/channels/{chan.id}/overrides",
            data=json.dumps(
                {"overrides": [{"role_id": role["id"], "allow": [], "deny": ["channel.view"]}]}
            ),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {bearer}",
            HTTP_X_REQUEST_ID=http_req_id,
        )
        assert resp.status_code == 503
        assert resp["Retry-After"] == "1"
        body = json.loads(resp.content)
        assert body["type"] == "https://kodera.io/problems/service-unavailable"
        assert not WorkspaceChannelRoleOverride.objects.filter(channel=chan).exists()
        assert not AuditEvent.objects.filter(request_id=http_req_id).exists()


def test_r6_delegated_role_manager_cannot_bypass_expanded_override_ceiling(
    world, http_signer, settings
):
    """Round-6 [Codex P2-1]: Because `message.post` channel overrides expand into all 4 `READ_ONLY`
    capabilities and `media.speak` expands into all 3 `LISTEN_ONLY` capabilities, a non-admin
    delegated `manage_roles` caller lacking any companion capability (`file.upload` or `media.video`)
    is refused (`403`) on `governance.overrides`, `iam.assign_roles`, and `iam.delete_role`."""
    from uuid import UUID

    org, workspace, members, tokens = world
    default_pol = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    workspace.default_policy = default_pol
    workspace.save(update_fields=["default_policy", "updated_at"])

    text_chan = Channel.objects.create(
        workspace=workspace,
        name="TextCeiling",
        kind="text",
        position=0,
        lifecycle="active",
        policy_mode="inherit",
    )
    audio_chan = Channel.objects.create(
        workspace=workspace,
        name="AudioCeiling",
        kind="audio",
        position=1,
        lifecycle="active",
        policy_mode="inherit",
    )

    owner_args = {"verified": tokens[0], "organisation_id": org.id}
    delegate_role = iam.create_role(
        **owner_args,
        data={
            "name": "PartialDelegate",
            "slug": "partial-delegate",
            "position": 40,
            "permissions": [
                "manage_roles",
                "channel.view",
                "message.post",
                "message.reply",
                "message.edit_own",
                "media.connect",
                "media.speak",
                "media.share",
            ],
        },
        request_id=str(uuid4()),
    )
    target_role = iam.create_role(
        **owner_args,
        data={"name": "SubTeam", "slug": "sub-team", "position": 10, "permissions": []},
        request_id=str(uuid4()),
    )
    iam.assign_roles(
        **owner_args,
        membership_id=members[2].id,
        role_ids=[delegate_role["id"]],
        request_id=str(uuid4()),
    )

    delegate_args = {"verified": tokens[2], "organisation_id": org.id}

    # 1. Delegate CAN set `allow: ["channel.view"]`, but CANNOT set `allow` or `deny` for
    #    `message.post` (missing `file.upload`) or `media.speak` (missing `media.video`)!
    governance.overrides(
        **delegate_args,
        channel_id=text_chan.id,
        data=[{"role_id": target_role["id"], "allow": ["channel.view"], "deny": []}],
        request_id=str(uuid4()),
    )
    for chan_obj, cap in ((text_chan, "message.post"), (audio_chan, "media.speak")):
        for payload_row in (
            {"role_id": target_role["id"], "allow": [cap], "deny": []},
            {"role_id": target_role["id"], "allow": [], "deny": [cap]},
        ):
            with pytest.raises(moderation.RefusalError) as err:
                governance.overrides(
                    **delegate_args,
                    channel_id=chan_obj.id,
                    data=[payload_row],
                    request_id=str(uuid4()),
                )
            assert err.value.status == 403

    # HTTP PUT check -> 403 forbidden!
    configure(settings, [trust_entry(http_signer, org.issuer)])
    settings.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"
    settings.ROOT_URLCONF = "apps.workspaces.api.moderation_urls"
    delegate_bearer = token(http_signer, org.issuer, subject=tokens[2].subject, email_verified=True)
    client = Client(HTTP_HOST="127.0.0.1")
    http_resp = client.put(
        f"/api/v1/organisations/{org.id}/workspace/channels/{text_chan.id}/overrides",
        data=json.dumps(
            {"overrides": [{"role_id": target_role["id"], "allow": ["message.post"], "deny": []}]}
        ),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {delegate_bearer}",
    )
    assert http_resp.status_code == 403

    # 2. When `org_owner` configures `allow: ["message.post"]` on `target_role`, partial delegate
    #    is ALSO blocked from clearing that override, assigning `target_role`, or deleting `target_role`!
    governance.overrides(
        **owner_args,
        channel_id=text_chan.id,
        data=[{"role_id": target_role["id"], "allow": ["message.post"], "deny": []}],
        request_id=str(uuid4()),
    )
    with pytest.raises(moderation.RefusalError) as clear_err:
        governance.overrides(
            **delegate_args,
            channel_id=text_chan.id,
            data=[],
            request_id=str(uuid4()),
        )
    assert clear_err.value.status == 403

    with pytest.raises(moderation.RefusalError) as assign_err:
        iam.assign_roles(
            **delegate_args,
            membership_id=members[3].id,
            role_ids=[target_role["id"]],
            request_id=str(uuid4()),
        )
    assert assign_err.value.status == 403

    with pytest.raises(moderation.RefusalError) as delete_err:
        iam.delete_role(**delegate_args, role_id=UUID(target_role["id"]), request_id=str(uuid4()))
    assert delete_err.value.status == 403

    # 3. Granting the missing companion capabilities (`file.upload` + `media.video`) to `delegate_role`
    #    allows the delegate to manage both `message.post` and `media.speak` overrides!
    iam.update_role(
        **owner_args,
        role_id=UUID(delegate_role["id"]),
        data={
            "permissions": [
                "manage_roles",
                "channel.view",
                "message.post",
                "message.reply",
                "message.edit_own",
                "file.upload",
                "media.connect",
                "media.speak",
                "media.share",
                "media.video",
            ]
        },
        if_match="*",
        request_id=str(uuid4()),
    )
    governance.overrides(
        **delegate_args,
        channel_id=text_chan.id,
        data=[{"role_id": target_role["id"], "allow": ["message.post"], "deny": []}],
        request_id=str(uuid4()),
    )
    governance.overrides(
        **delegate_args,
        channel_id=audio_chan.id,
        data=[{"role_id": target_role["id"], "allow": ["media.speak"], "deny": []}],
        request_id=str(uuid4()),
    )
