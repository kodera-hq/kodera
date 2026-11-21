# ruff: noqa: S101
"""Acceptance and mutation self-tests for T-K2c GDPR Art. 17/20 privacy erasure & idempotency store."""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from datetime import timedelta

import pytest
from django.db import IntegrityError, connection, transaction
from django.utils import timezone
from test_account_erasure import admit as admit_account
from test_core_erasure import operator
from workspace_safety.test_moderation import world as world

from apps.docs.models import Collection
from apps.identity.models import Identity
from apps.media.models import Attachment
from apps.media.storage import StorageRefusedError
from apps.orgs.account_erasure_services import (
    AccountAbsenceProof,
    AccountErasureScope,
    advance_account_erasure,
)
from apps.orgs.erasure_services import (
    AbsenceProof,
    ErasureScope,
    advance_erasure,
    begin_erasure,
    database_now,
)
from apps.orgs.models import Invitation, Membership, Organisation, SlugReservation
from apps.orgs.object_erasure import ObjectWorkspaceErasureAdapter
from apps.orgs.privacy_archives import Request as ExportRequest
from apps.orgs.privacy_core_sources import CoreSources
from apps.orgs.privacy_storage import PrivateVolume
from apps.outbox import sender
from apps.outbox.passport_erasure import PassportAccountOutboxErasureAdapter
from apps.workspaces.models import ResourcePolicy, Workspace, WorkspaceMemberRestriction
from core.db.ids import new_uuid7
from core.idempotency import store
from core.idempotency.models import IdempotencyRecord

pytestmark = pytest.mark.django_db(transaction=True)


class _OrgDomainStub:
    revision = "k2c-org-stub-v1"

    def __init__(self, domain: str) -> None:
        self.domain = domain

    def erase_and_verify(self, scope: ErasureScope) -> AbsenceProof:
        digest = hashlib.sha256(f"{self.domain}:{scope.request_id}".encode()).hexdigest()
        return AbsenceProof(
            request_id=scope.request_id,
            organisation_id=scope.organisation_id,
            cutoff_at=scope.cutoff_at,
            domain=self.domain,
            inventory_sha256=scope.inventory_sha256,
            evidence_sha256=digest,
            adapter_revision=self.revision,
            verified_at=database_now(),
        )

    def verify_proof(self, scope: ErasureScope, proof: AbsenceProof) -> bool:
        return True


class _AccountDomainStub:
    revision = "k2c-account-stub-v1"

    def __init__(self, domain: str) -> None:
        self.domain = domain

    def erase_and_verify(self, scope: AccountErasureScope) -> AccountAbsenceProof:
        digest = hashlib.sha256(f"{self.domain}:{scope.request_id}".encode()).hexdigest()
        return AccountAbsenceProof(
            request_id=scope.request_id,
            user_id=scope.user_id,
            cutoff_at=scope.cutoff_at,
            domain=self.domain,
            inventory_sha256=scope.inventory_sha256,
            evidence_sha256=digest,
            adapter_revision=self.revision,
            verified_at=database_now(),
        )

    def verify_proof(self, scope: AccountErasureScope, proof: AccountAbsenceProof) -> bool:
        return True


def test_bug_0064_webhook_idempotency_retention_outlives_24h_http_window():
    """BUG-0064: `webhook_scope` (`urn:kodera:webhook:*`) retains signature/event deduplication
    past the 24-hour HTTP window up to 30 days in both `lookup` and `purge_batch`."""
    http_scope = store.Scope(
        issuer="https://identity.customer.test/realms/alpha",
        subject="sub-http",
        method="POST",
        path="/api/v1/organisations",
        key="http-idempotency-key-1234",
    )
    hook_scope = store.webhook_scope(
        provider="github",
        subject="installation-42",
        path="/webhooks/github",
        delivery_key="sha256-deadbeef-1234567890",
    )
    body_sha = "a" * 64
    for candidate in (http_scope, hook_scope):
        outcome = store.run_once(
            scope=candidate,
            body_sha256=body_sha,
            handler=lambda: store.StoredResponse(
                status=200, body=b'{"ok":true}', content_type="application/json"
            ),
        )
        assert isinstance(outcome, store.Executed) and outcome.stored

    # Age both records to 5 days ago (> 24h HTTP TTL, < 30d webhook TTL).
    five_days_ago = timezone.now() - timedelta(days=5)
    IdempotencyRecord.objects.filter(issuer__in=[http_scope.issuer, hook_scope.issuer]).update(
        created_at=five_days_ago
    )

    http_found = store.lookup(http_scope)
    hook_found = store.lookup(hook_scope)
    assert http_found is not None and http_found.expired is True
    assert hook_found is not None and hook_found.expired is False

    purged = store.purge_expired()
    assert purged.deleted >= 1
    assert not IdempotencyRecord.objects.filter(issuer=http_scope.issuer).exists()
    assert IdempotencyRecord.objects.filter(issuer=hook_scope.issuer).exists()

    # Age webhook record to 31 days ago (> 30d webhook TTL) -> purged cleanly.
    IdempotencyRecord.objects.filter(issuer=hook_scope.issuer).update(
        created_at=timezone.now() - timedelta(days=31)
    )
    hook_expired = store.lookup(hook_scope)
    assert hook_expired is not None and hook_expired.expired is True
    assert store.purge_expired().deleted >= 1
    assert not IdempotencyRecord.objects.filter(issuer=hook_scope.issuer).exists()


