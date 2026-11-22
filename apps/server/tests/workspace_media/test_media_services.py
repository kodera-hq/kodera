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
from apps.workspaces.models import Channel, ResourcePolicy

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


def default_channel(workspace):
    existing = Channel.objects.filter(
        workspace=workspace, kind="text", lifecycle="active", name="General Attachments"
    ).first()
    if existing is not None:
        return existing
    policy = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    return Channel.objects.create(
        workspace=workspace,
        name="General Attachments",
        kind="text",
        lifecycle="active",
        position=0,
        policy_mode="explicit",
        explicit_policy=policy,
    )


def upload(world, gateway):
    org, workspace, _, tokens = world
    channel = default_channel(workspace)
    return service.create_upload(
        verified=tokens[3],
        organisation_id=org.id,
        body={
            "filename": "example.txt",
            "contentType": "text/plain",
            "sizeBytes": 42,
            "sha256": hashlib.sha256(secrets.token_bytes(42)).hexdigest(),
            "channelId": str(channel.id),
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
    from apps.workspaces.models import WorkspaceQuota
    from apps.workspaces.quotas import violation

    org, workspace, _, tokens = world
    channel = default_channel(workspace)
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
            "channelId": str(channel.id),
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
                "channelId": str(channel.id),
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
    tombstone = Attachment.objects.get(pk=second["attachmentId"])
    assert tombstone.cancelled_at is not None and tombstone.completed_at is None
    assert gateway.calls[-1][0] == "delete"
    # While the presigned PUT capability has not expired, completion is fenced (`409`) AND the
    # tombstone continues to hold its pending-upload slot so `create -> cancel -> PUT` cannot
    # bypass pending-ticket accounting or escape post-expiry reaper S3 cleanup.
    with pytest.raises(RefusalError) as cancelled_complete:
        service.complete_upload(
            verified=tokens[3],
            organisation_id=org.id,
            attachment_id=second["attachmentId"],
            request_id=str(uuid4()),
        )
    assert cancelled_complete.value.status == 409
    with pytest.raises(RefusalError) as still_capped_until_expiry:
        upload(world, gateway)
    assert still_capped_until_expiry.value.status == 429

    # Once the presigned PUT capability expires, the reaper executes signed S3 DELETE + HEAD 404
    # (cleaning up any delayed PUT) and removes the tombstone row, freeing the member's slot.
    Attachment.objects.filter(pk=second["attachmentId"]).update(
        upload_expires_at=service._upload_purge_before() - timedelta(seconds=5)
    )
    delete_calls_before_reap = sum(1 for op, _ in gateway.calls if op == "delete")
    assert service.reap_expired_uploads(limit=10) == 1
    assert sum(1 for op, _ in gateway.calls if op == "delete") == delete_calls_before_reap + 1
    assert not Attachment.objects.filter(pk=second["attachmentId"]).exists()

    service.complete_upload(
        verified=tokens[3],
        organisation_id=org.id,
        attachment_id=first["attachmentId"],
        request_id=str(uuid4()),
    )
    delete_calls_before_completed_cancel = sum(1 for op, _ in gateway.calls if op == "delete")
    with pytest.raises(RefusalError) as completed_cancel:
        service.cancel_upload(
            verified=tokens[3],
            organisation_id=org.id,
            attachment_id=first["attachmentId"],
            request_id=str(uuid4()),
        )
    assert completed_cancel.value.status == 409
    assert (
        sum(1 for op, _ in gateway.calls if op == "delete") == delete_calls_before_completed_cancel
    )

    Attachment.objects.filter(pk=third["attachmentId"]).update(
        upload_expires_at=service._upload_purge_before() - timedelta(seconds=5)
    )
    gateway.reject = True
    assert service.reap_expired_uploads(limit=10) == 0
    assert Attachment.objects.filter(pk=third["attachmentId"]).exists()
    gateway.reject = False
    assert service.reap_expired_uploads(limit=10) == 1
    assert not Attachment.objects.filter(pk=third["attachmentId"]).exists()
    assert Attachment.objects.filter(pk=first["attachmentId"]).exists()

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
            "channelId": str(channel.id),
        },
        request_id=str(uuid4()),
    )
    with pytest.raises(IntegrityError) as over_quota, transaction.atomic():
        service.create_upload(
            verified=tokens[3],
            organisation_id=org.id,
            body={
                "filename": "archive-b.bin",
                "contentType": "application/octet-stream",
                "sizeBytes": limit_bytes,
                "sha256": hashlib.sha256(b"archive-b").hexdigest(),
                "channelId": str(channel.id),
            },
            request_id=str(uuid4()),
        )
    quota_detail = violation(over_quota.value)
    assert quota_detail is not None and quota_detail["status"] == 413

    Attachment.objects.filter(pk=big_ticket["attachmentId"]).update(
        upload_expires_at=service._upload_purge_before() - timedelta(seconds=1)
    )
    assert service.reap_expired_uploads() == 1
    recovered = service.create_upload(
        verified=tokens[3],
        organisation_id=org.id,
        body={
            "filename": "archive-b.bin",
            "contentType": "application/octet-stream",
            "sizeBytes": limit_bytes,
            "sha256": hashlib.sha256(b"archive-b").hexdigest(),
            "channelId": str(channel.id),
        },
        request_id=str(uuid4()),
    )
    assert recovered["attachmentId"] != big_ticket["attachmentId"]


