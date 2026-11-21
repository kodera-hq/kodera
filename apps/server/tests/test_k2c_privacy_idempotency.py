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
            upload_expires_at=now + timedelta(minutes=10),
            completed_at=now,
        )
        b2b_att = Attachment.objects.create(
            organisation=org,
            uploader=members[3],
            filename="alice-roe-contract.pdf",
            content_type="application/pdf",
            size_bytes=8192,
            sha256="2" * 64,
            upload_expires_at=now + timedelta(minutes=10),
            completed_at=now,
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