def test_bug_0011_0025_0027_0037_account_and_org_erasure_completeness(world, settings, tmp_path):
    """Covers BUG-0011 (non-accepted invitations), BUG-0025 (`ObjectWorkspaceErasureAdapter` +
    Community/B2B account attachments + fail-closed `privacy_complete_account_erasure` when S3
    deletion fails), BUG-0027 (`orgs_invitationoutboxbinding` + send-time withdrawal + outbox
    certification), and BUG-0037 (`idempotency_record` purge + completion check)."""
    org, workspace, members, tokens = world
    staff_op = operator()
    settings.KODERA_OUTBOX_SEAL_KEY = hashlib.sha256(b"k2c-outbox-seal-key").digest()
    settings.KODERA_CONTACT_SEAL_KEY = hashlib.sha256(b"k2c-contact-seal-key").digest()
    settings.KODERA_MAIL_LINK_ORIGINS = frozenset({"https://app.localhost"})
    settings.KODERA_INVITATION_LINK = "https://app.localhost/invite"

    # Provision a default Community organisation + workspace where `members[3].user` also uploads a file.
    with transaction.atomic():
        community_org = Organisation.objects.create(
            slug="community",
            realm="community",
            issuer="https://identity.customer.test/realms/community",
            name="Community",
            state="active",
            is_default_community=True,
        )
        SlugReservation.objects.create(
            organisation=community_org,
            namespace="organisation",
            slug=community_org.slug,
            state="permanent",
            protected_at=timezone.now(),
        )
        Membership.objects.create(
            user=members[0].user,
            organisation=community_org,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
        Identity.objects.create(
            user=members[0].user,
            organisation=community_org,
            issuer=community_org.issuer,
            realm=community_org.realm,
            subject=f"comm-owner-{members[0].user_id}",
            email=members[0].user.email,
        )
        comm_member = Membership.objects.create(
            user=members[3].user,
            organisation=community_org,
            role="org_member",
            state="active",
            accepted_at=timezone.now(),
        )
        Identity.objects.create(
            user=members[3].user,
            organisation=community_org,
            issuer=community_org.issuer,
            realm=community_org.realm,
            subject=f"comm-{members[3].user_id}",
            email=members[3].user.email,
        )
        comm_ws = Workspace.objects.create(organisation=community_org)
        comm_pol = ResourcePolicy.objects.create(workspace=comm_ws, visibility="organisation")
        comm_ws.default_policy = comm_pol
        comm_ws.save(update_fields=["default_policy"])

        # Sibling B2B org with a non-accepted (`pending` + `expired`) invitation and queued invitation mail for `members[3].user.email`!
        sibling_org = Organisation.objects.create(
            slug="sibling-org-k2c",
            realm="sibling-org-k2c",
            issuer="https://identity.customer.test/realms/sibling-org-k2c",
            name="Sibling B2B",
            state="active",
        )
        SlugReservation.objects.create(
            organisation=sibling_org,
            namespace="organisation",
            slug=sibling_org.slug,
            state="permanent",
            protected_at=timezone.now(),
        )
        sib_owner = Membership.objects.create(
            user=members[0].user,
            organisation=sibling_org,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
        sib_owner_ident = Identity.objects.create(
            user=members[0].user,
            organisation=sibling_org,
            issuer=sibling_org.issuer,
            realm=sibling_org.realm,
            subject=f"sib-owner-{members[0].user_id}",
            email=members[0].user.email,
        )
        now = database_now()
        expired_inv = Invitation.objects.create(
            organisation=sibling_org,
            email=members[3].user.email,
            display_name="Target Expired Name",
            role="org_member",
            state="expired",
            locale="fr",
            token_digest=b"\x11" * 32,
            token_sealed=b"\x22" * 48,
            issued_at=now - timedelta(days=10),
            expires_at=now - timedelta(days=3),
            invited_by_user=members[0].user,
            invited_by_identity=sib_owner_ident,
        )
        pending_inv = Invitation.objects.create(
            organisation=sibling_org,
            email=members[3].user.email,
            display_name="Target Pending Name",
            role="org_member",
            state="pending",
            locale="fr",
            token_digest=b"\x33" * 32,
            token_sealed=b"\x44" * 48,
            issued_at=now,
            expires_at=now + timedelta(days=7),
            sent_count=1,
            mail_enqueued_count=1,
            invited_by_user=members[0].user,
            invited_by_identity=sib_owner_ident,
        )
        inv_delivery_id = sender.enqueue_message(
            organisation_id=sibling_org.id,
            template_id="invitation",
            locale="fr",
            recipient=members[3].user.email,
            link=f"https://app.localhost/invite/{sibling_org.id}/{sibling_org.slug}",
            link_secret="secret-invitation-token-1234567890",
            params={
                "organisation_name": sibling_org.name,
                "role": "membre",
                "expires_at": "soon",
            },
            expires_at=now + timedelta(days=5),
        )

        # Community attachment (must be deleted from S3 + DB!) and B2B attachment (retained by controller, PII filename scrubbed!).
        comm_att = Attachment.objects.create(
            organisation=community_org,
            uploader=comm_member,
            filename="personal-passport-scan.pdf",
            content_type="application/pdf",
            size_bytes=4096,
            sha256="1" * 64,
            upload_expires_at=now - timedelta(minutes=5),
            completed_at=now - timedelta(minutes=6),
        )
        b2b_att = Attachment.objects.create(
            organisation=org,
            uploader=members[3],
            filename="alice-roe-contract.pdf",
            content_type="application/pdf",
            size_bytes=8192,
            sha256="2" * 64,
            upload_expires_at=now - timedelta(minutes=5),
            completed_at=now - timedelta(minutes=6),
        )

    # BUG-0037: Record an IdempotencyRecord for `members[3]` carrying PII in its response body.
    m3_ident = Identity.objects.get(user=members[3].user, organisation=org)
    store.run_once(
        scope=store.Scope(
            issuer=org.issuer,
            subject=m3_ident.subject,
            method="POST",
            path="/api/v1/organisations/profile",
            key="m3-personal-action-key-0001",
        ),
        body_sha256="b" * 64,
        handler=lambda: store.StoredResponse(
            status=200,
            body=json.dumps({"email": members[3].user.email}).encode()
            if False
            else f'{{"email":"{members[3].user.email}"}}'.encode(),
            content_type="application/json",
        ),
    )
    assert IdempotencyRecord.objects.filter(issuer=org.issuer, subject=m3_ident.subject).exists()

    # Begin account erasure for `members[3]`.
    erasure = admit_account(
        world,
        verified=replace(tokens[3], auth_time=int(database_now().timestamp())),
        actor_identity_id=staff_op.id,
        purge_not_before=database_now(),
    )
    assert str(inv_delivery_id) in erasure.inventory["invitation_delivery_ids"]

    # BUG-0027: Outbox `claim_next` / `withdrawn` refuses to send any invitation addressed to erased person,
    # and post-cutoff invitation writes to that email are refused (`23514`).
    assert sender.withdrawn("invitation", inv_delivery_id) is True
    with pytest.raises(IntegrityError), transaction.atomic():
        Invitation.objects.create(
            organisation=sibling_org,
            email=f"user-{members[3].user_id}@invalid.test"
            if False
            else Identity.objects.get(pk=m3_ident.pk).email,
            role="org_member",
            state="pending",
            locale="fr",
            token_digest=b"\x55" * 32,
            token_sealed=b"\x66" * 48,
            issued_at=now,
            expires_at=now + timedelta(days=7),
            invited_by_user=sib_owner.user,
            invited_by_identity=sib_owner_ident,
        )

    all_account_adapters = {
        domain: (
            PassportAccountOutboxErasureAdapter()
            if domain == "account_message_outbox"
            else _AccountDomainStub(domain)
        )
        for domain in erasure.inventory["required_domains"]
    }

    # BUG-0025 FAIL-CLOSED PROOF: When S3 deletion raises StorageRefusedError,
    # `advance_account_erasure` & `privacy_complete_account_erasure` MUST refuse completion!
    def failing_deleter(_key: str):
        raise StorageRefusedError()

    held_progress = advance_account_erasure(
        erasure.id,
        all_account_adapters,
        object_deleter=failing_deleter,
    )
    assert held_progress["complete"] is False
    assert "account_personal_objects" in held_progress["held_domains"]
    assert Attachment.objects.filter(pk=comm_att.pk).exists()
    erasure.refresh_from_db()
    assert erasure.status == "core_purged"

    # Verify BUG-0011, BUG-0037, BUG-0027, and B2B filename scrub already ran during core purge:
    assert not IdempotencyRecord.objects.filter(
        issuer=org.issuer, subject=m3_ident.subject
    ).exists()
    assert held_progress["counts"]["idempotency_records"] >= 1
    assert held_progress["counts"]["invitation_contacts"] == 2
    assert held_progress["counts"]["b2b_attachments_scrubbed"] == 1
    for inv in (expired_inv, pending_inv):
        inv.refresh_from_db()
        assert inv.email == f"erased+{inv.id}@invalid.test"
        assert inv.display_name is None
        assert bytes(inv.token_digest) == b""
        assert bytes(inv.token_sealed) == b""
        assert inv.state in {"revoked", "expired"}
    b2b_att.refresh_from_db()
    assert b2b_att.filename == f"erased-{b2b_att.id}.bin"

    # Direct SQL call to `privacy_complete_account_erasure` ALSO returns False while S3 deletion is unverified!
    with connection.cursor() as cursor:
        cursor.execute("SELECT privacy_complete_account_erasure(%s)", [erasure.id])
        assert cursor.fetchone()[0] is False

    # Now S3 `delete_object` (`DELETE` + `HEAD 404`) succeeds -> Community attachment row deleted & completion certified!
    deleted_keys: list[str] = []

    def working_deleter(key: str):
        deleted_keys.append(key)
        return {"deleted": True}

    completed = advance_account_erasure(
        erasure.id,
        all_account_adapters,
        object_deleter=working_deleter,
    )
    assert completed["complete"] is True
    assert deleted_keys == [f"organisations/{community_org.id}/attachments/{comm_att.id}"]
    assert not Attachment.objects.filter(pk=comm_att.pk).exists()
    assert Attachment.objects.filter(pk=b2b_att.pk).exists()

    # Now test Organisation Erasure with concrete `ObjectWorkspaceErasureAdapter` (`BUG-0025` & `BUG-0037` org half)!
    owner_ident = Identity.objects.get(user=members[0].user, organisation=org)
    store.run_once(
        scope=store.Scope(
            issuer=org.issuer,
            subject=owner_ident.subject,
            method="POST",
            path="/api/v1/organisations/settings",
            key="org-owner-action-key-0001",
        ),
        body_sha256="c" * 64,
        handler=lambda: store.StoredResponse(
            status=200, body=b'{"saved":true}', content_type="application/json"
        ),
    )
    org_erasure = begin_erasure(
        organisation_id=org.id,
        instruction_ref="DEL-901",
        instruction_sha256="9" * 64,
        purge_not_before=database_now(),
        actor_identity_id=staff_op.id,
    )
    assert str(b2b_att.id) in org_erasure.inventory["attachments"]

    # Failing gateway deleter blocks `ObjectWorkspaceErasureAdapter` fail-closed.
    org_object_adapter_bad = ObjectWorkspaceErasureAdapter(deleter=failing_deleter)
    with pytest.raises(StorageRefusedError):
        advance_erasure(
            org_erasure.id,
            {
                d: org_object_adapter_bad if d == "objects" else _OrgDomainStub(d)
                for d in org_erasure.inventory["required_domains"]
            },
        )

    org_deleted_keys: list[str] = []
    org_done = advance_erasure(
        org_erasure.id,
        {
            d: (
                ObjectWorkspaceErasureAdapter(
                    deleter=lambda k: org_deleted_keys.append(k) or {"deleted": True}
                )
                if d == "objects"
                else _OrgDomainStub(d)
            )
            for d in org_erasure.inventory["required_domains"]
        },
    )
    assert org_done["complete"] is True
    assert f"organisations/{org.id}/attachments/{b2b_att.id}" in org_deleted_keys
    assert not IdempotencyRecord.objects.filter(issuer=org.issuer).exists()


def test_bug_0026_collection_portability_export_enforces_workspace_restrictions_and_identity(
    world, tmp_path
):
    """BUG-0026: GDPR Art. 20 account portability export excludes Docs Collections in workspaces
    where the user is `kicked` or `banned` or whose per-organisation `Identity` is disabled,
    both during `capture` and during post-capture `permitted` disclosure checks."""
    org, workspace, members, tokens = world

    # Second org where `members[3].user` holds an active identity to authenticate the account export request.
    with transaction.atomic():
        home_org = Organisation.objects.create(
            slug="home-export-k2c",
            realm="home-export-k2c",
            issuer="https://identity.customer.test/realms/home-export-k2c",
            name="Home",
            state="active",
        )
        SlugReservation.objects.create(
            organisation=home_org,
            namespace="organisation",
            slug=home_org.slug,
            state="permanent",
            protected_at=timezone.now(),
        )
        Membership.objects.create(
            user=members[3].user,
            organisation=home_org,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
        home_ident = Identity.objects.create(
            user=members[3].user,
            organisation=home_org,
            issuer=home_org.issuer,
            realm=home_org.realm,
            subject=f"home-{members[3].user_id}",
            email=members[3].user.email,
        )

    created_col = Collection.objects.create(
        workspace=workspace,
        creator=members[3],
        title="Member Roadmap",
    )
    col_id = str(created_col.id)

    now_epoch = int(timezone.now().timestamp())
    req = ExportRequest(
        id=str(new_uuid7()),
        scope="account",
        user_id=str(members[3].user_id),
        identity_id=str(home_ident.id),
        organisation_id=None,
        include_media=False,
        created_at=now_epoch,
        expires_at=now_epoch + 86400,
    )
    export_dir = tmp_path / "exports"
    export_dir.mkdir(mode=0o700)
    sources = CoreSources(PrivateVolume(export_dir))

    # Baseline: unrestricted active member captures and permits their collection.
    assert [e.resource for e in sources.capture("collections", req)] == [f"collection:{col_id}"]
    assert sources.permitted(req, f"collection:{col_id}") is True

    # Kicked -> denied on both `capture` and post-capture `permitted`!
    restriction, _ = WorkspaceMemberRestriction.objects.update_or_create(
        workspace=workspace, membership=members[3], defaults={"kicked": True, "banned": False}
    )
    assert sources.capture("collections", req) == ()
    assert sources.permitted(req, f"collection:{col_id}") is False

    # Banned -> denied on both `capture` and `permitted`!
    WorkspaceMemberRestriction.objects.filter(pk=restriction.pk).update(kicked=False, banned=True)
    assert sources.capture("collections", req) == ()
    assert sources.permitted(req, f"collection:{col_id}") is False

    # Unbanned, but per-org Identity disabled -> denied on both `capture` and `permitted`!
    WorkspaceMemberRestriction.objects.filter(pk=restriction.pk).update(banned=False)
    Identity.objects.filter(user=members[3].user, organisation=org).update(enabled=False)
    assert sources.capture("collections", req) == ()
    assert sources.permitted(req, f"collection:{col_id}") is False


def test_bug_0025_presigned_upload_window_fence_and_replay_erasure(world, settings):
    """BUG-0025 Round-3: Both Community account erasure and B2B organisation erasure evaluate
    `upload_expires_at + UPLOAD_DRAIN_GRACE` (60s) *before* issuing S3 `DELETE -> HEAD 404`:
    zero S3 deletes are issued while the presigned PUT or 60s drain window is open, a late PUT
    finishing right after presigned expiry cannot be certified, and the post-drain pass wipes
    the late PUT and completes erasure."""
    import time

    from apps.orgs.object_erasure import UPLOAD_DRAIN_GRACE

    org, _workspace, members, tokens = world
    staff_op = operator()
    settings.KODERA_OUTBOX_SEAL_KEY = hashlib.sha256(b"k2c-r2-seal-key").digest()

    with transaction.atomic():
        community_org = Organisation.objects.create(
            slug="community",
            realm="community",
            issuer="https://identity.customer.test/realms/community",
            name="Community",
            state="active",
            is_default_community=True,
        )
        SlugReservation.objects.create(
            organisation=community_org,
            namespace="organisation",
            slug=community_org.slug,
            state="permanent",
            protected_at=timezone.now(),
        )
        Membership.objects.create(
            user=members[0].user,
            organisation=community_org,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
        Identity.objects.create(
            user=members[0].user,
            organisation=community_org,
            issuer=community_org.issuer,
            realm=community_org.realm,
            subject=f"comm-r2-owner-{members[0].user_id}",
            email=members[0].user.email,
        )
        comm_member = Membership.objects.create(
            user=members[3].user,
            organisation=community_org,
            role="org_member",
            state="active",
            accepted_at=timezone.now(),
        )
        Identity.objects.create(
            user=members[3].user,
            organisation=community_org,
            issuer=community_org.issuer,
            realm=community_org.realm,
            subject=f"comm-r2-{members[3].user_id}",
            email=members[3].user.email,
        )
        comm_ws = Workspace.objects.create(organisation=community_org)
        comm_pol = ResourcePolicy.objects.create(workspace=comm_ws, visibility="organisation")
        comm_ws.default_policy = comm_pol
        comm_ws.save(update_fields=["default_policy"])

        # Presigned URL expired ~58.8s ago, so `upload_expires_at + 60s` drain grace is STILL OPEN (~1.2s left)!
        window_end = database_now() - UPLOAD_DRAIN_GRACE + timedelta(milliseconds=1200)
        drain_deadline = window_end + UPLOAD_DRAIN_GRACE
        comm_att = Attachment.objects.create(
            organisation=community_org,
            uploader=comm_member,
            filename="unexpired-put-ticket.pdf",
            content_type="application/pdf",
            size_bytes=2048,
            sha256="a" * 64,
            upload_expires_at=window_end,
            completed_at=None,
        )

    comm_key = f"organisations/{community_org.id}/attachments/{comm_att.id}"
    s3_objects: dict[str, bytes] = {comm_key: b"initial-personal-upload"}
    comm_deletes: list[str] = []

    def simulated_s3_delete(key: str) -> dict[str, object]:
        comm_deletes.append(key)
        s3_objects.pop(key, None)
        return {"deleted": True}

    erasure = admit_account(
        world,
        verified=replace(tokens[3], auth_time=int(database_now().timestamp())),
        actor_identity_id=staff_op.id,
        purge_not_before=database_now(),
    )
    account_adapters = {
        domain: (
            PassportAccountOutboxErasureAdapter()
            if domain == "account_message_outbox"
            else _AccountDomainStub(domain)
        )
        for domain in erasure.inventory["required_domains"]
    }

    # Pass 1 while 60s S3 PUT drain grace is STILL OPEN: checks fence BEFORE deleting -> ZERO S3 deletes!
    first_pass = advance_account_erasure(
        erasure.id,
        account_adapters,
        object_deleter=simulated_s3_delete,
    )
    assert first_pass["complete"] is False
    assert "account_personal_objects" in first_pass["held_domains"]
    assert comm_deletes == []
    assert comm_key in s3_objects

    # Direct SQL `privacy_confirm_account_attachments_erased` also refuses during the 60s drain grace!
    with pytest.raises(IntegrityError), transaction.atomic(), connection.cursor() as cursor:
        cursor.execute(
            "SELECT public.privacy_confirm_account_attachments_erased(%s, %s)",
            [erasure.id, "f" * 64],
        )

    # Simulate a slow PUT that started right before `upload_expires_at` completing during the drain window!
    s3_objects[comm_key] = b"late-put-started-before-expiry"

    # Wait until PostgreSQL `clock_timestamp()` passes `upload_expires_at + 60s`, then run pass 2!
    while database_now() <= drain_deadline:
        time.sleep(0.05)

    second_pass = advance_account_erasure(
        erasure.id,
        account_adapters,
        object_deleter=simulated_s3_delete,
    )
    assert second_pass["complete"] is True
    assert second_pass["held_domains"] == []
    assert comm_deletes == [comm_key]
    assert comm_key not in s3_objects
    assert not Attachment.objects.filter(pk=comm_att.pk).exists()

    # Now verify the same pre-delete fence on B2B organisation erasure (`ObjectWorkspaceErasureAdapter`).
    org_window_end = database_now() - UPLOAD_DRAIN_GRACE + timedelta(milliseconds=1200)
    org_drain_deadline = org_window_end + UPLOAD_DRAIN_GRACE
    b2b_att = Attachment.objects.create(
        organisation=org,
        uploader=members[0],
        filename="org-unexpired-put.pdf",
        content_type="application/pdf",
        size_bytes=4096,
        sha256="b" * 64,
        upload_expires_at=org_window_end,
        completed_at=None,
    )
    b2b_key = f"organisations/{org.id}/attachments/{b2b_att.id}"
    s3_objects[b2b_key] = b"initial-org-upload"
    org_deletes: list[str] = []

    def simulated_org_s3_delete(key: str) -> dict[str, object]:
        org_deletes.append(key)
        s3_objects.pop(key, None)
        return {"deleted": True}

    org_erasure = begin_erasure(
        organisation_id=org.id,
        instruction_ref="DEL-902",
        instruction_sha256="4" * 64,
        purge_not_before=database_now(),
        actor_identity_id=staff_op.id,
    )
    org_adapters = {
        d: (
            ObjectWorkspaceErasureAdapter(deleter=simulated_org_s3_delete)
            if d == "objects"
            else _OrgDomainStub(d)
        )
        for d in org_erasure.inventory["required_domains"]
    }
    org_first = advance_erasure(org_erasure.id, org_adapters)
    assert org_first["complete"] is False
    assert "objects" in org_first["held_domains"]
    assert org_deletes == []

    # Simulate late PUT completing before `org_drain_deadline`.
    s3_objects[b2b_key] = b"late-org-put-during-drain"
    while database_now() <= org_drain_deadline:
        time.sleep(0.05)

    org_second = advance_erasure(org_erasure.id, org_adapters)
    assert org_second["complete"] is True
    assert org_second["held_domains"] == []
    assert org_deletes == [b2b_key, b2b_key]  # `erase_and_verify` + `verify_proof`
    assert b2b_key not in s3_objects


def test_bug_0037_inflight_idempotency_receipt_blocked_across_erasure_cutoff(world, settings):
    """BUG-0037 Round-2: An in-flight `store.run_once` POST that passed entry authority before
    account erasure cannot persist an `idempotency_record` receipt after cutoff/completion:
    `aa_idempotency_privacy_cutoff` rejects the insert and `store.run_once` rolls back cleanly
    with `403` (`stored=False`), leaving zero PII receipts."""
    import threading
    from concurrent.futures import ThreadPoolExecutor

    from django.db import close_old_connections

    org, workspace, members, tokens = world
    staff_op = operator()
    settings.KODERA_OUTBOX_SEAL_KEY = hashlib.sha256(b"k2c-idem-cutoff-seal").digest()
    m3_ident = Identity.objects.get(user=members[3].user, organisation=org)
    original_subject = m3_ident.subject
    original_email = members[3].user.email

    entered_handler = threading.Event()
    erasure_completed = threading.Event()
    rolled_back_title = f"InFlightRollbackProbe-{new_uuid7()}"

    def inflight_post() -> store.Outcome:
        close_old_connections()
        try:

            def paused_handler() -> store.StoredResponse:
                Collection.objects.create(
                    workspace=workspace,
                    creator=members[0],
                    title=rolled_back_title,
                )
                entered_handler.set()
                assert erasure_completed.wait(timeout=10)
                return store.StoredResponse(
                    status=200,
                    body=json.dumps({"email": original_email}).encode("utf-8"),
                    content_type="application/json",
                )

            return store.run_once(
                scope=store.Scope(
                    issuer=org.issuer,
                    subject=original_subject,
                    method="POST",
                    path="/api/v1/organisations/profile",
                    key="inflight-post-across-cutoff-0001",
                ),
                body_sha256="c" * 64,
                handler=paused_handler,
            )
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(inflight_post)
        assert entered_handler.wait(timeout=10)

        erasure = admit_account(
            world,
            verified=replace(tokens[3], auth_time=int(database_now().timestamp())),
            actor_identity_id=staff_op.id,
            purge_not_before=database_now(),
        )
        done = advance_account_erasure(
            erasure.id,
            {
                d: (
                    PassportAccountOutboxErasureAdapter()
                    if d == "account_message_outbox"
                    else _AccountDomainStub(d)
                )
                for d in erasure.inventory["required_domains"]
            },
        )
        assert done["complete"] is True
        erasure_completed.set()

        outcome = future.result(timeout=10)

    assert isinstance(outcome, store.Executed)
    assert outcome.stored is False
    assert outcome.response.status == 403
    assert not Collection.objects.filter(title=rolled_back_title).exists()
    assert not IdempotencyRecord.objects.filter(
        issuer=org.issuer, subject=original_subject
    ).exists()

    # Direct `IdempotencyRecord.objects.create` is also blocked by `aa_idempotency_privacy_cutoff`!
    with pytest.raises(IntegrityError), transaction.atomic():
        IdempotencyRecord.objects.create(
            issuer=org.issuer,
            subject=original_subject,
            method="POST",
            path="/api/v1/organisations/profile",
            key_sha256="d" * 64,
            body_sha256="e" * 64,
            status=200,
            content_type="application/json",
            body=b"{}",
        )

    # Begin org erasure and verify both org issuer AND webhook (`urn:kodera:webhook:*`) inserts are blocked!
    begin_erasure(
        organisation_id=org.id,
        instruction_ref="DEL-903",
        instruction_sha256="5" * 64,
        purge_not_before=database_now(),
        actor_identity_id=staff_op.id,
    )
    for blocked_issuer, blocked_subject in (
        (org.issuer, f"post-cutoff-{new_uuid7()}"),
        ("urn:kodera:webhook:stripe", str(org.id)),
    ):
        with pytest.raises(IntegrityError), transaction.atomic():
            IdempotencyRecord.objects.create(
                issuer=blocked_issuer,
                subject=blocked_subject,
                method="POST",
                path="/api/v1/webhooks/stripe",
                key_sha256="1" * 64,
                body_sha256="2" * 64,
                status=200,
                content_type="application/json",
                body=b"{}",
            )


def test_bug_0027_upgrade_backfill_sends_valid_queued_invitation_and_withdraws_revoked(
    transactional_db, settings
):
    """BUG-0027 Round-2: Upgrading across `orgs/0034` backfills `orgs_invitationoutboxbinding`
    for pre-existing queued `invitation` and `invitation_account_ready` outbox messages (and
    lazily resolves any unbound rows via `resolve_legacy_invitation_binding`), so valid
    pre-upgrade invitations still send while revoked ones are withdrawn."""
    from django.db.migrations.executor import MigrationExecutor

    from apps.identity.models import User
    from apps.orgs.invitations import format_token

    settings.KODERA_OUTBOX_SEAL_KEY = hashlib.sha256(b"k2c-upgrade-seal-key").digest()
    settings.KODERA_MAIL_LINK_ORIGINS = frozenset({"https://app.localhost"})

    def restore_leaves() -> None:
        exec_up = MigrationExecutor(connection)
        exec_up.migrate(exec_up.loader.graph.leaf_nodes())

    try:
        executor = MigrationExecutor(connection)
        pre_targets = [
            ("orgs", "0033_proximity_erasure_inventory")
            if app == "orgs"
            else ("idempotency", "0001_initial")
            if app == "idempotency"
            else (app, name)
            for app, name in executor.loader.graph.leaf_nodes()
        ]
        executor.migrate(pre_targets)

        with connection.cursor() as cursor:
            cursor.execute("SELECT to_regclass('public.orgs_invitationoutboxbinding') IS NULL")
            assert cursor.fetchone()[0] is True

        with transaction.atomic():
            upg_org = Organisation.objects.create(
                slug="upgrade-inv-k2c",
                realm="upgrade-inv-k2c",
                issuer="https://identity.customer.test/realms/upgrade-inv-k2c",
                name="Upgrade Org",
                state="active",
            )
            SlugReservation.objects.create(
                organisation=upg_org,
                namespace="organisation",
                slug=upg_org.slug,
                state="permanent",
                protected_at=timezone.now(),
            )
            inviter_user = User.objects.create(email="inviter-upgrade@example.org")
            Membership.objects.create(
                user=inviter_user,
                organisation=upg_org,
                role="org_owner",
                state="active",
                accepted_at=timezone.now(),
            )
            inviter_ident = Identity.objects.create(
                user=inviter_user,
                organisation=upg_org,
                issuer=upg_org.issuer,
                realm=upg_org.realm,
                subject="inviter-upgrade-sub",
                email=inviter_user.email,
            )
            now = database_now()
            valid_inv = Invitation.objects.create(
                organisation=upg_org,
                email="valid-preupgrade@example.org",
                role="org_member",
                state="pending",
                locale="fr",
                token_digest=b"\xaa" * 32,
                token_sealed=b"\xbb" * 48,
                issued_at=now,
                expires_at=now + timedelta(days=5),
                sent_count=1,
                mail_enqueued_count=1,
                invited_by_user=inviter_user,
                invited_by_identity=inviter_ident,
            )
            revoked_inv = Invitation.objects.create(
                organisation=upg_org,
                email="revoked-preupgrade@example.org",
                role="org_member",
                state="revoked",
                revoked_at=now,
                locale="fr",
                token_digest=b"\xcc" * 32,
                token_sealed=b"\xdd" * 48,
                issued_at=now - timedelta(hours=1),
                expires_at=now + timedelta(days=5),
                sent_count=1,
                mail_enqueued_count=1,
                invited_by_user=inviter_user,
                invited_by_identity=inviter_ident,
            )
            valid_delivery_id = sender.enqueue_message(
                organisation_id=upg_org.id,
                template_id="invitation",
                locale="fr",
                recipient=valid_inv.email,
                link=f"https://app.localhost/invite/{upg_org.id}/{upg_org.slug}",
                link_secret=format_token(valid_inv.id, "A" * 43),
                params={
                    "organisation_name": upg_org.name,
                    "role": "membre",
                    "expires_at": "soon",
                },
                expires_at=now + timedelta(days=4),
            )
            revoked_delivery_id = sender.enqueue_message(
                organisation_id=upg_org.id,
                template_id="invitation_account_ready",
                locale="fr",
                recipient=revoked_inv.email,
                link=f"https://app.localhost/invite/{upg_org.id}/{upg_org.slug}",
                link_secret=format_token(revoked_inv.id, "B" * 43),
                params={
                    "organisation_name": upg_org.name,
                    "role": "membre",
                    "expires_at": "soon",
                },
                expires_at=now + timedelta(days=4),
            )

        # Upgrade forward across `orgs/0034` and `idempotency/0002`!
        restore_leaves()

        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT invitation_id FROM orgs_invitationoutboxbinding WHERE delivery_id = %s",
                [valid_delivery_id],
            )
            assert cursor.fetchone() == (valid_inv.id,)
            cursor.execute(
                "SELECT invitation_id FROM orgs_invitationoutboxbinding WHERE delivery_id = %s",
                [revoked_delivery_id],
            )
            assert cursor.fetchone() == (revoked_inv.id,)

        # Valid pre-upgrade queued invitation is NOT withdrawn (sends!), revoked one IS withdrawn!
        assert sender.withdrawn("invitation", valid_delivery_id) is False
        assert sender.withdrawn("invitation_account_ready", revoked_delivery_id) is True

        # Also prove lazy `resolve_legacy_invitation_binding` if `migrate` ran without seal key:
        with connection.cursor() as cursor:
            cursor.execute(
                "DELETE FROM orgs_invitationoutboxbinding WHERE delivery_id IN (%s, %s)",
                [valid_delivery_id, revoked_delivery_id],
            )
        assert sender.withdrawn("invitation", valid_delivery_id) is False
        assert sender.withdrawn("invitation_account_ready", revoked_delivery_id) is True
    finally:
        restore_leaves()


def test_bug_0025_retention_worker_role_executes_account_attachment_erasure(world):
    """BUG-0025 Round-2: A dedicated least-privilege `kodera_retention_worker_*` database login
    can execute `privacy_confirm_account_attachments_erased` and read `orgs_accountattachmenterasure`
    to complete account erasure without direct table privileges on `media_attachment`."""
    import psycopg
    from test_erasure_review_guards import restricted_login

    _org, _workspace, members, tokens = world
    staff_op = operator()
    now = database_now()

    with transaction.atomic():
        community_org = Organisation.objects.create(
            slug="community",
            realm="community",
            issuer="https://identity.customer.test/realms/community",
            name="Community",
            state="active",
            is_default_community=True,
        )
        SlugReservation.objects.create(
            organisation=community_org,
            namespace="organisation",
            slug=community_org.slug,
            state="permanent",
            protected_at=timezone.now(),
        )
        Membership.objects.create(
            user=members[0].user,
            organisation=community_org,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
        Identity.objects.create(
            user=members[0].user,
            organisation=community_org,
            issuer=community_org.issuer,
            realm=community_org.realm,
            subject=f"comm-worker-owner-{members[0].user_id}",
            email=members[0].user.email,
        )
        comm_member = Membership.objects.create(
            user=members[3].user,
            organisation=community_org,
            role="org_member",
            state="active",
            accepted_at=timezone.now(),
        )
        Identity.objects.create(
            user=members[3].user,
            organisation=community_org,
            issuer=community_org.issuer,
            realm=community_org.realm,
            subject=f"comm-worker-role-{members[3].user_id}",
            email=members[3].user.email,
        )
        comm_ws = Workspace.objects.create(organisation=community_org)
        comm_pol = ResourcePolicy.objects.create(workspace=comm_ws, visibility="organisation")
        comm_ws.default_policy = comm_pol
        comm_ws.save(update_fields=["default_policy"])
        comm_att = Attachment.objects.create(
            organisation=community_org,
            uploader=comm_member,
            filename="worker-role-personal.pdf",
            content_type="application/pdf",
            size_bytes=1024,
            sha256="9" * 64,
            upload_expires_at=now - timedelta(minutes=5),
            completed_at=now - timedelta(minutes=6),
        )

    row = admit_account(
        world,
        verified=replace(tokens[3], auth_time=int(database_now().timestamp())),
        actor_identity_id=staff_op.id,
        purge_not_before=database_now(),
    )

    with restricted_login("worker") as (role_name, connect):
        with connect() as login:
            assert login.execute("SELECT current_user, session_user").fetchone() == (
                role_name,
                role_name,
            )
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                login.execute("SELECT filename FROM public.media_attachment")

            login.execute("SELECT privacy_purge_account_core(%s)", [row.id])
            for domain in row.inventory["required_domains"]:
                login.execute(
                    "SELECT privacy_record_account_absence(%s,%s,%s,%s,%s,%s,%s,clock_timestamp())",
                    [
                        row.id,
                        row.user_reference,
                        row.cutoff_at,
                        row.inventory_sha256,
                        domain,
                        "8" * 64,
                        "synthetic-worker-role-control",
                    ],
                )
            # Still incomplete before `privacy_confirm_account_attachments_erased`!
            assert (
                login.execute("SELECT privacy_complete_account_erasure(%s)", [row.id]).fetchone()[0]
                is False
            )

            deleted_count = login.execute(
                "SELECT privacy_confirm_account_attachments_erased(%s, %s)",
                [row.id, "7" * 64],
            ).fetchone()[0]
            assert deleted_count == 1
            assert login.execute(
                "SELECT evidence_sha256 FROM orgs_accountattachmenterasure WHERE erasure_id = %s",
                [row.id],
            ).fetchone() == ("7" * 64,)
            assert (
                login.execute("SELECT privacy_complete_account_erasure(%s)", [row.id]).fetchone()[0]
                is True
            )

    assert not Attachment.objects.filter(pk=comm_att.pk).exists()


def test_bug_0025_default_unix_socket_delete_rpc_without_injected_deleter(world, settings):
    """BUG-0025 Round-3: Default production deletion path (`deleter=None`) contacts the private
    `AF_UNIX` media worker socket (`POST /rpc` `{"operation": "delete", ...}`), failing closed on
    worker refusal and completing both account and organisation erasures on `{"deleted": true}`."""
    import http.server
    import os
    import socketserver
    import tempfile
    import threading

    org, _workspace, members, tokens = world
    staff_op = operator()
    settings.KODERA_OUTBOX_SEAL_KEY = hashlib.sha256(b"k2c-sock-seal-key").digest()
    now = database_now()

    with transaction.atomic():
        community_org = Organisation.objects.create(
            slug="community",
            realm="community",
            issuer="https://identity.customer.test/realms/community",
            name="Community",
            state="active",
            is_default_community=True,
        )
        SlugReservation.objects.create(
            organisation=community_org,
            namespace="organisation",
            slug=community_org.slug,
            state="permanent",
            protected_at=timezone.now(),
        )
        Membership.objects.create(
            user=members[0].user,
            organisation=community_org,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
        Identity.objects.create(
            user=members[0].user,
            organisation=community_org,
            issuer=community_org.issuer,
            realm=community_org.realm,
            subject=f"comm-sock-owner-{members[0].user_id}",
            email=members[0].user.email,
        )
        comm_member = Membership.objects.create(
            user=members[3].user,
            organisation=community_org,
            role="org_member",
            state="active",
            accepted_at=timezone.now(),
        )
        Identity.objects.create(
            user=members[3].user,
            organisation=community_org,
            issuer=community_org.issuer,
            realm=community_org.realm,
            subject=f"comm-sock-{members[3].user_id}",
            email=members[3].user.email,
        )
        comm_ws = Workspace.objects.create(organisation=community_org)
        comm_pol = ResourcePolicy.objects.create(workspace=comm_ws, visibility="organisation")
        comm_ws.default_policy = comm_pol
        comm_ws.save(update_fields=["default_policy"])
        comm_att = Attachment.objects.create(
            organisation=community_org,
            uploader=comm_member,
            filename="unix-socket-personal.pdf",
            content_type="application/pdf",
            size_bytes=2048,
            sha256="6" * 64,
            upload_expires_at=now - timedelta(minutes=5),
            completed_at=now - timedelta(minutes=6),
        )
        b2b_att = Attachment.objects.create(
            organisation=org,
            uploader=members[0],
            filename="unix-socket-org.pdf",
            content_type="application/pdf",
            size_bytes=4096,
            sha256="7" * 64,
            upload_expires_at=now - timedelta(minutes=5),
            completed_at=now - timedelta(minutes=6),
        )

    rpc_calls: list[dict[str, object]] = []
    worker_state = {"fail": True}

    class _UnixRpcHandler(http.server.BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            rpc_calls.append(payload)
            if self.path != "/rpc" or worker_state["fail"]:
                self.send_response(502)
                self.end_headers()
                self.wfile.write(b'{"error":"s3_unreachable"}')
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"deleted":true}')

        def log_message(self, _fmt: str, *_args: object) -> None:
            return

    sock_dir = tempfile.mkdtemp(prefix="k2c-", dir="/tmp")  # noqa: S108 - macOS AF_UNIX 104-byte path limit
    sock_path = os.path.join(sock_dir, "gw.sock")
    server = socketserver.UnixStreamServer(sock_path, _UnixRpcHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        settings.KODERA_MEDIA_GATEWAY_SOCKET = sock_path
        erasure = admit_account(
            world,
            verified=replace(tokens[3], auth_time=int(database_now().timestamp())),
            actor_identity_id=staff_op.id,
            purge_not_before=database_now(),
        )
        account_adapters = {
            d: (
                PassportAccountOutboxErasureAdapter()
                if d == "account_message_outbox"
                else _AccountDomainStub(d)
            )
            for d in erasure.inventory["required_domains"]
        }

        # Worker returns 502 -> default socket path fails closed (`complete=False`, held)!
        held_res = advance_account_erasure(erasure.id, account_adapters)
        assert held_res["complete"] is False
        assert "account_personal_objects" in held_res["held_domains"]

        # Worker returns `200 {"deleted": true}` -> default socket path (`deleter=None`) completes!
        worker_state["fail"] = False
        ok_res = advance_account_erasure(erasure.id, account_adapters)
        assert ok_res["complete"] is True
        assert ok_res["held_domains"] == []
        assert {
            "operation": "delete",
            "object": {
                "organisationId": str(community_org.id),
                "attachmentId": str(comm_att.id),
            },
        } in rpc_calls

        # Default socket path (`ObjectWorkspaceErasureAdapter()` with `deleter=None`) on org erasure!
        org_erasure = begin_erasure(
            organisation_id=org.id,
            instruction_ref="DEL-904",
            instruction_sha256="6" * 64,
            purge_not_before=database_now(),
            actor_identity_id=staff_op.id,
        )
        org_res = advance_erasure(
            org_erasure.id,
            {
                d: (ObjectWorkspaceErasureAdapter() if d == "objects" else _OrgDomainStub(d))
                for d in org_erasure.inventory["required_domains"]
            },
        )
        assert org_res["complete"] is True
        assert {
            "operation": "delete",
            "object": {
                "organisationId": str(org.id),
                "attachmentId": str(b2b_att.id),
            },
        } in rpc_calls
    finally:
        server.shutdown()
        server.server_close()
        if os.path.exists(sock_path):
            os.unlink(sock_path)
        if os.path.exists(sock_dir):
            os.rmdir(sock_dir)
