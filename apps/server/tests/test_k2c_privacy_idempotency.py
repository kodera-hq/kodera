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
from apps.orgs.object_erasure import (
    BoundedStreamUploadDrainVerifier,
    ObjectWorkspaceErasureAdapter,
)
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
    qualified_drain = BoundedStreamUploadDrainVerifier(
        max_stream_duration=timedelta(seconds=60),
        has_in_flight_uploads=lambda _keys: False,
    )

    def failing_deleter(_key: str):
        raise StorageRefusedError()

    held_progress = advance_account_erasure(
        erasure.id,
        all_account_adapters,
        object_deleter=failing_deleter,
        upload_drain=qualified_drain,
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
        upload_drain=qualified_drain,
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
    org_object_adapter_bad = ObjectWorkspaceErasureAdapter(
        deleter=failing_deleter,
        upload_drain=qualified_drain,
    )
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
                    deleter=lambda k: org_deleted_keys.append(k) or {"deleted": True},
                    upload_drain=qualified_drain,
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
    """BUG-0025 Round-4: Both Community account erasure and B2B organisation erasure require a
    qualified `ObjectUploadDrainVerifier` (`BoundedStreamUploadDrainVerifier`) whenever any
    attachment carries `upload_expires_at`:
      (a) `upload_drain=None` fails closed (`False`, `0` deletes) even at `expiry + 3600s`;
      (b) `BoundedStreamUploadDrainVerifier` holds (`False`, `0` deletes) while either
          `now < expiry + max_stream_duration` OR `has_in_flight_uploads(keys)` returns `True`
          (even past `expiry + 3600s` while a pre-expiry PUT is still streaming!), and once the
          in-flight PUT finishes, deletes the object (`DELETE -> HEAD 404`) and certifies SQL."""
    import time

    org, _workspace, members, tokens = world
    staff_op = operator()
    settings.KODERA_OUTBOX_SEAL_KEY = hashlib.sha256(b"k2c-r2-seal-key").digest()
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

        # Presigned URL expired 3600s ago (`expiry + 3600s`), proving time alone without a qualified
        # `upload_drain` verifier — or with an in-flight pre-expiry PUT — NEVER permits deletion!
        comm_att = Attachment.objects.create(
            organisation=community_org,
            uploader=comm_member,
            filename="unexpired-put-ticket.pdf",
            content_type="application/pdf",
            size_bytes=2048,
            sha256="a" * 64,
            upload_expires_at=now - timedelta(hours=1),
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

    # (a) `upload_drain=None` with `upload_expires_at` holds (`False`, `0` deletes) even at `expiry + 3600s`!
    missing_verifier_pass = advance_account_erasure(
        erasure.id,
        account_adapters,
        object_deleter=simulated_s3_delete,
        upload_drain=None,
    )
    assert missing_verifier_pass["complete"] is False
    assert "account_personal_objects" in missing_verifier_pass["held_domains"]
    assert comm_deletes == []
    assert comm_key in s3_objects

    # (b) `BoundedStreamUploadDrainVerifier` with an active pre-expiry PUT (`in_flight_keys` non-empty)
    # holds (`False`, `0` deletes) even past `expiry + max_stream_duration`!
    in_flight_keys: set[str] = {comm_key}
    drain_verifier = BoundedStreamUploadDrainVerifier(
        max_stream_duration=timedelta(seconds=60),
        has_in_flight_uploads=lambda keys: bool(set(keys) & in_flight_keys),
    )
    inflight_pass = advance_account_erasure(
        erasure.id,
        account_adapters,
        object_deleter=simulated_s3_delete,
        upload_drain=drain_verifier,
    )
    assert inflight_pass["complete"] is False
    assert "account_personal_objects" in inflight_pass["held_domains"]
    assert comm_deletes == []

    # Finish the slow pre-expiry PUT, mark ingress stream drained -> `DELETE -> HEAD 404` wipes it & certifies SQL!
    s3_objects[comm_key] = b"late-put-started-before-expiry"
    in_flight_keys.remove(comm_key)

    second_pass = advance_account_erasure(
        erasure.id,
        account_adapters,
        object_deleter=simulated_s3_delete,
        upload_drain=drain_verifier,
    )
    assert second_pass["complete"] is True
    assert second_pass["held_domains"] == []
    assert comm_deletes == [comm_key]
    assert comm_key not in s3_objects
    assert not Attachment.objects.filter(pk=comm_att.pk).exists()

    # Now verify BOTH `upload_drain=None` refusal, `max_stream_duration` ceiling, AND `has_in_flight_uploads`
    # on B2B organisation erasure (`ObjectWorkspaceErasureAdapter`) + SQL `upload_expires_at` window!
    stream_ceiling = timedelta(seconds=60)
    org_window_end = database_now() - stream_ceiling + timedelta(milliseconds=900)
    org_drain_deadline = org_window_end + stream_ceiling
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
    org_in_flight: set[str] = {b2b_key}
    org_drain = BoundedStreamUploadDrainVerifier(
        max_stream_duration=stream_ceiling,
        has_in_flight_uploads=lambda keys: bool(set(keys) & org_in_flight),
    )

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

    # Without `upload_drain`, `ObjectWorkspaceErasureAdapter` holds `"objects"` (`0` deletes)!
    org_no_verifier = advance_erasure(
        org_erasure.id,
        {
            d: (
                ObjectWorkspaceErasureAdapter(deleter=simulated_org_s3_delete, upload_drain=None)
                if d == "objects"
                else _OrgDomainStub(d)
            )
            for d in org_erasure.inventory["required_domains"]
        },
    )
    assert org_no_verifier["complete"] is False
    assert "objects" in org_no_verifier["held_domains"]
    assert org_deletes == []

    org_adapters = {
        d: (
            ObjectWorkspaceErasureAdapter(
                deleter=simulated_org_s3_delete,
                upload_drain=org_drain,
            )
            if d == "objects"
            else _OrgDomainStub(d)
        )
        for d in org_erasure.inventory["required_domains"]
    }
    # Before `org_drain_deadline` AND while `org_in_flight` is non-empty -> held, `0` deletes!
    org_first = advance_erasure(org_erasure.id, org_adapters)
    assert org_first["complete"] is False
    assert "objects" in org_first["held_domains"]
    assert org_deletes == []

    while database_now() <= org_drain_deadline:
        time.sleep(0.05)

    # Past `org_drain_deadline`, STILL held while `b2b_key in org_in_flight` (`0` deletes)!
    org_still_inflight = advance_erasure(org_erasure.id, org_adapters)
    assert org_still_inflight["complete"] is False
    assert "objects" in org_still_inflight["held_domains"]
    assert org_deletes == []

    # Finish late PUT and clear `org_in_flight` -> `erase_and_verify` + `verify_proof` complete!
    s3_objects[b2b_key] = b"late-org-put-during-drain"
    org_in_flight.remove(b2b_key)

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

        # Upgrade forward across `orgs/0034` and `idempotency/0002` (static SQL only; outbox worker
        # holds `KODERA_OUTBOX_SEAL_KEY` and backfills multi-invitation bindings during `sweep()` / `withdrawn()`).
        restore_leaves()
        assert sender.backfill_legacy_invitation_bindings() == 2

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


def test_bug_0025_default_unix_socket_delete_rpc_without_injected_deleter(
    world, settings, monkeypatch, tmp_path
):
    """BUG-0025 Round-4: Default production deletion path (`deleter=None`) binds and exercises the
    REAL `apps.media.storage_worker` over a temporary `AF_UNIX` socket backed by a local loopback
    HTTP S3 server:
      - Verifies signed AWS4-HMAC-SHA256 `DELETE` followed by signed `HEAD -> 404`;
      - Fails closed (`StorageRefusedError` / `complete=False`) when `HEAD` still returns `200`;
      - Completes both account and organisation erasures when `DELETE -> 204` + `HEAD -> 404`."""
    import http.client
    import http.server
    import os
    import secrets
    import tempfile
    import threading
    from pathlib import Path
    from urllib.parse import parse_qs, urlsplit

    from apps.media import storage_worker

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

    comm_path = f"/k2c-bucket/organisations/{community_org.id}/attachments/{comm_att.id}"
    b2b_path = f"/k2c-bucket/organisations/{org.id}/attachments/{b2b_att.id}"
    s3_objects: dict[str, bytes] = {
        comm_path: b"personal-s3-bytes",
        b2b_path: b"org-s3-bytes",
    }
    s3_requests: list[tuple[str, str]] = []
    s3_mode = {"sticky_head_200": True}

    class _LoopbackS3Handler(http.server.BaseHTTPRequestHandler):
        def _verify_sigv4_query(self) -> bool:
            parsed = urlsplit(self.path)
            qs = parse_qs(parsed.query)
            return (
                qs.get("X-Amz-Algorithm") == ["AWS4-HMAC-SHA256"]
                and qs.get("X-Amz-SignedHeaders") == ["host"]
                and len(qs.get("X-Amz-Signature", [""])[0]) == 64
                and bool(qs.get("X-Amz-Credential"))
            )

        def do_DELETE(self) -> None:  # noqa: N802
            parsed = urlsplit(self.path)
            s3_requests.append(("DELETE", parsed.path))
            if not self._verify_sigv4_query():
                self.send_response(403)
                self.end_headers()
                return
            if not s3_mode["sticky_head_200"]:
                s3_objects.pop(parsed.path, None)
            self.send_response(204)
            self.end_headers()

        def do_HEAD(self) -> None:  # noqa: N802
            parsed = urlsplit(self.path)
            s3_requests.append(("HEAD", parsed.path))
            if not self._verify_sigv4_query():
                self.send_response(403)
                self.end_headers()
                return
            if s3_mode["sticky_head_200"] or parsed.path in s3_objects:
                self.send_response(200)
            else:
                self.send_response(404)
            self.end_headers()

        def log_message(self, _fmt: str, *_args: object) -> None:
            return

    s3_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _LoopbackS3Handler)
    s3_port = s3_server.server_address[1]
    s3_thread = threading.Thread(target=s3_server.serve_forever, daemon=True)
    s3_thread.start()

    def _loopback_outbound_request(destination, **kwargs):
        conn = http.client.HTTPConnection("127.0.0.1", s3_port, timeout=5)
        conn.request(
            kwargs.get("method", "GET"),
            destination.path,
            body=kwargs.get("body"),
            headers={"Host": destination.authority, **(kwargs.get("headers") or {})},
        )
        return conn, conn.getresponse()

    monkeypatch.setattr(storage_worker.outbound, "request", _loopback_outbound_request)

    secret_dir = tmp_path / "media_secrets"
    secret_dir.mkdir()
    for target_org in (community_org, org):
        (secret_dir / str(target_org.id)).write_text(
            json.dumps(
                {
                    "endpoint": "https://storage.example.org",
                    "bucket": "k2c-bucket",
                    "region": "fr-par",
                    "accessKey": secrets.token_hex(12),
                    "secretKey": secrets.token_urlsafe(32),
                }
            )
        )

    sock_dir = tempfile.mkdtemp(prefix="k2c-", dir="/tmp")  # noqa: S108 - macOS AF_UNIX 104-byte path limit
    sock_path = Path(sock_dir) / "gw.sock"
    worker_server = storage_worker.bind(sock_path, storage_worker.DirectorySource(secret_dir))
    worker_thread = threading.Thread(
        target=lambda: worker_server.serve_forever(poll_interval=0.01), daemon=True
    )
    worker_thread.start()
    drain = BoundedStreamUploadDrainVerifier(
        max_stream_duration=timedelta(seconds=60),
        has_in_flight_uploads=lambda _keys: False,
    )
    try:
        settings.KODERA_MEDIA_GATEWAY_SOCKET = str(sock_path)
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

        # S3 `HEAD` still returns `200` after `DELETE` -> REAL `storage_worker` raises `StorageRefusedError`!
        held_res = advance_account_erasure(
            erasure.id,
            account_adapters,
            upload_drain=drain,
        )
        assert held_res["complete"] is False
        assert "account_personal_objects" in held_res["held_domains"]
        assert ("DELETE", comm_path) in s3_requests
        assert ("HEAD", comm_path) in s3_requests

        # S3 `DELETE -> 204` + `HEAD -> 404` -> REAL `storage_worker` (`deleter=None`) completes!
        s3_requests.clear()
        s3_mode["sticky_head_200"] = False
        ok_res = advance_account_erasure(
            erasure.id,
            account_adapters,
            upload_drain=drain,
        )
        assert ok_res["complete"] is True
        assert ok_res["held_domains"] == []
        assert s3_requests == [("DELETE", comm_path), ("HEAD", comm_path)]
        assert comm_path not in s3_objects

        # Default socket path (`ObjectWorkspaceErasureAdapter(upload_drain=drain)` with `deleter=None`) on org erasure!
        s3_requests.clear()
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
                d: (
                    ObjectWorkspaceErasureAdapter(upload_drain=drain)
                    if d == "objects"
                    else _OrgDomainStub(d)
                )
                for d in org_erasure.inventory["required_domains"]
            },
        )
        assert org_res["complete"] is True
        assert ("DELETE", b2b_path) in s3_requests
        assert ("HEAD", b2b_path) in s3_requests
        assert b2b_path not in s3_objects
    finally:
        worker_server.shutdown()
        worker_server.server_close()
        worker_thread.join(timeout=2)
        s3_server.shutdown()
        s3_server.server_close()
        s3_thread.join(timeout=2)
        if sock_path.exists():
            sock_path.unlink()
        if os.path.exists(sock_dir):
            import shutil

            shutil.rmtree(sock_dir, ignore_errors=True)