@pytest.mark.django_db(transaction=True)
def test_cancel_claims_cancellation_before_s3_delete_preventing_race_with_complete(world, gateway):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    from django.db import close_old_connections

    org, _, _, tokens = world
    ticket = upload(world, gateway)
    entered_delete = Event()
    release_delete = Event()
    claimed_before_delete = []

    def on_delete(obj):
        row = Attachment.objects.get(pk=obj.attachment_id)
        claimed_before_delete.append(row.cancelled_at is not None and row.completed_at is None)
        entered_delete.set()
        assert release_delete.wait(5)

    gateway.hooks["delete"] = on_delete
    prepared_before_cancel = service.prepare_complete(
        verified=tokens[3],
        organisation_id=org.id,
        attachment_id=ticket["attachmentId"],
    )

    def run_cancel():
        close_old_connections()
        try:
            service.cancel_upload(
                verified=tokens[3],
                organisation_id=org.id,
                attachment_id=ticket["attachmentId"],
                request_id=str(uuid4()),
            )
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=1) as pool:
        cancel_future = pool.submit(run_cancel)
        assert entered_delete.wait(2)
        # Even a completion that already finished `prepare_complete` before `cancel_upload` started
        # is fenced (`409`) by the committed `cancelled_at` claim while S3 DELETE is in flight.
        with pytest.raises(RefusalError) as fenced:
            service.commit_complete(
                verified=tokens[3],
                organisation_id=org.id,
                prepared=prepared_before_cancel,
                request_id=str(uuid4()),
            )
        assert fenced.value.status == 409
        release_delete.set()
        cancel_future.result(5)

    assert claimed_before_delete == [True]
    row = Attachment.objects.get(pk=ticket["attachmentId"])
    assert row.cancelled_at is not None and row.completed_at is None


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


@pytest.mark.parametrize("cancel_first", [False, True])
def test_upload_tombstone_retains_late_put_and_quota_until_stream_drains(
    world, gateway, settings, monkeypatch, cancel_first
):
    from django.db import connection

    org, workspace, _, tokens = world
    ticket = upload(world, gateway)
    row = Attachment.objects.get(pk=ticket["attachmentId"])
    settings.KODERA_MEDIA_MAX_UPLOAD_STREAM_S = 300
    expiry = timezone.now() - timedelta(seconds=1)
    Attachment.objects.filter(pk=row.id).update(upload_expires_at=expiry)
    clock = [expiry + timedelta(seconds=1)]
    monkeypatch.setattr(service.timezone, "now", lambda: clock[0])
    # A DELETE may precede a late pre-expiry PUT. The row remains its durable cleanup index.
    present = [False]
    gateway.hooks["delete"] = lambda obj: present.__setitem__(0, False)
    if cancel_first:
        service.cancel_upload(
            verified=tokens[3],
            organisation_id=org.id,
            attachment_id=row.id,
            request_id=str(uuid4()),
        )
    present[0] = True
    deletes = sum(op == "delete" for op, _ in gateway.calls)
    assert service.reap_expired_uploads() == 0
    assert Attachment.objects.filter(pk=row.id).exists()
    with connection.cursor() as cursor:
        cursor.execute("SELECT workspace_quota_usage(%s)->>'mediaBytes'", [workspace.id])
        assert int(cursor.fetchone()[0]) == row.size_bytes
    clock[0] = expiry + timedelta(seconds=300)
    assert service.reap_expired_uploads() == 1
    assert sum(op == "delete" for op, _ in gateway.calls) == deletes + 1
    assert present[0] is False
    assert not Attachment.objects.filter(pk=row.id).exists()


