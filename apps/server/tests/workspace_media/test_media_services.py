"""Database and current-member boundaries of object tickets and completion."""

import hashlib
import secrets
from datetime import timedelta
from uuid import uuid4

import pytest
from django.db import IntegrityError, transaction
from django.utils import timezone
from workspace_safety.test_moderation import world as world

from apps.identity.models import Identity
from apps.media import services as service
from apps.media.context import RefusalError
from apps.media.models import Attachment
from apps.media.storage import ObjectMismatchError, StorageRefusedError
from apps.orgs.models import Membership, Organisation, SlugReservation

pytestmark = pytest.mark.django_db


class FakeGateway:
    def __init__(self):
        self.calls = []
        self.reject = False
        self.hooks = {}

    def call(self, operation, obj):
        self.calls.append((operation, obj))
        hook = self.hooks.get(operation)
        if hook is not None:
            hook(obj)
        if self.reject:
            if operation == "verify":
                raise ObjectMismatchError()
            raise StorageRefusedError()
        if operation == "verify":
            return {"verified": True}
        if operation == "delete":
            return {"deleted": True}
        return {
            "url": "https://storage.example.org/" + obj.key,
            "headers": {"Content-Type": obj.content_type},
            "expiresAt": (timezone.now() + timedelta(seconds=250)).isoformat(),
        }


@pytest.fixture
def gateway(monkeypatch):
    result = FakeGateway()
    monkeypatch.setattr(service, "_gateway", lambda: result)
    return result


def upload(world, gateway):
    org, _, _, tokens = world
    return service.create_upload(
        verified=tokens[3],
        organisation_id=org.id,
        body={
            "filename": "example.txt",
            "contentType": "text/plain",
            "sizeBytes": 42,
            "sha256": hashlib.sha256(secrets.token_bytes(42)).hexdigest(),
        },
        request_id=str(uuid4()),
    )


def test_completion_verifies_actual_object_and_download_rechecks_membership(world, gateway):
    org, _, members, tokens = world
    ticket = upload(world, gateway)
    row = Attachment.objects.get(pk=ticket["attachmentId"])
    assert row.organisation_id == org.id and row.uploader_id == members[3].id
    assert gateway.calls[0][1].key.startswith(f"organisations/{org.id}/attachments/")
    with pytest.raises(RefusalError) as denied:
        service.complete_upload(
            verified=tokens[2],
            organisation_id=org.id,
            attachment_id=row.id,
            request_id=str(uuid4()),
        )
    assert denied.value.status == 403
    assert row.completed_at is None
    completed = service.complete_upload(
        verified=tokens[3], organisation_id=org.id, attachment_id=row.id, request_id=str(uuid4())
    )
    assert completed["disposition"] == "attachment"
    assert [operation for operation, _ in gateway.calls] == ["upload", "verify", "download"]
    Identity.objects.filter(user_id=members[3].user_id).update(enabled=False)
    with pytest.raises(RefusalError) as denied:
        service.get_attachment(verified=tokens[3], organisation_id=org.id, attachment_id=row.id)
    assert denied.value.status == 403
    assert len(gateway.calls) == 3


def test_failed_checksum_completion_and_absent_signer_never_publish_metadata(world, gateway):
    org, _, _, tokens = world
    ticket = upload(world, gateway)
    gateway.reject = True
    with pytest.raises(RefusalError) as failed:
        service.complete_upload(
            verified=tokens[3],
            organisation_id=org.id,
            attachment_id=ticket["attachmentId"],
            request_id=str(uuid4()),
        )
    assert failed.value.status == 409
    assert Attachment.objects.get(pk=ticket["attachmentId"]).completed_at is None
    with pytest.raises(RefusalError) as failed:
        upload(world, gateway)
    assert failed.value.status == 503
    assert Attachment.objects.count() == 1