def test_round4_concurrent_org_erasure_account_erasure_and_passport_mail_lock_order(
    world, settings
):
    """Round-4 #3: Multi-connection PostgreSQL concurrency proof exercising concurrent organisation
    erasure admission (`begin_erasure`), account erasure admission (`begin_account_erasure`), and
    passport magic-link outbox withdrawal (`sender.withdrawn`), plus `orgs` `0033 <-> 0034`
    forward/reverse/reapply roundtrip."""
    import threading
    from concurrent.futures import ThreadPoolExecutor

    from django.db import OperationalError, close_old_connections
    from django.db.migrations.executor import MigrationExecutor

    from apps.identity.models import PassportMagicLinkToken, PassportOutboxBinding, User
    from apps.orgs.account_erasure_services import begin_account_erasure
    from core.passport import (
        enqueue_passport_magic_link,
        generate_magic_link_token,
    )

    _org0, _ws0, _members0, _tokens0 = world
    staff_op = operator()
    seal_key_bytes = hashlib.sha256(b"k2c-r4-lock-order-seal").digest()
    settings.KODERA_OUTBOX_SEAL_KEY = seal_key_bytes

    deadlocks: list[BaseException] = []

    for round_idx in range(6):
        now = database_now()
        with transaction.atomic():
            slug = f"r4lock-{round_idx}-{new_uuid7().hex[:8]}"
            target_org = Organisation.objects.create(
                slug=slug,
                realm=slug,
                issuer=f"https://identity.customer.test/realms/{slug}",
                name=f"R4 Lock {round_idx}",
                state="active",
            )
            SlugReservation.objects.create(
                organisation=target_org,
                namespace="organisation",
                slug=slug,
                state="permanent",
                protected_at=now,
            )
            owner_user = User.objects.create(
                email=f"owner-{slug}@example.test",
                display_name="Owner",
                enabled=True,
            )
            Membership.objects.create(
                user=owner_user,
                organisation=target_org,
                role="org_owner",
                state="active",
                accepted_at=now,
            )
            Identity.objects.create(
                user=owner_user,
                organisation=target_org,
                issuer=target_org.issuer,
                realm=target_org.realm,
                subject=f"owner-sub-{slug}",
                email=owner_user.email,
            )
            member_user = User.objects.create(
                email=f"member-{slug}@example.test",
                display_name="Member",
                enabled=True,
            )
            Membership.objects.create(
                user=member_user,
                organisation=target_org,
                role="org_member",
                state="active",
                accepted_at=now,
            )
            member_ident = Identity.objects.create(
                user=member_user,
                organisation=target_org,
                issuer=target_org.issuer,
                realm=target_org.realm,
                subject=f"member-sub-{slug}",
                email=member_user.email,
            )
            candidate_delivery_id = new_uuid7()
            raw_tok, tok_sha256 = generate_magic_link_token()
            PassportOutboxBinding.objects.create(
                delivery_id=candidate_delivery_id,
                user_id=member_user.id,
                organisation_id=target_org.id,
                created_at=now,
            )
            delivery_id = enqueue_passport_magic_link(
                seal_key=seal_key_bytes,
                link="https://app.localhost/passport/verify",
                organisation_id=target_org.id,
                organisation_name=target_org.name,
                recipient=member_user.email,
                raw_token=raw_tok,
                expires_at=now + timedelta(minutes=15),
                delivery_id=candidate_delivery_id,
            )
            PassportMagicLinkToken.objects.create(
                token_sha256=tok_sha256,
                user_id=member_user.id,
                delivery_id=delivery_id,
                email_normalized=member_user.email,
                domain_normalized="example.test",
                code_challenge="E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
                code_challenge_method="S256",
                device_challenge_sha256=None,
                expires_at=now + timedelta(minutes=15),
            )

        member_verified = replace(
            _tokens0[3],
            issuer=target_org.issuer,
            subject=member_ident.subject,
            issued_at=int(now.timestamp()),
            expires_at=int((now + timedelta(minutes=10)).timestamp()),
            auth_time=int(now.timestamp()),
        )
        barrier = threading.Barrier(3)

        def run_org_erasure(b=barrier, org_id=target_org.id, idx=round_idx) -> None:
            close_old_connections()
            try:
                b.wait(timeout=5)
                begin_erasure(
                    organisation_id=org_id,
                    instruction_ref=f"ORG-{100 + idx}",
                    instruction_sha256="1" * 64,
                    purge_not_before=database_now(),
                    actor_identity_id=staff_op.id,
                )
            except OperationalError as err:
                if getattr(getattr(err, "__cause__", None), "sqlstate", None) == "40P01":
                    deadlocks.append(err)
            except ValueError:
                pass
            finally:
                close_old_connections()

        def run_account_erasure(b=barrier, ver=member_verified, idx=round_idx) -> None:
            close_old_connections()
            try:
                b.wait(timeout=5)
                begin_account_erasure(
                    verified=ver,
                    confirmation="delete",
                    instruction_ref=f"ACC-{100 + idx}",
                    instruction_sha256="2" * 64,
                    purge_not_before=database_now(),
                    actor_identity_id=staff_op.id,
                )
            except OperationalError as err:
                if getattr(getattr(err, "__cause__", None), "sqlstate", None) == "40P01":
                    deadlocks.append(err)
            except (ValueError, IntegrityError):
                # Expected when org erasure commits first and disables `member_ident`!
                pass
            finally:
                close_old_connections()

        def run_passport_withdrawn(b=barrier, deliv_id=delivery_id) -> None:
            close_old_connections()
            try:
                b.wait(timeout=5)
                for _ in range(5):
                    with transaction.atomic():
                        sender.withdrawn("passport_magic_link", deliv_id)
            except OperationalError as err:
                if getattr(getattr(err, "__cause__", None), "sqlstate", None) == "40P01":
                    deadlocks.append(err)
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=3) as pool:
            f1 = pool.submit(run_org_erasure)
            f2 = pool.submit(run_account_erasure)
            f3 = pool.submit(run_passport_withdrawn)
            f1.result(timeout=20)
            f2.result(timeout=20)
            f3.result(timeout=20)

    assert deadlocks == []

    # Verify `orgs` `0033 <-> 0034` migration reverse & reapply roundtrip on a clean state
    # (clear test erasure rows first since `0034` REVERSE intentionally refuses downgrade with active erasures).
    with connection.cursor() as cursor:
        cursor.execute(
            "TRUNCATE orgs_accountattachmenterasure, orgs_invitationoutboxbinding, "
            "orgs_accounterasurereceipt, orgs_accounterasure, "
            "orgs_erasurereceipt, orgs_privacyerasure CASCADE"
        )
    try:
        MigrationExecutor(connection).migrate([("orgs", "0033_proximity_erasure_inventory")])
        MigrationExecutor(connection).migrate(
            [("orgs", "0034_erasure_completeness_and_invitation_outbox")]
        )
    finally:
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())


