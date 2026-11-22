# ruff: noqa: S101
"""Media and notification paths work under the restricted API writer role and refuse tampering."""

import hashlib
import secrets
from datetime import timedelta
from uuid import UUID, uuid4

import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from django.utils import timezone
from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, refused
from test_workspace_writer_role import _role
from workspace_safety.test_moderation import world as world

from apps.media import outbound, preview_guard, services as media_service
from apps.media.models import PreviewAdmission
from apps.notifications import push, services as notification_service
from apps.workspaces import moderation

pytestmark = pytest.mark.django_db


class FakeGateway:
    def call(self, operation, obj):
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
def writer(world):
    yield from _role()


def test_writer_runs_media_and_notifications_and_refuses_immutable_mutations(
    world, writer, settings, monkeypatch
):
    private = ec.generate_private_key(ec.SECP256R1())
    settings.KODERA_NOTIFICATION_SEAL_KEY = secrets.token_bytes(32)
    settings.KODERA_PUSH_VAPID_PUBLIC_KEY = push.public_key(private)
    monkeypatch.setattr(outbound, "addresses", lambda *args: [])
    monkeypatch.setattr(media_service, "_gateway", FakeGateway)

    org, _, members, tokens = world
    device_id = uuid4()
    digest = hashlib.sha256(secrets.token_bytes(32)).hexdigest()

    with acting_as(writer):
        ticket = media_service.create_upload(
            verified=tokens[3],
            organisation_id=org.id,
            body={
                "filename": "report.pdf",
                "contentType": "application/pdf",
                "sizeBytes": 128,
                "sha256": digest,
                "roomId": "!writer:matrix.kodera.test",
            },
            request_id=str(uuid4()),
        )
        attachment_id = UUID(ticket["attachmentId"])
        completed = media_service.complete_upload(
            verified=tokens[3],
            organisation_id=org.id,
            attachment_id=attachment_id,
            request_id=str(uuid4()),
        )
        assert completed["disposition"] == "attachment"
        fetched = media_service.get_attachment(
            verified=tokens[3],
            organisation_id=org.id,
            attachment_id=attachment_id,
        )
        assert fetched["sha256"] == digest

        cancelled_ticket = media_service.create_upload(
            verified=tokens[3],
            organisation_id=org.id,
            body={
                "filename": "transient.pdf",
                "contentType": "application/pdf",
                "sizeBytes": 64,
                "sha256": hashlib.sha256(secrets.token_bytes(32)).hexdigest(),
                "roomId": "!writer:matrix.kodera.test",
            },
            request_id=str(uuid4()),
        )
        cancelled_id = UUID(cancelled_ticket["attachmentId"])
        media_service.cancel_upload(
            verified=tokens[3],
            organisation_id=org.id,
            attachment_id=cancelled_id,
            request_id=str(uuid4()),
        )

        notification_service.put_subscription(
            verified=tokens[3],
            device_id=device_id,
            body={
                "endpoint": "https://push.example.org/device-a",
                "p256dh": push.public_key(ec.generate_private_key(ec.SECP256R1())),
                "auth": push.encode(secrets.token_bytes(16)),
            },
            request_id=str(uuid4()),
        )
        notification_service.put_subscription(
            verified=tokens[3],
            device_id=device_id,
            body={
                "endpoint": "https://push.example.org/device-b",
                "p256dh": push.public_key(ec.generate_private_key(ec.SECP256R1())),
                "auth": push.encode(secrets.token_bytes(16)),
            },
            request_id=str(uuid4()),
        )

        moderation.moderate(
            verified=tokens[2],
            organisation_id=org.id,
            target_id=members[3].id,
            action="mute",
            reason="Cooldown",
            expires_at=timezone.now() + timedelta(minutes=5),
            request_id=str(uuid4()),
        )
        page = notification_service.inbox(verified=tokens[3], cursor=None, limit=10)
        assert len(page["data"]) == 1
        entry_id = UUID(page["data"][0]["id"])
        notification_service.mark_read(
            verified=tokens[3],
            ids=[entry_id],
            request_id=str(uuid4()),
        )
        notification_service.delete_subscription(
            verified=tokens[3],
            device_id=device_id,
            request_id=str(uuid4()),
        )

        assert refused("UPDATE media_attachment SET sha256 = sha256") == INSUFFICIENT_PRIVILEGE
        assert (
            refused("UPDATE media_attachment SET size_bytes = size_bytes + 1")
            == INSUFFICIENT_PRIVILEGE
        )
        assert (
            refused("UPDATE media_attachment SET content_type = 'text/plain'")
            == INSUFFICIENT_PRIVILEGE
        )
        # Both completed rows and unexpired cancelled tombstones are protected from direct DELETE
        # (`23514`) and terminal-state rollback (`23514`).
        assert refused("DELETE FROM media_attachment") == "23514"
        assert refused("DELETE FROM media_attachment WHERE cancelled_at IS NOT NULL") == "23514"
        assert (
            refused(
                "UPDATE media_attachment SET cancelled_at = NULL WHERE cancelled_at IS NOT NULL"
            )
            == "23514"
        )
        assert (
            refused("UPDATE notifications_notification SET kind = 'mention'")
            == INSUFFICIENT_PRIVILEGE
        )
        assert refused("DELETE FROM notifications_notification") == INSUFFICIENT_PRIVILEGE
        assert (
            refused("UPDATE notifications_pushsubscription SET device_id = device_id")
            == INSUFFICIENT_PRIVILEGE
        )
        assert refused("DELETE FROM notifications_pushsubscription") == INSUFFICIENT_PRIVILEGE
        assert (
            refused("UPDATE notifications_pushoutbox SET state = 'delivered'")
            == INSUFFICIENT_PRIVILEGE
        )
        assert refused("DELETE FROM notifications_pushoutbox") == INSUFFICIENT_PRIVILEGE

    # Once `cancelled_id`'s presigned PUT window expires, `reap_expired_uploads()` purges it
    # cleanly under `api_writer` while `attachment_id` remains protected.
    from apps.identity.models import Identity, StaffRole, User
    from apps.media.models import Attachment
    from apps.orgs import account_erasure_services
    from apps.orgs.erasure_services import begin_erasure, database_now
    from services.identity.access_tokens import VerifiedAccessToken

    Attachment.objects.filter(pk=cancelled_id).update(
        upload_expires_at=media_service._upload_purge_before() - timedelta(seconds=5)
    )
    with acting_as(writer):
        assert media_service.reap_expired_uploads(limit=10) == 1
        assert refused("DELETE FROM media_attachment WHERE completed_at IS NOT NULL") == "23514"
    assert not Attachment.objects.filter(pk=cancelled_id).exists()
    assert Attachment.objects.filter(pk=attachment_id).exists()

    # Recording an account OR organisation erasure journal row alone NEVER permits `api_writer` to
    # delete completed `media_attachment` rows outside `retention_worker_context` (`BUG-0021` R2 #9)!
    staff_user = User.objects.create(email=f"{uuid4()}@staff.test")
    staff_identity = Identity.objects.create(
        user=staff_user,
        realm="kodera-staff",
        issuer="https://identity.staff.test/realms/kodera-staff",
        subject=str(uuid4()),
        email=staff_user.email,
    )
    StaffRole.objects.create(identity=staff_identity, realm="kodera-staff", role="staff_operator")

    now_ts = int(database_now().timestamp())
    fresh_token = VerifiedAccessToken(
        tokens[3].issuer,
        tokens[3].subject,
        tokens[3].audience,
        now_ts,
        now_ts + 300,
        None,
        None,
        None,
        now_ts,
        email_verified=True,
    )
    account_erasure_services.begin_account_erasure(
        verified=fresh_token,
        confirmation="delete",
        instruction_ref="ACC-100",
        instruction_sha256="2" * 64,
        purge_not_before=database_now(),
        actor_identity_id=staff_identity.id,
    )
    with acting_as(writer):
        assert refused("DELETE FROM media_attachment WHERE completed_at IS NOT NULL") == "23514"

    begin_erasure(
        organisation_id=org.id,
        instruction_ref="DEL-100",
        instruction_sha256="1" * 64,
        purge_not_before=database_now(),
        actor_identity_id=staff_identity.id,
    )
    with acting_as(writer):
        assert refused("DELETE FROM media_attachment WHERE completed_at IS NOT NULL") == "23514"
    assert Attachment.objects.filter(pk=attachment_id).exists()


def test_writer_can_insert_select_update_and_delete_preview_admission(world, writer):
    key = "principal:" + uuid4().hex
    with acting_as(writer):
        assert preview_guard.charge(key)
        assert preview_guard.charge(key)  # ON CONFLICT requires UPDATE and SELECT.
        assert PreviewAdmission.objects.get(pk=key).hits == 2
        preview_guard.remember_timeout(key, 10)
        assert preview_guard.timed_out(key)
        PreviewAdmission.objects.filter(pk=key).delete()
        assert not preview_guard.timed_out(key)