def test_database_refuses_an_attachment_uploader_from_another_organisation(world):
    org, _, members, _ = world
    with transaction.atomic():
        slug = "media-" + uuid4().hex[:12]
        other = Organisation.objects.create(
            slug=slug,
            realm=slug,
            issuer=f"https://identity.example.org/realms/{slug}",
            name="Example",
            state="active",
        )
        SlugReservation.objects.create(
            organisation=other,
            slug=slug,
            namespace="organisation",
            state="permanent",
            protected_at=timezone.now(),
        )
        foreign = Membership.objects.create(
            organisation=other,
            user=members[0].user,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
    with pytest.raises(IntegrityError), transaction.atomic():
        Attachment.objects.create(
            organisation=org,
            uploader=foreign,
            filename="example.txt",
            content_type="text/plain",
            size_bytes=1,
            sha256=hashlib.sha256(b"example").hexdigest(),
            upload_expires_at=timezone.now() + timedelta(minutes=5),
        )


def test_pending_upload_caps_cancel_reaper_and_expired_quota_release(world, gateway, settings):
    from django.db import connection

    from apps.workspaces.models import WorkspaceQuota

    org, workspace, _, tokens = world
    settings.KODERA_MAX_PENDING_UPLOADS_PER_MEMBER = 2
    settings.KODERA_MAX_PENDING_UPLOADS_PER_WORKSPACE = 3

    first = upload(world, gateway)
    second = upload(world, gateway)

    with pytest.raises(RefusalError) as member_capped:
        upload(world, gateway)
    assert member_capped.value.status == 429
    assert member_capped.value.reason == "pending_upload_limit_exceeded"

    third = service.create_upload(
        verified=tokens[2],
        organisation_id=org.id,
        body={
            "filename": "peer.txt",
            "contentType": "text/plain",
            "sizeBytes": 16,
            "sha256": hashlib.sha256(secrets.token_bytes(16)).hexdigest(),
        },
        request_id=str(uuid4()),
    )

    with pytest.raises(RefusalError) as workspace_capped:
        service.create_upload(
            verified=tokens[1],
            organisation_id=org.id,
            body={
                "filename": "admin.txt",
                "contentType": "text/plain",
                "sizeBytes": 16,
                "sha256": hashlib.sha256(secrets.token_bytes(16)).hexdigest(),
            },
            request_id=str(uuid4()),
        )
    assert workspace_capped.value.status == 429
    assert workspace_capped.value.reason == "workspace_pending_upload_limit_exceeded"

    with pytest.raises(RefusalError) as denied_cancel:
        service.cancel_upload(
            verified=tokens[2],
            organisation_id=org.id,
            attachment_id=second["attachmentId"],
            request_id=str(uuid4()),
        )
    assert denied_cancel.value.status == 403

    service.cancel_upload(
        verified=tokens[3],
        organisation_id=org.id,
        attachment_id=second["attachmentId"],
        request_id=str(uuid4()),
    )
    assert not Attachment.objects.filter(pk=second["attachmentId"]).exists()
    assert gateway.calls[-1][0] == "delete"

    service.complete_upload(
        verified=tokens[3],
        organisation_id=org.id,
        attachment_id=first["attachmentId"],
        request_id=str(uuid4()),
    )
    with pytest.raises(RefusalError) as completed_cancel:
        service.cancel_upload(
            verified=tokens[3],
            organisation_id=org.id,
            attachment_id=first["attachmentId"],
            request_id=str(uuid4()),
        )
    assert completed_cancel.value.status == 409

    Attachment.objects.filter(pk=third["attachmentId"]).update(
        upload_expires_at=timezone.now() - timedelta(seconds=5)
    )
    gateway.reject = True
    assert service.reap_expired_uploads(limit=10) == 0
    assert Attachment.objects.filter(pk=third["attachmentId"]).exists()
    gateway.reject = False
    assert service.reap_expired_uploads(limit=10) == 1
    assert not Attachment.objects.filter(pk=third["attachmentId"]).exists()
    assert Attachment.objects.filter(pk=first["attachmentId"]).exists()

    with connection.cursor() as cursor:
        cursor.execute(
            """
            CREATE OR REPLACE FUNCTION workspace_quota_usage(p_workspace uuid) RETURNS jsonb
            LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
            SELECT jsonb_build_object(
             'seats', (SELECT count(*) FROM public.orgs_membership m WHERE m.organisation_id=w.organisation_id
                       AND m.state='active' AND m.accepted_at IS NOT NULL AND m.deleted_at IS NULL)
                      +(SELECT count(*) FROM public.orgs_invitation i WHERE i.organisation_id=w.organisation_id
                        AND i.state='pending' AND i.expires_at>statement_timestamp()
                        AND NOT EXISTS(SELECT 1 FROM public.orgs_membership m JOIN public.identity_user u ON u.id=m.user_id
                                       WHERE m.organisation_id=i.organisation_id AND m.state='active'
                                       AND m.deleted_at IS NULL AND m.accepted_at IS NOT NULL AND lower(u.email)=i.email)),
             'mediaBytes', (SELECT coalesce(sum(a.size_bytes),0) FROM public.media_attachment a
                            WHERE a.organisation_id=w.organisation_id
                              AND (a.completed_at IS NOT NULL OR a.upload_expires_at > statement_timestamp())),
             'pages', (SELECT count(*) FROM public.docs_document d WHERE d.workspace_id=w.id AND d.deleted_at IS NULL))
            FROM public.workspaces_workspace w WHERE w.id=p_workspace;
            $$;
            """
        )

    limit_bytes = 26_214_400
    WorkspaceQuota.objects.update_or_create(
        workspace=workspace,
        defaults={"policy_ref": "tier:quota-test", "media_bytes": limit_bytes + 42},
    )
    big_ticket = service.create_upload(
        verified=tokens[3],
        organisation_id=org.id,
        body={
            "filename": "archive.bin",
            "contentType": "application/octet-stream",
            "sizeBytes": limit_bytes,
            "sha256": hashlib.sha256(b"archive-a").hexdigest(),
        },
        request_id=str(uuid4()),
    )
    with pytest.raises(RefusalError) as over_quota:
        service.create_upload(
            verified=tokens[3],
            organisation_id=org.id,
            body={
                "filename": "archive-b.bin",
                "contentType": "application/octet-stream",
                "sizeBytes": limit_bytes,
                "sha256": hashlib.sha256(b"archive-b").hexdigest(),
            },
            request_id=str(uuid4()),
        )
    assert over_quota.value.status == 413

    Attachment.objects.filter(pk=big_ticket["attachmentId"]).update(
        upload_expires_at=timezone.now() - timedelta(seconds=1)
    )
    recovered = service.create_upload(
        verified=tokens[3],
        organisation_id=org.id,
        body={
            "filename": "archive-b.bin",
            "contentType": "application/octet-stream",
            "sizeBytes": limit_bytes,
            "sha256": hashlib.sha256(b"archive-b").hexdigest(),
        },
        request_id=str(uuid4()),
    )
    assert recovered["attachmentId"] != big_ticket["attachmentId"]


@pytest.mark.django_db(transaction=True)
def test_storage_gateway_rpc_runs_outside_workspace_row_lock(world, gateway):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    from django.db import close_old_connections, connection
    from test_customer_persistence_concurrency import session

    org, workspace, _, tokens = world
    ticket = upload(world, gateway)
    entered = Event()
    release = Event()
    in_tx = []

    def slow_verify(_obj):
        in_tx.append(connection.in_atomic_block)
        entered.set()
        assert release.wait(5)

    gateway.hooks["verify"] = slow_verify

    def run_complete():
        close_old_connections()
        try:
            return service.complete_upload(
                verified=tokens[3],
                organisation_id=org.id,
                attachment_id=ticket["attachmentId"],
                request_id=str(uuid4()),
            )
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(run_complete)
        assert entered.wait(2)
        with session() as peer:
            peer.execute("BEGIN")
            peer.execute("SET LOCAL lock_timeout = '500ms'")
            locked = peer.execute(
                "SELECT id FROM workspaces_workspace WHERE id = %s FOR UPDATE NOWAIT",
                [workspace.id],
            ).fetchone()
            peer.execute("ROLLBACK")
        assert locked == (workspace.id,)
        release.set()
        completed = future.result(5)
    assert in_tx == [False]
    assert completed["id"] == ticket["attachmentId"]