def test_r5_bounded_stream_upload_drain_requires_authoritative_inflight_inspector(world):
    """Regression (BUG-0025): `BoundedStreamUploadDrainVerifier` rejects `None` or non-callable
    `has_in_flight_uploads` at init and rejects non-bool return values on `verify_drained`."""
    org, _ws, _members, _tokens = world
    now = database_now()
    scope = AccountErasureScope(
        request_id=new_uuid7(),
        user_id=new_uuid7(),
        cutoff_at=now,
        inventory={"required_domains": ["matrix_accounts"]},
    )

    with pytest.raises(TypeError):
        BoundedStreamUploadDrainVerifier(max_stream_duration=timedelta(seconds=60))

    for bad_inspector in (None, "not-a-callable", 123):
        with pytest.raises(TypeError, match="callable"):
            BoundedStreamUploadDrainVerifier(
                max_stream_duration=timedelta(seconds=60),
                has_in_flight_uploads=bad_inspector,
            )

    non_bool_verifier = BoundedStreamUploadDrainVerifier(
        max_stream_duration=timedelta(seconds=1),
        has_in_flight_uploads=lambda _keys: "still-uploading",
    )
    with pytest.raises(TypeError, match="bool"):
        non_bool_verifier.verify_drained(
            scope,
            (f"organisations/{org.id}/attachments/{new_uuid7()}",),
            now - timedelta(seconds=120),
        )


