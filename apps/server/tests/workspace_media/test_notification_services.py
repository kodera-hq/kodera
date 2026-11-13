"""Scoped inbox pages and version-bound leased push delivery."""

import secrets
from datetime import timedelta
from uuid import uuid4

import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from django.db import transaction
from django.utils import timezone
from workspace_safety.test_moderation import world as world

from apps.media import outbound
from apps.media.context import RefusalError
from apps.notifications import dispatcher, push, services as service
from apps.notifications.models import Notification, PushOutbox, PushSubscription
from apps.workspaces import moderation

pytestmark = pytest.mark.django_db


@pytest.fixture
def configured(settings, monkeypatch):
    private = ec.generate_private_key(ec.SECP256R1())
    settings.KODERA_NOTIFICATION_SEAL_KEY = secrets.token_bytes(32)
    settings.KODERA_PUSH_VAPID_PUBLIC_KEY = push.public_key(private)
    monkeypatch.setattr(outbound, "addresses", lambda *args: [])
    return private


def register(world, endpoint="https://push.example.org/wake"):
    _, _, _, tokens = world
    device = uuid4()
    service.put_subscription(
        verified=tokens[3],
        device_id=device,
        body={
            "endpoint": endpoint,
            "p256dh": push.public_key(ec.generate_private_key(ec.SECP256R1())),
            "auth": push.encode(secrets.token_bytes(16)),
        },
        request_id=str(uuid4()),
    )
    return PushSubscription.objects.get(device_id=device)


def notice(world, recipient=3):
    org, _, members, _ = world
    with transaction.atomic():
        return service.record(
            organisation_id=org.id,
            membership_id=members[recipient].id,
            kind="moderation",
            resource_id=members[recipient].id,
        )


def test_inbox_cursor_and_mark_read_are_bound_to_the_current_member(world):
    _, _, _, tokens = world
    first, second = notice(world), notice(world)
    foreign = notice(world, recipient=2)
    page = service.inbox(verified=tokens[3], cursor=None, limit=1)
    assert page["data"][0]["id"] == str(second.id) and page["has_more"]
    assert service.inbox(verified=tokens[3], cursor=page["next_cursor"], limit=1)["data"][0][
        "id"
    ] == str(first.id)
    with pytest.raises(RefusalError) as denied:
        service.inbox(verified=tokens[2], cursor=page["next_cursor"], limit=1)
    assert denied.value.status == 400
    with pytest.raises(RefusalError) as denied:
        service.mark_read(verified=tokens[3], ids=[first.id, foreign.id], request_id=str(uuid4()))
    assert denied.value.status == 404
    first.refresh_from_db()
    assert first.read_at is None
    service.mark_read(verified=tokens[3], ids=[first.id], request_id=str(uuid4()))
    first.refresh_from_db()
    assert first.read_at is not None


def test_subscription_material_is_sealed_and_dead_endpoint_is_pruned(
    world, configured, monkeypatch
):
    row = register(world)
    assert row.sealed_subscription[:1] == b"\x01"
    assert b"https://push.example.org" not in bytes(row.sealed_subscription)
    notice(world)
    calls = []
    monkeypatch.setattr(push, "send", lambda *args: calls.append(args) or push.Result("dead"))
    assert dispatcher.dispatch_one(configured, "mailto:operations@example.org")
    row.refresh_from_db()
    assert row.revoked_at is not None
    assert PushOutbox.objects.get().state == "obsolete"
    assert len(calls) == 1 and len(calls[0]) == 3


def test_old_410_response_cannot_revoke_a_replacement_subscription(world, configured, monkeypatch):
    row = register(world)
    notice(world)
    old_version = row.version

    def send(*args):
        _, _, _, tokens = world
        service.put_subscription(
            verified=tokens[3],
            device_id=row.device_id,
            body={
                "endpoint": "https://push.example.org/replacement",
                "p256dh": push.public_key(ec.generate_private_key(ec.SECP256R1())),
                "auth": push.encode(secrets.token_bytes(16)),
            },
            request_id=str(uuid4()),
        )
        return push.Result("dead")

    monkeypatch.setattr(push, "send", send)
    assert dispatcher.dispatch_one(configured, "mailto:operations@example.org")
    row.refresh_from_db()
    assert row.version != old_version and row.revoked_at is None
    assert PushOutbox.objects.get().state == "obsolete"


def test_expired_lease_is_reclaimed_and_its_old_result_is_ignored(world, configured):
    row = register(world)
    notice(world)
    first = dispatcher.claim()
    assert first is not None
    assert dispatcher.claim() is None
    PushOutbox.objects.filter(pk=first.id).update(
        lease_expires_at=timezone.now() - timedelta(seconds=1)
    )
    second = dispatcher.claim()
    assert second is not None and second.lease != first.lease
    dispatcher.finish(first, push.Result("dead"))
    row.refresh_from_db()
    assert row.revoked_at is None
    dispatcher.finish(second, push.Result("retry", 120))
    job = PushOutbox.objects.get(pk=first.id)
    assert job.state == "pending" and job.lease_id is None
    assert job.available_at > timezone.now() + timedelta(seconds=100)


def test_moderation_audit_atomically_creates_the_recipients_inbox_entry(world, configured):
    org, _, members, tokens = world
    register(world)
    moderation.moderate(
        verified=tokens[2],
        organisation_id=org.id,
        target_id=members[3].id,
        action="mute",
        reason="Example",
        expires_at=timezone.now() + timedelta(minutes=5),
        request_id=str(uuid4()),
    )
    entry = Notification.objects.get()
    assert entry.membership_id == members[3].id and entry.resource_id == members[3].id
    assert PushOutbox.objects.count() == 1
