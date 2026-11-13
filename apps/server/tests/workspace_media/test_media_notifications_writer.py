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

from apps.media import outbound, services as media_service
from apps.notifications import push, services as notification_service
from apps.workspaces import moderation

pytestmark = pytest.mark.django_db


class FakeGateway:
    def call(self, operation, obj):
        if operation == "verify":
            return {"verified": True}
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
        assert refused("DELETE FROM media_attachment") == INSUFFICIENT_PRIVILEGE
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