@pytest.mark.django_db(transaction=True)
def test_upload_quota_migration_reverses_and_reapplies():
    from django.db import connection
    from django.db.migrations.executor import MigrationExecutor

    def definition():
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_get_functiondef('workspace_quota_usage(uuid)'::regprocedure)")
            return cursor.fetchone()[0]

    assert "make_interval(secs => 300)" in definition()
    executor = MigrationExecutor(connection)
    leaves = executor.loader.graph.leaf_nodes()
    try:
        executor.migrate([("workspaces", "0015_confidential_channel_designation")])
        assert "a.upload_expires_at" in definition()
        assert "make_interval(secs => 300)" not in definition()
    finally:
        MigrationExecutor(connection).migrate(leaves)
    assert "make_interval(secs => 300)" in definition()


def test_cancel_crossing_stream_deadline_requires_another_cleanup_pass(
    world, gateway, settings, monkeypatch
):
    org, _, _, tokens = world
    ticket = upload(world, gateway)
    settings.KODERA_MEDIA_MAX_UPLOAD_STREAM_S = 300
    expiry = timezone.now() - timedelta(seconds=301)
    Attachment.objects.filter(pk=ticket["attachmentId"]).update(upload_expires_at=expiry)
    clock = [expiry + timedelta(seconds=299)]
    monkeypatch.setattr(service.timezone, "now", lambda: clock[0])

    def late_put_during_delete(obj):
        clock[0] = expiry + timedelta(seconds=300)

    gateway.hooks["delete"] = late_put_during_delete
    service.cancel_upload(
        verified=tokens[3],
        organisation_id=org.id,
        attachment_id=ticket["attachmentId"],
        request_id=str(uuid4()),
    )
    assert Attachment.objects.filter(pk=ticket["attachmentId"]).exists()
    assert service.reap_expired_uploads() == 1
    assert sum(op == "delete" for op, _ in gateway.calls) == 2


@pytest.mark.parametrize(
    "age,completed,counted",
    [(301, False, False), (299, False, True), (-60, False, True), (301, True, True)],
)
def test_quota_releases_abandoned_tickets_without_a_reaper(world, gateway, age, completed, counted):
    from django.db import connection

    _, workspace, _, _ = world
    ticket = upload(world, gateway)
    row = Attachment.objects.get(pk=ticket["attachmentId"])
    now = timezone.now()
    Attachment.objects.filter(pk=row.id).update(
        upload_expires_at=now - timedelta(seconds=age),
        completed_at=now if completed else None,
    )
    with connection.cursor() as cursor:
        cursor.execute("SELECT workspace_quota_usage(%s)->>'mediaBytes'", [workspace.id])
        assert int(cursor.fetchone()[0]) == (row.size_bytes if counted else 0)
    assert Attachment.objects.filter(pk=row.id).exists()


@pytest.mark.parametrize("age,expected", [(301, False), (299, True), (-60, True)])
def test_erasure_treats_post_expiry_tickets_as_in_flight(world, gateway, age, expected):
    from apps.orgs.object_erasure import has_in_flight_uploads

    ticket = upload(world, gateway)
    row = Attachment.objects.get(pk=ticket["attachmentId"])
    Attachment.objects.filter(pk=row.id).update(
        upload_expires_at=timezone.now() - timedelta(seconds=age)
    )
    key = f"organisations/{row.organisation_id}/attachments/{row.id}"
    assert has_in_flight_uploads((key,)) is expected