def test_r5_passport_withdrawn_and_account_admission_interleaving_and_sql_boundary(world, settings):
    """Regression (`orgs/0034` & `search_path`):
    1. `ADMISSION_FUNCTIONS` / `restricted_login('admission')` CANNOT execute the account-first
       `privacy_begin_account_erasure` directly (`InsufficientPrivilege`) and CAN execute
       `privacy_admit_account_erasure`.
    2. All `SECURITY DEFINER` functions in `orgs/0034`, `idempotency/0002`, and `docs/0011`
       place `pg_temp` last (`search_path=pg_catalog, public, pg_temp`).
    3. Deterministic 2-connection interleaving where Conn A (`sender.withdrawn('passport_magic_link')`)
       holds shared `privacy_account_cutoff:<person>` before requesting `identity_user FOR SHARE`
       while Conn B runs `begin_account_erasure`: Conn B parks on `privacy_account_cutoff:<person>`
       holding zero `identity_user` row locks, Conn A finishes cleanly, and Conn B admits cutoff
       with zero deadlock (`40P01`)."""
    import threading
    import time
    from concurrent.futures import ThreadPoolExecutor
    from uuid import UUID

    import psycopg
    from django.db import close_old_connections, connections
    from test_core_erasure import operator as make_staff_operator
    from test_erasure_review_guards import restricted_login

    from apps.identity.models import PassportMagicLinkToken, PassportOutboxBinding
    from apps.orgs.account_erasure_services import begin_account_erasure
    from apps.orgs.privacy_models import AccountErasure
    from apps.outbox import sender
    from core.passport import enqueue_passport_magic_link, generate_magic_link_token

    # 1. Verify SQL admission boundary refuses direct `privacy_begin_account_erasure`.
    with restricted_login("admission") as (role_name, connect):
        with connect() as login:
            assert login.execute("SELECT current_user, session_user").fetchone() == (
                role_name,
                role_name,
            )
            assert (
                login.execute(
                    "SELECT has_function_privilege("
                    "current_user,"
                    "'public.privacy_begin_account_erasure(uuid,uuid,text,text,timestamptz,uuid)',"
                    "'EXECUTE')"
                ).fetchone()[0]
                is False
            )
            assert (
                login.execute(
                    "SELECT has_function_privilege("
                    "current_user,"
                    "'public.privacy_admit_account_erasure(uuid,uuid,text,text,timestamptz,uuid)',"
                    "'EXECUTE')"
                ).fetchone()[0]
                is True
            )
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                login.execute("SELECT privacy_begin_account_erasure(NULL,NULL,NULL,NULL,NULL,NULL)")

    # 2. Verify `search_path=pg_catalog, public, pg_temp` (`pg_temp` last) on all K2c SECURITY DEFINER functions.
    expected_definer_functions = (
        "public.invitation_outbox_cutoff_guard()",
        "public.privacy_cutoff_guard()",
        "public.core_erasure_completeness_hook()",
        "public.privacy_confirm_account_attachments_erased(uuid,text)",
        "public.privacy_complete_erasure(uuid)",
        "public.privacy_complete_account_erasure(uuid)",
        "public.privacy_admit_account_erasure(uuid,uuid,text,text,timestamptz,uuid)",
        "public.idempotency_privacy_cutoff_guard()",
        "public.docs_collab_fence(uuid,uuid,uuid,uuid,text,text,text)",
    )
    with connection.cursor() as cursor:
        for sig in expected_definer_functions:
            cursor.execute(
                "SELECT proconfig FROM pg_catalog.pg_proc WHERE oid = %s::regprocedure", [sig]
            )
            proconfig = cursor.fetchone()[0] or []
            search_entries = [item for item in proconfig if item.startswith("search_path=")]
            assert len(search_entries) == 1, (sig, proconfig)
            normalized = search_entries[0].replace(" ", "")
            assert normalized == "search_path=pg_catalog,public,pg_temp", (sig, proconfig)

    # 3. Deterministic 2-connection interleaving: Mail holds shared `privacy_account_cutoff:<person>`
    #    before requesting `identity_user FOR SHARE`, while Admission enters `begin_account_erasure`.
    org, _ws, members, tokens = world
    person = members[3].user
    m3_ident = Identity.objects.get(user=person, organisation=org)
    staff_op = make_staff_operator()
    seal_key_bytes = b"\x55" * 32
    settings.KODERA_OUTBOX_SEAL_KEY = seal_key_bytes

    now = database_now()
    candidate_delivery_id = new_uuid7()
    raw_tok, tok_sha256 = generate_magic_link_token()
    with transaction.atomic():
        PassportOutboxBinding.objects.create(
            delivery_id=candidate_delivery_id,
            user_id=person.id,
            organisation_id=org.id,
            created_at=now,
        )
        delivery_id = enqueue_passport_magic_link(
            seal_key=seal_key_bytes,
            link="https://app.localhost/passport/verify",
            organisation_id=org.id,
            organisation_name=org.name,
            recipient=person.email,
            raw_token=raw_tok,
            expires_at=now + timedelta(minutes=15),
            delivery_id=candidate_delivery_id,
        )
        PassportMagicLinkToken.objects.create(
            token_sha256=tok_sha256,
            user_id=person.id,
            delivery_id=delivery_id,
            email_normalized=person.email,
            domain_normalized="example.org",
            code_challenge="E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            code_challenge_method="S256",
            device_challenge_sha256=None,
            expires_at=now + timedelta(minutes=15),
        )

    mail_holding_account_fence = threading.Event()
    release_mail = threading.Event()
    admission_pid_box: list[int] = []

    def pause_after_shared_account_fence(execute, sql, params, many, context):
        result = execute(sql, params, many, context)
        if "pg_advisory_xact_lock_shared(hashtextextended('privacy_account_cutoff:'" in sql:
            mail_holding_account_fence.set()
            assert release_mail.wait(timeout=10)
        return result

    def run_mail_withdrawn() -> bool:
        close_old_connections()
        try:
            with transaction.atomic(), connection.execute_wrapper(pause_after_shared_account_fence):
                return sender.withdrawn("passport_magic_link", delivery_id)
        finally:
            connections.close_all()

    def run_admission() -> UUID:
        close_old_connections()
        try:
            with connection.cursor() as cur:
                cur.execute("SELECT pg_backend_pid()")
                admission_pid_box.append(cur.fetchone()[0])
            ver = replace(
                tokens[3],
                issuer=org.issuer,
                subject=m3_ident.subject,
                issued_at=int(now.timestamp()),
                expires_at=int((now + timedelta(minutes=10)).timestamp()),
                auth_time=int(now.timestamp()),
            )
            return begin_account_erasure(
                verified=ver,
                confirmation="delete",
                instruction_ref="ACC-950",
                instruction_sha256="9" * 64,
                purge_not_before=database_now(),
                actor_identity_id=staff_op.id,
            ).id
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        mail_future = pool.submit(run_mail_withdrawn)
        assert mail_holding_account_fence.wait(timeout=5)
        admission_future = pool.submit(run_admission)
        try:
            # Wait until PostgreSQL `pg_locks` confirms Admission's backend is actively parked on
            # the exclusive `privacy_account_cutoff:<person>` advisory lock BEFORE holding any
            # exclusive/update lock on `identity_user`!
            parked_cleanly = False
            deadline = time.monotonic() + 4.0
            while time.monotonic() < deadline:
                if admission_pid_box:
                    adm_pid = admission_pid_box[0]
                    with connection.cursor() as cursor:
                        cursor.execute(
                            "SELECT EXISTS ("
                            "  SELECT 1 FROM pg_locks"
                            "  WHERE pid = %s AND locktype = 'advisory' AND NOT granted"
                            "), EXISTS ("
                            "  SELECT 1 FROM pg_locks"
                            "  WHERE pid = %s AND relation = 'public.identity_user'::regclass"
                            "    AND mode IN ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ExclusiveLock')"
                            ")",
                            [adm_pid, adm_pid],
                        )
                        waiting_advisory, holding_user_update = cursor.fetchone()
                        if waiting_advisory:
                            assert holding_user_update is False
                            parked_cleanly = True
                            break
                time.sleep(0.02)
            assert parked_cleanly is True
        finally:
            release_mail.set()

        # Mail acquires `identity_user FOR SHARE`, observes active person (`withdrawn == False`), and commits;
        # Admission then immediately acquires exclusive `privacy_account_cutoff:<person>` and commits cutoff!
        assert mail_future.result(timeout=10) is False
        erasure_id = admission_future.result(timeout=10)

    assert AccountErasure.objects.get(pk=erasure_id).status == "cutoff"
    with transaction.atomic():
        assert sender.withdrawn("passport_magic_link", delivery_id) is True
